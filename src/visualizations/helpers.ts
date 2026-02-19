/**
 * Shared visualization data helpers
 */
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { STEMS } from '../utils/constants';

export interface BandData {
  amp: number;
  tMult: number;
  delta: number;
}

/**
 * Get amplitude, transient, and delta for a given band/spike index
 */
export function getBandData(band: number, idx: number): BandData {
  const { audioState } = store;
  const isFreqMode = store.state.mode === 'freq';

  if (isFreqMode) {
    return {
      amp: audioState.smoothedBands[band][idx],
      tMult: audioState.transientValues[band],
      delta: audioState.deltaValues[band],
    };
  }

  const stem = STEMS[band];
  const stemSmoothed = audioEngine.getStemSmoothed();
  let amp = 0;
  let tMult = 1.0;
  let delta = 0;

  if (stemSmoothed?.[stem]) amp = stemSmoothed[stem][idx];
  if (audioState.transientStems[stem]) tMult = audioState.transientStems[stem].multiplier;
  if (audioState.deltaStems[stem]) delta = audioState.deltaStems[stem].smoothed;

  return { amp, tMult, delta };
}

/**
 * Get per-band averages for the balls visualization
 */
export function getBandAverages(bandCount: number): { amps: number[]; transients: number[]; deltas: number[] } {
  const { audioState } = store;
  const isFreqMode = store.state.mode === 'freq';
  const stemSmoothed = audioEngine.getStemSmoothed();

  const amps: number[] = new Array(bandCount);
  const transients: number[] = new Array(bandCount);
  const deltas: number[] = new Array(bandCount);

  for (let b = 0; b < bandCount; b++) {
    if (isFreqMode) {
      const bins = audioState.smoothedBands[b];
      let sum = 0;
      for (let j = 0; j < bins.length; j++) sum += bins[j];
      amps[b] = sum / bins.length;
      transients[b] = audioState.transientValues[b];
      deltas[b] = audioState.deltaValues[b];
    } else {
      const stem = STEMS[b];
      amps[b] = 0;
      transients[b] = 1.0;
      deltas[b] = 0;
      if (stemSmoothed?.[stem]) {
        let sum = 0;
        for (let j = 0; j < stemSmoothed[stem].length; j++) sum += stemSmoothed[stem][j];
        amps[b] = sum / stemSmoothed[stem].length;
      }
      if (audioState.transientStems[stem])
        transients[b] = audioState.transientStems[stem].multiplier;
      if (audioState.deltaStems[stem]) deltas[b] = audioState.deltaStems[stem].smoothed;
    }
  }

  return { amps, transients, deltas };
}
