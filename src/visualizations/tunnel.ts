/**
 * Tunnel visualization with octave-based rings
 */
import { store } from '../state/store';
import {
  OCTAVE_COUNT,
  TUNNEL_GLOW_PASSES,
  TUNNEL_BASE_BRIGHTNESS,
  TUNNEL_PERSPECTIVE_POWER,
  TUNNEL_PULSE_SCALE,
  DELTA_LENGTH_BOOST,
  DELTA_BRIGHTNESS_BOOST,
} from '../utils/constants';

export function drawTunnel(p: P5Instance): void {
  const { audioState } = store;

  const cx = p.width / 2;
  const cy = p.height / 2;
  const minDim = Math.min(p.width, p.height);
  const maxRadius = minDim * 0.32;
  const minRadius = minDim * 0.03;
  const radiusRange = maxRadius - minRadius;

  p.push();
  p.translate(cx, cy);
  p.noFill();

  for (let o = 0; o < OCTAVE_COUNT; o++) {
    // Octave 0 = outermost (bass), octave 9 = innermost (treble)
    const t = o / (OCTAVE_COUNT - 1); // 0 = outer, 1 = inner
    const perspT = Math.pow(t, TUNNEL_PERSPECTIVE_POWER);
    const baseRadius = maxRadius - perspT * radiusRange;

    const amp = audioState.smoothedOctaves[o];
    const tMult = audioState.octaveTransientValues[o];
    const delta = audioState.octaveDeltaValues[o];

    const energy = amp * tMult;
    const pulse = energy * TUNNEL_PULSE_SCALE * maxRadius * (1.0 + delta * DELTA_LENGTH_BOOST);
    const r = baseRadius + pulse;

    const brightness =
      TUNNEL_BASE_BRIGHTNESS +
      Math.min(energy, 1.0) * (255 - TUNNEL_BASE_BRIGHTNESS) +
      delta * DELTA_BRIGHTNESS_BOOST;
    const clampedBright = Math.min(brightness, 255);

    for (let passIdx = 0; passIdx < TUNNEL_GLOW_PASSES.length; passIdx++) {
      const glowPass = TUNNEL_GLOW_PASSES[passIdx];
      const sw = glowPass.widthMult * (1.5 + energy * 2.0);
      const alpha = clampedBright * glowPass.alphaMult;
      p.stroke(alpha);
      p.strokeWeight(sw);
      p.ellipse(0, 0, r * 2, r * 2);
    }
  }

  p.pop();
}
