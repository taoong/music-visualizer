/**
 * Tracery — Audio-reactive Gothic rose window.
 *
 * 7 concentric rings of stained-glass arc panels (one per freq band) nest
 * from a glowing sub-bass core to a fine brilliance rim. Each ring is
 * subdivided into N×(ring+1) panels so the petal count naturally multiplies
 * outward — the same self-similar geometry you see in real Gothic tracery.
 * Panel faces are filled in translucent HSB color keyed to their band;
 * amplitude drives brightness and saturation. Dark "lead-line" dividers
 * between panels mimic the stone mullions of cathedral windows. Beat fires
 * a radial white flash and shifts the whole hue palette. The window rotates
 * slowly; all seven rings share one angular offset so the tracery reads as
 * a single coherent design rather than seven independent wheels.
 *
 * Inspired by the west rose window of Notre-Dame de Paris (c. 1220 CE) and
 * the stained-glass program designed by Joan Vila-Grau for the Sagrada
 * Família (2010, https://www.sagradafamilia.org/en/decorative-arts).
 *
 * Sliders:
 *   Petals  — N-fold radial divisions per ring (4–12)
 *   Glow    — bloom and inner-light intensity
 *   Spin    — clockwise rotation rate
 */
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { BAND_COUNT, isMobile } from '../utils/constants';

const TWO_PI = Math.PI * 2;

// Hue per frequency band, inner→outer: violet → warm amber
const BAND_HUES = [270, 230, 195, 150, 90, 45, 25] as const;

// ── Module state ──────────────────────────────────────────────────────────
let rotation = 0;
let beatFlash = 0;   // 0–1, decays after beat
let hueShift = 0;    // rotates palette on every beat
let lastBeatIndex = -1;

// ── Helpers ───────────────────────────────────────────────────────────────

/** Draw a filled arc-sector as a closed polygon. */
function arcSector(
  p: P5Instance,
  cx: number, cy: number,
  r0: number, r1: number,
  a0: number, a1: number,
): void {
  const span = a1 - a0;
  // steps proportional to arc length, minimum 4
  const outerSteps = Math.max(4, Math.ceil((span * r1) / 6));
  const innerSteps = Math.max(4, Math.ceil((span * r0) / 6));

  p.beginShape();
  for (let j = 0; j <= outerSteps; j++) {
    const a = a0 + span * j / outerSteps;
    p.vertex(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
  }
  for (let j = innerSteps; j >= 0; j--) {
    const a = a0 + span * j / innerSteps;
    p.vertex(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
  }
  p.endShape(p['CLOSE']);
}

// ── Draw ──────────────────────────────────────────────────────────────────
export function drawTracery(p: P5Instance, dt: number): void {
  const { state, config } = store;
  const { amps } = getBandAverages(BAND_COUNT);

  const petals  = Math.round(config.traceryPetals);
  const glowAmt = config.traceryGlow;
  const spinAmt = config.tracerySpin;

  // Beat detection
  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    if (adjusted >= 0) {
      const idx = Math.floor(adjusted / state.beatIntervalSec);
      if (idx !== lastBeatIndex) {
        lastBeatIndex = idx;
        beatFlash = 1.0;
        hueShift  = (hueShift + 51) % 360;
      }
    }
  }
  beatFlash *= Math.pow(0.88, dt);
  rotation  += spinAmt * 0.0008 * dt;

  // Layout
  const cx   = p.width  / 2;
  const cy   = p.height / 2;
  const maxR = Math.min(cx, cy) * 0.93;
  const rw   = maxR / BAND_COUNT;   // width of each ring

  // Reduce panel count on mobile for performance
  const petalsMobile = isMobile ? Math.max(4, petals - 2) : petals;

  (p as any).colorMode(p['HSB'], 360, 100, 100, 100);

  // ── Background ──
  p.background(0, 0, 6);

  // ── Draw glass panels (inner→outer so outer rings don't occlude inner) ──
  p.noStroke();
  for (let ring = 0; ring < BAND_COUNT; ring++) {
    const r0  = ring * rw;
    const r1  = r0 + rw;
    const n   = petalsMobile * (ring + 1);
    const dA  = TWO_PI / n;

    const amp  = amps[ring];
    const hue  = (BAND_HUES[ring] + hueShift) % 360;
    const bri  = 12 + amp * 68 + beatFlash * 35;
    const sat  = 55 + amp * 45;

    for (let s = 0; s < n; s++) {
      const a0 = s * dA + rotation;
      const a1 = a0 + dA * 0.87;   // gap ~13 % for lead line

      // Alternate darker panels to break monotony
      const altFactor = (s % 2 === 0) ? 1.0 : 0.80;
      p.fill(hue, sat * altFactor, bri * altFactor, 88);
      arcSector(p, cx, cy, r0, r1, a0, a1);
    }
  }

  // ── Draw tracery lead lines (dark stone color) ──
  const leadColor = 15 + beatFlash * 10;   // slightly brighter on beat
  p.noFill();
  p.stroke(0, 0, leadColor);
  p.strokeWeight(isMobile ? 1.0 : 1.5);

  // Ring boundaries
  for (let ring = 0; ring <= BAND_COUNT; ring++) {
    p.circle(cx, cy, ring * rw * 2);
  }

  // Radial spokes per ring
  for (let ring = 0; ring < BAND_COUNT; ring++) {
    const r0 = ring * rw;
    const r1 = r0 + rw;
    const n  = petalsMobile * (ring + 1);
    const dA = TWO_PI / n;
    for (let s = 0; s < n; s++) {
      const a = s * dA + rotation;
      p.line(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0,
             cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
    }
  }

  // ── Glow pass — draw radial arc at mid-ring radius per band ──
  const ctx = (p as any).drawingContext;
  for (let ring = 0; ring < BAND_COUNT; ring++) {
    const amp = amps[ring];
    if (amp < 0.03 && beatFlash < 0.05) continue;

    const rMid   = (ring + 0.5) * rw;
    const hue    = (BAND_HUES[ring] + hueShift) % 360;
    const glowR  = glowAmt * 18 * (amp + beatFlash * 0.3);

    ctx.shadowBlur  = glowR;
    ctx.shadowColor = `hsla(${hue}, 90%, 65%, ${(amp * 0.7 + 0.1).toFixed(2)})`;

    p.noFill();
    p.stroke(hue, 70, 90, 55);
    p.strokeWeight(1.0);
    p.circle(cx, cy, rMid * 2);
  }
  ctx.shadowBlur = 0;

  // ── Centre boss — small glowing disc ──
  const overall = amps.reduce((s, v) => s + v, 0) / BAND_COUNT;
  p.noStroke();
  const bossR = rw * 0.38 * (1 + overall * 0.6 + beatFlash * 0.4);
  for (let layer = 3; layer >= 0; layer--) {
    const frac   = layer / 3;
    const alpha  = (1 - frac) * (30 + overall * 40 + beatFlash * 30);
    const bossHue = (60 + hueShift) % 360;
    p.fill(bossHue, 40 + overall * 30, 100, alpha);
    p.circle(cx, cy, bossR * (1 - frac * 0.6) * 2);
  }

  // ── Beat flash overlay ──
  if (beatFlash > 0.05) {
    p.fill(0, 0, 100, beatFlash * 18);
    p.rect(0, 0, p.width, p.height);
  }

  (p as any).colorMode(p['RGB'], 255);
}

// ── Reset ─────────────────────────────────────────────────────────────────
export function resetTracery(): void {
  rotation      = 0;
  beatFlash     = 0;
  hueShift      = 0;
  lastBeatIndex = -1;
}
