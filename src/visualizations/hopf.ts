/**
 * Hopf Fibers — Audio-reactive Hopf bundle visualization.
 *
 * Renders the principal fiber bundle π: S³ → S² discovered by Heinz Hopf (1931).
 * Every point on the 2-sphere S² has a preimage on S³ that is a great circle —
 * a "Hopf fiber".  All fibers are interlocked: any two fibers share exactly one
 * linking number, so no fiber can be moved away from the others without tearing.
 * Stereographic projection (S³ → R³) unrolls this into a family of interlocking
 * circles that fill concentric tori, then perspective projection lands them on the
 * 2-D canvas.
 *
 * Seven latitude rings of S² (one per frequency band) each supply N evenly-spaced
 * fibers.  Sub-bass anchors the innermost torus (tight rings near center), brilliance
 * drives the outermost (large arcs reaching screen edges).  Band amplitude controls
 * brightness.  Slow continuous rotation of the 3-D view reveals the interlocking
 * topology.  Beat fires an angular impulse and hue palette shift.  3-pass additive
 * neon glow; offscreen trail buffer with configurable fade.
 *
 * Inspired by Niles Johnson's "Hopf Fibration" animation (2012):
 * https://nilesjohnson.net/hopf.html
 * — one of the most celebrated objects in differential topology, projected into
 * visual form by the mathematics of smooth fiber bundles.
 *
 * Sliders:
 *   Fibers (hopfFibers) — fibers per band ring; 8 = sparse, 48 = dense weave
 *   Spin   (hopfSpin)   — rotation speed; 0 = nearly still, 2 = fast orbit
 *   Glow   (hopfGlow)   — bloom brightness and trail persistence
 */

import { store }         from '../state/store';
import { audioEngine }   from '../audio/engine';
import { getBandAverages } from './helpers';
import { BAND_COUNT, isMobile } from '../utils/constants';

// ── Band → latitude mapping ────────────────────────────────────────────────
// theta values in (0, pi) — sub-bass near south pole, brilliance near north pole
const BAND_THETAS: readonly number[] = [0.35, 0.65, 0.95, 1.25, 1.55, 1.85, 2.15];

// HSB hues per band: violet → blue → teal → green → yellow → orange → magenta
const BAND_HUES: readonly number[] = [270, 210, 170, 120, 60, 30, 300];

// Glow passes: [stroke width multiplier, alpha multiplier]
const GLOW_PASSES: readonly [number, number][] = [
  [5.0, 0.14],
  [2.0, 0.38],
  [0.6, 0.90],
];

// Clip 3-D points beyond this radius (avoids projection singularity blow-up)
const CLIP_R = 5.0;

const T_SEGS = isMobile ? 28 : 44;

// ── Module state ───────────────────────────────────────────────────────────
let trailBuf: any   = null;
let trailW          = 0;
let trailH          = 0;
let rotX            = 0.40;
let rotY            = 0.10;
let rotVX           = 0.000_28;
let rotVY           = 0.000_65;
let hueShift        = 0;
let lastBeatIdx     = -1;

export function resetHopf(): void {
  if (trailBuf) { (trailBuf as any).remove(); trailBuf = null; }
  trailW = 0; trailH = 0;
  rotX = 0.40; rotY = 0.10;
  rotVX = 0.000_28; rotVY = 0.000_65;
  hueShift = 0; lastBeatIdx = -1;
}

// ── Math helpers ───────────────────────────────────────────────────────────

// Hopf map: S² point (theta, phi) + fiber parameter t → R³ via
// quaternion embedding + stereographic projection from S³ north pole.
function hopfPt(theta: number, phi: number, t: number): [number,number,number] | null {
  const a = (t + phi) * 0.5;
  const b = (t - phi) * 0.5;
  const c = Math.cos(theta * 0.5);
  const s = Math.sin(theta * 0.5);
  const x1 = c * Math.cos(a);
  const x2 = c * Math.sin(a);
  const x3 = s * Math.cos(b);
  const x4 = s * Math.sin(b);
  const denom = 1.0 - x4;
  if (denom < 0.02) return null; // near north pole of S³
  const u = x1 / denom;
  const v = x2 / denom;
  const w = x3 / denom;
  if ((u*u + v*v + w*w) > CLIP_R * CLIP_R) return null;
  return [u, v, w];
}

function rotate(
  x: number, y: number, z: number,
  rx: number, ry: number
): [number,number,number] {
  // Rotate around X axis
  const cosX = Math.cos(rx), sinX = Math.sin(rx);
  const y1 = y * cosX - z * sinX;
  const z1 = y * sinX + z * cosX;
  // Rotate around Y axis
  const cosY = Math.cos(ry), sinY = Math.sin(ry);
  const x2 = x  * cosY + z1 * sinY;
  const z2 = -x * sinY + z1 * cosY;
  return [x2, y1, z2];
}

// ── Draw ───────────────────────────────────────────────────────────────────

export function drawHopf(p: P5Instance, dt: number): void {
  const { state, config } = store;
  const { amps } = getBandAverages(BAND_COUNT);

  // Config
  const spinSpeed = config.hopfSpin;
  const glowAmt   = config.hopfGlow;
  const fibSlider = config.hopfFibers;
  const nFibers   = Math.max(2, Math.min(
    Math.round(fibSlider),
    isMobile ? 10 : 32,
  ));

  // Beat detection
  let onBeat = false;
  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos      = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    const beatIdx  = adjusted >= 0 ? Math.floor(adjusted / state.beatIntervalSec) : -1;
    if (beatIdx >= 0 && beatIdx !== lastBeatIdx) {
      lastBeatIdx = beatIdx;
      onBeat = true;
    }
  }

  // Rotation drift
  const targetVX = 0.000_26 * spinSpeed;
  const targetVY = 0.000_58 * spinSpeed;
  rotVX += (targetVX - rotVX) * 0.003 * dt;
  rotVY += (targetVY - rotVY) * 0.003 * dt;
  rotX  += rotVX * dt;
  rotY  += rotVY * dt;

  if (onBeat) {
    const kick = 0.05 * (0.5 + spinSpeed);
    rotVX += (Math.random() - 0.5) * kick;
    rotVY += (Math.random() - 0.5) * kick;
    hueShift = (hueShift + 47) % 360;
  }

  // Trail buffer (resize if canvas changed)
  const W = p.width, H = p.height;
  if (!trailBuf || trailW !== W || trailH !== H) {
    if (trailBuf) (trailBuf as any).remove();
    trailBuf = p.createGraphics(W, H);
    (trailBuf as any).colorMode(p['HSB'], 360, 100, 100, 1.0);
    trailW = W; trailH = H;
  }

  // Fade trail (slower at high glow = longer persistence)
  const fadeA = Math.max(0.01, 0.06 * (1.6 - glowAmt) * dt);
  (trailBuf as any).fill(0, 0, 0, Math.min(fadeA, 0.5));
  (trailBuf as any).noStroke();
  (trailBuf as any).rect(0, 0, W, H);

  (trailBuf as any).colorMode(p['HSB'], 360, 100, 100, 1.0);
  (trailBuf as any).blendMode(p['ADD']);
  (trailBuf as any).noFill();

  const cx      = W * 0.5;
  const cy      = H * 0.5;
  const camDist = 2.6;
  const scale   = Math.min(W, H) * 0.34;
  const TWO_PI  = Math.PI * 2;

  for (let b = 0; b < BAND_COUNT; b++) {
    const amp = amps[b];
    if (amp < 0.008 && !onBeat) continue;

    const theta  = BAND_THETAS[b];
    const hue    = (BAND_HUES[b] + hueShift + 360) % 360;
    const bright = 35 + amp * 65;
    const baseW  = (0.6 + amp * 2.8) * (isMobile ? 0.7 : 1.0);

    for (const [wMult, aMult] of GLOW_PASSES) {
      const sw      = baseW * wMult;
      const alpha   = aMult * Math.max(0.06, amp) * (0.45 + glowAmt * 0.55);
      (trailBuf as any).stroke(hue, 75, bright, alpha);
      (trailBuf as any).strokeWeight(sw);

      for (let j = 0; j < nFibers; j++) {
        const phi = (TWO_PI * j) / nFibers;

        // Trace fiber as polyline; break on singularity/clip
        let shapeOpen = false;

        for (let k = 0; k <= T_SEGS; k++) {
          const t  = (TWO_PI * k) / T_SEGS;
          const pt = hopfPt(theta, phi, t);

          if (!pt) {
            if (shapeOpen) { (trailBuf as any).endShape(); shapeOpen = false; }
            continue;
          }

          const [rx2, ry2, rz2] = rotate(pt[0], pt[1], pt[2], rotX, rotY);
          const d = rz2 + camDist;
          if (d < 0.05) {
            if (shapeOpen) { (trailBuf as any).endShape(); shapeOpen = false; }
            continue;
          }

          const sx = cx + (scale * rx2) / d;
          const sy = cy + (scale * ry2) / d;

          // Generous screen clip
          if (sx < -W * 0.5 || sx > W * 1.5 || sy < -H * 0.5 || sy > H * 1.5) {
            if (shapeOpen) { (trailBuf as any).endShape(); shapeOpen = false; }
            continue;
          }

          if (!shapeOpen) {
            (trailBuf as any).beginShape();
            shapeOpen = true;
          }
          (trailBuf as any).vertex(sx, sy);
        }

        if (shapeOpen) (trailBuf as any).endShape();
      }
    }
  }

  // Composite trail → main canvas
  p.background(0);
  p.blendMode(p['BLEND']);
  p.image(trailBuf as any, 0, 0);
  p.blendMode(p['BLEND']);

  // Reset p5 state
  (p as any).colorMode(p['RGB'], 255);
  p.noStroke();
  p.noFill();
}
