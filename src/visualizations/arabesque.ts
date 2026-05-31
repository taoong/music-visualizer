/**
 * Arabesque — John Whitney Sr. differential motion harmonics.
 *
 * Seven petals (one per frequency band) are traced via Whitney's harmonic
 * radius formula: r[k] = R · |sin(k π / N)| at angle k · φ + band_offset.
 * Petals are phase-offset by 2π/7 so the ensemble traces 7-fold arabesque
 * symmetry. An offscreen trail buffer accumulates consecutive frames, building
 * layered Islamic-geometric forms that bloom with the music.
 *
 * Inspired by John Whitney Sr., "Arabesque" (1975, programmed by Larry Cuba).
 * https://www.youtube.com/watch?v=w7h0ppnUQhE
 *
 * Sliders: Steps (harmonic density 20–200), Speed (φ rate), Trail (persistence)
 */
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { BAND_COUNT, isMobile } from '../utils/constants';

// ── palette: 7 hues cycling violet → teal → gold ────────────────────────────
const BAND_HUES = [280, 230, 180, 120, 60, 30, 320];

// ── module-scoped state ──────────────────────────────────────────────────────
let phi = 0;
let hueShift = 0;
let beatPulse = 0;
let lastBeatIndex = -1;
let pg: any = null;

export function resetArabesque(): void {
  phi = 0;
  hueShift = 0;
  beatPulse = 0;
  lastBeatIndex = -1;
  pg = null;
}

export function drawArabesque(p: P5Instance, dt: number): void {
  const { state, config } = store;
  const { amps } = getBandAverages(BAND_COUNT);

  const w = p.width;
  const h = p.height;
  const cx = w / 2;
  const cy = h / 2;

  // Init / resize offscreen buffer
  if (!pg || pg.width !== w || pg.height !== h) {
    pg = (p as any).createGraphics(w, h);
    pg.pixelDensity(1);
    pg.background(0);
    phi = 0;
    hueShift = 0;
    beatPulse = 0;
    lastBeatIndex = -1;
  }

  // ── Beat detection ─────────────────────────────────────────────────────────
  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    const bi = adjusted >= 0 ? Math.floor(adjusted / state.beatIntervalSec) : -1;
    if (bi >= 0 && bi !== lastBeatIndex) {
      lastBeatIndex = bi;
      beatPulse = 1.0;
      hueShift = (hueShift + 35 + Math.random() * 35) % 360;
      // Phase snap: jump phi by a musically interesting fraction of a full cycle
      phi += (Math.PI * 2) / BAND_COUNT + (Math.random() - 0.5) * 0.3;
    }
  }
  beatPulse *= Math.pow(0.83, dt);
  if (beatPulse < 0.001) beatPulse = 0;

  // ── Parameters ────────────────────────────────────────────────────────────
  const maxN = isMobile ? 80 : 200;
  const N = Math.max(20, Math.min(maxN, Math.round(config.arabesqueSteps)));
  // phi advance rate: slow drift at 0, visibly morphing at 1
  const speed = 0.0008 + config.arabesqueSpeed * 0.018;
  // Trail fade alpha: high trail = low alpha (slow fade); low trail = high alpha (fast fade)
  const trailAlpha = Math.round(3 + (1 - config.arabesqueTrail) * 28);

  // Overall energy
  let energy = 0;
  for (let i = 0; i < amps.length; i++) energy += amps[i];
  energy /= amps.length;

  // Advance phi — audio energy nudges it faster
  phi += speed * dt * (1 + energy * 0.9 + beatPulse * 0.5);

  const R = Math.min(w, h) * 0.40;

  // ── Fade trail buffer ──────────────────────────────────────────────────────
  // Draw a semi-transparent black rect over the buffer each frame
  pg.noStroke();
  pg.fill(0, 0, 0, trailAlpha);
  pg.rect(0, 0, w, h);

  // ── Draw the 7 arabesque petals ────────────────────────────────────────────
  // Switch buffer to HSB
  (pg as any).colorMode(pg['HSB'] ?? 'hsb', 360, 100, 100, 100);

  const TWO_PI_OVER_7 = (Math.PI * 2) / BAND_COUNT;

  for (let b = 0; b < BAND_COUNT; b++) {
    const amp = amps[b] ?? 0;
    const phaseOff = b * TWO_PI_OVER_7;
    const hue = ((BAND_HUES[b] + hueShift) % 360 + 360) % 360;
    const sat = 70 + amp * 30;
    const bri = 48 + amp * 52 + beatPulse * 18;
    const alpha = 30 + amp * 60 + beatPulse * 30;
    const sw = 0.7 + amp * 2.0 + beatPulse * 0.6;

    // Pre-compute positions for this petal
    const xs = new Float32Array(N + 1);
    const ys = new Float32Array(N + 1);
    for (let k = 0; k <= N; k++) {
      const angle = k * phi + phaseOff;
      const normR = Math.abs(Math.sin((k * Math.PI) / N));
      const r = R * normR * (1 + amp * 0.55);
      xs[k] = cx + r * Math.cos(angle);
      ys[k] = cy + r * Math.sin(angle);
    }

    // Glow pass (wide, low-alpha)
    if (!isMobile) {
      pg.noFill();
      (pg as any).stroke(hue, sat * 0.55, bri, alpha * 0.28);
      (pg as any).strokeWeight(sw * 4.0);
      pg.beginShape();
      for (let k = 0; k <= N; k++) {
        pg.vertex(xs[k], ys[k]);
      }
      pg.endShape();
    }

    // Core pass
    (pg as any).stroke(hue, sat, Math.min(100, bri + 8), alpha);
    (pg as any).strokeWeight(sw);
    pg.noFill();
    pg.beginShape();
    for (let k = 0; k <= N; k++) {
      pg.vertex(xs[k], ys[k]);
    }
    pg.endShape();

    // Bright nodes at the petal's outermost point (k ≈ N/2)
    const peakK = Math.round(N / 2);
    const px = xs[peakK];
    const py = ys[peakK];
    const nodeSz = 3 + amp * 6 + beatPulse * 4;
    pg.noStroke();
    (pg as any).fill(hue, sat * 0.4, bri, alpha * 0.35);
    pg.ellipse(px, py, nodeSz * 3.5, nodeSz * 3.5);
    (pg as any).fill(hue, sat, Math.min(100, bri + 15), Math.min(100, alpha + 20));
    pg.ellipse(px, py, nodeSz, nodeSz);
  }

  // Reset buffer color mode to RGB
  (pg as any).colorMode(pg['RGB'] ?? 'rgb', 255);

  // ── Composite onto main canvas ─────────────────────────────────────────────
  p.background(0);
  p.image(pg, 0, 0);

  // Beat flash
  if (beatPulse > 0.25) {
    (p as any).colorMode(p['HSB'], 360, 100, 100, 100);
    (p as any).fill((hueShift + 160) % 360, 25, 100, beatPulse * 12);
    (p as any).noStroke();
    p.rect(0, 0, w, h);
    (p as any).colorMode(p['RGB'], 255);
  }
}
