/**
 * Radiolaria — Ernst Haeckel's "Kunstformen der Natur" (Art Forms in Nature, 1904) inspired viz.
 *
 * Microscopic radiolarian organisms feature perfect N-fold radial symmetry: nested
 * silica shells at concentric radii, two counter-rotating sets of lattice spokes,
 * long radiating spines at the outermost rim, and bioluminescent junction nodes.
 * 6 freq bands drive 6 shell radii (sub-bass at core → presence at rim); brilliance
 * drives spine length; two spoke sets counter-rotate creating a constantly shifting
 * geometric lattice. Beat fires hue shift + expansion ring.
 * Palette: warm amber core → teal midzone → violet rim (Haeckel bioluminescent).
 * Inspired by Ernst Haeckel "Kunstformen der Natur" Radiolaria plates (1904):
 * https://www.biodiversitylibrary.org/item/52381
 *
 * Sliders: Symmetry (N-fold 6–24), Shells (ring count 2–6), Glow (bloom + trail)
 */
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { BAND_COUNT, isMobile } from '../utils/constants';

// ── Palette: warm amber core → teal → violet rim ────────────────────────────
const SHELL_HUES = [48, 105, 172, 210, 255, 278]; // one per shell (6 shells max)
const SPINE_HUE  = 208;

// ── Module state ─────────────────────────────────────────────────────────────
let phase      = 0;    // primary rotation angle (increases each frame)
let hueOffset  = 0;    // palette hue offset — jumps on beat
let beatPulse  = 0;    // 1.0 → 0 on each beat, drives expansion ring alpha
let beatRingR  = 0;    // current radius of beat expansion ring
let lastBeatIdx = -1;

export function resetRadiolaria(): void {
  phase       = 0;
  hueOffset   = 0;
  beatPulse   = 0;
  beatRingR   = 0;
  lastBeatIdx = -1;
}

export function drawRadiolaria(p: P5Instance, dt: number): void {
  const { state, config } = store;
  const { amps } = getBandAverages(BAND_COUNT);

  // ── Config params ─────────────────────────────────────────────────────────
  const N         = Math.max(6, Math.min(24, Math.round(config.radiolariaSymmetry)));
  const numShells = Math.max(2, Math.min(6, Math.round(config.radiolariaShells)));
  const glow      = Math.max(0, Math.min(1, config.radiolariaGlow));

  // Mobile cap: reduce fold count and shell count for performance
  const effN      = isMobile ? Math.min(N, 12) : N;
  const effShells = isMobile ? Math.min(numShells, 4) : numShells;

  const cx   = p.width  * 0.5;
  const cy   = p.height * 0.5;
  const maxR = Math.min(p.width, p.height) * (isMobile ? 0.38 : 0.43);

  // Ring layout: innermost ring radius + spacing between rings
  const innerR = maxR * 0.10;
  const step   = (maxR * 0.76 - innerR) / Math.max(1, effShells - 1);

  // ── Beat detection ────────────────────────────────────────────────────────
  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos      = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    const beatIdx  = adjusted >= 0 ? Math.floor(adjusted / state.beatIntervalSec) : -1;
    if (beatIdx >= 0 && beatIdx !== lastBeatIdx) {
      lastBeatIdx = beatIdx;
      beatPulse   = 1.0;
      beatRingR   = innerR;
      hueOffset   = (hueOffset + 47) % 360;
    }
  }

  // ── Animate ───────────────────────────────────────────────────────────────
  const midAmp     = amps[3];  // mid drives rotation
  const overallAmp = amps.reduce((s, a) => s + a, 0) / BAND_COUNT;
  const rotSpeed   = 0.00025 + midAmp * 0.00080;
  phase      += rotSpeed * dt;
  beatPulse  *= Math.pow(0.92, dt);
  if (beatPulse > 0.01 && beatRingR < maxR * 2) {
    beatRingR += (4.0 + beatRingR * 0.009) * dt;
  }

  // ── Background with trail ─────────────────────────────────────────────────
  (p as any).colorMode(p['RGB'], 255);
  // Lower alpha = longer trail; glow slider also adjusts trail length
  const trailAlpha = isMobile ? 20 : Math.max(10, 22 - glow * 10);
  p.fill(2, 5, 16, trailAlpha);
  p.noStroke();
  p.rect(0, 0, p.width, p.height);

  // ── Switch to HSB ─────────────────────────────────────────────────────────
  (p as any).colorMode(p['HSB'], 360, 100, 100, 100);
  p.push();
  p.translate(cx, cy);
  p.blendMode(p['ADD']);

  const scaleF = Math.max(0.5, p.width / 900);
  const TWO_PI = Math.PI * 2;

  // ── Draw shells + lattice spokes ──────────────────────────────────────────
  for (let k = 0; k < effShells; k++) {
    const bandIdx  = Math.min(k, BAND_COUNT - 2); // bands 0–5, band 6 reserved for spines
    const amp      = amps[bandIdx];
    const pulseAmt = maxR * 0.075;
    const r        = innerR + k * step + amp * pulseAmt;

    const shellHue = (SHELL_HUES[Math.min(k, SHELL_HUES.length - 1)] + hueOffset) % 360;
    const bright   = 50 + amp * 50;
    const sat      = 70 + amp * 25;
    const alpha    = 55 + amp * 42;

    // ── Lattice struts: primary spokes (+phase) & secondary (-phase*0.6) ───
    // Primary set rotates clockwise; secondary counter-clockwise slightly slower.
    // Together they create an ever-shifting diamond lattice between shells.
    if (k > 0) {
      const prevBandIdx = Math.min(k - 1, BAND_COUNT - 2);
      const prevAmp     = amps[prevBandIdx];
      const rPrev       = innerR + (k - 1) * step + prevAmp * pulseAmt;
      const prevHue     = (SHELL_HUES[Math.min(k - 1, SHELL_HUES.length - 1)] + hueOffset) % 360;

      for (let pass = 0; pass < (isMobile ? 2 : 3); pass++) {
        const sw   = pass === 0 ? scaleF * 4.0 * glow
                   : pass === 1 ? scaleF * 1.5
                                : scaleF * 0.6;
        const alph = pass === 0 ? alpha * 0.055 * glow
                   : pass === 1 ? alpha * 0.25
                                : alpha * 0.82;
        const h    = pass < 2 ? shellHue : (shellHue + 18) % 360;
        const s    = pass < 2 ? sat - 20 : 25;
        const b    = pass < 2 ? bright : 100;

        p.strokeWeight(sw);
        p.stroke(h, s, b, alph);
        p.noFill();

        // Primary spokes: n evenly spaced, rotating at +phase
        for (let i = 0; i < effN; i++) {
          const aPrim = phase + i * TWO_PI / effN;
          p.line(
            rPrev * Math.cos(aPrim), rPrev * Math.sin(aPrim),
            r     * Math.cos(aPrim), r     * Math.sin(aPrim),
          );
        }

        // Secondary spokes: offset by π/effN, counter-rotating at -phase * 0.6
        const secOffset = Math.PI / effN;
        for (let i = 0; i < effN; i++) {
          const aSec = -phase * 0.60 + secOffset + i * TWO_PI / effN;
          const blendHue = (prevHue + (shellHue - prevHue) * 0.5 + hueOffset * 0.5) % 360;
          if (pass === 2) p.stroke((blendHue + 18) % 360, 25, 100, alph);
          p.line(
            rPrev * Math.cos(aSec), rPrev * Math.sin(aSec),
            r     * Math.cos(aSec), r     * Math.sin(aSec),
          );
        }
      }
    }

    // ── Junction nodes at primary & secondary spoke positions on this ring ──
    const nodeD = Math.max(2.5, (2.5 + amp * 3.5) * scaleF);

    for (let i = 0; i < effN; i++) {
      const aPrim = phase + i * TWO_PI / effN;
      const nx = r * Math.cos(aPrim);
      const ny = r * Math.sin(aPrim);

      p.noStroke();
      // Outer glow blob
      if (!isMobile) {
        p.fill(shellHue, sat - 25, bright, alpha * 0.10 * glow);
        p.circle(nx, ny, nodeD * 5.5 * glow);
      }
      // Core node
      p.fill((shellHue + 30) % 360, 22, 100, alpha * 0.88);
      p.circle(nx, ny, nodeD * 1.6);

      // Secondary offset nodes (smaller)
      const secOffset = Math.PI / effN;
      const aSec = -phase * 0.60 + secOffset + i * TWO_PI / effN;
      const sx = r * Math.cos(aSec);
      const sy = r * Math.sin(aSec);
      p.fill((shellHue + 15) % 360, 35, 100, alpha * 0.65);
      p.circle(sx, sy, nodeD * 1.0);
    }

    // ── Ring circle (3-pass glow) ─────────────────────────────────────────
    p.noFill();

    p.strokeWeight(scaleF * 5.5 * glow);
    p.stroke(shellHue, sat - 25, bright, alpha * 0.055 * glow);
    p.circle(0, 0, r * 2);

    p.strokeWeight(scaleF * 2.0);
    p.stroke(shellHue, sat, bright, alpha * 0.28);
    p.circle(0, 0, r * 2);

    p.strokeWeight(scaleF * 0.7);
    p.stroke((shellHue + 15) % 360, 22, 100, alpha * 0.88);
    p.circle(0, 0, r * 2);
  }

  // ── Outer spines ──────────────────────────────────────────────────────────
  const brilliance  = amps[6];
  const outerAmp    = amps[Math.min(effShells - 1, BAND_COUNT - 2)];
  const outerR      = innerR + (effShells - 1) * step + outerAmp * (maxR * 0.075);
  const spineLen    = maxR * (0.14 + brilliance * 0.16);
  const spineCount  = effN * 2; // twice the primary symmetry count
  const spineHue    = (SPINE_HUE + hueOffset) % 360;
  const spineAlpha  = 38 + brilliance * 55 + overallAmp * 20;

  // Spines vibrate slightly at high brilliance
  const vibMag = brilliance * 0.04;

  for (let i = 0; i < spineCount; i++) {
    const a     = phase + i * TWO_PI / spineCount;
    const vibr  = vibMag * Math.sin(a * 11 + phase * 2.5);
    const av    = a + vibr;
    const x1    = outerR * Math.cos(av);
    const y1    = outerR * Math.sin(av);
    const tipR  = outerR + spineLen;
    const x2    = tipR * Math.cos(av);
    const y2    = tipR * Math.sin(av);

    p.noFill();
    // Outer halo
    if (!isMobile) {
      p.strokeWeight(scaleF * 3.5 * glow);
      p.stroke(spineHue, 45, 100, spineAlpha * 0.065 * glow);
      p.line(x1, y1, x2, y2);
    }
    // Mid pass
    p.strokeWeight(scaleF * 1.2);
    p.stroke(spineHue, 35, 100, spineAlpha * 0.32);
    p.line(x1, y1, x2, y2);
    // Core — bright icy white
    p.strokeWeight(scaleF * 0.5);
    p.stroke(spineHue, 8, 100, spineAlpha * 0.88);
    p.line(x1, y1, x2, y2);

    // Spine tip dot
    p.noStroke();
    p.fill(spineHue, 10, 100, spineAlpha * 0.70);
    p.circle(x2, y2, scaleF * 2.8);
  }

  // ── Core glow ─────────────────────────────────────────────────────────────
  const coreAmp = amps[0]; // sub-bass drives core
  const coreHue = (SHELL_HUES[0] + hueOffset) % 360;
  const coreR   = innerR * (0.55 + coreAmp * 0.65);

  p.noStroke();
  if (!isMobile) {
    p.fill(coreHue, 35, 100, 7.0 * glow);   p.circle(0, 0, coreR * 7.0 * glow);
    p.fill(coreHue, 55, 100, 16 * glow);    p.circle(0, 0, coreR * 3.2 * glow);
  }
  p.fill(coreHue, 75, 100, 42);             p.circle(0, 0, coreR * 1.8);
  p.fill(0, 0, 100, 80);                    p.circle(0, 0, coreR * 0.65);

  // ── Beat expansion ring ───────────────────────────────────────────────────
  if (beatPulse > 0.02 && beatRingR < maxR * 1.85) {
    const beatHue   = (hueOffset + 28) % 360;
    const ringAlpha = beatPulse * 72;

    p.noFill();
    if (!isMobile) {
      p.strokeWeight(scaleF * 3.5 * glow);
      p.stroke(beatHue, 55, 100, ringAlpha * 0.22 * glow);
      p.circle(0, 0, beatRingR * 2);
    }
    p.strokeWeight(scaleF * 1.5);
    p.stroke(beatHue, 35, 100, ringAlpha * 0.52);
    p.circle(0, 0, beatRingR * 2);

    p.strokeWeight(scaleF * 0.6);
    p.stroke(0, 0, 100, ringAlpha * 0.82);
    p.circle(0, 0, beatRingR * 2);
  }

  p.blendMode(p['BLEND']);
  p.pop();

  // Reset color mode for other vizzes
  (p as any).colorMode(p['RGB'], 255);
}
