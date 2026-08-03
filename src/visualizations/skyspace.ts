/**
 * Skyspace: audio-reactive Turrell light aperture.
 *
 * N concentric luminous rings hang in a dark room like the LED-rimmed
 * ceiling apertures of a Turrell Skyspace; the innermost disc glows with
 * a slowly drifting sky color; each ring is driven by a frequency band
 * whose amplitude controls brightness and hue saturation; beat fires an
 * outward pulse that swells all rings simultaneously, creating the
 * characteristic "eye-opening" flash that visitors describe in real Skyspaces.
 *
 * Inspired by James Turrell's Skyspace series — specifically
 * "The Color Inside" (2013, UT Austin Landmarks,
 * https://landmarks.utexas.edu/artwork/color-inside) and
 * "As Seen Below" (2023, ARoS Aarhus Kunstmuseum,
 * https://www.anothermag.com/art-photography/17298/
 * james-turrell-new-skyspace-as-seen-below-aros-aarhus-review)
 * — where LED-illuminated apertures dissolve the boundary between
 * artificial light and open sky, creating immersive chromatic experiences
 * that shift slowly with time and atmospheric conditions.
 *
 * Sliders
 *   skyspaceRings — nested aperture count (0 = 3 rings → 1 = 12 rings)
 *   skyspaceGlow  — LED rim intensity and halo radius (0 = subtle, 1 = blazing)
 *   skyspaceDrift — sky color rotation speed (0 = near-still, 1 = fast sweep)
 */

import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { BAND_COUNT, isMobile } from '../utils/constants';

// Turrell-inspired chromatic sequence per band:
// sub-bass=violet, bass=rose, lowMid=magenta, mid=amber, upperMid=gold, presence=teal, brilliance=sky
const BAND_HUES: readonly number[] = [265, 300, 330, 38, 58, 168, 208];

// Glow pass definitions [strokeWeightMultiplier, maxAlpha 0-100]
const GLOW_PASSES: readonly [number, number][] = [
  [10.0, 8],   // wide outer halo
  [4.0,  28],  // body glow
  [1.5,  72],  // near-core
  [0.6,  100], // bright core rim
];

// ── Module state ──────────────────────────────────────────────────────────────
let phase = 0;
let beatPulse = 0;
let hueShift = 0;
let flashBright = 0;
let lastBeatIndex = -1;

export function resetSkyspace(): void {
  phase = 0;
  beatPulse = 0;
  hueShift = 0;
  flashBright = 0;
  lastBeatIndex = -1;
}

// ── Draw ──────────────────────────────────────────────────────────────────────
export function drawSkyspace(p: P5Instance, dt: number): void {
  const { state, config } = store;
  const { amps, transients } = getBandAverages(BAND_COUNT);

  const w  = p.width;
  const h  = p.height;
  const cx = w * 0.5;
  const cy = h * 0.5;

  // ── Beat detection ──────────────────────────────────────────────────────────
  if (state.beatIntervalSec > 0 && state.isPlaying) {
    const pos    = audioEngine.getPlaybackPosition();
    const adj    = pos - state.beatOffset;
    const beatIdx = adj >= 0 ? Math.floor(adj / state.beatIntervalSec) : -1;
    if (beatIdx >= 0 && beatIdx !== lastBeatIndex) {
      if (lastBeatIndex >= 0) {
        beatPulse   = 1.0;
        hueShift    = (hueShift + 47) % 360;
        flashBright = 0.5 + amps[0] * 0.5;
      }
      lastBeatIndex = beatIdx;
    }
  }

  beatPulse   *= Math.pow(0.84, dt);
  flashBright *= Math.pow(0.80, dt);

  // ── Sky drift ───────────────────────────────────────────────────────────────
  const driftRate = 0.004 + config.skyspaceDrift * 0.06;
  phase += dt * driftRate;

  // ── Layout ─────────────────────────────────────────────────────────────────
  const numRings = Math.round(3 + config.skyspaceRings * 9); // 3–12
  const glowStr  = 0.5 + config.skyspaceGlow * 1.5;          // 0.5–2.0

  const avgAmp   = amps.reduce((s, b) => s + b, 0) / BAND_COUNT;

  // Outer radius fills the canvas (limited by shorter dimension)
  const outerR  = Math.min(w, h) * 0.46;
  // Inner "sky" disc at center
  const innerR  = outerR * (isMobile ? 0.11 : 0.09);
  // Beat swells all rings outward
  const pulseMag = beatPulse * 0.06 * outerR;

  // Aspect multipliers so rings are oval on non-square canvases
  const axX = w / Math.min(w, h);
  const axY = h / Math.min(w, h);

  // ── Background ─────────────────────────────────────────────────────────────
  (p as any).colorMode(p['RGB'], 255, 255, 255, 255);
  p.blendMode(p['BLEND']);
  p.noStroke();
  // Near-black with tiny warmth from overall amplitude
  p.fill(4 + avgAmp * 5, 4 + avgAmp * 4, 7 + avgAmp * 9);
  p.rect(0, 0, w, h);

  // ── Inner sky disc ─────────────────────────────────────────────────────────
  (p as any).colorMode(p['HSB'], 360, 100, 100, 100);
  p.blendMode(p['BLEND']);
  p.noStroke();

  const skyHue    = (BAND_HUES[0] + hueShift + phase * 60) % 360;
  const skyBright = 12 + avgAmp * 32 + flashBright * 22;
  const skySat    = 45 + avgAmp * 40;

  const skyRw = (innerR + pulseMag * 0.25) * axX * 2;
  const skyRh = (innerR + pulseMag * 0.25) * axY * 2;

  // Main sky fill
  p.fill(skyHue, skySat, skyBright, 95);
  p.ellipse(cx, cy, skyRw, skyRh);

  // Soft luminous centre — the Turrell "lightness" that seems solid
  p.fill(skyHue, skySat * 0.25, Math.min(100, skyBright * 1.5), 38);
  p.ellipse(cx, cy, skyRw * 0.55, skyRh * 0.55);

  // ── Glowing rings (additive blending for LED luminance) ───────────────────
  p.blendMode(p['ADD']);
  p.noFill();

  // Draw outermost → innermost so brighter inner rings composite on top
  for (let i = numRings - 1; i >= 0; i--) {
    const t = numRings > 1 ? i / (numRings - 1) : 0; // 0 = innermost, 1 = outermost

    const baseR = innerR + (outerR - innerR) * t;
    // Inner rings pulse more strongly — outer rings barely move
    const r     = baseR + pulseMag * (1 - t * 0.55);

    const bandIdx = i % BAND_COUNT;
    const amp     = amps[bandIdx];
    const tr      = transients[bandIdx];
    const flash   = flashBright * (1 - t * 0.45);

    if (amp < 0.004 && tr < 0.005 && flash < 0.004) continue;

    // Hue: per-band Turrell colour + beat shift + slow phase drift
    const hue = (BAND_HUES[bandIdx] + hueShift + phase * 45 + t * 18) % 360;
    const sat = 65 + amp * 35;
    const brt = Math.min(100, 35 + amp * 58 + tr * 14 + flash * 38);

    const rw    = r * axX * 2;
    const rh    = r * axY * 2;
    const wBase = (1.0 + amp * 1.6) * glowStr;

    const passes = isMobile ? GLOW_PASSES.slice(1) : GLOW_PASSES;

    for (const [wMult, maxAlpha] of passes) {
      const alpha = Math.min(maxAlpha, maxAlpha * (0.35 + amp * 0.65 + flash * 0.3 + tr * 0.2));
      p.stroke(hue, sat, brt, alpha);
      p.strokeWeight(wBase * wMult);
      p.ellipse(cx, cy, rw, rh);
    }
  }

  // ── Reset ──────────────────────────────────────────────────────────────────
  p.blendMode(p['BLEND']);
  (p as any).colorMode(p['RGB'], 255, 255, 255, 255);
}
