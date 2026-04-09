/**
 * UI Controller — thin orchestrator that wires all UI modules
 */
import { store } from '../state/store';
import { injectErrorStyles } from '../utils/errors';
import { setVisualizerText, setDancerText } from '../visualizations';
import { BANDS, isMobile } from '../utils/constants';
import { bindFileUpload, bindSampleButton, bindMicButton, bindModeSelector, bindPlayButton, bindImageUpload, bindSplashKeyboard, initStemAvailability } from './splash';
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
  cleanupFns.push(bindMicButton());
  cleanupFns.push(bindModeSelector());
  cleanupFns.push(bindImageUpload());
  cleanupFns.push(bindPlayButton());
  cleanupFns.push(bindSplashKeyboard());

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

  // Probe for Flask server; disable stems button if unavailable
  initStemAvailability();

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
  const highwayControlsGroup = document.getElementById('highway-controls-group');
  const sculptureControlsGroup = document.getElementById('sculpture-controls-group');
  const circleImageRotationGroup = document.getElementById('circle-image-rotation-group');
  const bootsControlsGroup = document.getElementById('boots-controls-group');
  const rippletankControlsGroup = document.getElementById('rippletank-controls-group');
  const cymaticsControlsGroup = document.getElementById('cymatics-controls-group');
  const cloudchamberControlsGroup = document.getElementById('cloudchamber-controls-group');
  const attractorControlsGroup = document.getElementById('attractor-controls-group');
  const mandalaControlsGroup = document.getElementById('mandala-controls-group');
  const silkControlsGroup = document.getElementById('silk-controls-group');
  const kaleidoscopeControlsGroup = document.getElementById('kaleidoscope-controls-group');
  const textInput = document.getElementById('viz-text-input') as HTMLInputElement | null;

  if (!vizSelect) return () => {};

  // Remove tetris option on mobile
  if (isMobile) {
    const tetrisOption = vizSelect.querySelector('option[value="tetris"]');
    tetrisOption?.remove();
  }

  // Visualizations that require beat/BPM tracking and don't work well with mic input
  const micHiddenVizModes = ['liquidmetal', 'sculpture', 'tungtung', 'aurora'];

  function updateMicVizVisibility(): void {
    const isMic = store.isMicMode;
    for (const mode of micHiddenVizModes) {
      const option = vizSelect!.querySelector(`option[value="${mode}"]`) as HTMLOptionElement | null;
      if (option) {
        option.hidden = isMic;
        option.disabled = isMic;
      }
    }
    // If currently selected viz is now hidden, switch to circle
    if (isMic && micHiddenVizModes.includes(vizSelect!.value)) {
      vizSelect!.value = 'circle';
      vizSelect!.dispatchEvent(new Event('change'));
    }
  }

  updateMicVizVisibility();
  const removeModeListener = store.on('modeChange', updateMicVizVisibility);

  function show(el: HTMLElement | null): void { el?.classList.remove('hidden'); }
  function hide(el: HTMLElement | null): void { el?.classList.add('hidden'); }

  const intensityLabel = intensityGroup?.querySelector('label');
  const rotationLabel = rotationSpeedGroup?.querySelector('label');
  const decayRateLabel = decayRateGroup?.querySelector('label');

  const handler = () => {
    const mode = vizSelect.value as 'circle' | 'spectrum' | 'tunnel' | 'tetris' | 'lasers' | 'text' | 'highway' | 'liquidmetal' | 'neon' | 'imagegrid' | 'colormap' | 'sculpture' | 'binary' | 'tungtung' | 'aurora' | 'bootsandcats' | 'rippletank' | 'cymatics' | 'cloudchamber' | 'attractor' | 'mandala' | 'silk' | 'kaleidoscope';
    store.setVizMode(mode);

    // Per-mode control visibility
    // | Mode     | scale | decay | rotation | kickBoost | intensity | beatDiv | textInput |
    // |----------|:-----:|:-----:|:--------:|:---------:|:---------:|:-------:|:---------:|
    // | circle   |  show |  show |     show |      hide |      hide |    hide |      hide |
    // | spectrum |  show |  show |     hide |      hide |      hide |    hide |      hide |
    // | tunnel   |  hide |  show |     hide |      hide |      hide |    hide |      hide |
    // | balls    |  show |  show |     hide |      show |      hide |    hide |      hide |
    // | lasers   |  hide |  hide |     hide |      hide |      show |    show |      hide |
    // | text     |  hide |  hide |     hide |      hide |      show |    show |      show |
    // | highway  |  hide |  hide |     hide |      hide |      show |    hide |      hide |
    if (rotationLabel) rotationLabel.textContent = 'Rotation Speed';
    if (decayRateLabel) decayRateLabel.textContent = 'Decay Rate';
    switch (mode) {
      case 'circle':
        show(scaleGroup); show(decayRateGroup); show(rotationSpeedGroup); show(circleImageRotationGroup);
        if (intensityLabel) intensityLabel.textContent = 'Intensity';
        hide(ballsKickBoostGroup); hide(intensityGroup); hide(beatDivisionGroup); hide(textInputGroup); hide(highwayControlsGroup); hide(sculptureControlsGroup); hide(bootsControlsGroup); hide(rippletankControlsGroup); hide(cymaticsControlsGroup); hide(cloudchamberControlsGroup); hide(attractorControlsGroup); hide(mandalaControlsGroup); hide(silkControlsGroup); hide(kaleidoscopeControlsGroup);
        break;
      case 'spectrum':
        show(scaleGroup); show(decayRateGroup);
        if (intensityLabel) intensityLabel.textContent = 'Intensity';
        hide(rotationSpeedGroup); hide(ballsKickBoostGroup); hide(intensityGroup); hide(beatDivisionGroup); hide(textInputGroup); hide(highwayControlsGroup); hide(sculptureControlsGroup); hide(circleImageRotationGroup); hide(bootsControlsGroup); hide(rippletankControlsGroup); hide(cymaticsControlsGroup); hide(cloudchamberControlsGroup); hide(attractorControlsGroup); hide(mandalaControlsGroup); hide(silkControlsGroup); hide(kaleidoscopeControlsGroup);
        break;
      case 'tunnel':
        hide(scaleGroup); show(decayRateGroup);
        if (intensityLabel) intensityLabel.textContent = 'Intensity';
        hide(rotationSpeedGroup); hide(ballsKickBoostGroup); hide(intensityGroup); hide(beatDivisionGroup); hide(textInputGroup); hide(highwayControlsGroup); hide(sculptureControlsGroup); hide(circleImageRotationGroup); hide(bootsControlsGroup); hide(rippletankControlsGroup); hide(cymaticsControlsGroup); hide(cloudchamberControlsGroup); hide(attractorControlsGroup); hide(mandalaControlsGroup); hide(silkControlsGroup); hide(kaleidoscopeControlsGroup);
        break;
      case 'tetris':
        show(beatDivisionGroup);
        hide(scaleGroup); hide(decayRateGroup); hide(rotationSpeedGroup);
        hide(ballsKickBoostGroup); hide(intensityGroup); hide(textInputGroup); hide(highwayControlsGroup); hide(sculptureControlsGroup); hide(circleImageRotationGroup); hide(bootsControlsGroup); hide(rippletankControlsGroup); hide(cymaticsControlsGroup); hide(cloudchamberControlsGroup); hide(attractorControlsGroup); hide(mandalaControlsGroup); hide(silkControlsGroup); hide(kaleidoscopeControlsGroup);
        break;
      case 'lasers':
        show(intensityGroup); show(beatDivisionGroup);
        if (intensityLabel) intensityLabel.textContent = 'Intensity';
        hide(scaleGroup); hide(decayRateGroup); hide(rotationSpeedGroup); hide(ballsKickBoostGroup); hide(textInputGroup); hide(highwayControlsGroup); hide(sculptureControlsGroup); hide(circleImageRotationGroup); hide(bootsControlsGroup); hide(rippletankControlsGroup); hide(cymaticsControlsGroup); hide(cloudchamberControlsGroup); hide(attractorControlsGroup); hide(mandalaControlsGroup); hide(silkControlsGroup); hide(kaleidoscopeControlsGroup);
        break;
      case 'text':
        show(intensityGroup); show(beatDivisionGroup); show(textInputGroup);
        if (intensityLabel) intensityLabel.textContent = 'Intensity';
        hide(scaleGroup); hide(decayRateGroup); hide(rotationSpeedGroup); hide(ballsKickBoostGroup); hide(highwayControlsGroup); hide(sculptureControlsGroup); hide(circleImageRotationGroup); hide(bootsControlsGroup); hide(rippletankControlsGroup); hide(cymaticsControlsGroup); hide(cloudchamberControlsGroup); hide(attractorControlsGroup); hide(mandalaControlsGroup); hide(silkControlsGroup); hide(kaleidoscopeControlsGroup);
        break;
      case 'highway':
        show(intensityGroup); show(highwayControlsGroup);
        if (intensityLabel) intensityLabel.textContent = 'Speed';
        hide(scaleGroup); hide(decayRateGroup); hide(rotationSpeedGroup);
        hide(ballsKickBoostGroup); hide(beatDivisionGroup); hide(textInputGroup); hide(sculptureControlsGroup); hide(circleImageRotationGroup); hide(bootsControlsGroup); hide(rippletankControlsGroup); hide(cymaticsControlsGroup); hide(cloudchamberControlsGroup); hide(attractorControlsGroup); hide(mandalaControlsGroup); hide(silkControlsGroup); hide(kaleidoscopeControlsGroup);
        break;
      case 'liquidmetal':
        show(rotationSpeedGroup); show(intensityGroup);
        if (intensityLabel) intensityLabel.textContent = 'Spin Chaos';
        hide(scaleGroup); hide(decayRateGroup);
        hide(ballsKickBoostGroup); hide(beatDivisionGroup);
        hide(textInputGroup); hide(highwayControlsGroup); hide(sculptureControlsGroup); hide(circleImageRotationGroup); hide(bootsControlsGroup); hide(rippletankControlsGroup); hide(cymaticsControlsGroup); hide(cloudchamberControlsGroup); hide(attractorControlsGroup); hide(mandalaControlsGroup); hide(silkControlsGroup); hide(kaleidoscopeControlsGroup);
        break;
      case 'neon':
        show(rotationSpeedGroup); show(intensityGroup); show(decayRateGroup);
        if (rotationLabel) rotationLabel.textContent = 'Camera Rotation';
        if (intensityLabel) intensityLabel.textContent = 'Intensity';
        if (decayRateLabel) decayRateLabel.textContent = 'Camera Height';
        hide(scaleGroup);
        hide(ballsKickBoostGroup); hide(beatDivisionGroup);
        hide(textInputGroup); hide(highwayControlsGroup); hide(sculptureControlsGroup); hide(circleImageRotationGroup); hide(bootsControlsGroup); hide(rippletankControlsGroup); hide(cymaticsControlsGroup); hide(cloudchamberControlsGroup); hide(attractorControlsGroup); hide(mandalaControlsGroup); hide(silkControlsGroup); hide(kaleidoscopeControlsGroup);
        break;
      case 'imagegrid':
        show(rotationSpeedGroup); show(intensityGroup);
        if (intensityLabel) intensityLabel.textContent = 'Bloom Strength';
        hide(scaleGroup); hide(decayRateGroup);
        hide(ballsKickBoostGroup); hide(beatDivisionGroup);
        hide(textInputGroup); hide(highwayControlsGroup); hide(sculptureControlsGroup); hide(circleImageRotationGroup); hide(bootsControlsGroup); hide(rippletankControlsGroup); hide(cymaticsControlsGroup); hide(cloudchamberControlsGroup); hide(attractorControlsGroup); hide(mandalaControlsGroup); hide(silkControlsGroup); hide(kaleidoscopeControlsGroup);
        break;
      case 'colormap':
        show(intensityGroup);
        if (intensityLabel) intensityLabel.textContent = 'Color Boost';
        hide(scaleGroup); hide(decayRateGroup); hide(rotationSpeedGroup);
        hide(ballsKickBoostGroup); hide(beatDivisionGroup);
        hide(textInputGroup); hide(highwayControlsGroup); hide(sculptureControlsGroup); hide(circleImageRotationGroup); hide(bootsControlsGroup); hide(rippletankControlsGroup); hide(cymaticsControlsGroup); hide(cloudchamberControlsGroup); hide(attractorControlsGroup); hide(mandalaControlsGroup); hide(silkControlsGroup); hide(kaleidoscopeControlsGroup);
        break;
      case 'sculpture':
        show(rotationSpeedGroup); show(intensityGroup); show(sculptureControlsGroup);
        if (intensityLabel) intensityLabel.textContent = 'Bloom Strength';
        hide(scaleGroup); hide(decayRateGroup);
        hide(ballsKickBoostGroup); hide(beatDivisionGroup);
        hide(textInputGroup); hide(highwayControlsGroup); hide(circleImageRotationGroup); hide(bootsControlsGroup); hide(rippletankControlsGroup); hide(cymaticsControlsGroup); hide(cloudchamberControlsGroup); hide(attractorControlsGroup); hide(mandalaControlsGroup); hide(silkControlsGroup); hide(kaleidoscopeControlsGroup);
        break;
      case 'binary':
        show(scaleGroup); show(decayRateGroup);
        if (intensityLabel) intensityLabel.textContent = 'Intensity';
        hide(rotationSpeedGroup); hide(ballsKickBoostGroup); hide(intensityGroup); hide(beatDivisionGroup); hide(textInputGroup); hide(highwayControlsGroup); hide(sculptureControlsGroup); hide(circleImageRotationGroup); hide(bootsControlsGroup); hide(rippletankControlsGroup); hide(cymaticsControlsGroup); hide(cloudchamberControlsGroup); hide(attractorControlsGroup); hide(mandalaControlsGroup); hide(silkControlsGroup); hide(kaleidoscopeControlsGroup);
        break;
      case 'tungtung':
        show(textInputGroup);
        hide(scaleGroup); hide(decayRateGroup); hide(rotationSpeedGroup);
        hide(ballsKickBoostGroup); hide(intensityGroup); hide(beatDivisionGroup);
        hide(highwayControlsGroup); hide(sculptureControlsGroup); hide(circleImageRotationGroup); hide(bootsControlsGroup); hide(rippletankControlsGroup); hide(cymaticsControlsGroup); hide(cloudchamberControlsGroup); hide(attractorControlsGroup); hide(mandalaControlsGroup); hide(silkControlsGroup); hide(kaleidoscopeControlsGroup);
        break;
      case 'aurora':
        show(intensityGroup); show(scaleGroup);
        if (intensityLabel) intensityLabel.textContent = 'Glow Strength';
        hide(decayRateGroup); hide(rotationSpeedGroup);
        hide(ballsKickBoostGroup); hide(beatDivisionGroup);
        hide(textInputGroup); hide(highwayControlsGroup); hide(sculptureControlsGroup); hide(circleImageRotationGroup); hide(bootsControlsGroup); hide(rippletankControlsGroup); hide(cymaticsControlsGroup); hide(cloudchamberControlsGroup); hide(attractorControlsGroup); hide(mandalaControlsGroup); hide(silkControlsGroup); hide(kaleidoscopeControlsGroup);
        break;
      case 'bootsandcats':
        show(bootsControlsGroup);
        hide(scaleGroup); hide(decayRateGroup); hide(rotationSpeedGroup);
        hide(ballsKickBoostGroup); hide(intensityGroup); hide(beatDivisionGroup);
        hide(textInputGroup); hide(highwayControlsGroup); hide(sculptureControlsGroup); hide(circleImageRotationGroup); hide(rippletankControlsGroup); hide(cymaticsControlsGroup); hide(cloudchamberControlsGroup); hide(attractorControlsGroup); hide(mandalaControlsGroup); hide(silkControlsGroup); hide(kaleidoscopeControlsGroup);
        break;
      case 'rippletank':
        show(scaleGroup); show(rippletankControlsGroup);
        hide(decayRateGroup); hide(rotationSpeedGroup);
        hide(ballsKickBoostGroup); hide(intensityGroup); hide(beatDivisionGroup);
        hide(textInputGroup); hide(highwayControlsGroup); hide(sculptureControlsGroup); hide(circleImageRotationGroup); hide(bootsControlsGroup); hide(cymaticsControlsGroup); hide(cloudchamberControlsGroup); hide(attractorControlsGroup); hide(mandalaControlsGroup); hide(silkControlsGroup); hide(kaleidoscopeControlsGroup);
        break;
      case 'cymatics':
        show(cymaticsControlsGroup);
        hide(scaleGroup); hide(decayRateGroup); hide(intensityGroup); hide(rotationSpeedGroup);
        hide(ballsKickBoostGroup); hide(beatDivisionGroup);
        hide(textInputGroup); hide(highwayControlsGroup); hide(sculptureControlsGroup); hide(circleImageRotationGroup); hide(bootsControlsGroup); hide(rippletankControlsGroup); hide(cloudchamberControlsGroup); hide(attractorControlsGroup); hide(mandalaControlsGroup); hide(silkControlsGroup); hide(kaleidoscopeControlsGroup);
        break;
      case 'cloudchamber':
        show(cloudchamberControlsGroup);
        hide(scaleGroup); hide(decayRateGroup); hide(intensityGroup); hide(rotationSpeedGroup);
        hide(ballsKickBoostGroup); hide(beatDivisionGroup);
        hide(textInputGroup); hide(highwayControlsGroup); hide(sculptureControlsGroup); hide(circleImageRotationGroup); hide(bootsControlsGroup); hide(rippletankControlsGroup); hide(cymaticsControlsGroup); hide(attractorControlsGroup); hide(mandalaControlsGroup); hide(silkControlsGroup); hide(kaleidoscopeControlsGroup);
        break;
      case 'attractor':
        show(attractorControlsGroup);
        hide(scaleGroup); hide(decayRateGroup); hide(intensityGroup); hide(rotationSpeedGroup);
        hide(ballsKickBoostGroup); hide(beatDivisionGroup);
        hide(textInputGroup); hide(highwayControlsGroup); hide(sculptureControlsGroup); hide(circleImageRotationGroup); hide(bootsControlsGroup); hide(rippletankControlsGroup); hide(cymaticsControlsGroup); hide(cloudchamberControlsGroup); hide(mandalaControlsGroup); hide(silkControlsGroup); hide(kaleidoscopeControlsGroup);
        break;
      case 'mandala':
        show(mandalaControlsGroup);
        hide(scaleGroup); hide(decayRateGroup); hide(intensityGroup); hide(rotationSpeedGroup);
        hide(ballsKickBoostGroup); hide(beatDivisionGroup);
        hide(textInputGroup); hide(highwayControlsGroup); hide(sculptureControlsGroup); hide(circleImageRotationGroup); hide(bootsControlsGroup); hide(rippletankControlsGroup); hide(cymaticsControlsGroup); hide(cloudchamberControlsGroup); hide(attractorControlsGroup); hide(silkControlsGroup); hide(kaleidoscopeControlsGroup);
        break;
      case 'silk':
        show(silkControlsGroup);
        hide(scaleGroup); hide(decayRateGroup); hide(rotationSpeedGroup);
        hide(ballsKickBoostGroup); hide(intensityGroup); hide(beatDivisionGroup);
        hide(textInputGroup); hide(highwayControlsGroup); hide(sculptureControlsGroup); hide(circleImageRotationGroup); hide(bootsControlsGroup); hide(rippletankControlsGroup); hide(cymaticsControlsGroup); hide(cloudchamberControlsGroup); hide(attractorControlsGroup); hide(mandalaControlsGroup); hide(kaleidoscopeControlsGroup);
        break;
      case 'kaleidoscope':
        show(kaleidoscopeControlsGroup);
        hide(scaleGroup); hide(decayRateGroup); hide(rotationSpeedGroup);
        hide(ballsKickBoostGroup); hide(intensityGroup); hide(beatDivisionGroup);
        hide(textInputGroup); hide(highwayControlsGroup); hide(sculptureControlsGroup); hide(circleImageRotationGroup); hide(bootsControlsGroup); hide(rippletankControlsGroup); hide(cymaticsControlsGroup); hide(cloudchamberControlsGroup); hide(attractorControlsGroup); hide(mandalaControlsGroup); hide(silkControlsGroup);
        break;
    }
  };

  const textHandler = () => {
    if (textInput) {
      setVisualizerText(textInput.value);
      setDancerText(textInput.value);
    }
  };

  vizSelect.addEventListener('change', handler);
  textInput?.addEventListener('input', textHandler);
  return () => {
    vizSelect.removeEventListener('change', handler);
    textInput?.removeEventListener('input', textHandler);
    removeModeListener();
  };
}

function bindRandomizeButton(): () => void {
  const btn = document.getElementById('randomize-btn');

  if (!btn) return () => {};

  const handler = () => {
    const rand = (min: number, max: number) => Math.random() * (max - min) + min;
    const vizMode = store.state.vizMode;

    if (store.isFreqMode || store.isMicMode) {
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

    const useScale = vizMode === 'circle' || vizMode === 'spectrum';
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
