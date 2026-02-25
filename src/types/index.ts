/**
 * Core type definitions for Music Visualizer
 */

// Audio analysis modes
export type AnalysisMode = 'freq' | 'stems';
export type VizMode = 'circle' | 'spectrum' | 'tunnel' | 'balls' | 'cube' | 'stickman' | 'lasers' | 'text' | 'wormhole' | 'runners';

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
  ballsKickBoost: number;
  masterVolume: number;
  decayRate: number;
  intensity: number;
  beatDivision: number;
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

  // Balls visualization
  balls: Ball[];
  kickBoostMultiplier: number;
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

// Ball object for balls visualization
export interface Ball {
  x: number;
  y: number;
  vx: number;
  vy: number;
  baseRadius: number;
  band: number;
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
