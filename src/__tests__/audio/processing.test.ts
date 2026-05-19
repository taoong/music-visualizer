/**
 * Unit tests for audio/processing.ts
 * All functions are pure (no store/DOM dependencies), so no mocking is needed.
 */
import {
  updateAutoGain,
  applyAutoGain,
  updateTransient,
  computeDelta,
  smoothBins,
} from '../../audio/processing';
import { AUTO_GAIN_FLOOR, TRANSIENT_BOOST } from '../../utils/constants';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeTracker(windowSize = 300) {
  return { peaks: new Float32Array(windowSize), idx: 0 };
}

function makeTransientState(avg = 0, multiplier = 1.0) {
  return { avg, multiplier };
}

function makeDeltaState(prevMean = 0, smoothed = 0) {
  return { prevMean, smoothed };
}

// ---------------------------------------------------------------------------
// updateAutoGain
// ---------------------------------------------------------------------------
describe('updateAutoGain', () => {
  it('returns the peak value from the current frame', () => {
    const tracker = makeTracker();
    const max = updateAutoGain(tracker, new Float32Array([0.3, 0.7, 0.5]));
    expect(max).toBeCloseTo(0.7);
  });

  it('floors the stored peak at AUTO_GAIN_FLOOR when all bins are zero', () => {
    const tracker = makeTracker();
    const max = updateAutoGain(tracker, new Float32Array(10)); // all zeros
    expect(max).toBeCloseTo(AUTO_GAIN_FLOOR);
  });

  it('returns the rolling max across the window', () => {
    const tracker = makeTracker(4);
    // Fill window with a high value from a previous frame
    tracker.peaks.fill(0.9);
    tracker.idx = 0;
    // New frame has a lower value
    const max = updateAutoGain(tracker, new Float32Array([0.2]));
    expect(max).toBeCloseTo(0.9); // old peak still dominates
  });

  it('advances the circular index on each call', () => {
    const tracker = makeTracker(4);
    updateAutoGain(tracker, new Float32Array([0.5]));
    expect(tracker.idx).toBe(1);
    updateAutoGain(tracker, new Float32Array([0.5]));
    expect(tracker.idx).toBe(2);
  });

  it('wraps the index around the window size', () => {
    const tracker = makeTracker(2);
    updateAutoGain(tracker, new Float32Array([0.5]));
    updateAutoGain(tracker, new Float32Array([0.5]));
    expect(tracker.idx).toBe(0); // wrapped
  });
});

// ---------------------------------------------------------------------------
// applyAutoGain
// ---------------------------------------------------------------------------
describe('applyAutoGain', () => {
  it('normalizes bins to [0, 1] relative to the rolling max', () => {
    // Pre-fill peaks so the rolling max equals 1.0
    const tracker = makeTracker();
    tracker.peaks.fill(1.0);

    const raw = new Float32Array([0.25, 0.5, 0.75]);
    const result = applyAutoGain(raw, tracker);

    expect(result[0]).toBeCloseTo(0.25);
    expect(result[1]).toBeCloseTo(0.5);
    expect(result[2]).toBeCloseTo(0.75);
  });

  it('returns a new Float32Array of the same length as the input', () => {
    const tracker = makeTracker();
    const raw = new Float32Array(7);
    const result = applyAutoGain(raw, tracker);
    expect(result).toBeInstanceOf(Float32Array);
    expect(result.length).toBe(7);
  });

  it('does not mutate the input array', () => {
    const tracker = makeTracker();
    const raw = new Float32Array([0.4, 0.6]);
    const copy = raw.slice();
    applyAutoGain(raw, tracker);
    expect(raw[0]).toBe(copy[0]);
    expect(raw[1]).toBe(copy[1]);
  });
});

// ---------------------------------------------------------------------------
// updateTransient
// ---------------------------------------------------------------------------
describe('updateTransient', () => {
  it('boosts multiplier to TRANSIENT_BOOST when peak far exceeds running average', () => {
    // avg = 0.1, peak = 0.5 → ratio = 5 >> TRANSIENT_THRESHOLD (1.8)
    const state = makeTransientState(0.1, 1.0);
    const result = updateTransient(state, new Float32Array([0.5]), 1.0);
    expect(result).toBeCloseTo(TRANSIENT_BOOST);
  });

  it('does NOT boost multiplier when ratio is below TRANSIENT_THRESHOLD', () => {
    // avg = 0.5, peak = 0.6 → ratio ≈ 1.2 < TRANSIENT_THRESHOLD
    const state = makeTransientState(0.5, 1.0);
    const result = updateTransient(state, new Float32Array([0.6]), 1.0);
    expect(result).toBeCloseTo(1.0);
  });

  it('decays an elevated multiplier toward 1 over time', () => {
    const state = makeTransientState(0.5, 1.5);
    // Peak matches avg → no new boost
    const result = updateTransient(state, new Float32Array([0.5]), 1.0);
    expect(result).toBeGreaterThan(1.0);
    expect(result).toBeLessThan(1.5);
  });

  it('returns exactly 1.0 when multiplier is at baseline and no spike occurs', () => {
    const state = makeTransientState(0.5, 1.0);
    const result = updateTransient(state, new Float32Array([0.5]), 1.0);
    expect(result).toBeCloseTo(1.0);
  });

  it('uses the frame peak (max bin), not the mean', () => {
    // avg is very low; highest bin triggers the transient
    const state = makeTransientState(0.05, 1.0);
    // Only the last bin is high
    const result = updateTransient(state, new Float32Array([0.0, 0.0, 0.4]), 1.0);
    expect(result).toBeCloseTo(TRANSIENT_BOOST);
  });

  it('does not boost when signal is consistently quiet (avg stays below AUTO_GAIN_FLOOR)', () => {
    // avg=0, framePeak=0.001 → after EWMA: avg ≈ 5e-5 < AUTO_GAIN_FLOOR (0.01) → no boost
    const state = makeTransientState(0, 1.0);
    const result = updateTransient(state, new Float32Array([0.001]), 1.0);
    expect(result).toBeCloseTo(1.0);
  });
});

// ---------------------------------------------------------------------------
// computeDelta
// ---------------------------------------------------------------------------
describe('computeDelta', () => {
  it('returns a positive value when amplitude is rising', () => {
    const state = makeDeltaState(0.1, 0);
    const result = computeDelta(state, new Float32Array([0.8, 0.9, 0.7]), 1.0);
    expect(result).toBeGreaterThan(0);
  });

  it('returns 0 when amplitude is falling (rawDelta clamped to 0)', () => {
    const state = makeDeltaState(0.9, 0); // high previous mean
    const result = computeDelta(state, new Float32Array([0.1, 0.1, 0.1]), 1.0);
    expect(result).toBeCloseTo(0, 5);
  });

  it('clamps output to 1.0', () => {
    // smoothed is already 1.0 and rising fast
    const state = makeDeltaState(0, 0.25);
    const result = computeDelta(state, new Float32Array([1.0, 1.0, 1.0]), 1.0);
    expect(result).toBeLessThanOrEqual(1.0);
  });

  it('updates prevMean to the current frame mean', () => {
    const state = makeDeltaState(0, 0);
    computeDelta(state, new Float32Array([0.6, 0.4]), 1.0); // mean = 0.5
    expect(state.prevMean).toBeCloseTo(0.5);
  });
});

// ---------------------------------------------------------------------------
// smoothBins
// ---------------------------------------------------------------------------
describe('smoothBins', () => {
  it('moves toward the target * sensitivity on the attack path', () => {
    const smoothed = new Float32Array([0.0]);
    smoothBins(smoothed, new Float32Array([1.0]), 1.0, 0.9, 0.1, 1.0);
    // attack rate 0.9 at dt=1 → adjRate ≈ 0.9; smoothed ≈ 0 + (1 - 0) * 0.9 = 0.9
    expect(smoothed[0]).toBeCloseTo(0.9, 1);
  });

  it('moves toward the target more slowly on the release path', () => {
    const smoothed = new Float32Array([1.0]);
    smoothBins(smoothed, new Float32Array([0.0]), 1.0, 0.9, 0.1, 1.0);
    // release rate 0.1 at dt=1 → smoothed ≈ 1 + (0 - 1) * 0.1 = 0.9
    expect(smoothed[0]).toBeCloseTo(0.9, 1);
    expect(smoothed[0]).toBeLessThan(1.0);
  });

  it('applies sensitivity as a multiplier on the target', () => {
    const smoothed = new Float32Array([0.0]);
    // sensitivity 2 → target = 0.5 * 2 = 1.0; attack=1.0 → instantaneous
    smoothBins(smoothed, new Float32Array([0.5]), 2.0, 1.0, 0.1, 1.0);
    expect(smoothed[0]).toBeCloseTo(1.0);
  });

  it('processes all bins independently', () => {
    const smoothed = new Float32Array([0.0, 0.0, 0.0]);
    smoothBins(smoothed, new Float32Array([0.2, 0.5, 0.8]), 1.0, 1.0, 0.1, 1.0);
    expect(smoothed[0]).toBeCloseTo(0.2);
    expect(smoothed[1]).toBeCloseTo(0.5);
    expect(smoothed[2]).toBeCloseTo(0.8);
  });

  it('modifies the smoothed array in place', () => {
    const smoothed = new Float32Array([0.5]);
    const ref = smoothed; // same reference
    smoothBins(smoothed, new Float32Array([1.0]), 1.0, 0.5, 0.1, 1.0);
    expect(smoothed).toBe(ref);
  });
});
