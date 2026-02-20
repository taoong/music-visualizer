/**
 * Mock factory for the store singleton
 */

export function createMockStoreState() {
  return {
    state: {
      mode: 'freq' as const,
      vizMode: 'circle' as const,
      audioReady: true,
      isPlaying: true,
      useSample: false,
      userFile: null,
      currentObjectUrl: null,
      currentSampleBlobUrl: null,
      playStartedAt: 0,
      startOffset: 0,
      isSeeking: false,
      circleOutlineHue: 0,
      detectedBPM: 120,
      beatIntervalSec: 0.5,
      lastBeatIndex: -1,
      beatOffset: 0,
      balls: [],
      kickBoostMultiplier: 1.0,
    },
    config: {
      sensSub: 1.5,
      sensBass: 1.2,
      sensLowMid: 1.8,
      sensMid: 2.0,
      sensUpperMid: 2.0,
      sensPresence: 2.0,
      sensBrilliance: 2.0,
      sensKick: 2.0,
      sensDrums: 2.0,
      sensStemBass: 2.0,
      sensVocals: 2.0,
      sensOther: 2.0,
      spikeScale: 1.2,
      rotationSpeed: 0.3,
      ballsKickBoost: 6.0,
      masterVolume: 0.8,
      decayRate: 0.88,
    },
    audioState: {
      smoothedBands: Array(7)
        .fill(null)
        .map(() => new Float32Array(60).fill(0.5)),
      transientValues: new Float32Array(7).fill(1.0),
      deltaValues: new Float32Array(7).fill(0),
      autoGainBands: [],
      autoGainStems: {},
      transientBands: Array(7)
        .fill(null)
        .map(() => ({ avg: 0, multiplier: 1.0 })),
      transientStems: {},
      deltaBands: Array(7)
        .fill(null)
        .map(() => ({ prevMean: 0, smoothed: 0 })),
      deltaStems: {},
      smoothedCentroid: 0.5,
      centroidYOffset: 0,
      smoothedOctaves: new Float32Array(10).fill(0.5),
      octaveTransients: Array(10)
        .fill(null)
        .map(() => ({ avg: 0, multiplier: 1.0 })),
      octaveTransientValues: new Float32Array(10).fill(1.0),
      octaveDeltas: Array(10)
        .fill(null)
        .map(() => ({ prevMean: 0, smoothed: 0 })),
      octaveDeltaValues: new Float32Array(10).fill(0),
      autoGainOctaves: { peaks: new Float32Array(300).fill(0.01), idx: 0 },
    },
    emit: vi.fn(),
    on: vi.fn(() => vi.fn()),
  };
}
