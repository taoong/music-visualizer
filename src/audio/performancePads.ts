/**
 * Performance pads — manual, additive "hit" triggers for live play.
 *
 * Each pad targets a group of adjacent frequency bands and injects a
 * decaying boost directly into the same audioState values every
 * visualization already reads (smoothedBands for amplitude, transientValues
 * for the "punch" multiplier). Layered on top of whatever the real pipeline
 * computes each frame rather than replacing it — so pressing a pad reads as
 * a manual hit landing on top of the music, in any mode (freq/mic/
 * interactive), using the exact signal every one of the ~190 vizzes
 * already reacts sharply to for real beats.
 */
import { store } from '../state/store';
import { BAND_COUNT } from '../utils/constants';

// Band indices: 0=sub, 1=bass, 2=lowMid, 3=mid, 4=upperMid, 5=presence, 6=brilliance
export const PAD_GROUPS: readonly { label: string; bands: readonly number[] }[] = [
  { label: 'LOW', bands: [0, 1] },
  { label: 'LOW-MID', bands: [2, 3] },
  { label: 'HIGH-MID', bands: [4, 5] },
  { label: 'HIGH', bands: [6] },
];

const BOOST_AMP = 1.0;
const BOOST_TRANSIENT = 2.5;
const BOOST_DECAY = 0.88; // per-frame-at-60fps; ~350-450ms back to near-zero

const padAmpBoost = new Float32Array(BAND_COUNT);
const padTransientBoost = new Float32Array(BAND_COUNT);

export function triggerPad(padIndex: number): void {
  const group = PAD_GROUPS[padIndex];
  if (!group) return;
  for (const b of group.bands) {
    padAmpBoost[b] = BOOST_AMP;
    padTransientBoost[b] = BOOST_TRANSIENT;
  }
}

export function applyPadBoosts(dt: number): void {
  const { audioState } = store;
  for (let b = 0; b < BAND_COUNT; b++) {
    if (padAmpBoost[b] > 0.001) {
      const bins = audioState.smoothedBands[b];
      for (let i = 0; i < bins.length; i++) bins[i] += padAmpBoost[b];
      padAmpBoost[b] *= Math.pow(BOOST_DECAY, dt);
    } else {
      padAmpBoost[b] = 0;
    }

    if (padTransientBoost[b] > 0.001) {
      audioState.transientValues[b] += padTransientBoost[b];
      padTransientBoost[b] *= Math.pow(BOOST_DECAY, dt);
    } else {
      padTransientBoost[b] = 0;
    }
  }
}

export function resetPadBoosts(): void {
  padAmpBoost.fill(0);
  padTransientBoost.fill(0);
}
