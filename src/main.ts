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
  getOctaveAmplitudes,
  computeSpectralCentroid,
} from './audio/fft';
import { updateTransient, computeDelta, applyAutoGain } from './audio/processing';
import { processInteractiveAudio } from './audio/interactiveSynth';
import {
  computeDecayFactor,
  processOctaveData,
  decayOctaveState,
  decayFreqBands,
  smoothBandBins,
} from './audio/pipeline';
import { VIZ_REGISTRY, loadUserImage } from './visualizations';
import { initUI, updateScrubberUI } from './ui/controller';
import { initKeyboardShortcuts, initSwipeGestures, announceToScreenReader } from './ui/keyboard';
import { initInteraction } from './ui/interaction';
import { showError } from './utils/errors';
import {
  BANDS,
  BAND_COUNT,
  CENTROID_LOW_HZ,
  CENTROID_HIGH_HZ,
  CENTROID_LOG_LOW,
  CENTROID_LOG_RANGE,
  CENTROID_SMOOTHING,
  isMobile,
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

    if (isMobile) {
      p.frameRate(30);
    }

    // Initialize UI, keyboard shortcuts, swipe gestures, and interactive mode
    const cleanupUI = initUI();
    const cleanupKeyboard = initKeyboardShortcuts();
    const cleanupSwipe = initSwipeGestures();
    const cleanupInteraction = initInteraction(p.drawingContext.canvas);

    // Reset highway state when a new track is loaded
    const unsubAudioReady = store.on('audioReady', () => {
      VIZ_REGISTRY.highway.reset?.();
    });

    // Cleanup on page unload
    window.addEventListener('beforeunload', () => {
      unsubAudioReady();
      cleanupUI();
      cleanupKeyboard();
      cleanupSwipe();
      cleanupInteraction();
      audioEngine.disposeAll();
      Object.values(VIZ_REGISTRY).forEach(entry => entry.dispose?.());
    });

    // Load pending image if uploaded on splash before p5 was ready
    if (window.__pendingImageFile) {
      loadUserImage(p, window.__pendingImageFile);
      delete window.__pendingImageFile;
    }

    // Announce ready to screen readers
    announceToScreenReader(
      'Music Visualizer loaded. Press space to play, or ? for keyboard shortcuts.'
    );
  };

  p.draw = () => {
    p.background(0);
    const dt = p.deltaTime / 16.667; // normalize to 60fps reference

    // Process audio based on mode
    const mode = store.state.mode;
    if (mode === 'freq' || mode === 'mic') {
      processFreqMode(dt);
    } else if (mode === 'interactive') {
      // Audio plays as background; band state is synthesized from user input
      // so every viz responds to taps/drags/holds via the same code paths it
      // uses for real audio.
      processInteractiveAudio(dt);
    }

    // Update UI
    updateScrubberUI();

    // Render visualization
    try {
      VIZ_REGISTRY[store.state.vizMode].draw(p, dt);
    } catch (err) {
      console.error(`Visualization "${store.state.vizMode}" crashed:`, err);
      store.setVizMode('circle');
    }
  };

  p.windowResized = () => {
    p.resizeCanvas(window.innerWidth, window.innerHeight);
    VIZ_REGISTRY[store.state.vizMode].reset?.();
  };
};

/**
 * Process audio in frequency mode
 */
function processFreqMode(dt: number): void {
  const fft = audioEngine.getFreqFFT();
  if (!fft) return;

  const { state, config, audioState } = store;

  const isMicActive = state.mode === 'mic' && state.audioReady;

  if (state.isPlaying || isMicActive) {
    const rawBands = getLogBandAmplitudes(fft);
    const decayFactor = computeDecayFactor();

    for (let b = 0; b < BAND_COUNT; b++) {
      const band = BANDS[b];
      const raw = applyAutoGain(rawBands[b], audioState.autoGainBands[b]);

      audioState.transientValues[b] = updateTransient(audioState.transientBands[b], raw, dt);
      audioState.deltaValues[b] = computeDelta(audioState.deltaBands[b], raw, dt);

      smoothBandBins(
        audioState.smoothedBands[b],
        raw,
        config[band.sens as keyof typeof config] as number,
        band.attack,
        band.release,
        decayFactor,
        dt
      );
    }

    updateCentroid(computeSpectralCentroid(fft));

    const waveformAnalyser = audioEngine.getWaveformAnalyser();
    if (waveformAnalyser) {
      const waveRaw = waveformAnalyser.getValue();
      audioState.waveformData.set(waveRaw.subarray(0, audioState.waveformData.length));
    }

    if (state.vizMode === 'tunnel') {
      const rawOct = applyAutoGain(getOctaveAmplitudes(fft), audioState.autoGainOctaves);
      processOctaveData(rawOct, decayFactor, dt);
    }
  } else {
    decayFreqBands(dt);
    if (store.state.vizMode === 'tunnel') {
      decayOctaveState(dt);
    }
  }
}

/**
 * Update spectral centroid
 */
function updateCentroid(centroidHz: number): void {
  const { audioState } = store;
  const clampedHz = Math.max(CENTROID_LOW_HZ, Math.min(centroidHz, CENTROID_HIGH_HZ));
  const normalized = (Math.log(clampedHz) - CENTROID_LOG_LOW) / CENTROID_LOG_RANGE;
  audioState.smoothedCentroid += (normalized - audioState.smoothedCentroid) * CENTROID_SMOOTHING;
  audioState.centroidYOffset = 0;
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
