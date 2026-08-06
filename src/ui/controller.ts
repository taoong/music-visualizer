/**
 * UI Controller — thin orchestrator that wires all UI modules
 */
import { store } from '../state/store';
import type { VizMode } from '../types';
import { injectErrorStyles } from '../utils/errors';
import { setVisualizerText } from '../visualizations';
import { BANDS, isMobile } from '../utils/constants';
import { bindFileUpload, bindSampleButton, bindMicButton, bindModeSelector, bindPlayButton, bindImageUpload, bindSplashKeyboard } from './splash';
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
  'rippletank-controls-group', 'cymatics-controls-group',
  'attractor-controls-group',
  'stringart-controls-group', 'constellation-controls-group',
  'waterfall-controls-group',
  'weave-controls-group', 'synthwave-controls-group', 'bloom-controls-group',
  'hive-controls-group', 'marbling-controls-group', 'flowfield-controls-group',
  'truchet-controls-group', 'topography-controls-group',
  'interference-controls-group', 'voronoi-controls-group',
  'blobs-controls-group', 'grayscott-controls-group', 'growth-controls-group',
  'pixelsort-controls-group', 'echoes-controls-group', 'physarum-controls-group',
  'geodesic-controls-group', 'ribbons-controls-group',
  'infinitynet-controls-group',
  'arabesque-controls-group',
  'murmuration-controls-group',
  'epicycles-controls-group',
  'knots-controls-group',
  'penrose-controls-group',
  'flame-controls-group',
  'disorders-controls-group',
  'blackwave-controls-group',
  'origami-controls-group',
  'lightfield-controls-group',
  'brush-controls-group',
  'aurora-controls-group',
  'glitch-controls-group',
  'warp-controls-group',
  'vortex-controls-group',
  'lumia-controls-group',
  'woodmirror-controls-group',
  'moire-controls-group',
  'noctiluca-controls-group',
  'tesseract-controls-group',
  'supershapes-controls-group',
  'corridor-controls-group',
  'riemann-controls-group',
  'glyphs-controls-group',
  'radiolaria-controls-group',
  'ferrofluid-controls-group',
  'thermal-controls-group',
  'kintsugi-controls-group',
  'skyspace-controls-group',
  'morpho-controls-group',
  'prism-controls-group',
  'cloth-controls-group',
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
  sculpture:     { show: ['rotation-speed-group', 'intensity-group', 'sculpture-controls-group'], labels: { intensity: 'Bloom Strength' } },
  binary:        { show: ['scale-group', 'decay-rate-group'] },
  rippletank:    { show: ['scale-group', 'rippletank-controls-group'] },
  cymatics:      { show: ['cymatics-controls-group'] },
  attractor:     { show: ['attractor-controls-group'] },
  stringart:     { show: ['stringart-controls-group'] },
  constellation: { show: ['constellation-controls-group'] },
  waterfall:     { show: ['waterfall-controls-group'] },
  weave:         { show: ['weave-controls-group'] },
  synthwave:     { show: ['synthwave-controls-group'] },
  bloom:         { show: ['bloom-controls-group'] },
  hive:          { show: ['hive-controls-group'] },
  marbling:      { show: ['marbling-controls-group'] },
  flowfield:     { show: ['flowfield-controls-group'] },
  truchet:       { show: ['truchet-controls-group'] },
  topography:    { show: ['topography-controls-group'] },
  interference:  { show: ['interference-controls-group'] },
  voronoi:       { show: ['voronoi-controls-group'] },
  blobs:         { show: ['blobs-controls-group'] },
  grayscott:     { show: ['grayscott-controls-group'] },
  growth:        { show: ['growth-controls-group'] },
  pixelsort:     { show: ['pixelsort-controls-group'] },
  echoes:        { show: ['echoes-controls-group'] },
  physarum:      { show: ['physarum-controls-group'] },
  geodesic:      { show: ['geodesic-controls-group'] },
  ribbons:       { show: ['ribbons-controls-group'] },
  infinitynet:   { show: ['infinitynet-controls-group'] },
  arabesque:     { show: ['arabesque-controls-group'] },
  murmuration:   { show: ['murmuration-controls-group'] },
  epicycles:     { show: ['epicycles-controls-group'] },
  knots:         { show: ['knots-controls-group'] },
  penrose:       { show: ['penrose-controls-group'] },
  flame:         { show: ['flame-controls-group'] },
  disorders:     { show: ['disorders-controls-group'] },
  blackwave:     { show: ['blackwave-controls-group'] },
  origami:       { show: ['origami-controls-group'] },
  lightfield:    { show: ['lightfield-controls-group'] },
  brush:         { show: ['brush-controls-group'] },
  aurora:        { show: ['aurora-controls-group'] },
  glitch:        { show: ['glitch-controls-group'] },
  warp:          { show: ['warp-controls-group'] },
  vortex:        { show: ['vortex-controls-group'] },
  lumia:         { show: ['lumia-controls-group'] },
  woodmirror:    { show: ['woodmirror-controls-group'] },
  moire:         { show: ['moire-controls-group'] },
  noctiluca:     { show: ['noctiluca-controls-group'] },
  tesseract:     { show: ['tesseract-controls-group'] },
  supershapes:   { show: ['supershapes-controls-group'] },
  corridor:      { show: ['corridor-controls-group'] },
  riemann:       { show: ['riemann-controls-group'] },
  glyphs:        { show: ['glyphs-controls-group'] },
  radiolaria:    { show: ['radiolaria-controls-group'] },
  ferrofluid:    { show: ['ferrofluid-controls-group'] },
  thermal:       { show: ['thermal-controls-group'] },
  kintsugi:      { show: ['kintsugi-controls-group'] },
  skyspace:      { show: ['skyspace-controls-group'] },
  morpho:        { show: ['morpho-controls-group'] },
  prism:         { show: ['prism-controls-group'] },
  cloth:         { show: ['cloth-controls-group'] },
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
  const micHiddenVizModes = ['liquidmetal', 'sculpture'];

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

    // Randomize sensitivity sliders
    for (const band of BANDS) {
      setSlider(band.sliderId, rand(1.0, 3.0));
    }

    // Randomize shared display sliders based on what's visible for this viz
    const ctrl = VIZ_CONTROLS[vizMode];
    const shown = ctrl.show;

    if (shown.includes('scale-group')) setSlider('spike-scale', rand(0.5, 2.0));
    if (shown.includes('decay-rate-group')) setSlider('decay-rate', rand(0.7, 0.95));
    if (shown.includes('rotation-speed-group')) setSlider('rotation-speed', rand(0.0, 15.0));
    if (shown.includes('intensity-group')) setSlider('viz-intensity', rand(0.5, 2.0));
    if (shown.includes('beat-division-group')) setSlider('beat-division', Math.floor(rand(1, 5)));

    // Randomize all viz-specific sliders using each input's own min/max range
    for (const groupId of shown) {
      if (['scale-group', 'decay-rate-group', 'rotation-speed-group',
           'intensity-group', 'beat-division-group', 'text-input-group',
           'circle-image-rotation-group'].includes(groupId)) continue;
      const group = document.getElementById(groupId);
      group?.querySelectorAll<HTMLInputElement>('input[type="range"]').forEach(input => {
        const min = parseFloat(input.min);
        const max = parseFloat(input.max);
        const step = parseFloat(input.step) || 0.01;
        const value = Math.round(rand(min, max) / step) * step;
        setSlider(input.id, Math.max(min, Math.min(max, value)));
      });
    }
  };

  btn.addEventListener('click', handler);
  return () => btn.removeEventListener('click', handler);
}
