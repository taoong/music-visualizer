/**
 * Constants for the Music Visualizer
 */
import type { FrequencyBand, Octave } from '../types';

// Mobile detection
export const isMobile =
  /Android|iPhone|iPad|iPod|webOS/i.test(navigator.userAgent) ||
  (navigator.maxTouchPoints > 1 && window.innerWidth < 1024);

// Visualization constants
export const SPIKES_PER_BAND = isMobile ? 30 : 60;

// Frequency band definitions
export const BANDS: FrequencyBand[] = [
  {
    name: 'sub',
    loHz: 20,
    hiHz: 60,
    scale: 3.0,
    sens: 'sensSub',
    sliderId: 'sens-sub',
    attack: 0.5,
    release: 0.08,
    defaultSens: 1.5,
  },
  {
    name: 'bass',
    loHz: 60,
    hiHz: 250,
    scale: 4.0,
    sens: 'sensBass',
    sliderId: 'sens-bass',
    attack: 0.55,
    release: 0.09,
    defaultSens: 1.2,
  },
  {
    name: 'lowMid',
    loHz: 250,
    hiHz: 500,
    scale: 6.0,
    sens: 'sensLowMid',
    sliderId: 'sens-low-mid',
    attack: 0.62,
    release: 0.1,
    defaultSens: 1.8,
  },
  {
    name: 'mid',
    loHz: 500,
    hiHz: 2000,
    scale: 8.0,
    sens: 'sensMid',
    sliderId: 'sens-mid',
    attack: 0.7,
    release: 0.11,
    defaultSens: 2.0,
  },
  {
    name: 'upperMid',
    loHz: 2000,
    hiHz: 4000,
    scale: 10.0,
    sens: 'sensUpperMid',
    sliderId: 'sens-upper-mid',
    attack: 0.78,
    release: 0.12,
    defaultSens: 2.0,
  },
  {
    name: 'presence',
    loHz: 4000,
    hiHz: 6000,
    scale: 12.0,
    sens: 'sensPresence',
    sliderId: 'sens-presence',
    attack: 0.83,
    release: 0.13,
    defaultSens: 2.0,
  },
  {
    name: 'brilliance',
    loHz: 6000,
    hiHz: 20000,
    scale: 14.0,
    sens: 'sensBrilliance',
    sliderId: 'sens-brilliance',
    attack: 0.88,
    release: 0.14,
    defaultSens: 2.0,
  },
];
export const BAND_COUNT = BANDS.length;

// Octave-based tunnel constants
export const OCTAVE_COUNT = 10;
export const OCTAVES: Octave[] = [
  { loHz: 27.5, hiHz: 55 },
  { loHz: 55, hiHz: 110 },
  { loHz: 110, hiHz: 220 },
  { loHz: 220, hiHz: 440 },
  { loHz: 440, hiHz: 880 },
  { loHz: 880, hiHz: 1760 },
  { loHz: 1760, hiHz: 3520 },
  { loHz: 3520, hiHz: 7040 },
  { loHz: 7040, hiHz: 14080 },
  { loHz: 14080, hiHz: 20000 },
];
export const OCTAVE_SCALES = [6.0, 5.0, 4.0, 3.5, 3.0, 3.0, 3.5, 4.0, 5.0, 6.0];

// Tunnel rendering constants
export const TUNNEL_GLOW_PASSES = [
  { widthMult: 6.0, alphaMult: 0.25 }, // outer glow
  { widthMult: 3.0, alphaMult: 0.55 }, // body
  { widthMult: 1.0, alphaMult: 1.0 }, // core
];
export const TUNNEL_BASE_BRIGHTNESS = 40;
export const TUNNEL_PERSPECTIVE_POWER = 1.8;
export const TUNNEL_PULSE_SCALE = 0.15;

// Auto-gain constants
export const AUTO_GAIN_FRAMES = isMobile ? 150 : 300;
export const AUTO_GAIN_FLOOR = 0.01;

// Transient detection constants
export const TRANSIENT_THRESHOLD = 1.8;
export const TRANSIENT_DECAY = 0.85;
export const TRANSIENT_BOOST = 1.5;
export const TRANSIENT_AVG_ALPHA = 0.05;

// Delta detection constants
export const DELTA_ATTACK = 0.7;
export const DELTA_RELEASE = 0.08;
export const DELTA_SPIKE_WIDTH_MIN = 0.08;
export const DELTA_SPIKE_WIDTH_MAX = 0.35;
export const DELTA_LENGTH_BOOST = 0.3;
export const DELTA_BRIGHTNESS_BOOST = 60;

// Spectral centroid constants
export const CENTROID_LOW_HZ = 80;
export const CENTROID_HIGH_HZ = 8000;
export const CENTROID_LOG_LOW = Math.log(CENTROID_LOW_HZ);
export const CENTROID_LOG_HIGH = Math.log(CENTROID_HIGH_HZ);
export const CENTROID_LOG_RANGE = CENTROID_LOG_HIGH - CENTROID_LOG_LOW;
export const CENTROID_SMOOTHING = 0.06;
export const CENTROID_Y_RANGE = 0.15;

// Default configuration
export const DEFAULT_CONFIG = {
  // Freq mode (7 bands)
  sensSub: 1.5,
  sensBass: 1.2,
  sensLowMid: 1.8,
  sensMid: 2.0,
  sensUpperMid: 2.0,
  sensPresence: 2.0,
  sensBrilliance: 2.0,
  // Shared
  spikeScale: 1.2,
  rotationSpeed: 0.3,
  masterVolume: 0.25,
  decayRate: 0.88, // Default decay rate (0.0 = instant, 1.0 = no decay)
  intensity: 1.0,
  beatDivision: 1,
  // Highway-specific
  highwayCamFollow: 0.35,
  highwayHorizon: 0.35,
  highwayRoadWidth: 0.46,
  highwayDaySpeed: 0.5,
  // Sculpture-specific
  sculptureZoom: 0.5,
  // Circle-specific
  circleImageRotation: 0.5,
  // Rippletank-specific
  rippletankBeatFreq: 1,
  rippletankWaterSpeed: 0.5,
  rippletankBeatSurge: 0.5,
  // Cymatics-specific
  cymaticsBeatFreq: 1,
  cymaticsSandSize: 0.5,
  cymaticsSandSpeed: 0.5,
  // Attractor-specific
  attractorChaos: 0.6,
  attractorTrailLength: 0.5,
  // String Art-specific
  stringartPins: 100,
  stringartMultiplier: 3,
  stringartSpeed: 1.0,
  // Constellation-specific
  constellationStarCount: 0.5,
  constellationConnRange: 0.4,
  constellationDriftSpeed: 0.3,
  // Waterfall-specific
  waterfallScrollSpeed: 0.4,
  waterfallGain: 0.125,
  waterfallHue: 0.7,
  // Weave-specific
  weaveThreads: 12,
  weaveGlow: 1.0,
  weavePulse: 1.0,
  // Synthwave-specific
  synthwaveSpeed: 1.0,
  synthwaveHorizon: 0.42,
  synthwaveGlow: 1.5,
  // Bloom-specific
  bloomDensity: 0.5,
  bloomLifespan: 0.5,
  bloomSpread: 0.5,
  // Hive-specific
  hiveHexSize: 0.45,
  hiveGlow: 0.5,
  hiveRipple: 0.5,
  // Marbling-specific
  marblingHue: 0.0,
  marblingZoom: 0.35,
  marblingSpeed: 0.4,
  // Flow Field-specific
  flowfieldTurbulence: 0.4,
  flowfieldTrail: 0.55,
  flowfieldWidth: 0.5,
  // Truchet-specific
  truchetGrid: 0.35,
  truchetSpeed: 0.6,
  truchetGlow: 1.0,
  // Topography-specific
  topographyResolution: 35,
  topographyLevels: 7,
  topographySpeed: 0.5,
  // Interference-specific
  interferenceFrequency: 0.35,
  interferenceTwist: 0.5,
  interferenceDrift: 0.35,
  // Voronoi Stained Glass-specific
  voronoiCells: 35,
  voronoiGlow: 1.0,
  voronoiShatter: 0.5,
  // Blobs-specific
  blobsViscosity: 0.4,
  blobsDrift: 0.4,
  blobsGlow: 0.5,
  // Gray-Scott-specific
  grayscottFeed: 0.45,
  grayscottKill: 0.60,
  grayscottSpeed: 0.33,
  // Growth-specific
  growthSpeed: 0.5,
  growthTension: 0.5,
  growthRepulsion: 0.5,
  // Pixel Sort-specific
  pixelsortThreshold: 0.45,
  pixelsortSpan: 0.40,
  pixelsortHue: 0.0,
  // Echoes-specific
  echoesDepth: 60,
  echoesTwist: 0.2,
  echoesScale: 0.6,
  // Physarum-specific
  physarumAgents: 1500,
  physarumEvaporation: 0.65,
  physarumSensor: 30,
  // Geodesic-specific
  geodesicShells: 3,
  geodesicSpin: 1.0,
  geodesicGlow: 1.5,
  // Ribbons-specific
  ribbonsCount: 7,
  ribbonsWave: 1.0,
  ribbonsShimmer: 0.5,
  // Infinity Net-specific
  infinitynetScale: 0.3,
  infinitynetBreathe: 0.7,
  infinitynetPalette: 0.0,
  // Arabesque-specific
  arabesqueSteps: 80,
  arabesqueSpeed: 0.4,
  arabesqueTrail: 0.65,
  // Murmuration-specific
  murmuBirds: 800,
  murmuCohesion: 0.5,
  murmuTrail: 0.6,
  // Epicycles-specific
  epicyclesCycles: 0.7,
  epicyclesSpeed: 0.3,
  epicyclesTrail: 0.5,
  // Knot-specific
  knotsBeatFreq: 1,
  knotsGlow: 1.0,
  knotsSpeed: 0.5,
  // Penrose-specific
  penroseDensity: 0.5,
  penroseSpin: 0.3,
  penroseGlow: 1.0,
  // Fractal Flame-specific
  flameDensity: 0.5,
  flameGlow: 1.0,
  flameMutation: 0.4,
  // Disorders-specific
  disordersGrid: 16,
  disordersChaos: 0.2,
  disordersInterrupt: 0.5,
  // Black Wave-specific
  blackwaveDensity: 0.5,
  blackwaveSwell: 0.4,
  blackwaveHue: 0.5,
  // Origami-specific
  origamiFold: 0.5,
  origamiGrid: 14,
  origamiWave: 0.5,
  // Light Field-specific
  lightfieldGrid: 0.5,
  lightfieldFlow: 0.4,
  lightfieldGlow: 1.0,
  // Brush-specific
  brushStrokes: 0.5,
  brushWeight: 0.5,
  brushTrail: 0.6,
  // Aurora-specific
  auroraFlow: 0.4,
  auroraLayers: 0.5,
  auroraGlow: 0.6,
  // Glitch-specific
  glitchDistort: 0.5,
  glitchSplit: 0.5,
  glitchNoise: 0.4,
  // Phase-specific
  phaseRings: 0.57,
  phaseDensity: 0.5,
  phaseGlow: 1.0,
  // Warp-specific
  warpSpeed: 0.4,
  warpDensity: 0.5,
  warpTrail: 0.6,
  // Substrate-specific
  substrateDensity: 0.5,
  substrateSpeed: 0.4,
  substrateFade: 0.6,
  // Smear-specific
  smearSweep: 0.5,
  smearBlend: 0.6,
  smearPalette: 0.5,
  // Ink-specific
  inkFlow: 0.5,
  inkDensity: 0.5,
  inkDry: 0.3,
  // Nebula-specific
  nebulaWarp: 0.5,
  nebulaDrift: 0.4,
  nebulaPalette: 0.0,
  // Vortex-specific
  vortexArms: 0.5,
  vortexTwist: 0.5,
  vortexSpeed: 0.5,
  // Lumia-specific
  lumiaForms: 0.5,
  lumiaDrift: 0.4,
  lumiaGlow: 0.6,
  // Mirrors-specific
  mirrorsReflections: 0.5,
  mirrorsScatter: 0.5,
  mirrorsShimmer: 0.4,
  // WoodMirror-specific
  woodmirrorDensity: 0.5,
  woodmirrorDepth: 0.55,
  woodmirrorSpeed: 0.45,
  // Disco-specific
  discoSpin: 0.4,
  discoSparkle: 0.5,
  discoPalette: 0.0,
  // Moire-specific
  moireRings: 32,
  moireInterference: 1.0,
  moireContrast: 1.5,
  // Radiolaria-specific
  radiolariaArms: 0.43,
  radiolariaShells: 0.5,
  radiolariaSpine: 0.5,
  radiolariaGlow: 1.0,
};

// FFT and decay constants
export const FFT_SIZE = isMobile ? 128 : 256;
export const DECAY_RATE_BASELINE = 0.88;
export const DECAY_RATE_EXPONENT = 3;

// Sample URL - use simple relative path for maximum compatibility
export const SAMPLE_URL = 'sample.mp3';
export const SAMPLE_BPM = 140;
