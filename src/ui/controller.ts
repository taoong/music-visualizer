/**
 * UI Controller — thin orchestrator that wires all UI modules
 */
import { store } from '../state/store';
import { injectErrorStyles } from '../utils/errors';
import { setVisualizerText } from '../visualizations';
import { BANDS, isMobile } from '../utils/constants';
import { bindFileUpload, bindSampleButton, bindModeSelector, bindPlayButton, bindImageUpload } from './splash';
import { bindVolumeControl, bindSensitivitySliders, bindDisplaySliders, setSlider } from './sliders';
import { bindPauseButton, bindScrubber, bindTrackSwitching, bindImageControls, updateScrubberUI } from './playback';
import { initMidiUI } from '../midi/ui';
import { bindBPMControls } from './bpm';

export { updateScrubberUI };

/**
 * Initialize all UI event listeners
 */
export function initUI(): () => void {
  injectErrorStyles();

  const cleanupFns: (() => void)[] = [];

  // Sidebar toggle
  cleanupFns.push(bindSidebarToggle());

  // Splash screen controls
  cleanupFns.push(bindFileUpload());
  cleanupFns.push(bindSampleButton());
  cleanupFns.push(bindModeSelector());
  cleanupFns.push(bindImageUpload());
  cleanupFns.push(bindPlayButton());

  // Playback controls
  cleanupFns.push(bindPauseButton());
  cleanupFns.push(bindTrackSwitching());
  cleanupFns.push(bindImageControls());
  cleanupFns.push(bindScrubber());

  // Sliders
  cleanupFns.push(bindVolumeControl());
  cleanupFns.push(bindSensitivitySliders());
  cleanupFns.push(bindDisplaySliders());

  // Visualization selector
  cleanupFns.push(bindVizSelector());

  // Randomize button
  cleanupFns.push(bindRandomizeButton());

  // BPM controls
  cleanupFns.push(bindBPMControls());

  // MIDI mapping UI
  initMidiUI();

  // Return combined cleanup function
  return () => cleanupFns.forEach(fn => fn());
}

function bindSidebarToggle(): () => void {
  const sidebar = document.getElementById('sidebar');
  const toggleBtn = document.getElementById('sidebar-toggle');

  if (!sidebar || !toggleBtn) return () => {};

  const handler = () => sidebar.classList.toggle('open');
  toggleBtn.addEventListener('click', handler);

  return () => toggleBtn.removeEventListener('click', handler);
}

function bindVizSelector(): () => void {
  const vizSelect = document.getElementById('viz-selector') as HTMLSelectElement | null;
  const scaleGroup = document.getElementById('scale-group');
  const decayRateGroup = document.getElementById('decay-rate-group');
  const rotationSpeedGroup = document.getElementById('rotation-speed-group');
  const ballsKickBoostGroup = document.getElementById('balls-kick-boost-group');
  const intensityGroup = document.getElementById('intensity-group');
  const beatDivisionGroup = document.getElementById('beat-division-group');
  const textInputGroup = document.getElementById('text-input-group');
  const textInput = document.getElementById('viz-text-input') as HTMLInputElement | null;

  if (!vizSelect) return () => {};

  // Remove tetris option on mobile
  if (isMobile) {
    const tetrisOption = vizSelect.querySelector('option[value="tetris"]');
    tetrisOption?.remove();
  }

  function show(el: HTMLElement | null): void { el?.classList.remove('hidden'); }
  function hide(el: HTMLElement | null): void { el?.classList.add('hidden'); }

  const intensityLabel = intensityGroup?.querySelector('label');

  const handler = () => {
    const mode = vizSelect.value as 'circle' | 'spectrum' | 'tunnel' | 'tetris' | 'cube' | 'stickman' | 'lasers' | 'text' | 'highway' | 'runners';
    store.setVizMode(mode);

    // Per-mode control visibility
    // | Mode     | scale | decay | rotation | kickBoost | intensity | beatDiv | textInput |
    // |----------|:-----:|:-----:|:--------:|:---------:|:---------:|:-------:|:---------:|
    // | circle   |  show |  show |     show |      hide |      hide |    hide |      hide |
    // | spectrum |  show |  show |     hide |      hide |      hide |    hide |      hide |
    // | tunnel   |  hide |  show |     hide |      hide |      hide |    hide |      hide |
    // | balls    |  show |  show |     hide |      show |      hide |    hide |      hide |
    // | cube     |  show |  show |     hide |      hide |      hide |    hide |      hide |
    // | stickman |  hide |  show |     hide |      hide |      hide |    hide |      hide |
    // | lasers   |  hide |  hide |     hide |      hide |      show |    show |      hide |
    // | text     |  hide |  hide |     hide |      hide |      show |    show |      show |
    // | highway  |  hide |  hide |     hide |      hide |      show |    hide |      hide |
    switch (mode) {
      case 'circle':
        show(scaleGroup); show(decayRateGroup); show(rotationSpeedGroup);
        if (intensityLabel) intensityLabel.textContent = 'Intensity';
        hide(ballsKickBoostGroup); hide(intensityGroup); hide(beatDivisionGroup); hide(textInputGroup);
        break;
      case 'spectrum':
      case 'cube':
        show(scaleGroup); show(decayRateGroup);
        if (intensityLabel) intensityLabel.textContent = 'Intensity';
        hide(rotationSpeedGroup); hide(ballsKickBoostGroup); hide(intensityGroup); hide(beatDivisionGroup); hide(textInputGroup);
        break;
      case 'tunnel':
      case 'stickman':
        hide(scaleGroup); show(decayRateGroup);
        if (intensityLabel) intensityLabel.textContent = 'Intensity';
        hide(rotationSpeedGroup); hide(ballsKickBoostGroup); hide(intensityGroup); hide(beatDivisionGroup); hide(textInputGroup);
        break;
      case 'tetris':
        show(beatDivisionGroup);
        hide(scaleGroup); hide(decayRateGroup); hide(rotationSpeedGroup);
        hide(ballsKickBoostGroup); hide(intensityGroup); hide(textInputGroup);
        break;
      case 'lasers':
        show(intensityGroup); show(beatDivisionGroup);
        if (intensityLabel) intensityLabel.textContent = 'Intensity';
        hide(scaleGroup); hide(decayRateGroup); hide(rotationSpeedGroup); hide(ballsKickBoostGroup); hide(textInputGroup);
        break;
      case 'text':
        show(intensityGroup); show(beatDivisionGroup); show(textInputGroup);
        if (intensityLabel) intensityLabel.textContent = 'Intensity';
        hide(scaleGroup); hide(decayRateGroup); hide(rotationSpeedGroup); hide(ballsKickBoostGroup);
        break;
      case 'highway':
        show(intensityGroup);
        if (intensityLabel) intensityLabel.textContent = 'Speed';
        hide(scaleGroup); hide(decayRateGroup); hide(rotationSpeedGroup);
        hide(ballsKickBoostGroup); hide(beatDivisionGroup); hide(textInputGroup);
        break;
      case 'runners':
        show(intensityGroup); show(beatDivisionGroup);
        if (intensityLabel) intensityLabel.textContent = 'Intensity';
        hide(scaleGroup); hide(decayRateGroup); hide(rotationSpeedGroup); hide(ballsKickBoostGroup); hide(textInputGroup);
        break;
    }
  };

  const textHandler = () => {
    if (textInput) setVisualizerText(textInput.value);
  };

  vizSelect.addEventListener('change', handler);
  textInput?.addEventListener('input', textHandler);
  return () => {
    vizSelect.removeEventListener('change', handler);
    textInput?.removeEventListener('input', textHandler);
  };
}

function bindRandomizeButton(): () => void {
  const btn = document.getElementById('randomize-btn');

  if (!btn) return () => {};

  const handler = () => {
    const rand = (min: number, max: number) => Math.random() * (max - min) + min;
    const vizMode = store.state.vizMode;

    if (store.isFreqMode) {
      for (const band of BANDS) {
        setSlider(band.sliderId, rand(1.0, 3.0));
      }
    } else {
      setSlider('sens-kick', rand(1.0, 3.0));
      setSlider('sens-drums', rand(1.0, 3.0));
      setSlider('sens-bass-stem', rand(1.0, 3.0));
      setSlider('sens-vocals', rand(1.0, 3.0));
      setSlider('sens-other', rand(1.0, 3.0));
    }

    const useScale = vizMode === 'circle' || vizMode === 'spectrum' || vizMode === 'cube';
    const useDecay = vizMode !== 'lasers' && vizMode !== 'text' && vizMode !== 'tetris';

    if (useScale) setSlider('spike-scale', rand(0.5, 2.0));
    if (useDecay) setSlider('decay-rate', rand(0.7, 0.95));

    if (vizMode === 'circle') {
      setSlider('rotation-speed', rand(0.0, 15.0));
    }

    if (vizMode === 'tetris') {
      setSlider('beat-division', Math.floor(rand(1, 5)));
    }

    if (vizMode === 'lasers' || vizMode === 'text') {
      setSlider('viz-intensity', rand(0.5, 2.0));
    }
  };

  btn.addEventListener('click', handler);
  return () => btn.removeEventListener('click', handler);
}
