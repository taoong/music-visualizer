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

/**
 * A fixed vertical FOV gives a much narrower horizontal FOV on a tall
 * portrait screen than on a wide desktop one, so a Three.js subject framed
 * comfortably on desktop can fall partly or entirely outside the horizontal
 * frustum on mobile — leaving the camera filling the screen with the
 * subject's surface edge-to-edge, or cropping it out of frame. Widens the
 * vertical FOV as aspect narrows so the effective horizontal FOV — and thus
 * how much of the subject is actually in view — stays roughly constant.
 *
 * @param baseFov    vertical FOV (degrees) the scene was tuned against
 * @param aspect     camera.aspect (width / height)
 * @param refAspect  the aspect baseFov was tuned for (default: a typical desktop ~16:9-ish canvas)
 */
export function fovForAspect(baseFov: number, aspect: number, refAspect = 1.7): number {
  if (aspect >= refAspect) return baseFov;
  const refHorizHalf = Math.atan(Math.tan((baseFov * Math.PI / 180) / 2) * refAspect);
  const vFovRad = 2 * Math.atan(Math.tan(refHorizHalf) / aspect);
  return Math.min(100, vFovRad * 180 / Math.PI);
}
