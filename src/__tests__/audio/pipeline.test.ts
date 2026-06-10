/**
 * Unit tests for audio/pipeline.ts
 * Functions that read/write store state are tested via a mocked store.
 */

const { mockConfig, mockAudioState } = vi.hoisted(() => ({
  mockConfig: { decayRate: 0.88, spikeScale: 1.2 },
  mockAudioState: {
    smoothedBands:          Array(7).fill(null).map(() => new Float32Array(60).fill(0.5)),
    transientValues:        new Float32Array(7).fill(1.5),
    deltaValues:            new Float32Array(7).fill(0.3),
    smoothedOctaves:        new Float32Array(10).fill(0.5),
    octaveTransientValues:  new Float32Array(10).fill(1.5),
    octaveDeltaValues:      new Float32Array(10).fill(0.3),
    octaveTransients:       Array(10).fill(null).map(() => ({ avg: 0.3, multiplier: 1.5 })),
    octaveDeltas:           Array(10).fill(null).map(() => ({ prevMean: 0.3, smoothed: 0.3 })),
  },
}));

vi.mock('../../state/store', () => ({ store: { config: mockConfig, audioState: mockAudioState } }));

import {
  computeDecayFactor,
  smoothBandBins,
  decayFreqBands,
  decayOctaveState,
} from '../../audio/pipeline';
import {
  DELTA_RELEASE,
  SPIKES_PER_BAND,
  BAND_COUNT,
  OCTAVE_COUNT,
  DECAY_RATE_BASELINE,
  DECAY_RATE_EXPONENT,
} from '../../utils/constants';

// ---------------------------------------------------------------------------
// Reset mutable mock state before each test
// ---------------------------------------------------------------------------
beforeEach(() => {
  mockConfig.decayRate = 0.88;
  mockConfig.spikeScale = 1.2;
  for (let b = 0; b < BAND_COUNT; b++) {
    mockAudioState.smoothedBands[b].fill(0.5);
    mockAudioState.transientValues[b] = 1.5;
    mockAudioState.deltaValues[b] = 0.3;
  }
  for (let o = 0; o < OCTAVE_COUNT; o++) {
    mockAudioState.smoothedOctaves[o] = 0.5;
    mockAudioState.octaveTransientValues[o] = 1.5;
    mockAudioState.octaveDeltaValues[o] = 0.3;
  }
});

// ---------------------------------------------------------------------------
// computeDecayFactor
// ---------------------------------------------------------------------------
describe('computeDecayFactor', () => {
  it('returns 1.0 at the baseline decay rate (0.88)', () => {
    mockConfig.decayRate = DECAY_RATE_BASELINE;
    expect(computeDecayFactor()).toBeCloseTo(1.0);
  });

  it('returns less than 1 when decayRate is above baseline (slower decay)', () => {
    mockConfig.decayRate = 0.94;
    const factor = computeDecayFactor();
    expect(factor).toBeLessThan(1.0);
  });

  it('returns greater than 1 when decayRate is below baseline (faster decay)', () => {
    mockConfig.decayRate = 0.76;
    const factor = computeDecayFactor();
    expect(factor).toBeGreaterThan(1.0);
  });

  it('is exactly ((1 - rate) / (1 - baseline))^exponent', () => {
    mockConfig.decayRate = 0.76;
    const expected = ((1 - 0.76) / (1 - DECAY_RATE_BASELINE)) ** DECAY_RATE_EXPONENT;
    expect(computeDecayFactor()).toBeCloseTo(expected);
  });
});

// ---------------------------------------------------------------------------
// smoothBandBins
// ---------------------------------------------------------------------------
describe('smoothBandBins', () => {
  it('on the release path, higher decayFactor decays faster', () => {
    const smoothed1 = new Float32Array([0.8]);
    const smoothed2 = new Float32Array([0.8]);
    const raw = new Float32Array([0.0]); // target < current → release path

    smoothBandBins(smoothed1, raw, 1.0, 0.5, 0.1, 1.0, 1.0); // factor=1
    smoothBandBins(smoothed2, raw, 1.0, 0.5, 0.1, 2.0, 1.0); // factor=2 → faster

    expect(smoothed2[0]).toBeLessThan(smoothed1[0]);
  });

  it('caps scaled release at 0.99', () => {
    // release=0.8, decayFactor=2 → would be 1.6, must cap at 0.99
    const smoothed = new Float32Array([1.0]);
    const raw = new Float32Array([0.0]);
    smoothBandBins(smoothed, raw, 1.0, 0.5, 0.8, 2.0, 1.0);
    // At release=0.99, dt=1: smoothed ≈ 1 + (0 - 1) * 0.99 = 0.01
    expect(smoothed[0]).toBeGreaterThanOrEqual(0);
    expect(smoothed[0]).toBeLessThan(0.1);
  });

  it('on the attack path, moves toward target', () => {
    const smoothed = new Float32Array([0.0]);
    const raw = new Float32Array([1.0]);
    smoothBandBins(smoothed, raw, 1.0, 0.9, 0.1, 1.0, 1.0);
    expect(smoothed[0]).toBeGreaterThan(0.5); // fast attack
  });
});

// ---------------------------------------------------------------------------
// decayFreqBands
// ---------------------------------------------------------------------------
describe('decayFreqBands', () => {
  it('multiplies smoothedBands by decayRate^dt', () => {
    mockConfig.decayRate = 0.8;
    const before = mockAudioState.smoothedBands[0][0]; // 0.5

    decayFreqBands(1.0);

    expect(mockAudioState.smoothedBands[0][0]).toBeCloseTo(before * 0.8);
  });

  it('decays all bands and all spikes', () => {
    mockConfig.decayRate = 0.9;
    decayFreqBands(1.0);

    for (let b = 0; b < BAND_COUNT; b++) {
      for (let i = 0; i < SPIKES_PER_BAND; i++) {
        expect(mockAudioState.smoothedBands[b][i]).toBeCloseTo(0.5 * 0.9);
      }
    }
  });

  it('decays transientValues toward 1', () => {
    // Initial 1.5, should decrease toward 1
    decayFreqBands(1.0);
    for (let b = 0; b < BAND_COUNT; b++) {
      expect(mockAudioState.transientValues[b]).toBeGreaterThan(1.0);
      expect(mockAudioState.transientValues[b]).toBeLessThan(1.5);
    }
  });

  it('decays deltaValues', () => {
    decayFreqBands(1.0);
    for (let b = 0; b < BAND_COUNT; b++) {
      expect(mockAudioState.deltaValues[b]).toBeCloseTo(0.3 * Math.pow(DELTA_RELEASE, 1.0));
    }
  });
});

// ---------------------------------------------------------------------------
// decayOctaveState
// ---------------------------------------------------------------------------
describe('decayOctaveState', () => {
  it('multiplies smoothedOctaves by decayRate^dt', () => {
    mockConfig.decayRate = 0.85;
    decayOctaveState(1.0);

    for (let o = 0; o < OCTAVE_COUNT; o++) {
      expect(mockAudioState.smoothedOctaves[o]).toBeCloseTo(0.5 * 0.85);
    }
  });

  it('decays octaveTransientValues toward 1', () => {
    decayOctaveState(1.0);
    for (let o = 0; o < OCTAVE_COUNT; o++) {
      expect(mockAudioState.octaveTransientValues[o]).toBeGreaterThan(1.0);
      expect(mockAudioState.octaveTransientValues[o]).toBeLessThan(1.5);
    }
  });

  it('decays octaveDeltaValues by DELTA_RELEASE^dt', () => {
    decayOctaveState(1.0);
    for (let o = 0; o < OCTAVE_COUNT; o++) {
      expect(mockAudioState.octaveDeltaValues[o]).toBeCloseTo(0.3 * Math.pow(DELTA_RELEASE, 1.0));
    }
  });

  it('uses dt to scale the decay', () => {
    const dt = 2.0;
    decayOctaveState(dt);
    expect(mockAudioState.smoothedOctaves[0]).toBeCloseTo(0.5 * Math.pow(0.88, dt));
  });
});
