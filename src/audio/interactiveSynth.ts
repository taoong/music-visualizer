/**
 * Interactive synth — converts user input (tap, drag, hold, key) into the
 * same audio-processing state that vizzes already read in freq/stems mode
 * (`smoothedBands`, `transientValues`, `deltaValues`, `smoothedCentroid`,
 * `smoothedOctaves`, `octaveTransientValues`). With this, every visualization
 * automatically responds to interaction without needing its own handler —
 * tapping fires a kick-like transient, dragging sustains a band selected by
 * X position, holding pads the mid range, and pressing a key pulses a band.
 */
import { store } from '../state/store';
import { BAND_COUNT, OCTAVE_COUNT } from '../utils/constants';
import type { InteractionEvent } from '../types';

const bandTargets = new Float32Array(BAND_COUNT);
const transientPulses = new Float32Array(BAND_COUNT);

const BAND_DECAY = 0.92;
const TRANSIENT_DECAY = 0.82;

export function feedInteractionEvent(event: InteractionEvent): void {
  const { type, x, y } = event;
  const dx = event.dx ?? 0;
  const dy = event.dy ?? 0;

  switch (type) {
    case 'tap': {
      const centerBand = Math.floor(Math.max(0, Math.min(0.999, x)) * BAND_COUNT);
      for (let b = 0; b < BAND_COUNT; b++) {
        const dist = Math.abs(b - centerBand);
        const weight = Math.exp(-dist * dist * 0.5);
        transientPulses[b] = Math.max(transientPulses[b], 1.5 + weight * 2.5);
        bandTargets[b] = Math.max(bandTargets[b], 0.35 + weight * 0.55);
      }
      break;
    }
    case 'dragstart':
    case 'drag': {
      const speed = Math.hypot(dx, dy);
      const centerBand = Math.floor(Math.max(0, Math.min(0.999, x)) * BAND_COUNT);
      const yAmp = 0.35 + (1 - Math.max(0, Math.min(1, y))) * 0.6;
      const spread = 2;
      for (let b = 0; b < BAND_COUNT; b++) {
        const dist = Math.abs(b - centerBand);
        if (dist > spread) continue;
        const weight = 1 - dist / (spread + 1);
        bandTargets[b] = Math.max(bandTargets[b], yAmp * weight);
        if (speed > 0.02) {
          transientPulses[b] = Math.max(transientPulses[b], 0.5 + speed * 20 * weight);
        }
      }
      break;
    }
    case 'hold': {
      for (let b = 1; b < BAND_COUNT - 1; b++) {
        bandTargets[b] = Math.max(bandTargets[b], 0.55);
      }
      break;
    }
    case 'key': {
      const code = (event.key ?? '').charCodeAt(0) || 0;
      const b = ((code % BAND_COUNT) + BAND_COUNT) % BAND_COUNT;
      transientPulses[b] = Math.max(transientPulses[b], 3.0);
      bandTargets[b] = Math.max(bandTargets[b], 0.7);
      break;
    }
    case 'dragend':
      break;
  }
}

export function processInteractiveAudio(dt: number): void {
  const { audioState } = store;

  const decayBand = Math.pow(BAND_DECAY, dt);
  const decayTransient = Math.pow(TRANSIENT_DECAY, dt);

  for (let b = 0; b < BAND_COUNT; b++) {
    bandTargets[b] *= decayBand;
    transientPulses[b] *= decayTransient;
  }

  for (let b = 0; b < BAND_COUNT; b++) {
    const target = bandTargets[b];
    const bins = audioState.smoothedBands[b];
    for (let i = 0; i < bins.length; i++) {
      const cur = bins[i];
      const rate = target > cur ? 0.35 : 0.06;
      bins[i] = cur + (target - cur) * rate * dt;
    }
    audioState.transientValues[b] = Math.max(1, 1 + transientPulses[b]);
    audioState.deltaValues[b] = transientPulses[b] * 0.3;
  }

  let num = 0;
  let den = 0;
  for (let b = 0; b < BAND_COUNT; b++) {
    num += b * bandTargets[b];
    den += bandTargets[b];
  }
  const centroidNorm = den > 0.01 ? num / den / (BAND_COUNT - 1) : 0.5;
  audioState.smoothedCentroid += (centroidNorm - audioState.smoothedCentroid) * 0.08 * dt;
  audioState.centroidYOffset = 0;

  for (let o = 0; o < OCTAVE_COUNT; o++) {
    const bandPos = (o / (OCTAVE_COUNT - 1)) * (BAND_COUNT - 1);
    const b0 = Math.floor(bandPos);
    const b1 = Math.min(BAND_COUNT - 1, b0 + 1);
    const f = bandPos - b0;
    const target = bandTargets[b0] * (1 - f) + bandTargets[b1] * f;
    const cur = audioState.smoothedOctaves[o];
    const rate = target > cur ? 0.35 : 0.06;
    audioState.smoothedOctaves[o] = cur + (target - cur) * rate * dt;

    const trans = transientPulses[b0] * (1 - f) + transientPulses[b1] * f;
    audioState.octaveTransientValues[o] = Math.max(1, 1 + trans);
    audioState.octaveDeltaValues[o] = trans * 0.3;
  }
}

export function resetInteractiveAudio(): void {
  bandTargets.fill(0);
  transientPulses.fill(0);
}
