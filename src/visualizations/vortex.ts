/**
 * Vortex — Audio-reactive spiral galaxy.
 *
 * Inspired by Olafur Eliasson's "Your Rainbow Panorama" (2011, ARoS Aarhus
 * Kunstmuseum) — a circular rainbow-glass walkway crowning the museum roof —
 * and the mesmerising rotational structure of barred-spiral galaxies as
 * captured by the James Webb Space Telescope.
 * https://olafureliasson.net/artwork/your-rainbow-panorama-2011/
 *
 * N logarithmic spiral arms emanate from the canvas centre, each mapped to a
 * frequency band (cycling if arms > 7). Amplitude drives arm brightness and
 * width; beat detection fires a rotation impulse and shifts the hue palette.
 * An offscreen trail buffer accumulates layered mandala-like patterns. A
 * centre glow pulses with overall amplitude.
 *
 * Sliders
 *   vortexArms   — number of spiral arms (2–12)
 *   vortexTwist  — tightness of the logarithmic spiral (loose → tight)
 *   vortexSpeed  — base rotation speed
 */
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { BAND_COUNT, isMobile } from '../utils/constants';

const TWO_PI = Math.PI * 2;

const BAND_HUES = [280, 230, 180, 130, 55, 25, 330];

const GLOW_PASSES = [
  { widthMult: 6.0, alphaMult: 0.10 },
  { widthMult: 3.0, alphaMult: 0.30 },
  { widthMult: 1.0, alphaMult: 1.00 },
];

let rotation = 0;
let lastBeatIndex = -1;
let hueShift = 0;
let beatImpulse = 0;
let trailBuffer: any = null;
let trailW = 0;
let trailH = 0;

export function resetVortex(): void {
  rotation = 0;
  lastBeatIndex = -1;
  hueShift = 0;
  beatImpulse = 0;
  if (trailBuffer) {
    trailBuffer.remove();
    trailBuffer = null;
  }
  trailW = 0;
  trailH = 0;
}

export function drawVortex(p: P5Instance, dt: number): void {
  const W = p.width;
  const H = p.height;
  const cx = W / 2;
  const cy = H / 2;
  const minDim = Math.min(W, H);

  const { amps } = getBandAverages(BAND_COUNT);
  const totalAmp = amps.reduce((s, v) => s + v, 0) / BAND_COUNT;

  const cfg = store.config;
  const armCount = Math.round(2 + (cfg.vortexArms ?? 0.5) * 10);
  const twist = 0.15 + (cfg.vortexTwist ?? 0.5) * 1.85;
  const speedFactor = 0.2 + (cfg.vortexSpeed ?? 0.5) * 1.8;

  // Beat detection
  const { state } = store;
  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    const beatIdx = adjusted >= 0 ? Math.floor(adjusted / state.beatIntervalSec) : -1;
    if (beatIdx >= 0 && beatIdx !== lastBeatIndex) {
      if (lastBeatIndex >= 0) {
        beatImpulse = 1.0;
        hueShift = (hueShift + 25) % 360;
      }
      lastBeatIndex = beatIdx;
    }
  }

  beatImpulse *= Math.pow(0.88, dt);

  // Rotation accumulates over time
  const speed = speedFactor * (0.4 + totalAmp * 0.6 + beatImpulse * 2.5);
  rotation += speed * dt * 0.012;

  // Trail buffer (offscreen graphics for persistence)
  if (!trailBuffer || trailW !== W || trailH !== H) {
    if (trailBuffer) trailBuffer.remove();
    trailBuffer = p.createGraphics(W, H);
    (trailBuffer as any).colorMode(p['HSB'], 360, 100, 100, 1.0);
    trailW = W;
    trailH = H;
  }

  // Fade trail buffer slightly each frame
  trailBuffer.fill(0, 0, 0, 0.08 * dt);
  trailBuffer.noStroke();
  trailBuffer.rect(0, 0, W, H);

  (trailBuffer as any).colorMode(p['HSB'], 360, 100, 100, 1.0);
  (trailBuffer as any).blendMode(p['ADD']);

  const maxRadius = minDim * 0.48;
  const pointsPerArm = isMobile ? 80 : 160;

  // Draw spiral arms
  for (let arm = 0; arm < armCount; arm++) {
    const bandIdx = arm % BAND_COUNT;
    const amp = amps[bandIdx];
    const armAngleOffset = (TWO_PI / armCount) * arm;
    const hue = (BAND_HUES[bandIdx] + hueShift) % 360;

    const baseWidth = (2 + amp * 6) * (isMobile ? 0.7 : 1.0);
    const brightness = 30 + amp * 70;

    // Draw each glow pass
    for (const pass of GLOW_PASSES) {
      const strokeW = baseWidth * pass.widthMult;
      const alpha = pass.alphaMult * (0.3 + amp * 0.7) * (isMobile ? 0.8 : 1.0);

      trailBuffer.noFill();
      trailBuffer.stroke(hue, 70, brightness, alpha);
      trailBuffer.strokeWeight(strokeW);

      trailBuffer.beginShape();
      for (let i = 0; i < pointsPerArm; i++) {
        const t = i / (pointsPerArm - 1);
        const r = t * maxRadius;
        if (r < 2) continue;

        // Logarithmic spiral: angle grows with log of radius
        const spiralAngle = twist * Math.log(r / 10 + 1) * 4;
        const angle = rotation + armAngleOffset + spiralAngle;

        // Audio-reactive radial wobble
        const wobble = 1 + amp * 0.08 * Math.sin(t * 12 + rotation * 3);

        const px = cx + Math.cos(angle) * r * wobble;
        const py = cy + Math.sin(angle) * r * wobble;

        (trailBuffer as any).curveVertex(px, py);
      }
      trailBuffer.endShape();
    }
  }

  (trailBuffer as any).blendMode(p['BLEND']);

  // Centre glow
  const glowRadius = minDim * (0.05 + totalAmp * 0.08 + beatImpulse * 0.06);
  const layers = 8;
  trailBuffer.noStroke();
  for (let i = layers; i >= 0; i--) {
    const t = i / layers;
    const r = glowRadius * (1 + t * 2);
    const cHue = (hueShift + 30) % 360;
    const a = (1 - t) * (0.04 + totalAmp * 0.06 + beatImpulse * 0.04);
    trailBuffer.fill(cHue, 50, 90, a);
    trailBuffer.ellipse(cx, cy, r * 2, r * 2);
  }

  // Render to main canvas
  (p as any).colorMode(p['HSB'], 360, 100, 100, 1.0);
  p.background(0, 0, 2);
  (p as any).blendMode(p['ADD']);
  p.image(trailBuffer, 0, 0);
  (p as any).blendMode(p['BLEND']);

  // Beat flash overlay
  if (beatImpulse > 0.1) {
    const flashAlpha = beatImpulse * 0.06;
    p.noStroke();
    p.fill((hueShift + 30) % 360, 30, 100, flashAlpha);
    p.rect(0, 0, W, H);
  }

  (p as any).colorMode(p['RGB'], 255);
}
