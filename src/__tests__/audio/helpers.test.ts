/**
 * Unit tests for visualizations/helpers.ts
 */

const { mockState, mockAudioState } = vi.hoisted(() => {
  const mockState = { mode: 'freq' as 'freq' | 'mic' | 'interactive' };
  const mockAudioState = {
    smoothedBands:  Array(7).fill(null).map((_, b) => new Float32Array(60).fill(b * 0.1)),
    transientValues: new Float32Array(7).fill(1.0).map((_, i) => 1 + i * 0.1),
    deltaValues:     new Float32Array(7).fill(0.0).map((_, i) => i * 0.05),
  };
  return { mockState, mockAudioState };
});

vi.mock('../../state/store', () => ({
  store: {
    get state() { return mockState; },
    audioState: mockAudioState,
  },
}));

import { getBandData, getBandAverages } from '../../visualizations/helpers';

// ---------------------------------------------------------------------------
// getBandData
// ---------------------------------------------------------------------------
describe('getBandData', () => {
  it('returns amp from smoothedBands[band][idx]', () => {
    const result = getBandData(2, 0);
    expect(result.amp).toBeCloseTo(mockAudioState.smoothedBands[2][0]);
  });

  it('returns tMult from transientValues[band]', () => {
    const result = getBandData(3, 0);
    expect(result.tMult).toBeCloseTo(mockAudioState.transientValues[3]);
  });

  it('returns delta from deltaValues[band]', () => {
    const result = getBandData(4, 0);
    expect(result.delta).toBeCloseTo(mockAudioState.deltaValues[4]);
  });
});

// ---------------------------------------------------------------------------
// getBandAverages
// ---------------------------------------------------------------------------
describe('getBandAverages', () => {
  it('returns arrays of the requested length', () => {
    const { amps, transients, deltas } = getBandAverages(7);
    expect(amps).toHaveLength(7);
    expect(transients).toHaveLength(7);
    expect(deltas).toHaveLength(7);
  });

  it('averages the bins for each band', () => {
    // Band b is filled with b * 0.1, so average = b * 0.1
    const { amps } = getBandAverages(7);
    for (let b = 0; b < 7; b++) {
      expect(amps[b]).toBeCloseTo(b * 0.1);
    }
  });

  it('returns transients from transientValues', () => {
    const { transients } = getBandAverages(7);
    for (let b = 0; b < 7; b++) {
      expect(transients[b]).toBeCloseTo(mockAudioState.transientValues[b]);
    }
  });
});
