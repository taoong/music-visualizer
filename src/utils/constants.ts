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
export const BALL_COUNT = isMobile ? 15 : 30;

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

// Stem types and smoothing
export const STEMS = ['kick', 'drums', 'bass', 'vocals', 'other'] as const;
export const STEM_SMOOTHING: Record<string, [number, number]> = {
  kick: [0.9, 0.06],
  drums: [0.85, 0.08],
  bass: [0.75, 0.1],
  vocals: [0.78, 0.12],
  other: [0.8, 0.14],
};

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
  // Stem mode
  sensKick: 2.0,
  sensDrums: 2.0,
  sensStemBass: 2.0,
  sensVocals: 2.0,
  sensOther: 2.0,
  // Shared
  spikeScale: 1.2,
  rotationSpeed: 0.3,
  ballsKickBoost: 6.0,
  masterVolume: 0.8,
  decayRate: 0.88, // Default decay rate (0.0 = instant, 1.0 = no decay)
};

// FFT and decay constants
export const FFT_SIZE = isMobile ? 128 : 256;
export const DECAY_RATE_BASELINE = 0.88;
export const DECAY_RATE_EXPONENT = 3;

// Sample URL - use simple relative path for maximum compatibility
export const SAMPLE_URL = 'sample.mp3';
