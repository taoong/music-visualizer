/**
 * Unit tests for audio/bpm.ts
 * detectBPMFromBuffer is a pure algorithm; detectBPMWithFallback is tested
 * for the sample-URL short-circuit path (no network).
 */
import { detectBPMFromBuffer, detectBPMWithFallback } from '../../audio/bpm';
import { SAMPLE_BPM } from '../../utils/constants';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAudioBuffer(sampleRate: number, data: Float32Array): AudioBuffer {
  return {
    sampleRate,
    length: data.length,
    duration: data.length / sampleRate,
    numberOfChannels: 1,
    getChannelData: (_: number) => data,
    copyFromChannel: () => {},
    copyToChannel: () => {},
  } as unknown as AudioBuffer;
}

/** Build a synthetic signal with impulse bursts at every beat. */
function makeBeatSignal(sampleRate: number, bpm: number, durationSecs: number): Float32Array {
  const data = new Float32Array(Math.round(sampleRate * durationSecs));
  const beatInterval = Math.round(sampleRate * 60 / bpm);
  const burstLen = Math.round(sampleRate * 0.01); // 10 ms burst per beat
  for (let b = 0; b * beatInterval < data.length; b++) {
    const start = b * beatInterval;
    for (let j = 0; j < burstLen && start + j < data.length; j++) {
      data[start + j] = 1.0;
    }
  }
  return data;
}

// ---------------------------------------------------------------------------
// detectBPMFromBuffer
// ---------------------------------------------------------------------------
describe('detectBPMFromBuffer', () => {
  it('returns a BPM in the valid range [60, 200]', () => {
    const buf = makeAudioBuffer(44100, makeBeatSignal(44100, 120, 10));
    const { bpm } = detectBPMFromBuffer(buf);
    expect(bpm).toBeGreaterThanOrEqual(60);
    expect(bpm).toBeLessThanOrEqual(200);
  });

  it('detects approximately 120 BPM from a clear 120 BPM signal', () => {
    const buf = makeAudioBuffer(44100, makeBeatSignal(44100, 120, 10));
    const { bpm } = detectBPMFromBuffer(buf);
    expect(bpm).toBeGreaterThanOrEqual(110);
    expect(bpm).toBeLessThanOrEqual(130);
  });

  it('detects approximately 150 BPM from a clear 150 BPM signal', () => {
    // Autocorrelation needs ≥3 beats within its window (~1 s); 150 BPM = 40-frame period, fits three times
    const buf = makeAudioBuffer(44100, makeBeatSignal(44100, 150, 10));
    const { bpm } = detectBPMFromBuffer(buf);
    expect(bpm).toBeGreaterThanOrEqual(140);
    expect(bpm).toBeLessThanOrEqual(160);
  });

  it('returns a non-negative beatOffset', () => {
    const buf = makeAudioBuffer(44100, makeBeatSignal(44100, 120, 10));
    const { beatOffset } = detectBPMFromBuffer(buf);
    expect(beatOffset).toBeGreaterThanOrEqual(0);
  });

  it('handles a silent signal without throwing', () => {
    const buf = makeAudioBuffer(44100, new Float32Array(44100 * 5));
    expect(() => detectBPMFromBuffer(buf)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// detectBPMWithFallback — sample URL short-circuit (no network needed)
// ---------------------------------------------------------------------------
describe('detectBPMWithFallback', () => {
  it('returns known SAMPLE_BPM for "sample.mp3" without any network call', async () => {
    const result = await detectBPMWithFallback('sample.mp3', null);
    expect(result).not.toBeNull();
    expect(result!.bpm).toBe(SAMPLE_BPM);
    expect(result!.beatOffset).toBe(0);
  });

  it('returns SAMPLE_BPM regardless of whether an AudioBuffer is supplied', async () => {
    const buf = makeAudioBuffer(44100, makeBeatSignal(44100, 120, 5));
    const result = await detectBPMWithFallback('sample.mp3', buf);
    expect(result!.bpm).toBe(SAMPLE_BPM);
  });
});
