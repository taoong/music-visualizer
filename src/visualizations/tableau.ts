/**
 * Tableau — Visual Music: Fischinger-style dancing formations.
 *
 * 7 ensembles of coloured ellipses (one per frequency band) are arranged in precise
 * geometric formations — ring, arc, line, diamond — that morph into each other on beats.
 * Band amplitude scales each ensemble's formation radius and ellipse size; the whole
 * canvas floats with gentle sinusoidal drift. Three-pass glow gives each ellipse a
 * glass-bead highlight reminiscent of Fischinger's paper-cutout technique.
 *
 * Inspired by Oskar Fischinger "An Optical Poem" (1938) / "Motion Painting No. 1"
 * (1947) — the pioneering visual-music shorts where coloured paper shapes danced to
 * Franz Liszt and J.S. Bach, inventing the music visualizer 87 years early.
 * https://www.oskarfischinger.org
 *
 * Sliders
 *   Count — shapes per ensemble (sparse 3 → dense 24)
 *   Morph — formation-shift speed on beats (slow ripple → snap rearrangement)
 *   Flow  — ensemble drift / oscillation speed (still → lively)
 */
import { store } from '../state/store';
import { getBandAverages } from './helpers';
import { BAND_COUNT, isMobile } from '../utils/constants';

// Fischinger-palette: bold primaries + rich secondaries, warm bias
const BAND_HUES: readonly number[] = [0, 38, 65, 145, 200, 248, 292];

// Formation types: 0=ring, 1=arc, 2=line, 3=diamond
const NUM_FORMATIONS = 4;

// Fractional canvas positions for the 7 ensemble centres
const BASE_POS: readonly [number, number][] = [
  [0.50, 0.18],
  [0.20, 0.38],
  [0.80, 0.38],
  [0.12, 0.64],
  [0.88, 0.64],
  [0.33, 0.82],
  [0.67, 0.82],
];

interface Shape {
  oscPhase: number;
}

interface Ensemble {
  band: number;
  baseCX: number;
  baseCY: number;
  driftPhase: number;
  rotAngle: number;
  formation: number;
  nextFormation: number;
  morphT: number;
  morphSpeed: number;
  shapes: Shape[];
}

let ensembles: Ensemble[] = [];
let t = 0;
let beatPulse = 0;
let hueOffset = 0;
let currentCount = -1;

function makeShapes(n: number): Shape[] {
  return Array.from({ length: n }, () => ({ oscPhase: Math.random() * Math.PI * 2 }));
}

function init(count: number): void {
  currentCount = count;
  ensembles = BASE_POS.map(([bx, by], band) => ({
    band,
    baseCX: bx,
    baseCY: by,
    driftPhase: (band / BAND_COUNT) * Math.PI * 2,
    rotAngle: (band / BAND_COUNT) * Math.PI * 0.5,
    formation: band % NUM_FORMATIONS,
    nextFormation: (band + 1) % NUM_FORMATIONS,
    morphT: 1,
    morphSpeed: 1,
    shapes: makeShapes(count),
  }));
}

/** Returns [localX, localY, ellipseRotation] for shape i of N in formation f at radius r */
function formPos(
  f: number, i: number, N: number, r: number,
): [number, number, number] {
  const u = N <= 1 ? 0.5 : i / (N - 1);
  switch (f) {
    case 0: { // Ring
      const a = (i / N) * Math.PI * 2;
      return [r * Math.cos(a), r * Math.sin(a), a + Math.PI / 2];
    }
    case 1: { // Flattened arc (upper half-ellipse path)
      const a = Math.PI * (u - 0.5);
      return [r * 1.25 * Math.cos(a), r * 0.55 * Math.sin(a), a + Math.PI / 2];
    }
    case 2: { // Horizontal line with gentle bow
      if (N === 1) return [0, 0, 0];
      return [r * 2.3 * (u - 0.5), r * 0.18 * Math.sin(u * Math.PI), 0];
    }
    case 3: { // Diamond (rhombus outline) — fallback to ring when N < 4
      if (N < 4) {
        const a = (i / N) * Math.PI * 2;
        return [r * Math.cos(a), r * Math.sin(a), a + Math.PI / 2];
      }
      const perSide = Math.max(1, Math.floor(N / 4));
      const side = Math.min(3, Math.floor(i / perSide));
      const st = perSide > 1 ? (i % perSide) / (perSide - 1) : 0;
      const corners: [number, number][] = [
        [0, -r], [r * 0.88, 0], [0, r], [-r * 0.88, 0],
      ];
      const [x1, y1] = corners[side];
      const [x2, y2] = corners[(side + 1) % 4];
      return [
        x1 + (x2 - x1) * st,
        y1 + (y2 - y1) * st,
        Math.atan2(y2 - y1, x2 - x1),
      ];
    }
    default:
      return [0, 0, 0];
  }
}

export function resetTableau(): void {
  ensembles = [];
  t = 0;
  beatPulse = 0;
  hueOffset = 0;
  currentCount = -1;
}

export function drawTableau(p: P5Instance, dt: number): void {
  const { amps, transients } = getBandAverages(BAND_COUNT);
  const cfg = store.config;

  const count = Math.max(3, Math.round((cfg.tableauCount) * 21 + 3)); // 3–24
  const morph = cfg.tableauMorph;
  const flow = cfg.tableauFlow;

  if (count !== currentCount || ensembles.length === 0) init(count);

  t += dt;

  // Beat detection — fire when a strong transient arrives and pulse has faded
  const maxTransient = transients.reduce((a, b) => Math.max(a, b), 0);
  if (maxTransient > 1.32 && beatPulse < 0.22) {
    beatPulse = 1.0;
    hueOffset = (hueOffset + 14 + Math.random() * 16) % 360;
    const speed = 0.7 + morph * 3.8;
    for (const ens of ensembles) {
      if (Math.random() < 0.30 + morph * 0.60) {
        ens.nextFormation =
          (ens.formation + 1 + Math.floor(Math.random() * (NUM_FORMATIONS - 1))) %
          NUM_FORMATIONS;
        ens.morphT = 0;
        ens.morphSpeed = speed;
      }
    }
  }
  beatPulse *= Math.pow(0.87, dt);

  p.background(12, 8, 16);
  (p as any).colorMode(p['HSB'], 360, 100, 100, 100);
  p.noStroke();

  const ww = p.width;
  const wh = p.height;
  const md = Math.min(ww, wh);
  const formR  = md * (isMobile ? 0.072 : 0.082);
  const baseEW = md * (isMobile ? 0.022 : 0.027);
  const driftA = md * 0.028 * flow;
  const oscA   = md * 0.033 * flow;

  // Slow time bases (normalise dt=1 ≈ one 60fps frame → divide by 60 for Hz)
  const driftT = t * 0.020 * flow;  // ~0.20 Hz drift orbit
  const oscT   = t * 0.025 * flow;  // ~0.25 Hz global sway

  for (const ens of ensembles) {
    const amp = Math.min(1, amps[ens.band] ?? 0);
    const N = ens.shapes.length;

    // Advance morph
    if (ens.morphT < 1) {
      ens.morphT = Math.min(1, ens.morphT + dt * ens.morphSpeed * 0.017);
      if (ens.morphT >= 1) {
        ens.morphT = 1;
        ens.formation = ens.nextFormation;
      }
    }
    // Smoothstep easing
    const mt = ens.morphT * ens.morphT * (3 - 2 * ens.morphT);

    const hue    = (BAND_HUES[ens.band] + hueOffset) % 360;
    const sat    = 70 + 24 * amp;
    const bright = Math.min(100, 36 + 60 * amp + beatPulse * 22);

    const scale = 0.40 + 0.80 * amp + beatPulse * 0.24;
    const r  = formR * scale;
    const ew = baseEW * (0.48 + 0.78 * amp + beatPulse * 0.14);
    const eh = ew * 0.47;  // Fischinger-style flat ellipse

    // Slow formation rotation, alternating CW/CCW per band
    const rotRate = (0.0007 + 0.0011 * amp) * (1 + flow);
    ens.rotAngle += dt * rotRate * (ens.band % 2 === 0 ? 1 : -1);

    // Ensemble centre: fixed base + gentle drift + beat-driven sway
    const dX = driftA * Math.sin(driftT + ens.driftPhase);
    const dY = driftA * Math.cos(driftT * 0.88 + ens.driftPhase + 1.4);
    const oX = oscA * Math.cos(oscT + ens.band * 0.93);
    const oY = oscA * Math.sin(oscT * 0.82 + ens.band * 0.93 + 0.65);

    const cx = ens.baseCX * ww + dX + oX;
    const cy = ens.baseCY * wh + dY + oY;

    const cosR = Math.cos(ens.rotAngle);
    const sinR = Math.sin(ens.rotAngle);

    for (let i = 0; i < N; i++) {
      const { oscPhase } = ens.shapes[i];

      // Formation position (with morph lerp)
      const [ax, ay, ar] = formPos(ens.formation, i, N, r);
      let lx = ax, ly = ay, lr = ar;
      if (mt < 1) {
        const [bx, by, br] = formPos(ens.nextFormation, i, N, r);
        lx = ax + (bx - ax) * mt;
        ly = ay + (by - ay) * mt;
        lr = ar + (br - ar) * mt;
      }

      // Apply ensemble rotation
      const rx = lx * cosR - ly * sinR;
      const ry = lx * sinR + ly * cosR;

      // Subtle per-shape breathing
      const breathe = 1 + 0.09 * Math.sin(t * 0.095 + oscPhase);

      const ex = cx + rx;
      const ey = cy + ry;
      const rot = lr + ens.rotAngle;
      const bew = ew * breathe;
      const beh = eh * breathe;

      // Pass 1 — outer glow (wide, translucent)
      p.fill(hue, sat * 0.32, Math.min(100, bright * 0.82), 17);
      p.push();
      p.translate(ex, ey);
      p.rotate(rot);
      p.ellipse(0, 0, bew * 2.7, beh * 2.7);
      p.pop();

      // Pass 2 — main ellipse
      p.fill(hue, sat, bright, 88);
      p.push();
      p.translate(ex, ey);
      p.rotate(rot);
      p.ellipse(0, 0, bew, beh);
      p.pop();

      // Pass 3 — specular highlight (glass-bead shimmer)
      p.fill(hue, sat * 0.10, 100, 52);
      p.push();
      p.translate(ex - bew * 0.12, ey - beh * 0.20);
      p.rotate(rot);
      p.ellipse(0, 0, bew * 0.28, beh * 0.28);
      p.pop();
    }
  }

  (p as any).colorMode(p['RGB'], 255);
}
