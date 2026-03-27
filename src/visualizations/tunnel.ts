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
import { getUserImage } from './userImage';

export function drawTunnel(p: P5Instance): void {
  const { audioState } = store;

  const cx = p.width / 2;
  const cy = p.height / 2;
  const minDim = Math.min(p.width, p.height);
  const maxRadius = minDim * 0.32;
  const minRadius = minDim * 0.03;
  const radiusRange = maxRadius - minRadius;

  // Pre-compute all ring radii and energies
  const rings: { r: number; energy: number; clampedBright: number }[] = [];
  for (let o = 0; o < OCTAVE_COUNT; o++) {
    const t = o / (OCTAVE_COUNT - 1);
    const perspT = Math.pow(t, TUNNEL_PERSPECTIVE_POWER);
    const baseRadius = maxRadius - perspT * radiusRange;

    const amp = audioState.smoothedOctaves[o];
    const tMult = audioState.octaveTransientValues[o];
    const delta = audioState.octaveDeltaValues[o];

    const energy = amp * tMult;
    // Exponential boost for inner rings — higher octaves have much less energy
    // o=0 → 1.5x, o=4 (mid) → ~4x, o=9 (inner) → ~12x
    const innerBoost = 1.5 * Math.pow(1.0 + (o / (OCTAVE_COUNT - 1)) * 2.0, 2);
    const pulse = energy * innerBoost * TUNNEL_PULSE_SCALE * maxRadius * (1.0 + delta * DELTA_LENGTH_BOOST);
    const r = baseRadius + pulse;

    const brightness =
      TUNNEL_BASE_BRIGHTNESS +
      Math.min(energy, 1.0) * (255 - TUNNEL_BASE_BRIGHTNESS) +
      delta * DELTA_BRIGHTNESS_BOOST;
    const clampedBright = Math.min(brightness, 255);

    rings.push({ r, energy, clampedBright });
  }

  p.push();
  p.translate(cx, cy);

  const userImg = getUserImage();

  if (userImg) {
    // Image mode: draw image warped across all concentric rings
    const ctx = p.drawingContext;
    const imgAspect = userImg.width / userImg.height;

    // Draw from outermost ring inward so clipping layers stack correctly
    for (let o = 0; o < OCTAVE_COUNT; o++) {
      const outerR = rings[o].r;
      const innerR = o < OCTAVE_COUNT - 1 ? rings[o + 1].r : 0;

      ctx.save();

      // Clip to annular region (outer circle minus inner circle)
      ctx.beginPath();
      ctx.arc(0, 0, outerR, 0, Math.PI * 2);
      if (innerR > 0) {
        // Cut out the inner circle using counter-clockwise winding
        ctx.arc(0, 0, innerR, 0, Math.PI * 2, true);
      }
      ctx.clip();

      // Draw image scaled to cover circle of outerR
      // Each ring sees a different radial slice of the image
      let drawW: number, drawH: number;
      if (imgAspect > 1) {
        drawH = outerR * 2;
        drawW = drawH * imgAspect;
      } else {
        drawW = outerR * 2;
        drawH = drawW / imgAspect;
      }
      ctx.drawImage(userImg.canvas, -drawW / 2, -drawH / 2, drawW, drawH);

      // Glow stroke at ring boundary for neon tunnel aesthetic
      const { energy, clampedBright } = rings[o];
      ctx.beginPath();
      ctx.arc(0, 0, outerR, 0, Math.PI * 2);
      const glowAlpha = clampedBright * 0.4;
      ctx.strokeStyle = `rgba(${clampedBright}, ${clampedBright}, ${Math.min(255, clampedBright + 40)}, ${glowAlpha / 255})`;
      ctx.lineWidth = 1.5 + energy * 2.0;
      ctx.shadowColor = `rgba(${clampedBright}, ${clampedBright}, 255, 0.6)`;
      ctx.shadowBlur = 8 + energy * 12;
      ctx.stroke();
      ctx.shadowBlur = 0;

      ctx.restore();
    }
  } else {
    // No image: original glow-ring behavior
    p.noFill();
    for (let o = 0; o < OCTAVE_COUNT; o++) {
      const { r, energy, clampedBright } = rings[o];

      for (let passIdx = 0; passIdx < TUNNEL_GLOW_PASSES.length; passIdx++) {
        const glowPass = TUNNEL_GLOW_PASSES[passIdx];
        const sw = glowPass.widthMult * (1.5 + energy * 2.0);
        const alpha = clampedBright * glowPass.alphaMult;
        p.stroke(alpha);
        p.strokeWeight(sw);
        p.ellipse(0, 0, r * 2, r * 2);
      }
    }
  }

  p.pop();
}
