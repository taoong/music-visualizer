/**
 * Unit tests for audio/fft.ts
 * Tone is a CDN global — stubbed here before the module is imported.
 */

// Stub Tone global before fft.ts evaluates any call to Tone.context.sampleRate
vi.stubGlobal('Tone', { context: { sampleRate: 44100 } });

import { getFFTAmplitudes, computeSpectralCentroid } from '../../audio/fft';

// ---------------------------------------------------------------------------
// Mock factory
// ---------------------------------------------------------------------------
function makeMockFFT(dbValues: number[]): ToneFFT {
  return { getValue: () => new Float32Array(dbValues) } as unknown as ToneFFT;
}

/** Build an FFT whose bins are all at -100 dB (near silence) */
function silentFFT(binCount = 512): ToneFFT {
  return makeMockFFT(new Array(binCount).fill(-100));
}

/** Build an FFT with energy only in a specific bin range (0 dB = full amplitude) */
function bandFFT(binCount: number, loIdx: number, hiIdx: number, db = 0): ToneFFT {
  const vals = new Array(binCount).fill(-100);
  for (let i = loIdx; i <= hiIdx; i++) vals[i] = db;
  return makeMockFFT(vals);
}

// ---------------------------------------------------------------------------
// getFFTAmplitudes
// ---------------------------------------------------------------------------
describe('getFFTAmplitudes', () => {
  it('returns a Float32Array of the requested length', () => {
    const result = getFFTAmplitudes(silentFFT(), 60, 1.0);
    expect(result).toBeInstanceOf(Float32Array);
    expect(result.length).toBe(60);
  });

  it('returns near-zero for a silent signal', () => {
    const result = getFFTAmplitudes(silentFFT(), 10, 1.0);
    for (const v of result) {
      expect(v).toBeLessThan(0.001);
    }
  });

  it('returns values in [0, 1]', () => {
    // Force high amplitude (0 dB = linear 1.0) with a large scaleFactor
    const fft = makeMockFFT(new Array(512).fill(0)); // 0 dB
    const result = getFFTAmplitudes(fft, 60, 100.0);
    for (const v of result) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1.0);
    }
  });

  it('produces higher amplitudes for a louder signal', () => {
    const loud = getFFTAmplitudes(makeMockFFT(new Array(512).fill(-6)), 10, 1.0);
    const quiet = getFFTAmplitudes(silentFFT(), 10, 1.0);
    const loudMean = loud.reduce((a, b) => a + b, 0) / loud.length;
    const quietMean = quiet.reduce((a, b) => a + b, 0) / quiet.length;
    expect(loudMean).toBeGreaterThan(quietMean);
  });

  it('works with different bin counts', () => {
    expect(getFFTAmplitudes(silentFFT(256), 30, 1.0).length).toBe(30);
    expect(getFFTAmplitudes(silentFFT(1024), 120, 1.0).length).toBe(120);
  });
});

// ---------------------------------------------------------------------------
// computeSpectralCentroid
// ---------------------------------------------------------------------------
describe('computeSpectralCentroid', () => {
  it('returns 80 Hz (fallback) for a silent signal', () => {
    // -300 dB → linear ≈ 1e-15 per bin; 512 bins × 1e-15 ≈ 5e-13 < energySum threshold (1e-10)
    const result = computeSpectralCentroid(makeMockFFT(new Array(512).fill(-300)));
    expect(result).toBe(80);
  });

  it('returns a centroid in the low-frequency range when energy is in low bins', () => {
    // sampleRate=44100, binCount=512, binWidth = 44100/(512*2) ≈ 43 Hz
    // Low bins 1–50 → centroid ≈ 25 * 43 ≈ 1075 Hz (well below midpoint ~11 kHz)
    const fft = bandFFT(512, 1, 50, 0);
    const result = computeSpectralCentroid(fft);
    expect(result).toBeLessThan(5000);
  });

  it('returns a centroid in the high-frequency range when energy is in high bins', () => {
    // High bins 400–511 → centroid well above the midpoint
    const fft = bandFFT(512, 400, 511, 0);
    const result = computeSpectralCentroid(fft);
    expect(result).toBeGreaterThan(10000);
  });

  it('centroid shifts higher as energy moves to higher bins', () => {
    const lowCentroid = computeSpectralCentroid(bandFFT(512, 1, 50, 0));
    const highCentroid = computeSpectralCentroid(bandFFT(512, 400, 511, 0));
    expect(highCentroid).toBeGreaterThan(lowCentroid);
  });
});
