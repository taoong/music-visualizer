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
  // Warp-specific
  warpSpeed: 0.4,
  warpDensity: 0.5,
  warpTrail: 0.6,
  // Vortex-specific
  vortexArms: 0.5,
  vortexTwist: 0.5,
  vortexSpeed: 0.5,
  // Lumia-specific
  lumiaForms: 0.5,
  lumiaDrift: 0.4,
  lumiaGlow: 0.6,
  // WoodMirror-specific
  woodmirrorDensity: 0.5,
  woodmirrorDepth: 0.55,
  woodmirrorSpeed: 0.45,
  // Moire-specific
  moireRings: 32,
  moireInterference: 1.0,
  moireContrast: 1.5,
  // Noctiluca-specific
  noctilucaDrift: 0.3,
  noctilucaBloom: 0.5,
  noctilucaWake:  0.55,

  tesseractLayers: 3,
  tesseractSpin:   0.5,
  tesseractGlow:   0.6,
  // Super Forms-specific
  supershapesSymmetry: 0.45,
  supershapesMorph:    0.60,
  supershapesGlow:     0.55,
  // Corridor-specific
  corridorSpeed:   0.5,
  corridorDepth:   8,
  corridorPalette: 0.6,
  // Riemann Sphere-specific
  riemannSpin: 0.4,
  riemannTilt: 0.4,
  riemannGlow: 0.6,
  // Glyphs-specific
  glyphsDensity: 0.4,
  glyphsScale:   0.4,
  glyphsDrift:   0.4,
  // Prism-specific
  prismFilm:    0.35,   // base film thickness — starts in blue/green soap-film range
  prismFlow:    0.40,   // moderate drift speed
  prismShimmer: 0.65,   // vivid iridescence by default
  // Cloth/Tapestry-specific
  clothDrape:   0.50,   // moderate gravity
  clothRipple:  0.50,   // moderate audio-force strength
  clothShimmer: 0.55,   // vivid metallic iridescence
  // Veil-specific
  veilThreads:   0.35,  // ~480 threads desktop / ~160 mobile
  veilOrder:     0.50,  // balanced smoke/crystal
  veilTrail:     0.55,  // moderate trail persistence
  // Suminagashi-specific
  suminagashiRings: 0.40, // moderate ring spawn rate
  suminagashiDrift: 0.35, // gentle source drift
  suminagashiBloom: 0.50, // balanced glow and trail
  // Isometric City
  isometricDensity: 0.45, // mid-range zoom: balanced city view
  isometricHeight:  0.55, // moderate height sensitivity
  isometricPalette: 0.05, // near-neon night by default
  // Pursuit
  pursuitSymmetry: 0.33, // N=6 (hexagon) — balanced spiral arms
  pursuitSpeed:    0.40, // moderate chase velocity
  pursuitTrail:    0.60, // medium-long persistence for mandala build-up
  // Arboreal-specific
  arbDepth:  0.50, // depth 4 — rich branching with good performance
  arbSpread: 0.42, // ~30° branching angle — balanced tree/coral shape
  arbGlow:   0.60, // vivid neon bloom with moderate trail
  // Etching-specific
  etchingLines: 10,   // 10 strokes per zone — visible hatching density
  etchingWave:  0.35, // moderate spatial frequency — organic undulation
  etchingGlow:  0.55, // balanced brightness and halo
  // Kintsugi-specific
  kintsugiFragility: 0.50, // moderate crack density on beats
  kintsugiGold:      0.45, // warm amber-gold by default
  kintsugiTrace:     0.50, // medium persistence — cracks linger ~3 seconds
  // Klimt-specific
  klimtTileSize:     0.50, // medium tile density
  klimtGold:         0.65, // warm vivid gold
  klimtComplexity:   0.55, // moderately ornate decorations
  // Rosette-specific
  rosettePetals: 0.40, // base petal count near 5 — rich without being too dense
  rosetteBloom:  0.75, // generous pen extension — vivid spirograph petal shapes
  rosetteGlow:   0.72, // moderate trail — mandala layering without full smear
  // Feedback Loop-specific
  feedbackZoom:   0.55, // moderate convergence — neither too tight nor too slow
  feedbackSpiral: 0.20, // gentle rotation — soft spiral rather than concentric
  feedbackGlow:   0.60, // solid ring brightness with visible glow
  // Kandinsky-specific
  kandinskyForms: 8,    // 8 forms per band (56 total) — painterly density
  kandinskyChaos: 0.40, // moderate drift — contemplative but alive
  kandinskyGlow:  0.65, // vivid glow and gentle trail persistence
  // Cobweb-specific
  cobwebDensity: 0.50, // mid complexity — 16 spokes, 10 rings
  cobwebDew:     0.55, // moderate dew-drop glow
  cobwebTension: 0.55, // moderate strand vibration
  // Frost
  frostSymmetry: 6,    // hexagonal (snowflake) symmetry
  frostGrowth:   1.0,  // medium branch density
  frostGlow:     1.0,  // medium bloom intensity
  // Boogie Woogie
  boogieGrid:    0.4,  // medium grid density
  boogiePulse:   0.6,  // moderate beat-burst intensity
  boogiePalette: 0.0,  // classic Mondrian (light mode)
  // Patchwork
  patchworkGrid:    0.35, // medium-coarse cell density
  patchworkPalette: 0.2,  // warm folk quilt palette
  patchworkMotion:  0.5,  // moderate pattern animation

  risographShapes: 2,    // 2 shapes per ink layer
  risographShift:  0.5,  // moderate mis-registration on beats
  risographBloom:  0.5,  // moderate glow halo
  // Lens Flare defaults
  lensflareStreak: 0.55, // moderate anamorphic streak length
  lensflareGhosts: 0.5,  // moderate ghost bokeh
  lensflareBloom:  0.5,  // moderate central bloom radius
  // Radiolaria defaults
  radiolariaSymmetry: 12, // 12-fold symmetry (like a radiolarian diatom)
  radiolariaShells:    4, // 4 concentric shells
  radiolariaGlow:    0.6, // vivid phosphor glow with moderate trail
  // Stitch defaults
  stitchGrid:  16,  // 16 px cell → medium-fine cross-stitch needlework
  stitchTrail: 0.6, // moderate thread persistence
  stitchGlow:  0.5, // moderate phosphor bloom around each X stitch

  // Magnetosphere defaults
  magnetosphereParticles: 0.45, // medium-density swarm
  magnetosphereGravity:   0.45, // moderate attractor pull
  magnetosphereTrail:     0.55, // medium comet tail persistence
  // Substrate defaults
  substrateDensity: 0.45, // medium crystal density
  substrateSpeed:   0.45, // moderate growth speed
  substrateGlow:    0.60, // vivid neon glow with moderate trail persistence
  // Ferrofluid defaults
  ferrofluidDensity:     0.40, // medium hex grid — balanced spike count
  ferrofluidHeight:      0.50, // moderate amplitude sensitivity
  ferrofluidIridescence: 0.55, // lightly iridescent tips, still reads as dark liquid
  // Cataract-specific
  cataractLines:   20,   // 20 wave bands — clear bands without feeling congested
  cataractWave:    0.55, // moderate amplitude — curves visible but don't cross
  cataractPalette: 0.20, // mostly Riley monochrome with a hint of color
  // Homage-specific
  homageGrid:    1,    // single central composition by default
  homageNesting: 6,    // 6 nested squares — rich but readable Albers study
  homagePalette: 0.15, // warm Albers "Solar" palette with a hint of cool
  // Tracery-specific
  traceryPetals: 6,    // 6 radial divisions — classic Gothic triforium rhythm
  traceryGlow:   0.6,  // vivid stained-glass inner light
  tracerySpin:   0.3,  // gentle clockwise drift
  // Protractor-specific
  protractorFans:   5,   // 5 fans — full compass-rose aesthetic from the start
  protractorRings:  12,  // 12 concentric arcs — rich rainbow banding
  protractorSpread: 0.5, // 165° sweep — fans overlap and blend without fully merging
  // Phyllotaxis defaults
  phyllotaxisSeeds: 500, // rich lattice showing clear Fibonacci spiral arms
  phyllotaxisSpin:  0.4, // gentle rotation — arms emerge without dizzying spin
  phyllotaxisBloom: 0.6, // responsive blooming without overwhelming at rest

  aetherTurbulence: 0.5, // moderate warp — shows both smooth and complex zones
  aetherFlow:       0.4, // gentle drift — patterns evolve without dizzying churn
  aetherPalette:    0.9, // vivid chromatic — full nebula colour field from the start
};

// FFT and decay constants
export const FFT_SIZE = isMobile ? 128 : 256;
export const DECAY_RATE_BASELINE = 0.88;
export const DECAY_RATE_EXPONENT = 3;

// Sentinel identifying the bundled sample track (not a fetchable path —
// engine.ts loads it via a dynamic import of src/assets/sampleAudio.ts).
export const SAMPLE_URL = 'sample.mp3';
export const SAMPLE_BPM = 140;
