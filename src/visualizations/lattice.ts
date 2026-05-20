/**
 * Lattice — audio-reactive warped neon grid.
 *
 * Inspired by Vera Molnár's "Interruptions" series (1968–1969): a regular
 * rectangular grid is elastically deformed by controlled algorithmic
 * interventions — here, the music.  Each horizontal stripe of vertices is
 * pulled sinusoidally by its mapped frequency band; Perlin noise adds slow
 * organic drift; a beat-triggered ripple wave radiates outward from centre.
 * Edges are drawn with per-band jewel-tone hues and a 3-pass neon glow.
 *
 * Sliders
 *   Grid  — columns per row (5–24); rows scale to keep ~square cells
 *   Warp  — audio displacement amplitude (0–2)
 *   Glow  — neon brightness/halo multiplier (0.5–3)
 */
import { store } from '../state/store';
import { getBandAverages } from './helpers';
import { BAND_COUNT, isMobile } from '../utils/constants';
import { audioEngine } from '../audio/engine';

// Jewel-tone palette: violet → blue → teal → green → gold → orange → magenta
const BAND_HUES = [270, 215, 170, 115, 52, 22, 305] as const;

// Glow passes: outer halo → mid bloom → core line
const GLOW_PASSES = [
  { wMult: 6.0, aScale: 0.07 },
  { wMult: 2.5, aScale: 0.26 },
  { wMult: 1.0, aScale: 1.00 },
] as const;

// Module-scoped state (no classes, per project convention)
let time = 0;
let lastBeatIndex = -1;
let beatFlash = 0;      // 1→0 on beat
let rippleRadius = 0;   // pixel radius of expanding shock ring
let rippleStrength = 0; // 1→0, amplitude of the ripple wave

export function resetLattice(): void {
  time = 0;
  lastBeatIndex = -1;
  beatFlash = 0;
  rippleRadius = 0;
  rippleStrength = 0;
}

export function drawLattice(p: P5Instance, dt: number): void {
  const { state, config } = store;
  const { amps } = getBandAverages(BAND_COUNT);

  const w = p.width;
  const h = p.height;
  const cx = w / 2;
  const cy = h / 2;

  // Grid resolution — cols from slider, rows keeps approximately square cells
  const maxGrid = isMobile ? 12 : 24;
  const cols = Math.max(3, Math.min(maxGrid, Math.round(config.latticeGrid)));
  const rows = Math.max(3, Math.round(cols * h / w));

  const cellW = w / cols;
  const cellH = h / rows;

  const warpAmt = config.latticeWarp;
  const glowMult = config.latticeGlow;

  // ── Beat detection ──────────────────────────────────────────────────────────
  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adj = pos - state.beatOffset;
    const idx = adj >= 0 ? Math.floor(adj / state.beatIntervalSec) : -1;
    if (idx >= 0 && idx !== lastBeatIndex) {
      lastBeatIndex = idx;
      beatFlash = 1.0;
      rippleRadius = 0;
      rippleStrength = 1.0;
    }
  }

  // Advance and decay
  time += dt * 0.018;
  beatFlash *= Math.pow(0.87, dt);
  if (beatFlash < 0.001) beatFlash = 0;

  rippleRadius += dt * 5.8; // px per normalized frame
  rippleStrength *= Math.pow(0.92, dt);
  if (rippleStrength < 0.001) { rippleStrength = 0; rippleRadius = 0; }

  // ── Compute displaced vertex positions ─────────────────────────────────────
  // vtx[(j*(cols+1)+i)*2] = x,  [+1] = y
  const vtxCount = (cols + 1) * (rows + 1);
  const vtx = new Float32Array(vtxCount * 2);

  const noiseScale = 0.003;
  const ringW = Math.min(cellW, cellH) * 4.5; // ripple ring width in px

  for (let j = 0; j <= rows; j++) {
    const jt = j / rows;
    const rowBand = Math.min(BAND_COUNT - 1, Math.floor(jt * BAND_COUNT));
    const rowAmp = amps[rowBand];

    for (let i = 0; i <= cols; i++) {
      const it = i / cols;
      const colBand = Math.min(BAND_COUNT - 1, Math.floor(it * BAND_COUNT));
      const colAmp = amps[colBand];

      const baseX = it * w;
      const baseY = jt * h;

      // Sinusoidal displacement: row amplitude drives Y, col amplitude drives X
      const dispY = Math.sin(time * 2.1 + i * 0.43 + rowBand * 0.85) * rowAmp * warpAmt * cellH * 1.3;
      const dispX = Math.cos(time * 1.8 + j * 0.37 + colBand * 0.70) * colAmp * warpAmt * cellW * 0.7;

      // Perlin noise — slow organic undulation independent of audio
      const nx = (p.noise(baseX * noiseScale, baseY * noiseScale, time * 0.22) - 0.5) * cellW * 0.55;
      const ny = (p.noise(baseX * noiseScale + 83.7, baseY * noiseScale + 41.3, time * 0.22) - 0.5) * cellH * 0.55;

      // Radial ripple from last beat
      let ripX = 0;
      let ripY = 0;
      if (rippleStrength > 0.001) {
        const dx = baseX - cx;
        const dy = baseY - cy;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const d = Math.abs(dist - rippleRadius);
        if (d < ringW) {
          const env = (1.0 - d / ringW) * rippleStrength;
          ripX = (dx / dist) * env * cellW * 3.2;
          ripY = (dy / dist) * env * cellH * 3.2;
        }
      }

      const vi = (j * (cols + 1) + i) * 2;
      vtx[vi]     = baseX + dispX + nx + ripX;
      vtx[vi + 1] = baseY + dispY + ny + ripY;
    }
  }

  // ── Render ──────────────────────────────────────────────────────────────────
  (p as any).colorMode(p['HSB'], 360, 100, 100, 100);
  (p as any).noFill();

  const baseW = Math.max(0.4, Math.min(w, h) / 900);

  for (const pass of GLOW_PASSES) {
    // Horizontal edges: (i,j)→(i+1,j) — colored by row's frequency band
    for (let j = 0; j <= rows; j++) {
      const jt = j / rows;
      const bIdx = Math.min(BAND_COUNT - 1, Math.floor(jt * BAND_COUNT));
      const amp = amps[bIdx];
      const hue = BAND_HUES[bIdx];
      const sat = 52 + amp * 43;
      const bri = 28 + amp * 62 + beatFlash * 22;
      const alp = Math.min(100, pass.aScale * (10 + amp * 80 + beatFlash * 25) * glowMult);

      (p as any).stroke(hue, sat, bri, alp);
      p.strokeWeight(baseW * pass.wMult * glowMult * (0.55 + amp * 0.85 + beatFlash * 0.45));

      for (let i = 0; i < cols; i++) {
        const a = (j * (cols + 1) + i) * 2;
        p.line(vtx[a], vtx[a + 1], vtx[a + 2], vtx[a + 3]);
      }
    }

    // Vertical edges: (i,j)→(i,j+1) — colored by column's frequency band
    for (let i = 0; i <= cols; i++) {
      const it = i / cols;
      const bIdx = Math.min(BAND_COUNT - 1, Math.floor(it * BAND_COUNT));
      const amp = amps[bIdx];
      const hue = BAND_HUES[bIdx];
      const sat = 48 + amp * 47;
      const bri = 24 + amp * 66 + beatFlash * 22;
      const alp = Math.min(100, pass.aScale * (8 + amp * 82 + beatFlash * 25) * glowMult);

      (p as any).stroke(hue, sat, bri, alp);
      p.strokeWeight(baseW * pass.wMult * glowMult * (0.50 + amp * 0.90 + beatFlash * 0.45));

      for (let j = 0; j < rows; j++) {
        const a = (j * (cols + 1) + i) * 2;
        const b = ((j + 1) * (cols + 1) + i) * 2;
        p.line(vtx[a], vtx[a + 1], vtx[b], vtx[b + 1]);
      }
    }
  }

  // Momentary white beat flash
  if (beatFlash > 0.35) {
    (p as any).fill(0, 0, 100, beatFlash * 14);
    (p as any).noStroke();
    p.rect(0, 0, w, h);
  }

  (p as any).colorMode(p['RGB'], 255);
}
