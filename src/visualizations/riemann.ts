/**
 * Riemann Sphere — Stereographic projection of a rotating sphere.
 *
 * Inspired by Henry Segerman's stereographic projection lamp sculptures
 * (Oklahoma State University, https://math.okstate.edu/people/segerman/)
 * where a light at the north pole of a 3D-printed patterned sphere casts
 * beautiful morphing shadows that are perfect mathematical circles — a
 * living demonstration that stereographic projection maps circles to circles.
 *
 * A unit sphere carries 7 glowing latitude circles (one per freq band) and
 * a set of meridian grid lines. As the sphere rotates and tilts, the circles
 * project onto the canvas via stereographic projection from the north pole.
 * When the sphere is upright, latitude circles project to concentric rings
 * and meridians project to radial lines. When the sphere tilts, every circle
 * becomes an eccentric circle that orbits away from the canvas centre — the
 * meridians arc into graceful loops, and the latitude circles chase each
 * other in a slow, music-driven orbital dance.
 *
 * Sub-bass (k=0) drives the largest outermost ring; brilliance (k=6) drives
 * the smallest innermost dot. Additive blending creates luminous glow.
 * Beat detection fires a rotation impulse and 47° hue palette shift.
 *
 * Sliders
 *   Spin — sphere rotation speed (slow drift → fast whirl)
 *   Tilt — sphere tilt amount (0=upright concentric rings, 1=maximum eccentric orbit)
 *   Glow — stroke weight and bloom brightness
 */

import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { BAND_COUNT, isMobile } from '../utils/constants';

// Colatitudes (angle from north pole, radians) for the 7 freq-band latitude circles.
// k=0 sub-bass: 90° = equator → r = cot(45°) = 1.0   (largest projected circle)
// k=6 brilliance: 168°         → r = cot(84°) ≈ 0.105 (tiny inner dot)
const COLAT_RADS: readonly number[] = [
  90, 103, 116, 129, 142, 155, 168,
].map(d => d * Math.PI / 180);

// Hue per band: sub=violet, bass=blue, lowMid=teal, mid=green, upperMid=yellow,
// presence=orange, brilliance=red
const BAND_HUES: readonly number[] = [280, 220, 175, 130, 68, 30, 0];

const NUM_MERIDIANS = isMobile ? 6 : 10;
const SEGMENTS = isMobile ? 80 : 120;          // points sampled per circle
const MAX_GAP = 4.0;                            // in units of sc; gap → segment break

// ── Module-level state ───────────────────────────────────────────────────────
let rotation = 0;      // cumulative Y-axis rotation (radians)
let tiltNow = 0;       // current X-axis tilt (radians)
let hueShift = 0;      // beat-driven hue offset (degrees)
let rotVel = 0;        // beat rotation impulse (decays each frame)
let flashBright = 0;   // beat brightness flash (decays)
let lastBeatIndex = -1;

export function resetRiemann(): void {
  rotation = 0;
  tiltNow = 0;
  hueShift = 0;
  rotVel = 0;
  flashBright = 0;
  lastBeatIndex = -1;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Rotate a unit-sphere point first around the Y-axis then around the X-axis. */
function rotatePoint(
  sx: number, sy: number, sz: number,
  cosR: number, sinR: number,
  cosT: number, sinT: number,
): [number, number, number] {
  // Y-axis rotation
  const x1 = cosR * sx + sinR * sz;
  const z1 = -sinR * sx + cosR * sz;
  // X-axis rotation
  const y2 = cosT * sy - sinT * z1;
  const z2 = sinT * sy + cosT * z1;
  return [x1, y2, z2];
}

/** Stereographic projection from north pole (0,0,1) → canvas coordinates. */
function stereoProject(
  rx: number, ry: number, rz: number,
  cx: number, cy: number, sc: number,
): [number, number] | null {
  if (rz >= 0.98) return null;          // near north pole → goes to infinity
  const d = sc / (1 - rz);
  return [cx + rx * d, cy + ry * d];
}

// ── Main draw ────────────────────────────────────────────────────────────────

export function drawRiemann(p: P5Instance, dt: number): void {
  const { state, config } = store;
  const { amps, transients } = getBandAverages(BAND_COUNT);

  const spinCfg = config.riemannSpin;
  const tiltCfg = config.riemannTilt;
  const glowCfg = config.riemannGlow;

  // ── Beat detection ─────────────────────────────────────────────────────────
  if (state.beatIntervalSec > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adj = pos - state.beatOffset;
    const beatIdx = adj >= 0 ? Math.floor(adj / state.beatIntervalSec) : -1;
    if (beatIdx >= 0 && beatIdx !== lastBeatIndex) {
      if (lastBeatIndex >= 0) {
        hueShift   = (hueShift + 47) % 360;
        rotVel    += 1.5 + amps[0] * 2.5;    // sub-bass amplifies the kick
        flashBright = 0.6 + amps[0] * 0.4;
      }
      lastBeatIndex = beatIdx;
    }
  }

  rotVel     *= Math.pow(0.86, dt);
  flashBright *= Math.pow(0.82, dt);

  // ── Physics ────────────────────────────────────────────────────────────────
  const avgAmp = amps.reduce((s, b) => s + b, 0) / BAND_COUNT;
  rotation += (spinCfg * 0.022 + avgAmp * 0.004 + rotVel * 0.007) * dt;

  // Tilt: base from slider + slow organic wobble driven by bass
  const baseTilt = tiltCfg * Math.PI * 0.68;  // slider 0→1 maps to 0°→123°
  tiltNow = baseTilt + Math.sin(rotation * 0.21) * 0.25 * amps[1];

  // ── Canvas setup ───────────────────────────────────────────────────────────
  const W = p.width, H = p.height;
  const cx = W * 0.5, cy = H * 0.5;
  // Stereographic scale: equatorial circle (r=1) maps to sc pixels from centre
  const sc = Math.min(W, H) * 0.37;

  // Trail: draw a translucent black overlay in BLEND mode to fade previous frame
  (p as any).colorMode(p['RGB'], 255, 255, 255, 255);
  p.blendMode(p['BLEND']);
  p.noStroke();
  p.fill(0, 0, 0, 18);
  p.rect(0, 0, W, H);

  // Switch to HSB + additive blending for the luminous geometry
  (p as any).colorMode(p['HSB'], 360, 100, 100, 100);
  p.blendMode(p['ADD']);
  p.noFill();

  // Precompute rotation trig
  const cosR = Math.cos(rotation), sinR = Math.sin(rotation);
  const cosT = Math.cos(tiltNow),  sinT = Math.sin(tiltNow);

  // ── Meridian grid (background structural lines) ────────────────────────────
  const meridAlpha = 8 + avgAmp * 15;
  p.strokeWeight(0.6);
  p.stroke(200, 12, 55, meridAlpha);

  for (let m = 0; m < NUM_MERIDIANS; m++) {
    const lon = (Math.PI * 2 * m) / NUM_MERIDIANS;
    const cL = Math.cos(lon), sL = Math.sin(lon);

    let prevPt: [number, number] | null = null;
    for (let i = 0; i <= SEGMENTS; i++) {
      // Parameterise from 5° to 175° colatitude to stay away from both poles
      const th = 0.087 + (Math.PI - 0.174) * (i / SEGMENTS);
      const st = Math.sin(th), ct = Math.cos(th);
      const [rx, ry, rz] = rotatePoint(st * cL, st * sL, ct, cosR, sinR, cosT, sinT);
      const pp = stereoProject(rx, ry, rz, cx, cy, sc);

      if (pp && prevPt) {
        const gap = Math.hypot(pp[0] - prevPt[0], pp[1] - prevPt[1]);
        if (gap < sc * MAX_GAP) {
          p.line(prevPt[0], prevPt[1], pp[0], pp[1]);
        }
      }
      prevPt = pp;
    }
  }

  // ── Latitude circles — one per freq band, with 3-pass glow ────────────────
  // Glow passes: (strokeWeight factor, alpha factor)
  const GLOW_PASSES: readonly [number, number][] = [
    [8.0, 0.12],   // outer halo
    [3.2, 0.42],   // body
    [1.0, 1.00],   // core
  ];

  const wBase = 0.6 + glowCfg * 1.8;   // global stroke-weight scale from slider

  for (let k = 0; k < BAND_COUNT; k++) {
    const theta  = COLAT_RADS[k];
    const amp    = amps[k];
    const tr     = transients[k];
    const flash  = flashBright * (1 - k * 0.1);  // outer bands flash brighter

    if (amp < 0.005 && tr < 0.01 && flash < 0.005) continue;

    const hue  = (BAND_HUES[k] + hueShift + 360) % 360;
    const sat  = 72 + amp * 28;
    const brt  = Math.min(100, 20 + amp * 75 + tr * 25 + flash * 45);
    const baseAlpha = 18 + amp * 82 + tr * 18 + flash * 38;

    const sinT_  = Math.sin(theta);
    const cosT_  = Math.cos(theta);

    // Sample evenly-spaced points on the latitude circle
    const pts: Array<[number, number] | null> = new Array(SEGMENTS + 1);
    for (let i = 0; i <= SEGMENTS; i++) {
      const phi = (Math.PI * 2 * i) / SEGMENTS;
      const [rx, ry, rz] = rotatePoint(
        sinT_ * Math.cos(phi), sinT_ * Math.sin(phi), cosT_,
        cosR, sinR, cosT, sinT,
      );
      pts[i] = stereoProject(rx, ry, rz, cx, cy, sc);
    }

    // Build connected polyline segments, breaking at pole crossings / large gaps
    const segs: Array<[number, number][]> = [[]];
    let prevP: [number, number] | null = null;

    for (let i = 0; i <= SEGMENTS; i++) {
      const pt = pts[i];
      const seg = segs[segs.length - 1];

      if (!pt) {
        if (seg.length > 1) segs.push([]);
        prevP = null;
        continue;
      }

      if (prevP) {
        const gap = Math.hypot(pt[0] - prevP[0], pt[1] - prevP[1]);
        if (gap > sc * MAX_GAP) {
          if (seg.length > 1) segs.push([]);
          segs[segs.length - 1].push(pt);
          prevP = pt;
          continue;
        }
      }

      seg.push(pt);
      prevP = pt;
    }

    // Draw each segment with 3-pass glow
    for (const [wFactor, aFactor] of GLOW_PASSES) {
      const sw    = wFactor * wBase * (0.4 + amp * 0.6);
      const alpha = baseAlpha * aFactor;
      p.strokeWeight(sw);
      p.stroke(hue, sat, brt, alpha);

      for (const seg of segs) {
        if (seg.length < 2) continue;

        // Close the shape if first and last points are near each other
        const isLoop =
          seg.length > 4 &&
          Math.hypot(seg[0][0] - seg[seg.length - 1][0],
                     seg[0][1] - seg[seg.length - 1][1]) < sc * 0.12;

        p.beginShape();
        for (const [sx, sy] of seg) p.vertex(sx, sy);
        if (isLoop) {
          p.endShape(p['CLOSE']);
        } else {
          p.endShape();
        }
      }
    }
  }

  // ── Restore blend/color ────────────────────────────────────────────────────
  p.blendMode(p['BLEND']);
  (p as any).colorMode(p['RGB'], 255, 255, 255, 255);
}
