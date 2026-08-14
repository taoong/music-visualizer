/**
 * Kintsugi — Audio-reactive golden repair visualization.
 *
 * Inspired by the traditional Japanese art of kintsugi (金継ぎ, "golden joinery"),
 * the 15th-century craft attributed to ceramicist Murata Jukō: repairing shattered
 * pottery with gold lacquer — turning breakage into part of an object's beauty and
 * history. Reinterpreted through teamLab's installation "Transcending Boundaries"
 * (Mori Art Museum, Tokyo 2020, https://www.teamlab.art/w/transcending_boundaries_tsugite/)
 * in which glowing golden seams fracture across dark walls, mapping invisible
 * connections between visitor bodies.
 *
 * Beats shatter the dark ceramic canvas; fracture lines spread and branch, each
 * glowing from within with molten gold light. Sub-bass produces wide, deep fissures;
 * brilliance creates fine hairline tracery. Between beats the crack network pulses
 * gently with the music's breath.
 *
 * Sliders
 *   Fragility — how aggressively beats fracture the surface (crack density & count)
 *   Gold      — luminous repair color: warm amber → pure gold → cool silver-white
 *   Trace     — how long crack lines linger before fading
 */
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { BAND_COUNT, isMobile } from '../utils/constants';

const MAX_SEGS = isMobile ? 70 : 160;

// Base stroke weight per band: sub-bass = heavy crack, brilliance = hairline
const BAND_WEIGHTS = [4.5, 3.5, 2.8, 2.2, 1.6, 1.0, 0.6];

interface Seg {
  x1: number; y1: number;
  ax: number; ay: number;   // unit direction vector
  len: number;              // current drawn length
  maxLen: number;
  w: number;                // stroke base weight
  alpha: number;            // 0–100
  age: number;              // accumulated dt frames
  band: number;             // 0–6
  branched: boolean;
}

let segs: Seg[] = [];
let lastBeat = -1;
let beatFlash = 0;
let micPrevAmp = 0;   // smoothed amp for mic-mode transient detection

export function resetKintsugi(): void {
  segs = [];
  lastBeat = -1;
  beatFlash = 0;
  micPrevAmp = 0;
}

function addSeg(
  x: number, y: number, angle: number, band: number, len: number, w: number
): void {
  if (segs.length >= MAX_SEGS) return;
  segs.push({
    x1: x, y1: y,
    ax: Math.cos(angle), ay: Math.sin(angle),
    len: 0, maxLen: len,
    w, alpha: 100, age: 0,
    band, branched: false,
  });
}

function burst(px: number, py: number, amps: number[], fragility: number): void {
  const n = 3 + Math.round(fragility * 5);   // 3–8 root cracks
  const baseAng = Math.random() * Math.PI * 2;
  for (let i = 0; i < n; i++) {
    const ang = baseAng + (i / n) * Math.PI * 2 + (Math.random() - 0.5) * 0.7;
    const b   = Math.floor(Math.random() * BAND_COUNT);
    const len = 35 + amps[b] * 180 + Math.random() * 90;
    addSeg(px, py, ang, b, len, BAND_WEIGHTS[b]);
  }
}

export function drawKintsugi(p: P5Instance, dt: number): void {
  const { state, config } = store;
  const { amps } = getBandAverages(BAND_COUNT);
  const W = p.width;
  const H = p.height;

  const fragility = config.kintsugiFragility;
  const goldT     = config.kintsugiGold;
  const traceT    = config.kintsugiTrace;

  // Crack lifespan in dt-units: 80–340
  const traceDur  = 80 + traceT * 260;
  const fadeStart = traceDur * 0.52;

  // ── Beat detection ──────────────────────────────────────────────────────────
  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adj = pos - state.beatOffset;
    const bi  = adj >= 0 ? Math.floor(adj / state.beatIntervalSec) : -1;
    if (bi >= 0 && bi !== lastBeat) {
      lastBeat  = bi;
      beatFlash = 1.0;
      const numBursts = 1 + Math.round(fragility * 2);  // 1–3 fracture points
      for (let c = 0; c < numBursts; c++) {
        const px = W * (0.12 + Math.random() * 0.76);
        const py = H * (0.12 + Math.random() * 0.76);
        burst(px, py, amps, fragility);
      }
    }
  } else {
    // Mic / interactive: amplitude surges trigger pseudo-beat fractures
    const totalAmp = amps.reduce((a, b) => a + b, 0) / BAND_COUNT;
    if (totalAmp > micPrevAmp * 1.55 + 0.12 && totalAmp > 0.28 && segs.length < MAX_SEGS - 8) {
      beatFlash = 0.55;
      burst(W * (0.2 + Math.random() * 0.6), H * (0.2 + Math.random() * 0.6), amps, fragility * 0.7);
    }
    micPrevAmp = micPrevAmp * 0.94 + totalAmp * 0.06;
  }

  // ── Background: dark ceramic with subtle beat flash ─────────────────────────
  beatFlash *= Math.pow(0.88, dt);
  const fg = Math.round(beatFlash * 20);
  p.background(11 + fg, 8 + Math.round(fg * 0.6), 6 + Math.round(fg * 0.35));

  // ── Gold color temperature ──────────────────────────────────────────────────
  // goldT=0.0 → warm amber   H=30 S=90 B=87
  // goldT=0.5 → pure gold    H=44 S=78 B=100
  // goldT=1.0 → silver-white H=50 S=8  B=98
  const baseH: number = goldT < 0.5
    ? 30 + goldT * 2.0 * 14          // 30–44
    : 44 + (goldT - 0.5) * 2.0 * 6; // 44–50
  const baseS: number = goldT < 0.5
    ? 90 - goldT * 2.0 * 12          // 90–78
    : 78 - (goldT - 0.5) * 2.0 * 70; // 78–8
  const baseB: number = goldT < 0.5
    ? 87 + goldT * 2.0 * 13          // 87–100
    : 100 - (goldT - 0.5) * 2.0 * 2; // 100–98

  // ── Render ──────────────────────────────────────────────────────────────────
  (p as any).colorMode(p['HSB'], 360, 100, 100, 100);
  p.blendMode(p['ADD']);
  p.noFill();

  const growRate = 3.2;

  let i = segs.length;
  while (i--) {
    const s = segs[i];

    // Grow toward maxLen (faster when that band is loud)
    if (s.len < s.maxLen) {
      s.len = Math.min(s.maxLen, s.len + growRate * dt * (1 + amps[s.band] * 3.5));

      // Spawn one branch at ~70% grown
      if (!s.branched && s.len >= s.maxLen * 0.70) {
        s.branched = true;
        if (Math.random() < 0.35 + fragility * 0.45 && segs.length < MAX_SEGS - 2) {
          const ex   = s.x1 + s.ax * s.len;
          const ey   = s.y1 + s.ay * s.len;
          const aOff = (Math.random() - 0.5) * 1.3;
          const bAng = Math.atan2(s.ay, s.ax) + aOff;
          const cb   = Math.min(BAND_COUNT - 1, s.band + 1 + (Math.random() < 0.35 ? 1 : 0));
          addSeg(ex, ey, bAng, cb, s.maxLen * (0.30 + Math.random() * 0.40), Math.max(0.4, s.w * 0.6));
        }
      }
    }

    // Age & fade
    s.age += dt;
    if (s.age > fadeStart) {
      const fp = Math.min(1, (s.age - fadeStart) / Math.max(1, traceDur - fadeStart));
      s.alpha  = Math.max(0, 100 * (1 - fp));
    }
    if (s.alpha <= 0) { segs.splice(i, 1); continue; }

    const ex = s.x1 + s.ax * s.len;
    const ey = s.y1 + s.ay * s.len;

    // Subtle per-band hue tint (sub-bass warmer, brilliance cooler)
    const hTint = (s.band - 3) * 2.5;
    const h     = ((baseH + hTint) % 360 + 360) % 360;
    const sat   = Math.max(0, Math.min(100, baseS));
    const bri   = Math.max(0, Math.min(100, baseB));

    // Amplitude pulse on the core brightness
    const pulse = amps[s.band] * 14;
    const a     = s.alpha;

    // Pass 1: wide outer halo — warm, very soft
    p.strokeWeight(s.w * 7.5);
    p.stroke(h, sat * 0.35, bri * 0.55, a * 0.07);
    p.line(s.x1, s.y1, ex, ey);

    // Pass 2: mid glow
    p.strokeWeight(s.w * 3.5);
    p.stroke(h, sat * 0.60, bri * 0.84, a * 0.20);
    p.line(s.x1, s.y1, ex, ey);

    // Pass 3: bright molten core
    p.strokeWeight(s.w);
    p.stroke(h, sat * 0.22, Math.min(100, bri + pulse), a * 0.90);
    p.line(s.x1, s.y1, ex, ey);
  }

  // Spontaneous hairline cracks from sustained high amplitude (not beat-gated)
  const avgAmp = amps.reduce((a, b) => a + b, 0) / BAND_COUNT;
  if (avgAmp > 0.38 && segs.length < MAX_SEGS - 2 &&
      Math.random() < (avgAmp - 0.38) * fragility * 0.05) {
    const b = Math.floor(Math.random() * BAND_COUNT);
    addSeg(
      Math.random() * W, Math.random() * H,
      Math.random() * Math.PI * 2,
      b, 10 + amps[b] * 60, 0.4 + Math.random() * 0.5
    );
  }

  // ── Reset render state ──────────────────────────────────────────────────────
  p.blendMode(p['BLEND']);
  (p as any).colorMode(p['RGB'], 255, 255, 255, 255);
}
