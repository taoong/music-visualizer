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

/**
 * A "fill dimension" for sizing centred compositions (circles, mandalas,
 * grids) against the canvas. Plain `Math.min(w, h)` looks right on a wide
 * desktop canvas (sizes to the height, fills nicely) but on a tall portrait
 * mobile canvas it sizes to the much narrower width, leaving the composition
 * small and centred with large empty margins top and bottom. On portrait
 * canvases this blends the dimension halfway toward height so the
 * composition fills noticeably more of the screen; landscape canvases are
 * returned unchanged (`Math.min(w, h)`, identical to the old behaviour).
 */
export function getFillDim(w: number, h: number): number {
  return w >= h ? Math.min(w, h) : w + (h - w) * 0.5;
}
