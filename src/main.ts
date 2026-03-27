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
import { updateTransient, computeDelta, applyAutoGain } from './audio/processing';
import {
  computeDecayFactor,
  processOctaveData,
  decayOctaveState,
  decayFreqBands,
  decayStemBands,
  smoothBandBins,
} from './audio/pipeline';
import {
  drawSpikeCircle,
  drawSpectrum,
  drawTunnel,
  drawTetris,
  resetTetris,
  drawCube,
  resetCube,
  drawLasers,
  resetLasers,
  drawText,
  resetText,
  drawHighway,
  resetHighway,
  drawLiquidMetal,
  resetLiquidMetal,
  disposeLiquidMetal,
  drawNeon,
  resetNeon,
  disposeNeon,
  drawImageGrid,
  resetImageGrid,
  disposeImageGrid,
  drawColormap,
  resetColormap,
  disposeColormap,
  drawSculpture,
  resetSculpture,
  disposeSculpture,
  drawBinary,
  resetBinary,
  drawTungTung,
  resetTungTung,
  drawAurora,
  resetAurora,
  drawBootsAndCats,
  resetBootsAndCats,
  loadUserImage,
} from './visualizations';
import { initUI, updateScrubberUI } from './ui/controller';
import { initKeyboardShortcuts, initSwipeGestures, announceToScreenReader } from './ui/keyboard';
import { showError } from './utils/errors';
import {
  BANDS,
  BAND_COUNT,
  STEMS,
  SPIKES_PER_BAND,
  CENTROID_LOW_HZ,
  CENTROID_HIGH_HZ,
  CENTROID_LOG_LOW,
  CENTROID_LOG_RANGE,
  CENTROID_SMOOTHING,
  STEM_SMOOTHING,
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

    // Initialize UI, keyboard shortcuts, and swipe gestures
    const cleanupUI = initUI();
    const cleanupKeyboard = initKeyboardShortcuts();
    const cleanupSwipe = initSwipeGestures();

    // Reset highway state when a new track is loaded
    const unsubAudioReady = store.on('audioReady', () => {
      resetHighway();
    });

    // Cleanup on page unload
    window.addEventListener('beforeunload', () => {
      unsubAudioReady();
      cleanupUI();
      cleanupKeyboard();
      cleanupSwipe();
      audioEngine.disposeAll();
      disposeLiquidMetal();
      disposeNeon();
      disposeImageGrid();
      disposeColormap();
      disposeSculpture();
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
    } else {
      processStemMode(dt);
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
      case 'tetris':
        drawTetris(p, dt);
        break;
      case 'cube':
        drawCube(p, dt);
        break;
      case 'lasers':
        drawLasers(p, dt);
        break;
      case 'text':
        drawText(p, dt);
        break;
      case 'highway':
        drawHighway(p, dt);
        break;
      case 'liquidmetal':
        drawLiquidMetal(p, dt);
        break;
      case 'neon':
        drawNeon(p, dt);
        break;
      case 'imagegrid':
        drawImageGrid(p, dt);
        break;
      case 'colormap':
        drawColormap(p, dt);
        break;
      case 'sculpture':
        drawSculpture(p, dt);
        break;
      case 'binary':
        drawBinary(p, dt);
        break;
      case 'tungtung':
        drawTungTung(p, dt);
        break;
      case 'aurora':
        drawAurora(p, dt);
        break;
      case 'bootsandcats':
        drawBootsAndCats(p, dt);
        break;
      case 'circle':
      default:
        drawSpikeCircle(p, dt);
        break;
    }
  };

  p.windowResized = () => {
    p.resizeCanvas(window.innerWidth, window.innerHeight);
    if (store.state.vizMode === 'tetris') {
      resetTetris();
    } else if (store.state.vizMode === 'cube') {
      resetCube();
    } else if (store.state.vizMode === 'lasers') {
      resetLasers();
    } else if (store.state.vizMode === 'text') {
      resetText();
    } else if (store.state.vizMode === 'highway') {
      resetHighway();
    } else if (store.state.vizMode === 'liquidmetal') {
      resetLiquidMetal();
    } else if (store.state.vizMode === 'neon') {
      resetNeon();
    } else if (store.state.vizMode === 'imagegrid') {
      resetImageGrid();
    } else if (store.state.vizMode === 'colormap') {
      resetColormap();
    } else if (store.state.vizMode === 'sculpture') {
      resetSculpture();
    } else if (store.state.vizMode === 'binary') {
      resetBinary();
    } else if (store.state.vizMode === 'tungtung') {
      resetTungTung();
    } else if (store.state.vizMode === 'aurora') {
      resetAurora();
    } else if (store.state.vizMode === 'bootsandcats') {
      resetBootsAndCats();
    }
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
 * Process audio in stem mode
 */
function processStemMode(dt: number): void {
  const stemFfts = audioEngine.getStemFFTs();
  if (!stemFfts) return;

  const { state, config, audioState } = store;
  const stemSmoothed = audioEngine.getStemSmoothed();

  const anyPlaying = state.isPlaying && stemFfts.kick !== undefined;

  if (anyPlaying) {
    const decayFactor = computeDecayFactor();

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

      const raw = applyAutoGain(
        getFFTAmplitudes(stemFfts[stem], SPIKES_PER_BAND, 10.0),
        audioState.autoGainStems[stem]
      );

      audioState.transientStems[stem].multiplier = updateTransient(
        audioState.transientStems[stem],
        raw,
        dt
      );
      audioState.deltaStems[stem].smoothed = computeDelta(audioState.deltaStems[stem], raw, dt);

      const sensKey = `sens${stem.charAt(0).toUpperCase() + stem.slice(1)}` as keyof typeof config;
      const [attack, release] = STEM_SMOOTHING[stem];

      smoothBandBins(
        stemSmoothed[stem],
        raw,
        config[sensKey] as number,
        attack,
        release,
        decayFactor,
        dt
      );
    }

    updateCentroid(computeStemCentroid(stemFfts, STEMS));

    const waveformAnalyserStem = audioEngine.getWaveformAnalyser();
    if (waveformAnalyserStem) {
      const waveRaw = waveformAnalyserStem.getValue();
      audioState.waveformData.set(waveRaw.subarray(0, audioState.waveformData.length));
    }

    if (state.vizMode === 'tunnel') {
      const rawOct = applyAutoGain(
        getOctaveAmplitudesFromStems(stemFfts, STEMS),
        audioState.autoGainOctaves
      );
      processOctaveData(rawOct, decayFactor, dt);
    }
  } else {
    decayStemBands(dt);
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
