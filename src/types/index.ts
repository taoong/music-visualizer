/**
 * Core type definitions for Music Visualizer
 */

// Audio analysis modes
export type AnalysisMode = 'freq' | 'stems' | 'mic';
export type VizMode = 'circle' | 'spectrum' | 'tunnel' | 'tetris' | 'lasers' | 'text' | 'highway' | 'liquidmetal' | 'neon' | 'imagegrid' | 'colormap' | 'sculpture' | 'binary' | 'tungtung' | 'aurora' | 'bootsandcats' | 'rippletank' | 'cymatics' | 'cloudchamber' | 'attractor' | 'mandala' | 'stringart' | 'constellation' | 'petals' | 'waterfall' | 'kaleido' | 'kaleidoscope' | 'weave' | 'synthwave' | 'bloom' | 'monolith' | 'hive' | 'marbling' | 'flowfield' | 'lissajous' | 'truchet' | 'topography' | 'interference' | 'voronoi' | 'blobs' | 'grayscott' | 'growth' | 'pixelsort' | 'echoes' | 'physarum' | 'optical' | 'geodesic' | 'ribbons' | 'infinitynet' | 'zengarden' | 'arabesque';

// Frequency band definitions
export interface FrequencyBand {
  name: string;
  loHz: number;
  hiHz: number;
  scale: number;
  sens: string;
  sliderId: string;
  attack: number;
  release: number;
  defaultSens: number;
}

// Stem types
export type StemType = 'kick' | 'drums' | 'bass' | 'vocals' | 'other';

// Octave definitions for tunnel visualization
export interface Octave {
  loHz: number;
  hiHz: number;
}

// Configuration object
export interface Config {
  // Freq mode sensitivities
  sensSub: number;
  sensBass: number;
  sensLowMid: number;
  sensMid: number;
  sensUpperMid: number;
  sensPresence: number;
  sensBrilliance: number;
  // Stem mode sensitivities
  sensKick: number;
  sensDrums: number;
  sensStemBass: number;
  sensVocals: number;
  sensOther: number;
  // Shared
  spikeScale: number;
  rotationSpeed: number;
  masterVolume: number;
  decayRate: number;
  intensity: number;
  beatDivision: number;
  // Highway-specific
  highwayCamFollow: number;
  highwayHorizon: number;
  highwayRoadWidth: number;
  highwayDaySpeed: number;
  // Sculpture-specific
  sculptureZoom: number;
  // Circle-specific
  circleImageRotation: number;
  // Boots & Cats-specific
  bootsAcceleration: number;
  // Rippletank-specific
  rippletankBeatFreq: number;
  rippletankWaterSpeed: number;
  rippletankBeatSurge: number;
  // Cymatics-specific
  cymaticsBeatFreq: number;
  cymaticsSandSize: number;
  cymaticsSandSpeed: number;
  // Cloud Chamber-specific
  cloudMagneticField: number;
  cloudParticleLife: number;
  cloudBeatFreq: number;
  cloudBeatBoost: number;
  // Attractor-specific
  attractorChaos: number;
  attractorTrailLength: number;
  // Mandala-specific
  mandalaBeatFreq: number;
  mandalaGridSpeed: number;
  mandalaHexSpeed: number;
  mandalaSquareSpeed: number;
  mandalaTriSpeed: number;
  mandalaCircleSpeed: number;
  // String Art-specific
  stringartPins: number;
  stringartMultiplier: number;
  stringartSpeed: number;
  // Constellation-specific
  constellationStarCount: number;
  constellationConnRange: number;
  constellationDriftSpeed: number;
  // Petal Bloom-specific
  petalsPetalCount: number;
  petalsBloomScale: number;
  petalsSpinSpeed: number;
  // Waterfall-specific
  waterfallScrollSpeed: number;
  waterfallGain: number;
  waterfallHue: number;
  // Kaleido-specific
  kaleidoSegments: number;
  kaleidoTrail: number;
  kaleidoSmear: number;
  // Kaleidoscope-specific
  kaleidoscopeSegments: number;
  kaleidoscopeComplexity: number;
  kaleidoscopeSpinSpeed: number;
  // Weave-specific
  weaveThreads: number;
  weaveGlow: number;
  weavePulse: number;
  // Synthwave-specific
  synthwaveSpeed: number;
  synthwaveHorizon: number;
  synthwaveGlow: number;
  // Bloom-specific
  bloomDensity: number;
  bloomLifespan: number;
  bloomSpread: number;
  // Hive-specific
  hiveHexSize: number;
  hiveGlow: number;
  hiveRipple: number;
  // Marbling-specific
  marblingHue: number;
  marblingZoom: number;
  marblingSpeed: number;
  // Flow Field-specific
  flowfieldTurbulence: number;
  flowfieldTrail: number;
  flowfieldWidth: number;
  // Lissajous-specific
  lissajousCurves: number;
  lissajousGlow: number;
  lissajousDrift: number;
  // Truchet-specific
  truchetGrid: number;
  truchetSpeed: number;
  truchetGlow: number;
  // Topography-specific
  topographyResolution: number;
  topographyLevels: number;
  topographySpeed: number;
  // Interference-specific
  interferenceFrequency: number;
  interferenceTwist: number;
  interferenceDrift: number;
  // Voronoi Stained Glass-specific
  voronoiCells: number;
  voronoiGlow: number;
  voronoiShatter: number;
  // Blobs-specific
  blobsViscosity: number;
  blobsDrift: number;
  blobsGlow: number;
  // Gray-Scott-specific
  grayscottFeed: number;
  grayscottKill: number;
  grayscottSpeed: number;
  // Growth-specific
  growthSpeed: number;
  growthTension: number;
  growthRepulsion: number;
  // Pixel Sort-specific
  pixelsortThreshold: number;
  pixelsortSpan: number;
  pixelsortHue: number;
  // Echoes-specific
  echoesDepth: number;
  echoesTwist: number;
  echoesScale: number;
  // Physarum-specific
  physarumAgents: number;
  physarumEvaporation: number;
  physarumSensor: number;
  // Optical (Op-Art)-specific
  opticalGrid: number;
  opticalBulge: number;
  opticalColor: number;
  // Geodesic-specific
  geodesicShells: number;
  geodesicSpin: number;
  geodesicGlow: number;
  // Ribbons-specific
  ribbonsCount: number;
  ribbonsWave: number;
  ribbonsShimmer: number;
  // Infinity Net-specific
  infinitynetScale: number;
  infinitynetBreathe: number;
  infinitynetPalette: number;
  // Zen Garden-specific
  zengardenLines: number;
  zengardenDepth: number;
  zengardenRocks: number;
  // Arabesque-specific
  arabesqueSteps: number;
  arabesqueSpeed: number;
  arabesqueTrail: number;
}

// Application state
export interface AppState {
  mode: AnalysisMode;
  vizMode: VizMode;
  audioReady: boolean;
  isPlaying: boolean;
  useSample: boolean;
  userFile: File | null;
  currentObjectUrl: string | null;
  currentSampleBlobUrl: string | null;

  // Playback timing
  playStartedAt: number;
  startOffset: number;
  isSeeking: boolean;

  // Beat detection
  circleOutlineHue: number;
  detectedBPM: number;
  beatIntervalSec: number;
  lastBeatIndex: number;
  beatOffset: number;

}

// Wormhole visualization types
export interface WormholeEvent {
  time: number;
  band: number;
  magnitude: number;
  /** Pre-assigned value in [0, 1) used for deterministic density filtering by intensity. */
  spawnSeed: number;
}

export interface ActiveObject {
  band: number;
  hitTime: number;
  z: number;
  worldX: number;
  worldY: number;
  magnitude: number;
  hitFlash: number;
  expired: boolean;
}

// Audio processing state
export interface AudioProcessingState {
  // Smoothed band data
  smoothedBands: Float32Array[];
  transientValues: Float32Array;
  deltaValues: Float32Array;

  // Auto-gain trackers
  autoGainBands: AutoGainTracker[];
  autoGainStems: Record<string, AutoGainTracker>;

  // Transient detection
  transientBands: TransientState[];
  transientStems: Record<string, TransientState>;

  // Delta (rate of change) detection
  deltaBands: DeltaState[];
  deltaStems: Record<string, DeltaState>;

  // Waveform time-domain data
  waveformData: Float32Array;

  // Spectral centroid
  smoothedCentroid: number;
  centroidYOffset: number;

  // Octave-based state (tunnel mode)
  smoothedOctaves: Float32Array;
  octaveTransients: TransientState[];
  octaveTransientValues: Float32Array;
  octaveDeltas: DeltaState[];
  octaveDeltaValues: Float32Array;
  autoGainOctaves: AutoGainTracker;
}

export interface AutoGainTracker {
  peaks: Float32Array;
  idx: number;
}

export interface TransientState {
  avg: number;
  multiplier: number;
}

export interface DeltaState {
  prevMean: number;
  smoothed: number;
}

// Stem URLs
export interface StemUrls {
  kick: string | undefined;
  drums: string | undefined;
  bass: string | undefined;
  vocals: string | undefined;
  other: string | undefined;
}

// Error types
export class AudioInitError extends Error {
  constructor(
    message: string,
    public originalError?: Error
  ) {
    super(message);
    this.name = 'AudioInitError';
  }
}

export class StemSeparationError extends Error {
  constructor(
    message: string,
    public originalError?: Error
  ) {
    super(message);
    this.name = 'StemSeparationError';
  }
}

export class BPMDetectionError extends Error {
  constructor(
    message: string,
    public originalError?: Error
  ) {
    super(message);
    this.name = 'BPMDetectionError';
  }
}

// BPM detection result
export interface BPMData {
  bpm: number;
  beatOffset: number;
}

// MIDI mapping types
export interface MidiMapping {
  channel: number; // 1–16
  cc: number;      // 0–127
}
export type MidiMappings = Partial<Record<keyof Config, MidiMapping>>;
