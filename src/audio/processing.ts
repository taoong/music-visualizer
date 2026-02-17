/**
 * Audio processing utilities
 */
import type { AutoGainTracker, TransientState, DeltaState } from "../types";
import {
  AUTO_GAIN_FLOOR,
  TRANSIENT_AVG_ALPHA,
  TRANSIENT_THRESHOLD,
  TRANSIENT_BOOST,
  DELTA_ATTACK,
  DELTA_RELEASE,
} from "../utils/constants";

/**
 * Update auto-gain tracker with new frame peak
 */
export function updateAutoGain(
  tracker: AutoGainTracker,
  rawBins: Float32Array,
): number {
  let framePeak = 0;
  for (let i = 0; i < rawBins.length; i++) {
    if (rawBins[i] > framePeak) framePeak = rawBins[i];
  }
  tracker.peaks[tracker.idx] = Math.max(framePeak, AUTO_GAIN_FLOOR);
  tracker.idx = (tracker.idx + 1) % tracker.peaks.length;

  let rollingMax = 0;
  for (let i = 0; i < tracker.peaks.length; i++) {
    if (tracker.peaks[i] > rollingMax) rollingMax = tracker.peaks[i];
  }
  return rollingMax;
}

/**
 * Apply auto-gain normalization to raw FFT bins
 */
export function applyAutoGain(
  rawBins: Float32Array,
  tracker: AutoGainTracker,
): Float32Array {
  const rollingMax = updateAutoGain(tracker, rawBins);
  const result = new Float32Array(rawBins.length);
  for (let i = 0; i < rawBins.length; i++) {
    result[i] = rawBins[i] / rollingMax;
  }
  return result;
}

/**
 * Update transient detection state
 */
export function updateTransient(
  state: TransientState,
  rawBins: Float32Array,
  dt: number,
): number {
  let framePeak = 0;
  for (let i = 0; i < rawBins.length; i++) {
    if (rawBins[i] > framePeak) framePeak = rawBins[i];
  }

  state.avg +=
    (framePeak - state.avg) * (1 - Math.pow(1 - TRANSIENT_AVG_ALPHA, dt));

  if (
    state.avg > AUTO_GAIN_FLOOR &&
    framePeak / state.avg > TRANSIENT_THRESHOLD
  ) {
    state.multiplier = TRANSIENT_BOOST;
  } else {
    state.multiplier = 1.0 + (state.multiplier - 1.0) * Math.pow(0.85, dt);
  }

  return state.multiplier;
}

/**
 * Compute delta (rate of change) for audio bins
 */
export function computeDelta(
  state: DeltaState,
  rawBins: Float32Array,
  dt: number,
): number {
  let sum = 0;
  for (let i = 0; i < rawBins.length; i++) sum += rawBins[i];
  const currentMean = sum / rawBins.length;

  const rawDelta = Math.max(0, currentMean - state.prevMean);
  state.prevMean = currentMean;

  const alpha = rawDelta > state.smoothed ? DELTA_ATTACK : DELTA_RELEASE;
  const adjAlpha = 1 - Math.pow(1 - alpha, dt);
  state.smoothed += (rawDelta - state.smoothed) * adjAlpha;

  return Math.min(state.smoothed * 4, 1.0);
}

/**
 * Smooth FFT bins with attack/release envelope
 */
export function smoothBins(
  smoothed: Float32Array,
  raw: Float32Array,
  sensitivity: number,
  attack: number,
  release: number,
  dt: number,
): void {
  for (let i = 0; i < smoothed.length; i++) {
    const target = raw[i] * sensitivity;
    const rate = target > smoothed[i] ? attack : release;
    const adjRate = 1 - Math.pow(1 - rate, dt);
    smoothed[i] += (target - smoothed[i]) * adjRate;
  }
}
