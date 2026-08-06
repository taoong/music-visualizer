/**
 * Tapestry — Audio-reactive cloth simulation with metallic tile rendering.
 *
 * Inspired by El Anatsui's "Bleeding Takari II" (2007, MoMA,
 * https://www.moma.org/collection/works/116286) — thousands of hand-linked
 * aluminium bottle-caps and copper wire draped like cloth, each facet catching
 * gallery light differently to produce a shimmering mosaic. Seven frequency
 * bands map to seven metallic hue zones across the cloth; Verlet-integration
 * spring physics makes the surface breathe and ripple with the music; per-quad
 * Phong shading (two virtual lights) renders each tile's iridescent glint.
 *
 * Sliders
 *   Drape   — gravity strength (0 = levitating waft, 1 = heavy canvas)
 *   Ripple  — audio-force amplitude (how forcefully sound disturbs the cloth)
 *   Shimmer — metallic iridescence and specular highlight brightness
 */
import { store } from '../state/store';
import { getBandAverages } from './helpers';
import { BAND_COUNT, isMobile } from '../utils/constants';

// Grid dimensions
const COLS_DESK = 30;
const ROWS_DESK = 26;
const COLS_MOB  = 18;
const ROWS_MOB  = 16;

// Particle positions (Verlet: current + previous)
let px:  Float32Array;
let py:  Float32Array;
let pz:  Float32Array; // depth — affects normals/lighting, not screen XY
let ppx: Float32Array;
let ppy: Float32Array;
let ppz: Float32Array;
let pinned: Uint8Array; // 1 = fixed (top row)

// Constraints: index a, index b, rest length
let conA:    Int32Array;
let conB:    Int32Array;
let conRest: Float32Array;

let COLS = 0;
let ROWS = 0;
let N  = 0;
let NC = 0;
let initialized = false;
let lastW = 0;
let lastH = 0;

// Animation state (module-scoped — used in renderTile helper below)
let time      = 0;
let hueShift  = 0;
let beatPulse = 0;

// Warm copper/gold/bronze palette per band (sub → brilliance)
const BAND_HUES: readonly number[] = [22, 43, 32, 8, 290, 182, 215];

// Light A: upper-left-front (pre-normalised)
const L1X = 0.48, L1Y = -0.69, L1Z = 0.54;
const L1L = Math.sqrt(L1X * L1X + L1Y * L1Y + L1Z * L1Z);
const NL1X = L1X / L1L, NL1Y = L1Y / L1L, NL1Z = L1Z / L1L;

// Light B: upper-right-front (pre-normalised)
const L2X = -0.42, L2Y = -0.56, L2Z = 0.71;
const L2L = Math.sqrt(L2X * L2X + L2Y * L2Y + L2Z * L2Z);
const NL2X = L2X / L2L, NL2Y = L2Y / L2L, NL2Z = L2Z / L2L;

function initCloth(W: number, H: number): void {
  COLS = isMobile ? COLS_MOB : COLS_DESK;
  ROWS = isMobile ? ROWS_MOB : ROWS_DESK;
  N = COLS * ROWS;

  const sx = W / (COLS - 1);
  const sy = (H * 0.90) / (ROWS - 1);
  const startY = H * 0.02;

  px  = new Float32Array(N);
  py  = new Float32Array(N);
  pz  = new Float32Array(N);
  ppx = new Float32Array(N);
  ppy = new Float32Array(N);
  ppz = new Float32Array(N);
  pinned = new Uint8Array(N);

  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const i = r * COLS + c;
      const x = c * sx;
      const y = startY + r * sy;
      px[i] = ppx[i] = x;
      py[i] = ppy[i] = y;
      pz[i] = ppz[i] = 0;
      pinned[i] = r === 0 ? 1 : 0;
    }
  }

  // Build constraint lists
  const tmpA: number[] = [];
  const tmpB: number[] = [];
  const tmpR: number[] = [];

  const add = (a: number, b: number, len: number): void => {
    tmpA.push(a); tmpB.push(b); tmpR.push(len);
  };

  const diagSS = Math.sqrt(sx * sx + sy * sy);

  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const i = r * COLS + c;
      // Structural: horizontal + vertical
      if (c < COLS - 1) add(i, i + 1, sx);
      if (r < ROWS - 1) add(i, i + COLS, sy);
      // Shear (diagonal)
      if (c < COLS - 1 && r < ROWS - 1) {
        add(i,     i + COLS + 1, diagSS);
        add(i + 1, i + COLS,     diagSS);
      }
      // Bend (skip-2): resists folding
      if (c < COLS - 2) add(i, i + 2,        2 * sx);
      if (r < ROWS - 2) add(i, i + 2 * COLS, 2 * sy);
    }
  }

  NC = tmpA.length;
  conA    = new Int32Array(tmpA);
  conB    = new Int32Array(tmpB);
  conRest = new Float32Array(tmpR);

  initialized = true;
  lastW = W;
  lastH = H;
}

export function resetCloth(): void {
  initialized = false;
  time      = 0;
  hueShift  = 0;
  beatPulse = 0;
}

export function drawCloth(p: P5Instance, dt: number): void {
  const W = p.width;
  const H = p.height;

  if (!initialized || W !== lastW || H !== lastH) {
    initCloth(W, H);
    return;
  }

  const { amps, transients } = getBandAverages(BAND_COUNT);
  const { clothDrape, clothRipple, clothShimmer } = store.config;

  time += dt;

  const sub    = amps[0], bass   = amps[1], lowMid = amps[2],
        mid    = amps[3], upMid  = amps[4], pres   = amps[5],
        brill  = amps[6];
  const subT = transients[0], bassT = transients[1];

  // Beat detection
  if (subT > 1.35 || bassT > 1.35) {
    hueShift  = (hueShift + 42 + (time % 25)) % 360;
    beatPulse = 1.0;
  }
  beatPulse *= 0.87;

  // ── Physics ────────────────────────────────────────────────────────────────
  const ITERS  = 6;
  const DAMP   = 0.984;
  const grav   = (clothDrape * 0.30 + 0.04) * dt;
  const ripStr = clothRipple * 1.40 + 0.15;

  for (let i = 0; i < N; i++) {
    if (pinned[i]) continue;

    const r = Math.floor(i / COLS);
    const c = i % COLS;
    const tFrac = r / (ROWS - 1); // 0 at top, 1 at bottom

    // Verlet velocities (one-frame displacement)
    const vx = (px[i] - ppx[i]) * DAMP;
    const vy = (py[i] - ppy[i]) * DAMP;
    const vz = (pz[i] - ppz[i]) * DAMP;

    // Audio-driven z forces — each band oscillates at its own spatial frequency
    const phase = c * 0.18 + tFrac * Math.PI * 2.4;
    const zAcc  = ripStr * tFrac * (
      sub    * 2.0 * Math.sin(phase * 0.6  + time * 0.040) +
      bass   * 1.4 * Math.sin(phase * 1.0  - time * 0.028) +
      lowMid * 1.0 * Math.sin(phase * 1.6  + time * 0.055) +
      mid    * 0.7 * Math.sin(phase * 2.3  - time * 0.072) +
      upMid  * 0.5 * Math.sin(phase * 3.1  + time * 0.090) +
      pres   * 0.3 * Math.sin(phase * 4.0  - time * 0.110) +
      brill  * 0.2 * Math.sin(phase * 5.2  + time * 0.130)
    ) * 3.5;

    // Beat impulse: z outward in a sine arc across columns
    const beatZ = beatPulse * Math.sin(c / COLS * Math.PI) * tFrac * 4.0 * ripStr;

    // Gentle lateral wind from sub-bass
    const xWind = sub * 0.25 * Math.sin(time * 0.018 + r * 0.09) * tFrac * ripStr;

    ppx[i] = px[i];
    ppy[i] = py[i];
    ppz[i] = pz[i];

    px[i] += vx + xWind * dt;
    py[i] += vy + grav;
    pz[i] += vz + (zAcc + beatZ) * dt * 0.18;
  }

  // Constraint satisfaction (Gauss-Seidel)
  for (let iter = 0; iter < ITERS; iter++) {
    for (let ci = 0; ci < NC; ci++) {
      const a    = conA[ci];
      const b    = conB[ci];
      const rest = conRest[ci];
      const dx   = px[b] - px[a];
      const dy   = py[b] - py[a];
      const dz   = pz[b] - pz[a];
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (dist < 0.001) continue;
      const diff = (dist - rest) / dist * 0.5;
      const hx = dx * diff;
      const hy = dy * diff;
      const hz = dz * diff;
      if (!pinned[a] && !pinned[b]) {
        px[a] += hx; py[a] += hy; pz[a] += hz;
        px[b] -= hx; py[b] -= hy; pz[b] -= hz;
      } else if (!pinned[a]) {
        px[a] += hx * 2; py[a] += hy * 2; pz[a] += hz * 2;
      } else if (!pinned[b]) {
        px[b] -= hx * 2; py[b] -= hy * 2; pz[b] -= hz * 2;
      }
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  p.background(7, 5, 9);
  (p as any).colorMode(p['HSB'], 360, 100, 100, 100);

  const shimmer = clothShimmer;

  for (let r = 0; r < ROWS - 1; r++) {
    for (let c = 0; c < COLS - 1; c++) {
      const i00 = r * COLS + c;
      const i01 = r * COLS + (c + 1);
      const i10 = (r + 1) * COLS + c;
      const i11 = (r + 1) * COLS + (c + 1);

      // Quad corners (screen XY + depth Z)
      const x00 = px[i00], y00 = py[i00], z00 = pz[i00];
      const x01 = px[i01], y01 = py[i01], z01 = pz[i01];
      const x10 = px[i10], y10 = py[i10], z10 = pz[i10];
      const x11 = px[i11], y11 = py[i11], z11 = pz[i11];

      const bandIdx = Math.min(6, Math.floor(c / (COLS - 1) * 7));
      const bandAmp = amps[bandIdx];

      // ── Triangle A: corners (00, 01, 10) ──
      {
        const eax = x01 - x00, eay = y01 - y00, eaz = z01 - z00;
        const ebx = x10 - x00, eby = y10 - y00, ebz = z10 - z00;
        let nx = eay * ebz - eaz * eby;
        let ny = eaz * ebx - eax * ebz;
        let nz = eax * eby - eay * ebx;
        const nl = Math.sqrt(nx * nx + ny * ny + nz * nz);
        if (nl > 0.001) {
          nx /= nl; ny /= nl; nz /= nl;
          if (nz < 0) { nx = -nx; ny = -ny; nz = -nz; }
          renderTile(p, nx, ny, nz, bandIdx, bandAmp, shimmer);
          p.triangle(x00, y00, x01, y01, x10, y10);
        }
      }

      // ── Triangle B: corners (01, 11, 10) ──
      {
        const eax = x11 - x01, eay = y11 - y01, eaz = z11 - z01;
        const ebx = x10 - x01, eby = y10 - y01, ebz = z10 - z01;
        let nx = eay * ebz - eaz * eby;
        let ny = eaz * ebx - eax * ebz;
        let nz = eax * eby - eay * ebx;
        const nl = Math.sqrt(nx * nx + ny * ny + nz * nz);
        if (nl > 0.001) {
          nx /= nl; ny /= nl; nz /= nl;
          if (nz < 0) { nx = -nx; ny = -ny; nz = -nz; }
          renderTile(p, nx, ny, nz, bandIdx, bandAmp, shimmer);
          p.triangle(x01, y01, x11, y11, x10, y10);
        }
      }
    }
  }

  (p as any).colorMode(p['RGB'], 255, 255, 255, 255);
}

/** Set p5 fill + stroke for one metallic tile given its surface normal and band. */
function renderTile(
  p: P5Instance,
  nx: number,
  ny: number,
  nz: number,
  bandIdx: number,
  bandAmp: number,
  shimmer: number,
): void {
  // Diffuse from two lights
  const diff1 = Math.max(0, nx * NL1X + ny * NL1Y + nz * NL1Z);
  const diff2 = Math.max(0, nx * NL2X + ny * NL2Y + nz * NL2Z);
  const diffuse = diff1 * 0.60 + diff2 * 0.40;

  // Specular highlight (view direction = [0, 0, -1])
  const dot1 = nx * NL1X + ny * NL1Y + nz * NL1Z;
  const rz1  = nz * 2 * dot1 - NL1Z;
  const spec  = Math.pow(Math.max(0, -rz1), 52) * shimmer;

  // Iridescent hue from view angle (normal.z ≈ cos of angle-to-viewer)
  const iridOffset = (1 - nz) * 160 * shimmer;
  const baseHue    = (BAND_HUES[bandIdx] + hueShift) % 360;
  const hue        = (baseHue + iridOffset) % 360;

  const sat    = Math.min(100, 40 + shimmer * 40 + bandAmp * 25 + beatPulse * 12);
  const bri    = Math.min(100, (0.18 + diffuse * 0.72) * 100 + spec * 90 + beatPulse * 18 + bandAmp * 14);
  const satAdj = sat * (1 - spec * 0.85); // highlight bleaches toward white

  p.stroke(hue, satAdj * 0.6, bri * 0.55, 70);
  p.strokeWeight(0.6);
  p.fill(hue, satAdj, bri);
}
