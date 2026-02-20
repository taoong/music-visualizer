/**
 * Centralized state management using EventEmitter pattern
 */
import type { AppState, AudioProcessingState, Config, BPMData } from '../types';
import type { AnalysisMode, VizMode } from '../types';
import {
  DEFAULT_CONFIG,
  BAND_COUNT,
  SPIKES_PER_BAND,
  OCTAVE_COUNT,
  AUTO_GAIN_FRAMES,
  AUTO_GAIN_FLOOR,
} from '../utils/constants';

// Event types
type EventType =
  | 'stateChange'
  | 'audioReady'
  | 'playbackStart'
  | 'playbackStop'
  | 'modeChange'
  | 'vizModeChange'
  | 'bpmDetected'
  | 'imageChange'
  | 'error';

type EventListener = (data?: unknown) => void;

class StateStore {
  private listeners: Map<EventType, EventListener[]> = new Map();

  // Application state
  public state: AppState = {
    mode: 'freq',
    vizMode: 'circle',
    audioReady: false,
    isPlaying: false,
    useSample: false,
    userFile: null,
    currentObjectUrl: null,
    currentSampleBlobUrl: null,
    playStartedAt: 0,
    startOffset: 0,
    isSeeking: false,
    circleOutlineHue: 0,
    detectedBPM: 0,
    beatIntervalSec: 0,
    lastBeatIndex: -1,
    beatOffset: 0,
    balls: [],
    kickBoostMultiplier: 1.0,
  };

  // Configuration
  public config: Config = { ...DEFAULT_CONFIG };

  // Audio processing state
  public audioState: AudioProcessingState = this.initializeAudioState();

  private initializeAudioState(): AudioProcessingState {
    return {
      smoothedBands: Array(BAND_COUNT)
        .fill(null)
        .map(() => new Float32Array(SPIKES_PER_BAND)),
      transientValues: new Float32Array(BAND_COUNT).fill(1.0),
      deltaValues: new Float32Array(BAND_COUNT).fill(0),
      autoGainBands: Array(BAND_COUNT)
        .fill(null)
        .map(() => ({
          peaks: new Float32Array(AUTO_GAIN_FRAMES).fill(AUTO_GAIN_FLOOR),
          idx: 0,
        })),
      autoGainStems: {},
      transientBands: Array(BAND_COUNT)
        .fill(null)
        .map(() => ({ avg: 0, multiplier: 1.0 })),
      transientStems: {},
      deltaBands: Array(BAND_COUNT)
        .fill(null)
        .map(() => ({ prevMean: 0, smoothed: 0 })),
      deltaStems: {},
      smoothedCentroid: 0.5,
      centroidYOffset: 0,
      smoothedOctaves: new Float32Array(OCTAVE_COUNT).fill(0),
      octaveTransients: Array(OCTAVE_COUNT)
        .fill(null)
        .map(() => ({ avg: 0, multiplier: 1.0 })),
      octaveTransientValues: new Float32Array(OCTAVE_COUNT).fill(1.0),
      octaveDeltas: Array(OCTAVE_COUNT)
        .fill(null)
        .map(() => ({ prevMean: 0, smoothed: 0 })),
      octaveDeltaValues: new Float32Array(OCTAVE_COUNT).fill(0),
      autoGainOctaves: {
        peaks: new Float32Array(AUTO_GAIN_FRAMES).fill(AUTO_GAIN_FLOOR),
        idx: 0,
      },
    };
  }

  // Event subscription
  on(event: EventType, listener: EventListener): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event)!.push(listener);

    // Return unsubscribe function
    return () => {
      const listeners = this.listeners.get(event);
      if (listeners) {
        const index = listeners.indexOf(listener);
        if (index > -1) {
          listeners.splice(index, 1);
        }
      }
    };
  }

  // Emit event
  emit(event: EventType, data?: unknown): void {
    const listeners = this.listeners.get(event);
    if (listeners) {
      listeners.forEach(listener => {
        try {
          listener(data);
        } catch (err) {
          console.error(`Error in event listener for ${event}:`, err);
        }
      });
    }
  }

  // State setters with event emission
  setMode(mode: AnalysisMode): void {
    this.state.mode = mode;
    this.emit('modeChange', mode);
    this.emit('stateChange', this.state);
  }

  setVizMode(vizMode: VizMode): void {
    this.state.vizMode = vizMode;
    this.emit('vizModeChange', vizMode);
    this.emit('stateChange', this.state);
  }

  setAudioReady(ready: boolean): void {
    this.state.audioReady = ready;
    if (ready) {
      this.emit('audioReady');
    }
    this.emit('stateChange', this.state);
  }

  setPlaying(playing: boolean): void {
    this.state.isPlaying = playing;
    if (playing) {
      this.emit('playbackStart');
    } else {
      this.emit('playbackStop');
    }
    this.emit('stateChange', this.state);
  }

  setBPM(data: BPMData): void {
    this.state.detectedBPM = data.bpm;
    this.state.beatIntervalSec = data.bpm > 0 ? 60 / data.bpm : 0;
    this.state.beatOffset = data.beatOffset;
    this.state.lastBeatIndex = -1;
    this.emit('bpmDetected', data);
  }

  setUserFile(file: File | null): void {
    this.state.userFile = file;
    if (file) {
      this.state.useSample = false;
    }
    this.emit('stateChange', this.state);
  }

  setUseSample(use: boolean): void {
    this.state.useSample = use;
    if (use) {
      this.state.userFile = null;
    }
    this.emit('stateChange', this.state);
  }

  setPlaybackTiming(playStartedAt: number, startOffset: number): void {
    this.state.playStartedAt = playStartedAt;
    this.state.startOffset = startOffset;
    this.emit('stateChange', this.state);
  }

  setStartOffset(offset: number): void {
    this.state.startOffset = offset;
    this.emit('stateChange', this.state);
  }

  setSeeking(isSeeking: boolean): void {
    this.state.isSeeking = isSeeking;
    this.emit('stateChange', this.state);
  }

  setCurrentObjectUrl(url: string | null): void {
    if (this.state.currentObjectUrl) {
      URL.revokeObjectURL(this.state.currentObjectUrl);
    }
    this.state.currentObjectUrl = url;
  }

  // Update configuration
  updateConfig<K extends keyof Config>(key: K, value: Config[K]): void {
    this.config[key] = value;
    this.emit('stateChange', this.state);
  }

  // Reset audio processing state
  resetAudioState(): void {
    // Reset bands
    for (let b = 0; b < BAND_COUNT; b++) {
      this.audioState.smoothedBands[b].fill(0);
      this.audioState.autoGainBands[b].peaks.fill(AUTO_GAIN_FLOOR);
      this.audioState.autoGainBands[b].idx = 0;
      this.audioState.transientBands[b].avg = 0;
      this.audioState.transientBands[b].multiplier = 1.0;
      this.audioState.deltaBands[b].prevMean = 0;
      this.audioState.deltaBands[b].smoothed = 0;
    }
    this.audioState.transientValues.fill(1.0);
    this.audioState.deltaValues.fill(0);

    // Reset stems
    this.audioState.autoGainStems = {};
    this.audioState.transientStems = {};
    this.audioState.deltaStems = {};

    // Reset centroid
    this.audioState.smoothedCentroid = 0.5;
    this.audioState.centroidYOffset = 0;

    // Reset octaves
    this.audioState.smoothedOctaves.fill(0);
    this.audioState.octaveTransientValues.fill(1.0);
    this.audioState.octaveDeltaValues.fill(0);
    for (let o = 0; o < OCTAVE_COUNT; o++) {
      this.audioState.octaveTransients[o].avg = 0;
      this.audioState.octaveTransients[o].multiplier = 1.0;
      this.audioState.octaveDeltas[o].prevMean = 0;
      this.audioState.octaveDeltas[o].smoothed = 0;
    }
    this.audioState.autoGainOctaves.peaks.fill(AUTO_GAIN_FLOOR);
    this.audioState.autoGainOctaves.idx = 0;

    // Reset BPM
    this.state.detectedBPM = 0;
    this.state.beatIntervalSec = 0;
    this.state.lastBeatIndex = -1;
    this.state.beatOffset = 0;
    this.state.circleOutlineHue = 0;

    // Reset balls
    this.state.balls = [];
    this.state.kickBoostMultiplier = 1.0;
  }

  // Getters
  get isFreqMode(): boolean {
    return this.state.mode === 'freq';
  }

  get isStemMode(): boolean {
    return this.state.mode === 'stems';
  }
}

// Export singleton instance
export const store = new StateStore();
export default store;
