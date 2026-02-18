/**
 * Music Visualizer - Main Application Entry Point
 *
 * Refactored from monolithic sketch.js to modular TypeScript architecture:
 * - State management via centralized store
 * - Audio processing separated from visualization
 * - TypeScript for type safety and better maintainability
 * - Error handling and user feedback
 * - Accessibility features including keyboard shortcuts
 */

import { store } from './state/store';
import { audioEngine } from './audio/engine';
import {
  getLogBandAmplitudes,
  getFFTAmplitudes,
  getOctaveAmplitudes,
  getOctaveAmplitudesFromStems,
  computeSpectralCentroid,
  computeStemCentroid,
} from './audio/fft';
import { smoothBins, updateTransient, computeDelta, applyAutoGain } from './audio/processing';
import { drawSpikeCircle, drawSpectrum, drawTunnel, drawBalls, initBalls } from './visualizations';
import { initUI, updateScrubberUI } from './ui/controller';
import { initKeyboardShortcuts, announceToScreenReader } from './ui/keyboard';
import { showError } from './utils/errors';
import {
  BANDS,
  BAND_COUNT,
  STEMS,
  SPIKES_PER_BAND,
  TRANSIENT_DECAY,
  DELTA_RELEASE,
  CENTROID_LOG_LOW,
  CENTROID_LOG_RANGE,
  CENTROID_SMOOTHING,
  OCTAVE_COUNT,
} from './utils/constants';

// Global p5 instance reference
declare global {
  interface Window {
    p5Instance: P5Instance;
  }
}

/**
 * Main p5.js sketch
 */
const sketch = (p: P5Instance) => {
  // Expose p5 instance globally for visualization modules
  window.p5Instance = p;

  p.setup = () => {
    const canvas = p.createCanvas(window.innerWidth, window.innerHeight);
    canvas.parent('canvas-container');
    p.pixelDensity(1);

    const isMobile =
      /Android|iPhone|iPad|iPod|webOS/i.test(navigator.userAgent) ||
      (navigator.maxTouchPoints > 1 && window.innerWidth < 1024);

    if (isMobile) {
      p.frameRate(30);
    }

    // Initialize UI and keyboard shortcuts
    const cleanupUI = initUI();
    const cleanupKeyboard = initKeyboardShortcuts();

    // Cleanup on page unload
    window.addEventListener('beforeunload', () => {
      cleanupUI();
      cleanupKeyboard();
      audioEngine.disposeAll();
    });

    // Announce ready to screen readers
    announceToScreenReader(
      'Music Visualizer loaded. Press space to play, or ? for keyboard shortcuts.'
    );
  };

  p.draw = () => {
    p.background(0);
    const dt = p.deltaTime / 16.667; // normalize to 60fps reference

    // Process audio based on mode
    const isFreqMode = store.state.mode === 'freq';
    if (isFreqMode) {
      processFreqMode(p, dt);
    } else {
      processStemMode(p, dt);
    }

    // Update UI
    updateScrubberUI();

    // Render visualization
    switch (store.state.vizMode) {
      case 'tunnel':
        drawTunnel(p);
        break;
      case 'spectrum':
        drawSpectrum(p);
        break;
      case 'balls':
        drawBalls(p, dt);
        break;
      case 'circle':
      default:
        drawSpikeCircle(p);
        break;
    }
  };

  p.windowResized = () => {
    p.resizeCanvas(window.innerWidth, window.innerHeight);
    if (store.state.vizMode === 'balls') {
      initBalls(p);
    }
  };
};

/**
 * Process audio in frequency mode
 */
function processFreqMode(_p: P5Instance, dt: number): void {
  const fft = audioEngine.getFreqFFT();
  if (!fft) return;

  const { state, config, audioState } = store;

  if (state.isPlaying) {
    // Analyze frequency bands
    const rawBands = getLogBandAmplitudes(fft);

    // Scale release by decay rate using cubed ratio for dramatic effect:
    // at default (0.88) factor=1, at 0.5 factor≈72 (instant snap), at 0.99 factor≈0.0005 (spikes linger)
    const decayFactor = ((1 - config.decayRate) / (1 - 0.88)) ** 3;

    for (let b = 0; b < BAND_COUNT; b++) {
      const band = BANDS[b];
      const raw = applyAutoGain(rawBands[b], audioState.autoGainBands[b]);

      // Update transient and delta
      audioState.transientValues[b] = updateTransient(audioState.transientBands[b], raw, dt);
      audioState.deltaValues[b] = computeDelta(audioState.deltaBands[b], raw, dt);

      // Smooth bins with decay-scaled release
      const scaledRelease = Math.min(band.release * decayFactor, 0.99);
      smoothBins(
        audioState.smoothedBands[b],
        raw,
        config[band.sens as keyof typeof config] as number,
        band.attack,
        scaledRelease,
        dt
      );
    }

    // Update spectral centroid
    const centroid = computeSpectralCentroid(fft);
    updateCentroid(centroid);

    // Process octave data for tunnel mode
    if (state.vizMode === 'tunnel') {
      const rawOct = applyAutoGain(getOctaveAmplitudes(fft), audioState.autoGainOctaves);

      for (let o = 0; o < OCTAVE_COUNT; o++) {
        audioState.octaveTransientValues[o] = updateTransient(
          audioState.octaveTransients[o],
          new Float32Array([rawOct[o]]),
          dt
        );
        audioState.octaveDeltaValues[o] = computeDelta(
          audioState.octaveDeltas[o],
          new Float32Array([rawOct[o]]),
          dt
        );
        const scaledOctaveSmoothing = Math.min(0.55 * decayFactor, 0.99);
        audioState.smoothedOctaves[o] +=
          (rawOct[o] * config.spikeScale - audioState.smoothedOctaves[o]) *
          (1 - Math.pow(1 - scaledOctaveSmoothing, dt));
      }
    }
  } else {
    // Decay when not playing
    decayAudioState(dt);
  }
}

/**
 * Process audio in stem mode
 */
function processStemMode(_p: P5Instance, dt: number): void {
  const stemFfts = audioEngine.getStemFFTs();
  if (!stemFfts) return;

  const { state, config, audioState } = store;
  const stemSmoothed = audioEngine.getStemSmoothed();

  const anyPlaying = state.isPlaying && stemFfts.kick !== undefined;

  if (anyPlaying) {
    // Scale release by decay rate using cubed ratio for dramatic effect:
    // at default (0.88) factor=1, at 0.5 factor≈72 (instant snap), at 0.99 factor≈0.0005 (spikes linger)
    const decayFactor = ((1 - config.decayRate) / (1 - 0.88)) ** 3;

    for (const stem of STEMS) {
      if (!stemFfts[stem] || !stemSmoothed?.[stem]) continue;

      // Initialize tracking structures if needed
      if (!audioState.autoGainStems[stem]) {
        audioState.autoGainStems[stem] = {
          peaks: new Float32Array(300).fill(0.01),
          idx: 0,
        };
      }
      if (!audioState.transientStems[stem]) {
        audioState.transientStems[stem] = { avg: 0, multiplier: 1.0 };
      }
      if (!audioState.deltaStems[stem]) {
        audioState.deltaStems[stem] = { prevMean: 0, smoothed: 0 };
      }

      // Get stem-specific FFT amplitudes
      const raw = applyAutoGain(
        getFFTAmplitudes(stemFfts[stem], SPIKES_PER_BAND, 10.0),
        audioState.autoGainStems[stem]
      );

      // Update transient and delta
      audioState.transientStems[stem].multiplier = updateTransient(
        audioState.transientStems[stem],
        raw,
        dt
      );
      if (!audioState.deltaStems[stem]) {
        audioState.deltaStems[stem] = { prevMean: 0, smoothed: 0 };
      }
      audioState.deltaStems[stem].smoothed = computeDelta(audioState.deltaStems[stem], raw, dt);

      // Get sensitivity and smoothing parameters
      const sensKey = `sens${stem.charAt(0).toUpperCase() + stem.slice(1)}` as keyof typeof config;
      const smoothing: Record<string, [number, number]> = {
        kick: [0.9, 0.06],
        drums: [0.85, 0.08],
        bass: [0.75, 0.1],
        vocals: [0.78, 0.12],
        other: [0.8, 0.14],
      };
      const [attack, release] = smoothing[stem];

      // Smooth bins with decay-scaled release
      const scaledRelease = Math.min(release * decayFactor, 0.99);
      smoothBins(stemSmoothed[stem], raw, config[sensKey] as number, attack, scaledRelease, dt);
    }

    // Update spectral centroid from stems
    const centroid = computeStemCentroid(stemFfts, STEMS);
    updateCentroid(centroid);

    // Process octave data for tunnel mode
    if (state.vizMode === 'tunnel') {
      const rawOct = applyAutoGain(
        getOctaveAmplitudesFromStems(stemFfts, STEMS),
        audioState.autoGainOctaves
      );

      for (let o = 0; o < OCTAVE_COUNT; o++) {
        audioState.octaveTransientValues[o] = updateTransient(
          audioState.octaveTransients[o],
          new Float32Array([rawOct[o]]),
          dt
        );
        audioState.octaveDeltaValues[o] = computeDelta(
          audioState.octaveDeltas[o],
          new Float32Array([rawOct[o]]),
          dt
        );
        const scaledOctaveSmoothing = Math.min(0.55 * decayFactor, 0.99);
        audioState.smoothedOctaves[o] +=
          (rawOct[o] * config.spikeScale - audioState.smoothedOctaves[o]) *
          (1 - Math.pow(1 - scaledOctaveSmoothing, dt));
      }
    }
  } else {
    // Decay when not playing
    decayStemState(dt);
  }
}

/**
 * Update spectral centroid
 */
function updateCentroid(centroidHz: number): void {
  const { audioState } = store;
  const clampedHz = Math.max(80, Math.min(centroidHz, 8000));
  const normalized = (Math.log(clampedHz) - CENTROID_LOG_LOW) / CENTROID_LOG_RANGE;
  audioState.smoothedCentroid += (normalized - audioState.smoothedCentroid) * CENTROID_SMOOTHING;
  audioState.centroidYOffset = 0;
}

/**
 * Decay audio state when not playing (freq mode)
 */
function decayAudioState(dt: number): void {
  const { audioState, config } = store;

  for (let b = 0; b < BAND_COUNT; b++) {
    for (let i = 0; i < SPIKES_PER_BAND; i++) {
      audioState.smoothedBands[b][i] *= Math.pow(config.decayRate, dt);
    }
    audioState.transientValues[b] =
      1.0 + (audioState.transientValues[b] - 1.0) * Math.pow(TRANSIENT_DECAY, dt);
    audioState.deltaValues[b] *= Math.pow(DELTA_RELEASE, dt);
  }

  if (store.state.vizMode === 'tunnel') {
    for (let o = 0; o < OCTAVE_COUNT; o++) {
      audioState.smoothedOctaves[o] *= Math.pow(config.decayRate, dt);
      audioState.octaveTransientValues[o] =
        1.0 + (audioState.octaveTransientValues[o] - 1.0) * Math.pow(TRANSIENT_DECAY, dt);
      audioState.octaveDeltaValues[o] *= Math.pow(DELTA_RELEASE, dt);
    }
  }
}

/**
 * Decay stem audio state when not playing
 */
function decayStemState(dt: number): void {
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

  if (store.state.vizMode === 'tunnel') {
    for (let o = 0; o < OCTAVE_COUNT; o++) {
      audioState.smoothedOctaves[o] *= Math.pow(config.decayRate, dt);
      audioState.octaveTransientValues[o] =
        1.0 + (audioState.octaveTransientValues[o] - 1.0) * Math.pow(TRANSIENT_DECAY, dt);
      audioState.octaveDeltaValues[o] *= Math.pow(DELTA_RELEASE, dt);
    }
  }
}

/**
 * Initialize the application
 */
function init(): void {
  try {
    new p5(sketch);
  } catch (err) {
    console.error('Failed to initialize Music Visualizer:', err);
    showError('Failed to initialize the visualizer. Please refresh the page.');
  }
}

// Start the application
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
