/**
 * Shared visualization data helpers
 */
import { store } from '../state/store';

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
  return {
    amp: audioState.smoothedBands[band][idx],
    tMult: audioState.transientValues[band],
    delta: audioState.deltaValues[band],
  };
}

/**
 * Get per-band averages
 */
export function getBandAverages(bandCount: number): { amps: number[]; transients: number[]; deltas: number[] } {
  const { audioState } = store;

  const amps: number[] = new Array(bandCount);
  const transients: number[] = new Array(bandCount);
  const deltas: number[] = new Array(bandCount);

  for (let b = 0; b < bandCount; b++) {
    const bins = audioState.smoothedBands[b];
    let sum = 0;
    for (let j = 0; j < bins.length; j++) sum += bins[j];
    amps[b] = sum / bins.length;
    transients[b] = audioState.transientValues[b];
    deltas[b] = audioState.deltaValues[b];
  }

  return { amps, transients, deltas };
}
