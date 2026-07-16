/**
 * Kandinsky Composition — Bauhaus geometric abstraction.
 *
 * Inspired by Wassily Kandinsky's "Composition VIII" (1923, Solomon R.
 * Guggenheim Museum, New York, https://www.guggenheim.org/artwork/1924)
 * and his synesthesia-based color-music theory from "Concerning the Spiritual
 * in Art" (1911) and "Point and Line to Plane" (1926).
 *
 * Kandinsky had chromesthesia — sounds triggered automatic color-and-shape
 * perceptions. Bass rumble was a deep blue circle ("like the sound of an
 * organ"). A sharp trumpet note was yellow and triangular. Red belonged to a
 * powerful fanfare. This visualization completes his vision: each of the 7
 * frequency bands drives a geometric element in Kandinsky's own color-sound
 * vocabulary, producing a living Bauhaus composition that plays itself.
 *
 * 14 elements (2 per band) drift through a dynamic compositional balance
 * loosely mirroring the layout of Composition VIII — large disk upper-right,
 * triangles at opposing corners, arcs sweeping through the center.
 * On each beat the composition gently reshuffles into a new arrangement while
 * maintaining the tension between circular and angular, heavy and light.
 * Mobile: 7 elements (one per band) for reduced rendering cost.
 *
 * Sliders
 *   Density  — element scale (sparse/airy → large/overlapping forms)
 *   Motion   — amplitude response (subtle pulse → dramatic swell)
 *   Palette  — Bauhaus primaries (yellow/red/blue) → full chromatic spectrum
 */
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { BAND_COUNT, isMobile } from '../utils/constants';

// Kandinsky's chromesthesia color-music assignments (HSB, 0–360/100/100)
// Sub=deep blue (organ bass), Bass=red (trumpet fanfare), LowMid=green (viola),
// Mid=yellow (sharp flute), UpperMid=orange (warm horn), Presence=violet (muted),
// Brilliance=sky-blue (pure crystalline high)
const BAUHAUS_H: readonly number[] = [220,  0, 120,  55,  30, 280, 200];
const BAUHAUS_S: readonly number[] = [ 85, 90,  72,  95,  90,  72,  50];
const BAUHAUS_B: readonly number[] = [ 62, 78,  62,  96,  86,  68,  82];

// Chromatic alternative (violet → red)
const CHROMA_H: readonly number[] = [280, 230, 180, 120, 60, 30, 0];

type ElemType = 'disk' | 'ring' | 'arc' | 'triangle' | 'line' | 'chevron' | 'dot';

interface Elem {
  type:     ElemType;
  band:     number;   // 0–6 frequency band
  x:        number;   // current canvas position [0,1]
  y:        number;
  tx:       number;   // target position for smooth drift
  ty:       number;
  bx:       number;   // blueprint anchor (for bounded reshuffling)
  by:       number;
  rot:      number;   // current rotation (radians)
  trot:     number;   // target rotation
  baseSize: number;   // base size as fraction of min(W,H)
  a0:       number;   // arc start angle (radians)
  a1:       number;   // arc end angle
  scale:    number;   // current animated scale
}

// Blueprint: [type, band, x, y, rotDeg, arcA0, arcA1]
// Layout inspired by Composition VIII (1923) — large disk upper-right,
// triangles at opposing corners, arcs through center.
type BP = [ElemType, number, number, number, number, number, number];

const BLUEPRINT: readonly BP[] = [
  // PAIR 0 — sub-bass: deep blue ("like the sound of an organ")
  ['disk',     0,  0.72, 0.27,   0,  0,              0            ],
  ['ring',     0,  0.24, 0.74,   0,  0,              0            ],
  // PAIR 1 — bass: red (powerful fanfare)
  ['arc',      1,  0.50, 0.52,  25,  0,              Math.PI      ],
  ['triangle', 1,  0.80, 0.65,  20,  0,              0            ],
  // PAIR 2 — low-mid: calm green (viola)
  ['triangle', 2,  0.17, 0.21, -18,  0,              0            ],
  ['arc',      2,  0.62, 0.80,  -5,  0.25,           Math.PI*1.55 ],
  // PAIR 3 — mid: sharp yellow ("eccentric, like a trumpet's high note")
  ['line',     3,  0.38, 0.47,  58,  0,              0            ],
  ['chevron',  3,  0.68, 0.58,  12,  0,              0            ],
  // PAIR 4 — upper-mid: warm orange (horn)
  ['dot',      4,  0.13, 0.53,   0,  0,              0            ],
  ['ring',     4,  0.53, 0.16,   0,  0,              0            ],
  // PAIR 5 — presence: violet ("melancholy, fading into the distance")
  ['arc',      5,  0.84, 0.40,  38, -0.6,            Math.PI+0.7  ],
  ['line',     5,  0.42, 0.83,  18,  0,              0            ],
  // PAIR 6 — brilliance: sky-blue (pure, crystalline)
  ['dot',      6,  0.62, 0.11,   0,  0,              0            ],
  ['arc',      6,  0.50, 0.69, -38, -0.9,            Math.PI+0.5  ],
];

// Base sizes as fraction of min(W,H) — lower bands get larger elements
const BASE_SZ: Record<ElemType, number> = {
  disk:     0.22,
  ring:     0.17,
  arc:      0.28,
  triangle: 0.18,
  line:     0.30,
  chevron:  0.13,
  dot:      0.07,
};

// On mobile use only the first element of each pair (one per band)
const ACTIVE_BP: readonly BP[] = isMobile
  ? BLUEPRINT.filter((_, i) => i % 2 === 0)
  : BLUEPRINT;

// ── Module state ─────────────────────────────────────────────────────────────
let elems: Elem[] = [];
let lastBeat = -1;
let huePhase = 0;

export function resetKandinsky(): void {
  elems    = [];
  lastBeat = -1;
  huePhase = 0;
}

function initElems(): void {
  elems = ACTIVE_BP.map(([type, band, bx, by, rotDeg, a0, a1]) => ({
    type, band, bx, by,
    x: bx, y: by, tx: bx, ty: by,
    rot:  (rotDeg * Math.PI) / 180,
    trot: (rotDeg * Math.PI) / 180,
    baseSize: BASE_SZ[type],
    a0, a1,
    scale: 0.65,
  }));
}

function bounded(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function shufflePositions(): void {
  for (const el of elems) {
    // Drift ±14% from blueprint anchor — keeps composition coherent
    el.tx   = bounded(el.bx + (Math.random() - 0.5) * 0.28, 0.06, 0.94);
    el.ty   = bounded(el.by + (Math.random() - 0.5) * 0.22, 0.06, 0.94);
    el.trot = el.rot + (Math.random() - 0.5) * (Math.PI / 3.5);
  }
}

// ── Per-element drawing ───────────────────────────────────────────────────────
function drawElem(
  p:    P5Instance,
  el:   Elem,
  sz:   number,
  h:    number,
  s:    number,
  b:    number,
  a:    number,
): void {
  const cx = el.x * p.width;
  const cy = el.y * p.height;
  const sw = Math.max(1.5, sz * 0.055);

  p.push();
  p.translate(cx, cy);
  p.rotate(el.rot);

  switch (el.type) {
    case 'disk':
      p.noStroke();
      p.fill(h, s, b, a);
      p.ellipse(0, 0, sz, sz);
      // Thin contrasting ring — Kandinsky's bold graphic outline
      p.noFill();
      p.stroke((h + 180) % 360, s * 0.22, Math.min(b + 28, 100), a * 0.32);
      p.strokeWeight(sw * 0.7);
      p.ellipse(0, 0, sz * 1.07, sz * 1.07);
      break;

    case 'ring':
      p.noFill();
      p.stroke(h, s, b, a);
      p.strokeWeight(sw * 1.35);
      p.ellipse(0, 0, sz, sz);
      break;

    case 'arc':
      p.noFill();
      p.stroke(h, s, b, a);
      p.strokeWeight(sw * 1.5);
      p.arc(0, 0, sz, sz, el.a0, el.a1);
      break;

    case 'triangle': {
      const r   = sz * 0.5;
      const tx0 = 0,          ty0 = -r;
      const tx1 = -r * 0.866, ty1 =  r * 0.5;
      const tx2 =  r * 0.866, ty2 =  r * 0.5;
      p.noStroke();
      p.fill(h, s, b, a);
      p.triangle(tx0, ty0, tx1, ty1, tx2, ty2);
      // Thin dark edge stroke — Bauhaus bold contour
      p.noFill();
      p.stroke(h, s * 0.22, 10, a * 0.48);
      p.strokeWeight(sw * 0.62);
      p.triangle(tx0, ty0, tx1, ty1, tx2, ty2);
      break;
    }

    case 'line':
      p.noFill();
      p.stroke(h, s, b, a);
      p.strokeWeight(sz * 0.042);
      p.strokeCap(p['SQUARE']);
      p.line(-sz * 0.5, 0, sz * 0.5, 0);
      break;

    case 'chevron':
      p.noFill();
      p.stroke(h, s, b, a);
      p.strokeWeight(sw * 1.2);
      p.strokeJoin(p['MITER']);
      p.strokeCap(p['SQUARE']);
      p.beginShape();
      p.vertex(-sz * 0.44,  sz * 0.27);
      p.vertex(0,           -sz * 0.27);
      p.vertex( sz * 0.44,  sz * 0.27);
      p.endShape();
      break;

    case 'dot':
      p.noStroke();
      p.fill(h, s, b, a);
      p.ellipse(0, 0, sz, sz);
      // Secondary cluster dots — Kandinsky's "Point" theory (P&L to Plane)
      p.fill(h, s, Math.min(b + 14, 100), a * 0.62);
      p.ellipse(sz * 0.60, -sz * 0.32, sz * 0.48, sz * 0.48);
      p.fill(h, s, Math.min(b +  8, 100), a * 0.48);
      p.ellipse(-sz * 0.52, sz * 0.28, sz * 0.36, sz * 0.36);
      break;
  }

  p.pop();
}

// ── Main draw function ────────────────────────────────────────────────────────
export function drawKandinsky(p: P5Instance, dt: number): void {
  const { state, config } = store;
  const { amps }          = getBandAverages(BAND_COUNT);

  const density = config.kandinskyDensity;
  const motion  = config.kandinskyMotion;
  const palette = config.kandinskyPalette;

  const W = p.width;
  const H = p.height;
  const S = Math.min(W, H);

  if (elems.length === 0) initElems();

  // Beat detection — reshuffles composition and shifts hue
  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos     = audioEngine.getPlaybackPosition();
    const beatIdx = (pos - state.beatOffset) >= 0
      ? Math.floor((pos - state.beatOffset) / state.beatIntervalSec)
      : -1;
    if (beatIdx >= 0 && beatIdx !== lastBeat) {
      lastBeat = beatIdx;
      huePhase = (huePhase + 28) % 360;
      shufflePositions();
    }
  }

  // Smooth-update element positions, rotations, and amplitude-driven scale
  const posLerp   = 1 - Math.pow(0.97, dt);  // slow graceful compositional drift
  const scaleLerp = 1 - Math.pow(0.82, dt);  // fast amplitude tracking
  for (const el of elems) {
    const amp = amps[el.band];
    el.x   += (el.tx   - el.x)   * posLerp;
    el.y   += (el.ty   - el.y)   * posLerp;
    el.rot += (el.trot - el.rot) * posLerp;
    el.scale += (0.65 + amp * motion * 1.6 - el.scale) * scaleLerp;
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  (p as any).colorMode(p['HSB'], 360, 100, 100, 100);

  // Deep charcoal background — like canvas primed for Bauhaus work
  p.background(220, 6, 7);

  // Faint composition guide lines (underdrawing, very low opacity)
  p.stroke(45, 12, 38, 14);
  p.strokeWeight(0.5);
  p.line(W * 0.04, H * 0.08, W * 0.96, H * 0.92);  // diagonal tension axis
  p.line(W * 0.02, H * 0.72, W * 0.98, H * 0.72);  // lower-third horizontal

  // Draw elements back-to-front by visual weight for correct layering
  const PASSES: ElemType[][] = [
    ['line', 'arc', 'chevron'],   // thinnest / back
    ['ring'],                      // medium
    ['triangle', 'dot', 'disk'],  // heaviest / front
  ];
  for (const pass of PASSES) {
    for (const el of elems) {
      if (!pass.includes(el.type)) continue;

      const amp = amps[el.band];
      const sz  = el.baseSize * density * el.scale * S;
      if (sz < 1) continue;

      // Lerp hue between Bauhaus and chromatic palettes, add beat hue shift
      const h  = ((1 - palette) * BAUHAUS_H[el.band] + palette * CHROMA_H[el.band] + huePhase + 360) % 360;
      const s  = BAUHAUS_S[el.band] * (1 - palette) + 80 * palette;
      const b  = Math.min(BAUHAUS_B[el.band] + amp * motion * 28, 100);
      const a  = Math.min(58 + amp * 32 + density * 12, 90);

      drawElem(p, el, sz, h, s, b, a);
    }
  }

  (p as any).colorMode(p['RGB'], 255, 255, 255, 255);
}
