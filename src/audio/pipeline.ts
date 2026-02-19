/**
 * Shared audio processing pipeline helpers
 */
import { store } from '../state/store';
import { audioEngine } from './engine';
import { updateTransient, computeDelta, smoothBins } from './processing';
import {
  OCTAVE_COUNT,
  SPIKES_PER_BAND,
  TRANSIENT_DECAY,
  DELTA_RELEASE,
  BAND_COUNT,
  DECAY_RATE_BASELINE,
  DECAY_RATE_EXPONENT,
} from '../utils/constants';

// Pre-allocated reusable buffer for single-value Float32Array operations in the render loop
const _singleValBuf = new Float32Array(1);

/**
 * Compute the decay factor from the current decay rate config
 */
export function computeDecayFactor(): number {
  return ((1 - store.config.decayRate) / (1 - DECAY_RATE_BASELINE)) ** DECAY_RATE_EXPONENT;
}

/**
 * Process octave data for tunnel mode
 */
export function processOctaveData(rawOct: Float32Array, decayFactor: number, dt: number): void {
  const { audioState, config } = store;

  for (let o = 0; o < OCTAVE_COUNT; o++) {
    _singleValBuf[0] = rawOct[o];
    audioState.octaveTransientValues[o] = updateTransient(
      audioState.octaveTransients[o],
      _singleValBuf,
      dt
    );
    _singleValBuf[0] = rawOct[o];
    audioState.octaveDeltaValues[o] = computeDelta(
      audioState.octaveDeltas[o],
      _singleValBuf,
      dt
    );
    const scaledOctaveSmoothing = Math.min(0.55 * decayFactor, 0.99);
    audioState.smoothedOctaves[o] +=
      (rawOct[o] * config.spikeScale - audioState.smoothedOctaves[o]) *
      (1 - Math.pow(1 - scaledOctaveSmoothing, dt));
  }
}

/**
 * Decay octave state when not playing
 */
export function decayOctaveState(dt: number): void {
  const { audioState, config } = store;

  for (let o = 0; o < OCTAVE_COUNT; o++) {
    audioState.smoothedOctaves[o] *= Math.pow(config.decayRate, dt);
    audioState.octaveTransientValues[o] =
      1.0 + (audioState.octaveTransientValues[o] - 1.0) * Math.pow(TRANSIENT_DECAY, dt);
    audioState.octaveDeltaValues[o] *= Math.pow(DELTA_RELEASE, dt);
  }
}

/**
 * Decay band-smoothed data (freq mode)
 */
export function decayFreqBands(dt: number): void {
  const { audioState, config } = store;

  for (let b = 0; b < BAND_COUNT; b++) {
    for (let i = 0; i < SPIKES_PER_BAND; i++) {
      audioState.smoothedBands[b][i] *= Math.pow(config.decayRate, dt);
    }
    audioState.transientValues[b] =
      1.0 + (audioState.transientValues[b] - 1.0) * Math.pow(TRANSIENT_DECAY, dt);
    audioState.deltaValues[b] *= Math.pow(DELTA_RELEASE, dt);
  }
}

/**
 * Decay stem-smoothed data
 */
export function decayStemBands(dt: number): void {
  const { audioState, config } = store;
  const stemSmoothed = audioEngine.getStemSmoothed();

  if (stemSmoothed) {
    for (const stem of Object.keys(stemSmoothed)) {
      for (let i = 0; i < SPIKES_PER_BAND; i++) {
        stemSmoothed[stem][i] *= Math.pow(config.decayRate, dt);
      }

      if (audioState.transientStems[stem]) {
        audioState.transientStems[stem].multiplier =
          1.0 + (audioState.transientStems[stem].multiplier - 1.0) * Math.pow(TRANSIENT_DECAY, dt);
      }
      if (audioState.deltaStems[stem]) {
        audioState.deltaStems[stem].smoothed *= Math.pow(DELTA_RELEASE, dt);
      }
    }
  }
}

/**
 * Smooth band bins with decay-scaled release
 */
export function smoothBandBins(
  smoothed: Float32Array,
  raw: Float32Array,
  sensitivity: number,
  attack: number,
  release: number,
  decayFactor: number,
  dt: number,
): void {
  const scaledRelease = Math.min(release * decayFactor, 0.99);
  smoothBins(smoothed, raw, sensitivity, attack, scaledRelease, dt);
}
