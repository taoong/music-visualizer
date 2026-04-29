/**
 * Noodles — glowing neon serpents that swim to the music.
 *
 * 7 noodles (one per frequency band) roam freely across the canvas.
 * Each noodle is a ring-buffered chain of head positions; the head is
 * steered each frame by Perlin noise scaled by the band's amplitude,
 * and the body is the trail of recent positions.  On beats all noodles
 * surge in speed and brightness.
 *
 * Sliders
 *   Length    — body segment count (20–150)
 *   Speed     — base movement speed (0.2–3)
 *   Thickness — stroke-weight multiplier (0.3–2)
 */
import { store } from '../state/store';
import { getBandAverages } from './helpers';
import { BAND_COUNT } from '../utils/constants';
import { audioEngine } from '../audio/engine';

// HSB hues per band: sub → bass → lowMid → mid → upperMid → presence → brilliance
const BAND_HUES = [0, 30, 65, 140, 195, 240, 280];

const MAX_SEGS = 150;

interface Noodle {
  xs: Float32Array;
  ys: Float32Array;
  head: number; // newest segment index in ring buffer
  vx: number;
  vy: number;
  nOffX: number; // Perlin noise seed offset X
  nOffY: number; // Perlin noise seed offset Y
}

// ── module-scoped state ──────────────────────────────────────────────────────
let noodles: Noodle[] = [];
let noiseT = 0;
let lastBeatIndex = -1;
let beatPulse = 0;
let canvasW = 0;
let canvasH = 0;

// ── helpers ──────────────────────────────────────────────────────────────────
function makeNoodle(cx: number, cy: number, i: number): Noodle {
  return {
    xs: new Float32Array(MAX_SEGS).fill(cx),
    ys: new Float32Array(MAX_SEGS).fill(cy),
    head: 0,
    vx: 0,
    vy: 0,
    nOffX: i * 43.71,
    nOffY: i * 91.33,
  };
}

function initNoodles(w: number, h: number): void {
  noodles = Array.from({ length: BAND_COUNT }, (_, i) => {
    const angle = (i / BAND_COUNT) * Math.PI * 2;
    const r = Math.min(w, h) * 0.22;
    return makeNoodle(w / 2 + Math.cos(angle) * r, h / 2 + Math.sin(angle) * r, i);
  });
}

// ── reset ────────────────────────────────────────────────────────────────────
export function resetNoodles(): void {
  noodles = [];
  noiseT = 0;
  lastBeatIndex = -1;
  beatPulse = 0;
  canvasW = 0;
  canvasH = 0;
}

// ── draw ─────────────────────────────────────────────────────────────────────
export function drawNoodles(p: P5Instance, dt: number): void {
  const { state, config } = store;
  const { amps } = getBandAverages(BAND_COUNT);

  const w = p.width;
  const h = p.height;

  // Initialize / re-initialize when canvas size changes
  if (noodles.length !== BAND_COUNT || canvasW !== w || canvasH !== h) {
    canvasW = w;
    canvasH = h;
    initNoodles(w, h);
  }

  // Beat detection
  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    const beat = adjusted >= 0 ? Math.floor(adjusted / state.beatIntervalSec) : -1;
    if (beat >= 0 && beat !== lastBeatIndex) {
      lastBeatIndex = beat;
      beatPulse = 1.0;
    }
  }
  beatPulse *= Math.pow(0.87, dt);
  if (beatPulse < 0.001) beatPulse = 0;

  const segCount = Math.max(10, Math.min(MAX_SEGS, Math.round(config.noodlesLength)));
  const speed = config.noodlesSpeed;
  const thickness = config.noodlesThickness;

  noiseT += 0.012 * dt * speed;

  (p as any).colorMode(p['HSB'], 360, 100, 100, 100);

  for (let i = 0; i < BAND_COUNT; i++) {
    const nd = noodles[i];
    const amp = amps[i];

    // ── physics: Perlin-noise steering ───────────────────────────────────────
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const nx = (p as any).noise(nd.nOffX, noiseT + i * 0.37);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ny = (p as any).noise(nd.nOffY + 100, noiseT + i * 0.37);

    const steerAngle = nx * Math.PI * 4;
    const forceMag = (0.4 + amp * 2.8 + beatPulse * 1.2) * speed * dt * 0.15;

    nd.vx += Math.cos(steerAngle) * forceMag + (ny - 0.5) * forceMag * 0.5;
    nd.vy += Math.sin(steerAngle) * forceMag + (nx - 0.5) * forceMag * 0.5;

    // Speed cap
    const spd = Math.sqrt(nd.vx * nd.vx + nd.vy * nd.vy);
    const maxSpd = (2.0 + amp * 4.5 + beatPulse * 3.0) * speed;
    if (spd > maxSpd) {
      nd.vx = (nd.vx / spd) * maxSpd;
      nd.vy = (nd.vy / spd) * maxSpd;
    }

    // Damping
    const damp = Math.pow(0.88, dt);
    nd.vx *= damp;
    nd.vy *= damp;

    // Soft boundary repulsion
    const margin = 55;
    const hx = nd.xs[nd.head];
    const hy = nd.ys[nd.head];
    if (hx < margin) nd.vx += (margin - hx) * 0.06 * dt;
    else if (hx > w - margin) nd.vx -= (hx - (w - margin)) * 0.06 * dt;
    if (hy < margin) nd.vy += (margin - hy) * 0.06 * dt;
    else if (hy > h - margin) nd.vy -= (hy - (h - margin)) * 0.06 * dt;

    // Advance ring-buffer head
    const newX = Math.max(0, Math.min(w, hx + nd.vx * dt));
    const newY = Math.max(0, Math.min(h, hy + nd.vy * dt));
    nd.head = (nd.head + 1) % MAX_SEGS;
    nd.xs[nd.head] = newX;
    nd.ys[nd.head] = newY;

    // ── rendering ────────────────────────────────────────────────────────────
    const hue = BAND_HUES[i];
    const sat = 72 + amp * 28;
    const baseBri = 55 + amp * 45 + beatPulse * 15;

    // Draw 3-pass glow using chunked alpha for a tail-fade effect
    // Dividing body into NUM_CHUNKS sections, each with its own alpha level.
    const NUM_CHUNKS = 8;
    const chunkSize = Math.ceil(segCount / NUM_CHUNKS);

    const PASSES = [
      { wMult: 5.0, baseAlpha: 18 + amp * 14 },
      { wMult: 2.2, baseAlpha: 38 + amp * 28 },
      { wMult: 1.0, baseAlpha: 85 + amp * 15 + beatPulse * 10 },
    ];

    for (const pass of PASSES) {
      const sw = Math.max(0.5, thickness * (2 + amp * 6 + beatPulse * 2.5) * pass.wMult);

      for (let chunk = 0; chunk < NUM_CHUNKS; chunk++) {
        const chunkStart = chunk * chunkSize;
        const chunkEnd = Math.min(chunkStart + chunkSize + 1, segCount); // +1 for overlap
        const t = (chunk + 0.5) / NUM_CHUNKS; // 0 = tail, 1 = head
        const alpha = pass.baseAlpha * t * t; // quadratic fade for smoother look

        p.noFill();
        p.stroke(hue, sat, Math.min(100, baseBri), alpha);
        p.strokeWeight(sw);

        p.beginShape();
        for (let s = chunkStart; s < chunkEnd; s++) {
          // Index in ring buffer: s=0 is oldest visible segment, s=segCount-1 is head
          const idx = (nd.head - segCount + 1 + s + MAX_SEGS) % MAX_SEGS;
          p.curveVertex(nd.xs[idx], nd.ys[idx]);
        }
        p.endShape();
      }
    }
  }

  (p as any).colorMode(p['RGB'], 255, 255, 255, 255);
}
