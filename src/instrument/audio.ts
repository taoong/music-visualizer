/**
 * Wobble — thin audio adapter over the existing Tone.js engine + analysis.
 *
 * Reuses the exact same per-frame accessor pattern as src/main.ts:
 * engine.getFreqFFT() -> getLogBandAmplitudes -> applyAutoGain ->
 * updateTransient -> smoothBandBins. Beat phase comes from the store's
 * detected BPM + playback position (same formula the visualizations use).
 */
import { audioEngine } from '../audio/engine';
import { store } from '../state/store';
import { getLogBandAmplitudes, computeSpectralCentroid } from '../audio/fft';
import { applyAutoGain, updateTransient } from '../audio/processing';
import { computeDecayFactor, decayFreqBands, smoothBandBins } from '../audio/pipeline';
import { detectBPMWithFallback } from '../audio/bpm';
import {
  BANDS,
  BAND_COUNT,
  CENTROID_LOW_HZ,
  CENTROID_HIGH_HZ,
  CENTROID_LOG_LOW,
  CENTROID_LOG_RANGE,
  CENTROID_SMOOTHING,
  TRANSIENT_BOOST,
} from '../utils/constants';

export interface AudioFrame {
  /** 7 smoothed band amplitudes, 0..1 */
  bands: number[];
  /** true on the frame a new beat lands */
  beat: boolean;
  /** 0..1 position within the current beat */
  beatPhase: number;
  /** detected BPM (0 when unknown) */
  bpm: number;
  /** 0..1 transient energy */
  transient: number;
  /** 0..1 normalized spectral centroid */
  centroid: number;
}

let lastBeatIndex = -1;
const tapTimes: number[] = [];

export function resetBeatTracking(): void {
  lastBeatIndex = -1;
}

export async function loadTrackFile(file: File): Promise<void> {
  resetBeatTracking();
  store.setMode('freq');
  await audioEngine.initFreqMode(file);
  const bpmData = await detectBPMWithFallback(file, audioEngine.getAudioBuffer());
  if (bpmData) store.setBPM(bpmData);
}

export async function loadSampleTrack(): Promise<void> {
  resetBeatTracking();
  store.setMode('freq');
  await audioEngine.initFreqMode('sample.mp3');
  const bpmData = await detectBPMWithFallback('sample.mp3', audioEngine.getAudioBuffer());
  if (bpmData) store.setBPM(bpmData);
}

export async function openMic(): Promise<void> {
  resetBeatTracking();
  store.setMode('mic');
  await audioEngine.initMicMode();
}

/** Toggle playback. Returns the new playing state. */
export function togglePlay(): boolean {
  if (store.state.isPlaying) {
    audioEngine.stop();
    return false;
  }
  audioEngine.start();
  return true;
}

/** Manual tap tempo — useful for mic mode where there is no BPM detection. */
export function tapTempo(): number {
  const now = performance.now();
  tapTimes.push(now);
  while (tapTimes.length > 8) tapTimes.shift();
  if (tapTimes.length < 3) return store.state.detectedBPM;
  const intervals: number[] = [];
  for (let i = 1; i < tapTimes.length; i++) intervals.push(tapTimes[i] - tapTimes[i - 1]);
  const avg = intervals.reduce((a, b) => a + b, 0) / intervals.length;
  const bpm = Math.round(60000 / avg);
  if (bpm >= 40 && bpm <= 240) {
    store.setBPM({ bpm, beatOffset: 0 });
    resetBeatTracking();
  }
  return store.state.detectedBPM;
}

/**
 * Sample one frame of audio analysis. `dt` is normalized to 60fps units
 * (i.e. ms elapsed / 16.667), matching the main app's convention.
 */
export function sampleAudioFrame(dt: number): AudioFrame {
  const { audioState, config, state } = store;
  const fft = audioEngine.getFreqFFT();
  const bands = new Array<number>(BAND_COUNT).fill(0);
  let transient = 0;

  const active = !!fft && (state.isPlaying || (state.mode === 'mic' && state.audioReady));

  if (active && fft) {
    const rawBands = getLogBandAmplitudes(fft);
    const decayFactor = computeDecayFactor();
    let peakTransient = 1;
    for (let b = 0; b < BAND_COUNT; b++) {
      const band = BANDS[b];
      const raw = applyAutoGain(rawBands[b], audioState.autoGainBands[b]);
      const tv = updateTransient(audioState.transientBands[b], raw, dt);
      if (tv > peakTransient) peakTransient = tv;
      smoothBandBins(
        audioState.smoothedBands[b],
        raw,
        config[band.sens as keyof typeof config] as number,
        band.attack,
        band.release,
        decayFactor,
        dt,
      );
      const sb = audioState.smoothedBands[b];
      let sum = 0;
      for (let i = 0; i < sb.length; i++) sum += sb[i];
      bands[b] = Math.min(1, sum / sb.length);
    }
    transient = Math.min(1, Math.max(0, (peakTransient - 1) / (TRANSIENT_BOOST - 1)));

    const cHz = computeSpectralCentroid(fft);
    const clamped = Math.max(CENTROID_LOW_HZ, Math.min(cHz, CENTROID_HIGH_HZ));
    const norm = (Math.log(clamped) - CENTROID_LOG_LOW) / CENTROID_LOG_RANGE;
    audioState.smoothedCentroid += (norm - audioState.smoothedCentroid) * CENTROID_SMOOTHING;
  } else {
    decayFreqBands(dt);
  }

  let beat = false;
  let beatPhase = 0;
  const bpm = state.detectedBPM;
  if (state.beatIntervalSec > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const rel = (pos - state.beatOffset) / state.beatIntervalSec;
    const idx = Math.floor(rel);
    if (idx > lastBeatIndex && lastBeatIndex >= 0) beat = true;
    lastBeatIndex = idx;
    beatPhase = rel - Math.floor(rel);
    if (beatPhase < 0) beatPhase += 1;
  }

  return {
    bands,
    beat,
    beatPhase,
    bpm,
    transient,
    centroid: Math.max(0, Math.min(1, audioState.smoothedCentroid)),
  };
}
