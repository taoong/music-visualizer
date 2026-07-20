/**
 * Super Forms — Audio-reactive Gielis superformula morphology.
 *
 * Inspired by Johan Gielis' "A Generic Geometric Transformation that Unifies
 * a Wide Range of Natural and Abstract Shapes" (2003, American Journal of
 * Botany, https://doi.org/10.2307/4117014), and the way his superformula has
 * been embraced by generative artists and parametric architects — most visibly
 * in Michael Hansmeyer's "Digital Grotesque" (2013, Centre Pompidou,
 * https://www.michael-hansmeyer.com/digital-grotesque), where subdivision
 * algorithms related in spirit to the superformula generate impossibly intricate
 * stone-hewn vaulted chambers from pure mathematics.
 *
 * The Gielis superformula is a single polar equation that, by varying four
 * parameters (m, n₁, n₂, n₃), continuously morphs between triangles, squares,
 * pentagons, starbursts, flowers, and alien organic forms:
 *   r(θ) = (|cos(m·θ/4)|^n₂ + |sin(m·θ/4)|^n₃)^(−1/n₁)
 *
 * Seven concentric superformula curves nest at the canvas centre, one per
 * frequency band. Sub-bass anchors the outermost ring; brilliance lives at
 * the core. Each shape's n₁ (roundness) is driven by its band's amplitude:
 * quiet passages hold smooth rounded polygons while loud moments collapse them
 * into spiky starbursts. n₂/n₃ drift organically via Perlin noise for subtle
 * asymmetry. Adjacent shapes rotate in opposite directions at audio-scaled
 * speeds. On every beat all shapes simultaneously jump to new integer m values
 * (new topology) and the hue palette rotates.
 *
 * Rendering: trail-buffer at full canvas res; 3-pass neon glow per shape;
 * additive flash overlay on beat; mobile guard (reduced step count).
 *
 * Sliders
 *   Symmetry — m (lobe count) range: 0 = simple (m 2–6), 1 = complex (m 8–18)
 *   Morph    — amplitude sensitivity of n₁ (roundness): 0 = static, 1 = wild
 *   Glow     — neon bloom intensity and trail persistence
 */
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { BAND_COUNT, isMobile } from '../utils/constants';

// Hue per band: sub=violet, bass=blue, lowMid=teal, mid=green, upperMid=yellow, presence=orange, brilliance=rose
const BAND_HUES: readonly number[] = [280, 230, 180, 120, 60, 30, 330];

// Alternating CW/CCW; treble bands spin faster than bass bands
const ROT_DIR: readonly number[] = [1, -1, 1, -1, 1, -1, 1];
const ROT_SPD: readonly number[] = [0.13, 0.20, 0.28, 0.38, 0.49, 0.62, 0.78];

// Base m (lobe count) per band: simple triangle → 12-fold geometry
const M_BASE: readonly number[] = [3, 4, 5, 6, 7, 8, 12];

// Polygon resolution: fewer on mobile for performance
const STEPS = isMobile ? 100 : 280;

// ── Module-scoped state ──────────────────────────────────────────────────────

let rotAngles:   number[] = [0, 0, 0, 0, 0, 0, 0];
let currentM:    number[] = [...M_BASE];
let targetM:     number[] = [...M_BASE];
let noiseOff:    number[] = M_BASE.map((_, i) => i * 137.508);
let hueShift     = 0;
let beatFlash    = 0;
let lastBeatIdx  = -1;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let pg: any      = null;
let pgW = 0;
let pgH = 0;

export function resetSupershapes(): void {
  rotAngles  = [0, 0, 0, 0, 0, 0, 0];
  currentM   = [...M_BASE];
  targetM    = [...M_BASE];
  noiseOff   = M_BASE.map((_, i) => i * 137.508);
  hueShift   = 0;
  beatFlash  = 0;
  lastBeatIdx = -1;
  if (pg) { pg.remove(); pg = null; }
  pgW = pgH = 0;
}

// Gielis superformula: r(θ) = (|cos(m·θ/4)|^n2 + |sin(m·θ/4)|^n3)^(−1/n1)
function sf(theta: number, m: number, n1: number, n2: number, n3: number): number {
  const t1 = Math.pow(Math.abs(Math.cos((m * theta) / 4)), n2);
  const t2 = Math.pow(Math.abs(Math.sin((m * theta) / 4)), n3);
  const base = t1 + t2;
  return base < 1e-10 ? 0 : Math.pow(base, -1 / n1);
}

// ── Draw ─────────────────────────────────────────────────────────────────────

export function drawSupershapes(p: P5Instance, dt: number): void {
  const { state, config } = store;
  const { amps } = getBandAverages(BAND_COUNT);

  const W  = p.width;
  const H  = p.height;
  const cx = W / 2;
  const cy = H / 2;
  const maxR = Math.min(W, H) * 0.44;

  const sym   = config.supershapesSymmetry; // 0–1
  const morph = config.supershapesMorph;    // 0–1
  const glow  = config.supershapesGlow;     // 0–1

  // ── Beat detection ──────────────────────────────────────────────────────────
  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos     = audioEngine.getPlaybackPosition();
    const adj     = pos - state.beatOffset;
    const beatIdx = adj >= 0 ? Math.floor(adj / state.beatIntervalSec) : -1;
    if (beatIdx >= 0 && beatIdx !== lastBeatIdx) {
      lastBeatIdx = beatIdx;
      hueShift    = (hueShift + 47) % 360;
      beatFlash   = 1.0;

      // Jump all m values: stay roughly ordered from simple (sub-bass) to complex (brilliance)
      const minM = 2 + Math.round(sym * 4);
      const maxM = 6 + Math.round(sym * 12);
      for (let i = 0; i < BAND_COUNT; i++) {
        const bias = minM + Math.round((i / (BAND_COUNT - 1)) * (maxM - minM));
        const jitter = Math.round((Math.random() - 0.5) * 4);
        targetM[i] = Math.max(2, bias + jitter);
      }
    }
  }

  // Ease currentM toward targetM each frame
  const easeK = 0.055 * dt;
  for (let i = 0; i < BAND_COUNT; i++) {
    currentM[i] += (targetM[i] - currentM[i]) * easeK;
  }
  beatFlash *= Math.pow(0.88, dt);

  // ── Rotation & noise offset ─────────────────────────────────────────────────
  const overallAmp = amps.reduce((s, a) => s + a, 0) / BAND_COUNT;

  for (let i = 0; i < BAND_COUNT; i++) {
    rotAngles[i] += ROT_SPD[i] * ROT_DIR[i] * dt * (0.55 + amps[i] * 1.9);
    noiseOff[i]  += 0.0045 * dt;
  }

  // ── Trail buffer init / resize ───────────────────────────────────────────────
  if (!pg || pgW !== W || pgH !== H) {
    if (pg) pg.remove();
    pg  = (p as any).createGraphics(W, H);
    pg.pixelDensity(1);
    pg.background(0);
    pgW = W;
    pgH = H;
  }

  // Fade previous frame: high glow → slower fade (longer trails)
  const trailFade = Math.round(6 + (1 - glow) * 24);
  pg.noStroke();
  pg.fill(0, 0, 0, trailFade);
  pg.rect(0, 0, W, H);

  // Switch buffer to HSB with 0–255 alpha
  (pg as any).colorMode(p['HSB'], 360, 100, 100, 255);

  // ── Draw all seven shapes ────────────────────────────────────────────────────
  pg.noFill();
  const CLOSE = p['CLOSE'];

  for (let i = 0; i < BAND_COUNT; i++) {
    const amp = amps[i];
    const hue = (BAND_HUES[i] + hueShift + 360) % 360;

    // Radial scale: sub-bass (i=0) is outermost, brilliance (i=6) is innermost
    const outer = 1 - i / (BAND_COUNT - 1);
    const rMin  = maxR * (0.09 + outer * 0.24);
    const rMax  = maxR * (0.18 + outer * 0.62);
    const r0    = rMin + amp * (rMax - rMin);

    // n₁: high = smooth polygon, low = spiky star — driven by amplitude
    const n1 = Math.max(0.28, 3.8 - morph * amp * 3.5);

    // n₂/n₃ drift via Perlin noise for subtle organic asymmetry
    const nv  = p.noise(noiseOff[i], i * 0.63);
    const n23 = 0.72 + nv * 1.1;

    const m   = currentM[i];
    const rot = rotAngles[i];

    // Pre-compute all vertices (shared across the 3 glow passes)
    const xs = new Float32Array(STEPS + 1);
    const ys = new Float32Array(STEPS + 1);
    for (let j = 0; j <= STEPS; j++) {
      const theta = (j / STEPS) * Math.PI * 2;
      const r     = r0 * sf(theta, m, n1, n23, n23);
      xs[j] = cx + r * Math.cos(theta + rot);
      ys[j] = cy + r * Math.sin(theta + rot);
    }

    const bright  = 30 + amp * 65 + beatFlash * 22;
    const sat     = 62 + amp * 32;
    const gFactor = 0.38 + glow * 0.62;

    // Pass 1 — wide outer halo
    pg.strokeWeight((12 + glow * 14) * (0.42 + amp * 0.70));
    (pg as any).stroke(hue, sat * 0.28, Math.min(bright * gFactor * 0.42, 100), 160);
    pg.beginShape();
    for (let j = 0; j <= STEPS; j++) pg.vertex(xs[j], ys[j]);
    pg.endShape(CLOSE);

    // Pass 2 — mid glow
    pg.strokeWeight((4 + glow * 5.5) * (0.42 + amp * 0.70));
    (pg as any).stroke(hue, sat * 0.58, Math.min(bright * gFactor * 0.75, 100), 200);
    pg.beginShape();
    for (let j = 0; j <= STEPS; j++) pg.vertex(xs[j], ys[j]);
    pg.endShape(CLOSE);

    // Pass 3 — bright core
    pg.strokeWeight(0.8 + amp * 1.6);
    (pg as any).stroke(hue, sat * 0.22 + 14, Math.min(bright, 100), 235);
    pg.beginShape();
    for (let j = 0; j <= STEPS; j++) pg.vertex(xs[j], ys[j]);
    pg.endShape(CLOSE);
  }

  // ── Centre orb ───────────────────────────────────────────────────────────────
  pg.noStroke();
  const orbR = 5 + overallAmp * 20 + beatFlash * 12;
  pg.fill(0, 0, 100, Math.round(85 + beatFlash * 155));
  pg.ellipse(cx, cy, orbR * 2, orbR * 2);
  pg.fill(0, 0, 100, Math.round(22 + beatFlash * 55));
  pg.ellipse(cx, cy, orbR * 5.5, orbR * 5.5);

  // Reset buffer color mode before next fade call
  (pg as any).colorMode('rgb', 255, 255, 255, 255);

  // ── Composite buffer to main canvas ────────────────────────────────────────
  p.background(0);
  p.image(pg, 0, 0);

  // Beat flash: brief colour overlay
  if (beatFlash > 0.015) {
    (p as any).colorMode(p['HSB'], 360, 100, 100, 255);
    p.fill((hueShift + 210) % 360, 55, 100, Math.round(beatFlash * 38));
    p.noStroke();
    p.rect(0, 0, W, H);
    (p as any).colorMode(p['RGB'], 255, 255, 255, 255);
  }
}
