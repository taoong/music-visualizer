/**
 * UI Controller — thin orchestrator that wires all UI modules
 */
import { store } from '../state/store';
import type { VizMode } from '../types';
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

// All toggleable sidebar control group IDs
const ALL_CONTROL_IDS = [
  'scale-group', 'decay-rate-group', 'rotation-speed-group', 'balls-kick-boost-group',
  'intensity-group', 'beat-division-group', 'text-input-group',
  'highway-controls-group', 'sculpture-controls-group', 'circle-image-rotation-group',
  'boots-controls-group', 'rippletank-controls-group', 'cymatics-controls-group',
  'cloudchamber-controls-group', 'attractor-controls-group', 'mandala-controls-group',
  'stringart-controls-group', 'constellation-controls-group', 'petals-controls-group',
  'waterfall-controls-group', 'kaleido-controls-group', 'kaleidoscope-controls-group',
  'weave-controls-group', 'synthwave-controls-group', 'bloom-controls-group',
  'hive-controls-group', 'marbling-controls-group', 'flowfield-controls-group',
  'lissajous-controls-group', 'truchet-controls-group', 'topography-controls-group',
  'interference-controls-group',
] as const;

type LabelOverrides = { intensity?: string; rotation?: string; decayRate?: string };
type VizControlsConfig = { show: readonly string[]; labels?: LabelOverrides };

const VIZ_CONTROLS: Record<VizMode, VizControlsConfig> = {
  circle:        { show: ['scale-group', 'decay-rate-group', 'rotation-speed-group', 'circle-image-rotation-group'] },
  spectrum:      { show: ['scale-group', 'decay-rate-group'] },
  tunnel:        { show: ['decay-rate-group'] },
  tetris:        { show: ['beat-division-group'] },
  lasers:        { show: ['intensity-group', 'beat-division-group'] },
  text:          { show: ['intensity-group', 'beat-division-group', 'text-input-group'] },
  highway:       { show: ['intensity-group', 'highway-controls-group'],                           labels: { intensity: 'Speed' } },
  liquidmetal:   { show: ['rotation-speed-group', 'intensity-group'],                             labels: { intensity: 'Spin Chaos' } },
  neon:          { show: ['rotation-speed-group', 'intensity-group', 'decay-rate-group'],          labels: { rotation: 'Camera Rotation', intensity: 'Intensity', decayRate: 'Camera Height' } },
  imagegrid:     { show: ['rotation-speed-group', 'intensity-group'],                             labels: { intensity: 'Bloom Strength' } },
  colormap:      { show: ['intensity-group'],                                                      labels: { intensity: 'Color Boost' } },
  sculpture:     { show: ['rotation-speed-group', 'intensity-group', 'sculpture-controls-group'], labels: { intensity: 'Bloom Strength' } },
  binary:        { show: ['scale-group', 'decay-rate-group'] },
  tungtung:      { show: ['text-input-group'] },
  aurora:        { show: ['intensity-group', 'scale-group'],                                      labels: { intensity: 'Glow Strength' } },
  bootsandcats:  { show: ['boots-controls-group'] },
  rippletank:    { show: ['scale-group', 'rippletank-controls-group'] },
  cymatics:      { show: ['cymatics-controls-group'] },
  cloudchamber:  { show: ['cloudchamber-controls-group'] },
  attractor:     { show: ['attractor-controls-group'] },
  mandala:       { show: ['mandala-controls-group'] },
  stringart:     { show: ['stringart-controls-group'] },
  constellation: { show: ['constellation-controls-group'] },
  petals:        { show: ['petals-controls-group'] },
  waterfall:     { show: ['waterfall-controls-group'] },
  kaleido:       { show: ['kaleido-controls-group'] },
  kaleidoscope:  { show: ['kaleidoscope-controls-group'] },
  weave:         { show: ['weave-controls-group'] },
  synthwave:     { show: ['synthwave-controls-group'] },
  bloom:         { show: ['bloom-controls-group'] },
  monolith:      { show: ['intensity-group'],                                                      labels: { intensity: 'Bloom Strength' } },
  hive:          { show: ['hive-controls-group'] },
  marbling:      { show: ['marbling-controls-group'] },
  flowfield:     { show: ['flowfield-controls-group'] },
  lissajous:     { show: ['lissajous-controls-group'] },
  truchet:       { show: ['truchet-controls-group'] },
  topography:    { show: ['topography-controls-group'] },
  interference:  { show: ['interference-controls-group'] },
};

function bindVizSelector(): () => void {
  const vizSelect = document.getElementById('viz-selector') as HTMLSelectElement | null;
  const textInput = document.getElementById('viz-text-input') as HTMLInputElement | null;

  if (!vizSelect) return () => {};

  // Remove tetris option on mobile
  if (isMobile) {
    const tetrisOption = vizSelect.querySelector('option[value="tetris"]');
    tetrisOption?.remove();
  }

  // Visualizations that require beat/BPM tracking and don't work well with mic input
  const micHiddenVizModes = ['liquidmetal', 'sculpture', 'tungtung', 'aurora', 'monolith'];

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

  const intensityLabel = document.getElementById('intensity-group')?.querySelector('label');
  const rotationLabel = document.getElementById('rotation-speed-group')?.querySelector('label');
  const decayRateLabel = document.getElementById('decay-rate-group')?.querySelector('label');

  const handler = () => {
    const mode = vizSelect.value as VizMode;
    store.setVizMode(mode);

    // Reset label defaults
    if (intensityLabel) intensityLabel.textContent = 'Intensity';
    if (rotationLabel) rotationLabel.textContent = 'Rotation Speed';
    if (decayRateLabel) decayRateLabel.textContent = 'Decay Rate';

    // Hide all control groups, then show only the ones for the active mode
    for (const id of ALL_CONTROL_IDS) {
      document.getElementById(id)?.classList.add('hidden');
    }
    const ctrl = VIZ_CONTROLS[mode];
    for (const id of ctrl.show) {
      document.getElementById(id)?.classList.remove('hidden');
    }
    if (ctrl.labels?.intensity && intensityLabel) intensityLabel.textContent = ctrl.labels.intensity;
    if (ctrl.labels?.rotation && rotationLabel) rotationLabel.textContent = ctrl.labels.rotation;
    if (ctrl.labels?.decayRate && decayRateLabel) decayRateLabel.textContent = ctrl.labels.decayRate;
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
