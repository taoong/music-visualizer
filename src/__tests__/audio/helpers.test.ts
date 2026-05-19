/**
 * Unit tests for visualizations/helpers.ts
 * Both freq mode and stem mode paths are covered via mocked store + audioEngine.
 */

const { mockState, mockAudioState, mockStemSmoothed } = vi.hoisted(() => {
  const mockStemSmoothed: Record<string, Float32Array> = {
    kick:   new Float32Array(60).fill(0.4),
    drums:  new Float32Array(60).fill(0.3),
    bass:   new Float32Array(60).fill(0.6),
    vocals: new Float32Array(60).fill(0.2),
    other:  new Float32Array(60).fill(0.1),
  };
  const mockState = { mode: 'freq' as 'freq' | 'stems' | 'mic' };
  const mockAudioState = {
    smoothedBands:  Array(7).fill(null).map((_, b) => new Float32Array(60).fill(b * 0.1)),
    transientValues: new Float32Array(7).fill(1.0).map((_, i) => 1 + i * 0.1),
    deltaValues:     new Float32Array(7).fill(0.0).map((_, i) => i * 0.05),
    transientStems: {
      kick:   { avg: 0.4, multiplier: 1.3 },
      drums:  { avg: 0.3, multiplier: 1.1 },
      bass:   { avg: 0.6, multiplier: 1.5 },
      vocals: { avg: 0.2, multiplier: 1.0 },
      other:  { avg: 0.1, multiplier: 1.0 },
    },
    deltaStems: {
      kick:   { prevMean: 0, smoothed: 0.2 },
      drums:  { prevMean: 0, smoothed: 0.1 },
      bass:   { prevMean: 0, smoothed: 0.3 },
      vocals: { prevMean: 0, smoothed: 0.05 },
      other:  { prevMean: 0, smoothed: 0.0 },
    },
  };
  return { mockState, mockAudioState, mockStemSmoothed };
});

vi.mock('../../state/store', () => ({
  store: {
    get state() { return mockState; },
    audioState: mockAudioState,
    get isFreqMode() { return mockState.mode === 'freq'; },
  },
}));
vi.mock('../../audio/engine', () => ({
  audioEngine: { getStemSmoothed: () => mockStemSmoothed },
}));

import { getBandData, getBandAverages } from '../../visualizations/helpers';

// ---------------------------------------------------------------------------
// getBandData
// ---------------------------------------------------------------------------
describe('getBandData — freq mode', () => {
  beforeEach(() => { mockState.mode = 'freq'; });

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

describe('getBandData — stem mode', () => {
  beforeEach(() => { mockState.mode = 'stems'; });

  it('returns amp from stemSmoothed[stem][idx]', () => {
    // Band 0 → STEMS[0] = 'kick', stemSmoothed.kick is filled with 0.4
    const result = getBandData(0, 5);
    expect(result.amp).toBeCloseTo(0.4);
  });

  it('returns tMult from transientStems[stem]', () => {
    const result = getBandData(2, 0); // band 2 → 'bass', multiplier 1.5
    expect(result.tMult).toBeCloseTo(1.5);
  });

  it('returns delta from deltaStems[stem]', () => {
    const result = getBandData(2, 0); // 'bass' delta = 0.3
    expect(result.delta).toBeCloseTo(0.3);
  });
});

// ---------------------------------------------------------------------------
// getBandAverages
// ---------------------------------------------------------------------------
describe('getBandAverages — freq mode', () => {
  beforeEach(() => { mockState.mode = 'freq'; });

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

describe('getBandAverages — stem mode', () => {
  beforeEach(() => { mockState.mode = 'stems'; });

  it('returns amp averages from stemSmoothed', () => {
    const { amps } = getBandAverages(5);
    // kick=0.4, drums=0.3, bass=0.6, vocals=0.2, other=0.1
    expect(amps[0]).toBeCloseTo(0.4); // kick
    expect(amps[2]).toBeCloseTo(0.6); // bass
  });

  it('returns transients from transientStems', () => {
    const { transients } = getBandAverages(5);
    expect(transients[2]).toBeCloseTo(1.5); // bass
  });
});
