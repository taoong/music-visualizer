/**
 * UI Controller — thin orchestrator that wires all UI modules
 */
import { store } from '../state/store';
import type { VizMode } from '../types';
import { injectErrorStyles } from '../utils/errors';
import { setVisualizerText } from '../visualizations';
import { VIZ_REGISTRY } from '../visualizations/registry';
import { BANDS, isMobile } from '../utils/constants';
import { bindFileUpload, bindSampleButton, bindMicButton, bindModeSelector, bindPlayButton, bindImageUpload, bindSplashKeyboard } from './splash';
import { bindVolumeControl, bindSensitivitySliders, bindDisplaySliders, setSlider } from './sliders';
import { bindPauseButton, bindScrubber, bindTrackSwitching, bindImageControls, updateScrubberUI } from './playback';
import { initMidiUI } from '../midi/ui';
import { bindBPMControls } from './bpm';
import { triggerPad } from '../audio/performancePads';
import { bindAdminMode } from './admin';

export { updateScrubberUI };

/**
 * Initialize all UI event listeners
 */
export function initUI(): () => void {
  injectErrorStyles();

  const cleanupFns: (() => void)[] = [];

  // Mobile: collapse the playback bar down to name + scrubber + a
  // collapsible knob panel, moving everything else into the sidebar menu.
  // Must run before the other binds touch these elements — they're all
  // getElementById-based, so moving the nodes doesn't affect binding, but
  // doing it first avoids a visible layout jump on the native app's first paint.
  applyMobileLayout();

  // Sidebar toggle
  cleanupFns.push(bindSidebarToggle());
  cleanupFns.push(bindPerformancePads());

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
  cleanupFns.push(bindVizNameTag());

  // Randomize button
  cleanupFns.push(bindRandomizeButton());

  // BPM controls
  cleanupFns.push(bindBPMControls());

  // MIDI mapping UI
  initMidiUI();

  // Admin review mode
  cleanupFns.push(bindAdminMode());

  // Return combined cleanup function
  return () => cleanupFns.forEach(fn => fn());
}

/**
 * On touch/mobile devices, the playback bar used to carry everything —
 * pause, track switching, image upload, BPM, volume — crammed into one
 * row below the scrubber, with the full per-viz slider set only reachable
 * through the sidebar drawer. That left nothing on screen but a wall of
 * small icons, and no quick way to actually tweak the visualization you're
 * looking at. This reparents the DOM (not duplicates it — every element
 * keeps its id, so every existing getElementById-based binding still
 * works) into: a minimal always-visible bar (viz name / play / scrubber)
 * with a tap-to-expand knob panel for the active viz's own sliders, and
 * moves the secondary, non-real-time controls into the sidebar menu.
 * Desktop is untouched — there's room there for everything inline.
 */
function applyMobileLayout(): void {
  if (!isMobile) return;

  const playbackBar = document.getElementById('playback-bar');
  const vizNameTag = document.getElementById('viz-name-tag');
  const scrubberRow = document.getElementById('scrubber-row');
  const controlsRow = document.getElementById('controls-row');
  const pauseBtn = document.getElementById('pause-btn');
  const sidebar = document.getElementById('sidebar');
  const displaySection = document.getElementById('display-heading')?.closest('section') ?? null;
  const textInputGroup = document.getElementById('text-input-group');
  if (!playbackBar || !vizNameTag || !scrubberRow || !controlsRow || !pauseBtn || !sidebar) return;

  document.body.classList.add('mobile-layout');

  // Pause belongs with the scrubber — it's the one secondary control that's
  // still real-time-essential (you can't usefully see/seek audio you can't
  // also stop).
  scrubberRow.insertBefore(pauseBtn, scrubberRow.firstChild);

  // Wrap the name tag in a tappable handle that expands/collapses the knob
  // panel, with a chevron indicating state.
  const handle = document.createElement('button');
  handle.id = 'viz-panel-handle';
  handle.type = 'button';
  handle.setAttribute('aria-expanded', 'false');
  handle.setAttribute('aria-controls', 'mobile-knob-panel');
  playbackBar.insertBefore(handle, vizNameTag);
  handle.appendChild(vizNameTag);
  const chevron = document.createElement('span');
  chevron.id = 'viz-panel-chevron';
  chevron.setAttribute('aria-hidden', 'true');
  chevron.textContent = '▲';
  handle.appendChild(chevron);

  // The knob panel's content is the sidebar's existing "Display" section
  // (every shared + per-viz slider group) plus the text-input group —
  // reparented, so VIZ_CONTROLS show/hide and MIDI mapping keep working
  // unchanged; they're all id lookups, not position-dependent.
  const panel = document.createElement('div');
  panel.id = 'mobile-knob-panel';
  playbackBar.insertBefore(panel, scrubberRow);
  if (textInputGroup) panel.appendChild(textInputGroup);
  if (displaySection) panel.appendChild(displaySection);

  const togglePanel = (): void => {
    const isOpen = panel.classList.toggle('open');
    handle.setAttribute('aria-expanded', String(isOpen));
  };
  handle.addEventListener('click', togglePanel);

  // Everything else in the old controls row — track switching, image
  // upload, BPM, volume — isn't needed to tweak the visualization in real
  // time, so it moves into the sidebar menu instead of sitting on screen.
  const secondary = document.createElement('section');
  secondary.id = 'mobile-secondary-controls';
  secondary.setAttribute('aria-label', 'Playback');
  for (const id of ['track-info', 'image-group', 'bpm-group', 'volume-group']) {
    const el = document.getElementById(id);
    if (el) secondary.appendChild(el);
  }
  const sidebarHeading = sidebar.querySelector('h2');
  if (sidebarHeading?.nextSibling) {
    sidebar.insertBefore(secondary, sidebarHeading.nextSibling);
  } else {
    sidebar.appendChild(secondary);
  }

  controlsRow.remove();
}

function bindSidebarToggle(): () => void {
  const sidebar = document.getElementById('sidebar');
  const toggleBtn = document.getElementById('sidebar-toggle');

  if (!sidebar || !toggleBtn) return () => {};

  const handler = () => sidebar.classList.toggle('open');
  toggleBtn.addEventListener('click', handler);

  return () => toggleBtn.removeEventListener('click', handler);
}

function bindPerformancePads(): () => void {
  const pads = document.getElementById('performance-pads');
  const toggleBtn = document.getElementById('pads-toggle');
  const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('.pad-btn'));

  if (!pads || !toggleBtn) return () => {};

  // No longer needs to close the sidebar on open — the pads panel lives in
  // the bottom playback bar now (collapsed to zero height when closed)
  // instead of a full-height side panel, so the two no longer compete for
  // screen space.
  const toggleHandler = () => {
    pads.classList.toggle('open');
    toggleBtn.setAttribute('aria-expanded', String(pads.classList.contains('open')));
  };
  toggleBtn.addEventListener('click', toggleHandler);

  const padHandlers: Array<() => void> = [];
  for (const btn of buttons) {
    const padIndex = Number(btn.dataset.pad);
    const fire = () => {
      triggerPad(padIndex);
      // The CSS :active state alone would disappear the instant a quick tap
      // releases — too fast to register as "this did something." Holding a
      // flash class briefly makes the press visibly land even on a tap.
      btn.classList.add('firing');
      window.setTimeout(() => btn.classList.remove('firing'), 180);
    };
    btn.addEventListener('click', fire);
    padHandlers.push(() => btn.removeEventListener('click', fire));
  }

  return () => {
    toggleBtn.removeEventListener('click', toggleHandler);
    padHandlers.forEach(fn => fn());
  };
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
  'marbling-controls-group',
  'truchet-controls-group', 'topography-controls-group',
  'growth-controls-group',
  'pixelsort-controls-group', 'echoes-controls-group',
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
  'prism-controls-group',
  'cloth-controls-group',
  'veil-controls-group',
  'suminagashi-controls-group',
  'isometric-controls-group',
  'pursuit-controls-group',
  'arboreal-controls-group',
  'etching-controls-group',
  'kintsugi-controls-group',
  'klimt-controls-group',
  'rosette-controls-group',
  'feedbackloop-controls-group',
  'kandinsky-controls-group',
  'cobweb-controls-group',
  'frost-controls-group',
  'boogie-controls-group',
  'patchwork-controls-group',
  'risograph-controls-group',
  'lensflare-controls-group',
  'radiolaria-controls-group',
  'stitch-controls-group',
  'magnetosphere-controls-group',
  'substrate-controls-group',
  'ferrofluid-controls-group',
  'cataract-controls-group',
  'homage-controls-group',
  'tracery-controls-group',
  'protractor-controls-group',
  'phyllotaxis-controls-group',
  'aether-controls-group',
  'chromatic-controls-group',
  'particlelife-controls-group',
  'tableau-controls-group',
  'rorschach-controls-group',
  'pollock-controls-group',
  'julia-controls-group',
  'langton-controls-group',
  'anemone-controls-group',
  'meander-controls-group',
  'aggregation-controls-group',
  'hopf-controls-group',
  'reticulae-controls-group',
  'solidlight-controls-group',
  'crystaluniverse-controls-group',
  'skyspace-controls-group',
  'torusknot-controls-group',
  'cloister-controls-group',
  'melt-controls-group',
  'shard-controls-group',
  'stelae-controls-group',
  'orrery-controls-group',
  'kinetic-controls-group',
  'braid-controls-group',
  'vessels-controls-group',
  'massless-controls-group',
  'gossamer-controls-group',
  'dome-controls-group',
  'torque-controls-group',
  'tomography-controls-group',
  'gyroid-controls-group',
  'descent-controls-group',
  'drift-controls-group',
  'gridwarp-controls-group',
  'heliograph-controls-group',
  'tidal-controls-group',
  'specter-controls-group',
  'flux-controls-group',
  'oscillograph-controls-group',
  'strata-controls-group',
  'sonambient-controls-group',
  'aperture-controls-group',
  'nimbus-controls-group',
  'relay-controls-group',
  'reeds-controls-group',
  'chronicle-controls-group',
  'filaments-controls-group',
  'stringer-controls-group',
  'lamina-controls-group',
  'dispersion-controls-group',
  'foam-controls-group',
  'dune-controls-group',
  'spire-controls-group',
  'membrane-controls-group',
  'cinder-controls-group',
  'platter-controls-group',
  'typograph-controls-group',
  'tape-controls-group',
  'lattice-controls-group',
  'loom-controls-group',
  'penumbra-controls-group',
  'confluence-controls-group',
  'scanfield-controls-group',
  'fieldlines-controls-group',
  'lamella-controls-group',
  'grotto-controls-group',
  'folio-controls-group',
  'worm-controls-group',
  'shimmer-controls-group',
  'thermal-controls-group',
  'chrome-controls-group',
  'incision-controls-group',
  'harmonic-controls-group',
  'stacks-controls-group',
  'plexus-controls-group',
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
  neon:          { show: ['rotation-speed-group', 'intensity-group', 'decay-rate-group'],          labels: { rotation: 'Camera Rotation', intensity: 'Intensity', decayRate: 'Camera Height' } },
  sculpture:     { show: ['rotation-speed-group', 'intensity-group', 'sculpture-controls-group'], labels: { intensity: 'Bloom Strength' } },
  binary:        { show: ['scale-group', 'decay-rate-group'] },
  rippletank:    { show: ['scale-group', 'rippletank-controls-group'] },
  cymatics:      { show: ['cymatics-controls-group'] },
  attractor:     { show: ['attractor-controls-group'] },
  stringart:     { show: ['stringart-controls-group'] },
  constellation: { show: ['constellation-controls-group'] },
  waterfall:     { show: ['waterfall-controls-group'] },
  marbling:      { show: ['marbling-controls-group'] },
  truchet:       { show: ['truchet-controls-group'] },
  topography:    { show: ['topography-controls-group'] },
  growth:        { show: ['growth-controls-group'] },
  pixelsort:     { show: ['pixelsort-controls-group'] },
  echoes:        { show: ['echoes-controls-group'] },
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
  prism:         { show: ['prism-controls-group'] },
  cloth:         { show: ['cloth-controls-group'] },
  veil:          { show: ['veil-controls-group'] },
  suminagashi:   { show: ['suminagashi-controls-group'] },
  isometric:     { show: ['isometric-controls-group'] },
  pursuit:       { show: ['pursuit-controls-group'] },
  arboreal:      { show: ['arboreal-controls-group'] },
  etching:       { show: ['etching-controls-group'] },
  kintsugi:      { show: ['kintsugi-controls-group'] },
  klimt:         { show: ['klimt-controls-group'] },
  rosette:       { show: ['rosette-controls-group'] },
  feedbackloop:  { show: ['feedbackloop-controls-group'] },
  kandinsky:     { show: ['kandinsky-controls-group'] },
  cobweb:        { show: ['cobweb-controls-group'] },
  frost:         { show: ['frost-controls-group'] },
  boogie:        { show: ['boogie-controls-group'] },
  patchwork:     { show: ['patchwork-controls-group'] },
  risograph:     { show: ['risograph-controls-group'] },
  lensflare:     { show: ['lensflare-controls-group'] },
  radiolaria:    { show: ['radiolaria-controls-group'] },
  stitch:        { show: ['stitch-controls-group'] },
  magnetosphere: { show: ['magnetosphere-controls-group'] },
  substrate:     { show: ['substrate-controls-group'] },
  ferrofluid:    { show: ['ferrofluid-controls-group'] },
  cataract:      { show: ['cataract-controls-group'] },
  homage:        { show: ['homage-controls-group'] },
  tracery:       { show: ['tracery-controls-group'] },
  protractor:    { show: ['protractor-controls-group'] },
  phyllotaxis:   { show: ['phyllotaxis-controls-group'] },
  aether:        { show: ['aether-controls-group'] },
  chromatic:     { show: ['chromatic-controls-group'] },
  particlelife:  { show: ['particlelife-controls-group'] },
  tableau:       { show: ['tableau-controls-group'] },
  rorschach:     { show: ['rorschach-controls-group'] },
  pollock:       { show: ['pollock-controls-group'] },
  julia:         { show: ['julia-controls-group'] },
  langton:       { show: ['langton-controls-group'] },
  anemone:       { show: ['anemone-controls-group'] },
  meander:       { show: ['meander-controls-group'] },
  aggregation:   { show: ['aggregation-controls-group'] },
  hopf:          { show: ['hopf-controls-group'] },
  reticulae:     { show: ['reticulae-controls-group'] },
  solidlight:       { show: ['solidlight-controls-group'] },
  crystaluniverse:  { show: ['crystaluniverse-controls-group'] },
  skyspace:         { show: ['skyspace-controls-group'] },
  torusknot:        { show: ['torusknot-controls-group'] },
  cloister:         { show: ['cloister-controls-group'] },
  melt:             { show: ['melt-controls-group'] },
  shard:            { show: ['shard-controls-group'] },
  stelae:           { show: ['stelae-controls-group'] },
  orrery:           { show: ['orrery-controls-group'] },
  kinetic:          { show: ['kinetic-controls-group'] },
  braid:            { show: ['braid-controls-group'] },
  vessels:          { show: ['vessels-controls-group'] },
  massless:         { show: ['massless-controls-group'] },
  gossamer:         { show: ['gossamer-controls-group'] },
  dome:             { show: ['dome-controls-group'] },
  torque:           { show: ['torque-controls-group'] },
  tomography:       { show: ['tomography-controls-group'] },
  gyroid:           { show: ['gyroid-controls-group'] },
  descent:          { show: ['descent-controls-group'] },
  drift:            { show: ['drift-controls-group'] },
  gridwarp:         { show: ['gridwarp-controls-group'] },
  heliograph:       { show: ['heliograph-controls-group'] },
  tidal:            { show: ['tidal-controls-group'] },
  specter:          { show: ['specter-controls-group'] },
  flux:             { show: ['flux-controls-group'] },
  oscillograph:     { show: ['oscillograph-controls-group'] },
  strata:           { show: ['strata-controls-group'] },
  sonambient:       { show: ['sonambient-controls-group'] },
  aperture:         { show: ['aperture-controls-group'] },
  nimbus:           { show: ['nimbus-controls-group'] },
  relay:            { show: ['relay-controls-group'] },
  reeds:            { show: ['reeds-controls-group'] },
  chronicle:        { show: ['chronicle-controls-group'] },
  filaments:        { show: ['filaments-controls-group'] },
  stringer:         { show: ['stringer-controls-group'] },
  lamina:           { show: ['lamina-controls-group'] },
  dispersion:       { show: ['dispersion-controls-group'] },
  foam:             { show: ['foam-controls-group'] },
  dune:             { show: ['dune-controls-group'] },
  spire:            { show: ['spire-controls-group'] },
  membrane:         { show: ['membrane-controls-group'] },
  cinder:           { show: ['cinder-controls-group'] },
  platter:          { show: ['platter-controls-group'] },
  typograph:        { show: ['typograph-controls-group'] },
  tape:             { show: ['tape-controls-group'] },
  lattice:          { show: ['lattice-controls-group'] },
  loom:             { show: ['loom-controls-group'] },
  penumbra:         { show: ['penumbra-controls-group'] },
  confluence:       { show: ['confluence-controls-group'] },
  scanfield:        { show: ['scanfield-controls-group'] },
  fieldlines:       { show: ['fieldlines-controls-group'] },
  lamella:          { show: ['lamella-controls-group'] },
  grotto:           { show: ['grotto-controls-group'] },
  folio:            { show: ['folio-controls-group'] },
  worm:             { show: ['worm-controls-group'] },
  shimmer:          { show: ['shimmer-controls-group'] },
  thermal:          { show: ['thermal-controls-group'] },
  chrome:           { show: ['chrome-controls-group'] },
  incision:         { show: ['incision-controls-group'] },
  harmonic:         { show: ['harmonic-controls-group'] },
  stacks:           { show: ['stacks-controls-group'] },
  plexus:           { show: ['plexus-controls-group'] },
};

function bindVizNameTag(): () => void {
  const tag = document.getElementById('viz-name-tag');
  if (!tag) return () => {};

  const update = (data?: unknown) => {
    const mode = (data as VizMode) ?? store.state.vizMode;
    tag.textContent = VIZ_REGISTRY[mode]?.label ?? mode;
  };

  update();
  return store.on('vizModeChange', update);
}

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
  const micHiddenVizModes = ['sculpture'];

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
