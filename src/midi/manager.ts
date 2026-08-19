/**
 * MIDI Manager — Web MIDI API access, CC listener, mapping storage
 */
import type { Config, MidiMapping, MidiMappings } from '../types';

const STORAGE_KEY = 'visualizer-midi-mappings';

// Config key → slider DOM ID
const CONFIG_TO_SLIDER: Record<keyof Config, string> = {
  sensSub: 'sens-sub',
  sensBass: 'sens-bass',
  sensLowMid: 'sens-low-mid',
  sensMid: 'sens-mid',
  sensUpperMid: 'sens-upper-mid',
  sensPresence: 'sens-presence',
  sensBrilliance: 'sens-brilliance',
  spikeScale: 'spike-scale',
  decayRate: 'decay-rate',
  rotationSpeed: 'rotation-speed',
  intensity: 'viz-intensity',
  beatDivision: 'beat-division',
  masterVolume: 'master-volume',
  highwayCamFollow: 'highway-cam-follow',
  highwayHorizon: 'highway-horizon',
  highwayRoadWidth: 'highway-road-width',
  highwayDaySpeed: 'highway-day-speed',
  sculptureZoom: 'sculpture-zoom',
  circleImageRotation: 'circle-image-rotation',
  rippletankBeatFreq: 'rippletank-beat-freq',
  rippletankWaterSpeed: 'rippletank-water-speed',
  rippletankBeatSurge: 'rippletank-beat-surge',
  cymaticsBeatFreq: 'cymatics-beat-freq',
  cymaticsSandSize: 'cymatics-sand-size',
  cymaticsSandSpeed: 'cymatics-sand-speed',
  attractorChaos: 'attractor-chaos',
  attractorTrailLength: 'attractor-trail-length',
  stringartPins: 'stringart-pins',
  stringartMultiplier: 'stringart-multiplier',
  stringartSpeed: 'stringart-speed',
  constellationStarCount: 'constellation-star-count',
  constellationConnRange: 'constellation-conn-range',
  constellationDriftSpeed: 'constellation-drift-speed',
  waterfallScrollSpeed: 'waterfall-scroll-speed',
  waterfallGain: 'waterfall-gain',
  waterfallHue: 'waterfall-hue',
  weaveThreads: 'weave-threads',
  weaveGlow: 'weave-glow',
  weavePulse: 'weave-pulse',
  synthwaveSpeed: 'synthwave-speed',
  synthwaveHorizon: 'synthwave-horizon',
  synthwaveGlow: 'synthwave-glow',
  bloomDensity: 'bloom-density',
  bloomLifespan: 'bloom-lifespan',
  bloomSpread: 'bloom-spread',
  hiveHexSize: 'hive-hex-size',
  hiveGlow: 'hive-glow',
  hiveRipple: 'hive-ripple',
  marblingHue: 'marbling-hue',
  marblingZoom: 'marbling-zoom',
  marblingSpeed: 'marbling-speed',
  flowfieldTurbulence: 'flowfield-turbulence',
  flowfieldTrail: 'flowfield-trail',
  flowfieldWidth: 'flowfield-width',
  truchetGrid: 'truchet-grid',
  truchetSpeed: 'truchet-speed',
  truchetGlow: 'truchet-glow',
  topographyResolution: 'topography-resolution',
  topographyLevels: 'topography-levels',
  topographySpeed: 'topography-speed',
  interferenceFrequency: 'interference-frequency',
  interferenceTwist: 'interference-twist',
  interferenceDrift: 'interference-drift',
  voronoiCells: 'voronoi-cells',
  voronoiGlow: 'voronoi-glow',
  voronoiShatter: 'voronoi-shatter',
  blobsViscosity: 'blobs-viscosity',
  blobsDrift: 'blobs-drift',
  blobsGlow: 'blobs-glow',
  grayscottFeed: 'grayscott-feed',
  grayscottKill: 'grayscott-kill',
  grayscottSpeed: 'grayscott-speed',
  growthSpeed: 'growth-speed',
  growthTension: 'growth-tension',
  growthRepulsion: 'growth-repulsion',
  pixelsortThreshold: 'pixelsort-threshold',
  pixelsortSpan: 'pixelsort-span',
  pixelsortHue: 'pixelsort-hue',
  echoesDepth: 'echoes-depth',
  echoesTwist: 'echoes-twist',
  echoesScale: 'echoes-scale',
  physarumAgents: 'physarum-agents',
  physarumEvaporation: 'physarum-evaporation',
  physarumSensor: 'physarum-sensor',
  geodesicShells: 'geodesic-shells',
  geodesicSpin: 'geodesic-spin',
  geodesicGlow: 'geodesic-glow',
  ribbonsCount: 'ribbons-count',
  ribbonsWave: 'ribbons-wave',
  ribbonsShimmer: 'ribbons-shimmer',
  infinitynetScale: 'infinitynet-scale',
  infinitynetBreathe: 'infinitynet-breathe',
  infinitynetPalette: 'infinitynet-palette',
  arabesqueSteps: 'arabesque-steps',
  arabesqueSpeed: 'arabesque-speed',
  arabesqueTrail: 'arabesque-trail',
  murmuBirds: 'murmu-birds',
  murmuCohesion: 'murmu-cohesion',
  murmuTrail: 'murmu-trail',
  epicyclesCycles: 'epicycles-cycles',
  epicyclesSpeed: 'epicycles-speed',
  epicyclesTrail: 'epicycles-trail',
  knotsBeatFreq: 'knots-beat-freq',
  knotsGlow: 'knots-glow',
  knotsSpeed: 'knots-speed',
  penroseDensity: 'penrose-density',
  penroseSpin: 'penrose-spin',
  penroseGlow: 'penrose-glow',
  flameDensity: 'flame-density',
  flameGlow: 'flame-glow',
  flameMutation: 'flame-mutation',
  disordersGrid: 'disorders-grid',
  disordersChaos: 'disorders-chaos',
  disordersInterrupt: 'disorders-interrupt',
  blackwaveDensity: 'blackwave-density',
  blackwaveSwell: 'blackwave-swell',
  blackwaveHue: 'blackwave-hue',
  origamiFold: 'origami-fold',
  origamiGrid: 'origami-grid',
  origamiWave: 'origami-wave',
  lightfieldGrid: 'lightfield-grid',
  lightfieldFlow: 'lightfield-flow',
  lightfieldGlow: 'lightfield-glow',
  brushStrokes: 'brush-strokes',
  brushWeight: 'brush-weight',
  brushTrail: 'brush-trail',
  auroraFlow: 'aurora-flow',
  auroraLayers: 'aurora-layers',
  auroraGlow: 'aurora-glow',
  glitchDistort: 'glitch-distort',
  glitchSplit: 'glitch-split',
  glitchNoise: 'glitch-noise',
  warpSpeed: 'warp-speed',
  warpDensity: 'warp-density',
  warpTrail: 'warp-trail',
  vortexArms: 'vortex-arms',
  vortexTwist: 'vortex-twist',
  vortexSpeed: 'vortex-speed',
  lumiaForms: 'lumia-forms',
  lumiaDrift: 'lumia-drift',
  lumiaGlow: 'lumia-glow',
  woodmirrorDensity: 'woodmirror-density',
  woodmirrorDepth: 'woodmirror-depth',
  woodmirrorSpeed: 'woodmirror-speed',
  moireRings: 'moire-rings',
  moireInterference: 'moire-interference',
  moireContrast: 'moire-contrast',
  noctilucaDrift: 'noctiluca-drift',
  noctilucaBloom: 'noctiluca-bloom',
  noctilucaWake:  'noctiluca-wake',
  tesseractLayers: 'tesseract-layers',
  tesseractSpin:   'tesseract-spin',
  tesseractGlow:   'tesseract-glow',
  supershapesSymmetry: 'supershapes-symmetry',
  supershapesMorph:    'supershapes-morph',
  supershapesGlow:     'supershapes-glow',
  corridorSpeed:   'corridor-speed',
  corridorDepth:   'corridor-depth',
  corridorPalette: 'corridor-palette',
  riemannSpin: 'riemann-spin',
  riemannTilt: 'riemann-tilt',
  riemannGlow: 'riemann-glow',
  glyphsDensity: 'glyphs-density',
  glyphsScale:   'glyphs-scale',
  glyphsDrift:   'glyphs-drift',
  prismFilm:     'prism-film',
  prismFlow:     'prism-flow',
  prismShimmer:  'prism-shimmer',
  clothDrape:    'cloth-drape',
  clothRipple:   'cloth-ripple',
  clothShimmer:  'cloth-shimmer',
  veilThreads:    'veil-threads',
  veilOrder:      'veil-order',
  veilTrail:      'veil-trail',
  suminagashiRings: 'suminagashi-rings',
  suminagashiDrift: 'suminagashi-drift',
  suminagashiBloom: 'suminagashi-bloom',
  isometricDensity: 'isometric-density',
  isometricHeight:  'isometric-height',
  isometricPalette: 'isometric-palette',
  pursuitSymmetry:  'pursuit-symmetry',
  pursuitSpeed:     'pursuit-speed',
  pursuitTrail:     'pursuit-trail',
  arbDepth:  'arb-depth',
  arbSpread: 'arb-spread',
  arbGlow:   'arb-glow',
  etchingLines: 'etching-lines',
  etchingWave:  'etching-wave',
  etchingGlow:  'etching-glow',
  kintsugiFragility: 'kintsugi-fragility',
  kintsugiGold:      'kintsugi-gold',
  kintsugiTrace:     'kintsugi-trace',
  klimtTileSize:     'klimt-tile-size',
  klimtGold:         'klimt-gold',
  klimtComplexity:   'klimt-complexity',
  rosettePetals: 'rosette-petals',
  rosetteBloom:  'rosette-bloom',
  rosetteGlow:   'rosette-glow',
  feedbackZoom:   'feedback-zoom',
  feedbackSpiral: 'feedback-spiral',
  feedbackGlow:   'feedback-glow',
  kandinskyForms: 'kandinsky-forms',
  kandinskyChaos: 'kandinsky-chaos',
  kandinskyGlow:  'kandinsky-glow',
  cobwebDensity: 'cobweb-density',
  cobwebDew:     'cobweb-dew',
  cobwebTension: 'cobweb-tension',
};

type MidiStatus = 'unsupported' | 'denied' | 'no-devices' | 'connected';

let midiAccess: MIDIAccess | null = null;
let status: MidiStatus = 'unsupported';
let mappings: MidiMappings = {};
// reverse map: "channel:cc" → configKey
let reverseMap: Map<string, keyof Config> = new Map();

interface MappingModeState {
  configKey: keyof Config;
  resolve: (mapping: MidiMapping) => void;
  reject: (reason?: unknown) => void;
}
let mappingMode: MappingModeState | null = null;

const changeListeners: Set<() => void> = new Set();

function notifyListeners(): void {
  for (const fn of changeListeners) fn();
}

function buildReverseMap(): void {
  reverseMap = new Map();
  for (const [key, mapping] of Object.entries(mappings) as [keyof Config, MidiMapping][]) {
    if (mapping) {
      reverseMap.set(`${mapping.channel}:${mapping.cc}`, key);
    }
  }
}

function persistMappings(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(mappings));
  } catch {
    // localStorage unavailable
  }
}

function loadMappings(): void {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      mappings = JSON.parse(raw) as MidiMappings;
      buildReverseMap();
    }
  } catch {
    mappings = {};
  }
}

function handleMidiMessage(event: MIDIMessageEvent): void {
  const data = event.data;
  if (!data || data.length < 3) return;

  const statusByte = data[0];
  // Only handle CC messages (0xB0– 0xBF)
  if ((statusByte & 0xf0) !== 0xb0) return;

  const channel = (statusByte & 0x0f) + 1;
  const cc = data[1];
  const value = data[2];

  if (mappingMode) {
    // Save the mapping
    const { configKey, resolve } = mappingMode;
    mappingMode = null;
    const newMapping: MidiMapping = { channel, cc };
    mappings[configKey] = newMapping;
    buildReverseMap();
    persistMappings();
    notifyListeners();
    resolve(newMapping);
    return;
  }

  // Look up configKey in reverse map
  const key = `${channel}:${cc}`;
  const configKey = reverseMap.get(key);
  if (!configKey) return;

  const sliderId = CONFIG_TO_SLIDER[configKey];
  if (!sliderId) return;

  const slider = document.getElementById(sliderId) as HTMLInputElement | null;
  if (!slider) return;

  const min = parseFloat(slider.min) || 0;
  const max = parseFloat(slider.max) || 1;
  const mapped = min + (value / 127) * (max - min);

  slider.value = String(mapped);
  slider.dispatchEvent(new Event('input', { bubbles: true }));
}

function attachToAllInputs(): void {
  if (!midiAccess) return;
  for (const input of midiAccess.inputs.values()) {
    input.onmidimessage = handleMidiMessage;
  }
  updateStatus();
}

function updateStatus(): void {
  if (!midiAccess) return;
  const prev = status;
  status = midiAccess.inputs.size > 0 ? 'connected' : 'no-devices';
  if (prev !== status) notifyListeners();
}

export async function initMidi(): Promise<boolean> {
  loadMappings();

  if (!navigator.requestMIDIAccess) {
    status = 'unsupported';
    return false;
  }

  try {
    midiAccess = await navigator.requestMIDIAccess();
    attachToAllInputs();
    midiAccess.onstatechange = () => {
      attachToAllInputs();
    };
    return true;
  } catch {
    status = 'denied';
    return false;
  }
}

export function getMidiStatus(): MidiStatus {
  return status;
}

export function getMappings(): Readonly<MidiMappings> {
  return mappings;
}

export function startMappingMode(configKey: keyof Config): Promise<MidiMapping> {
  // Cancel any existing mapping mode
  if (mappingMode) {
    mappingMode.reject(new Error('Cancelled'));
    mappingMode = null;
  }

  return new Promise<MidiMapping>((resolve, reject) => {
    mappingMode = { configKey, resolve, reject };
  });
}

export function cancelMappingMode(): void {
  if (mappingMode) {
    mappingMode.reject(new Error('Cancelled'));
    mappingMode = null;
  }
}

export function getActiveMappingKey(): keyof Config | null {
  return mappingMode ? mappingMode.configKey : null;
}

export function clearMapping(configKey: keyof Config): void {
  delete mappings[configKey];
  buildReverseMap();
  persistMappings();
  notifyListeners();
}

export function clearAllMappings(): void {
  mappings = {};
  reverseMap = new Map();
  persistMappings();
  notifyListeners();
}

export function onMappingsChange(fn: () => void): () => void {
  changeListeners.add(fn);
  return () => changeListeners.delete(fn);
}
