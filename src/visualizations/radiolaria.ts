/**
 * Radiolaria — Ernst Haeckel's Art Forms in Nature, 1904.
 *
 * Inspired by Haeckel's "Kunstformen der Natur" (Art Forms in Nature) plates,
 * specifically Plate 1 "Stephoidea" depicting radiolarian silica skeletons
 * https://commons.wikimedia.org/wiki/File:Haeckel_Stephoidea.jpg
 *
 * These microscopic ocean organisms build lattice cages of geometric perfection —
 * nested concentric shells connected by radial arms, with long crystalline spines
 * radiating outward like a Gothic cathedral crossed with a snowflake. Each of the
 * 7 freq bands drives one arm sector; sub-bass breathes the overall scale; beats
 * fire an outward pulse ring and shift the hue palette.
 *
 * Sliders
 *   Arms  — N-fold radial symmetry (3–12 arms)
 *   Shells — Concentric lattice rings (2–7)
 *   Spine  — Spine extension length (0 = stubby, 1 = long)
 *   Glow   — Neon phosphor intensity
 */
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { BAND_COUNT, isMobile } from '../utils/constants';

// Per-band hue palette — cool crystalline spectrum
const BAND_HUES: readonly number[] = [260, 200, 170, 140, 60, 30, 320];

let hueShift = 0;
let beatPulse = 0;
let lastBeatIndex = -1;
let breathPhase = 0;
let spineWave = 0;

export function resetRadiolaria(): void {
  hueShift = 0;
  beatPulse = 0;
  lastBeatIndex = -1;
  breathPhase = 0;
  spineWave = 0;
}

export function drawRadiolaria(p: P5Instance, dt: number): void {
  const W = p.width;
  const H = p.height;
  const cx = W / 2;
  const cy = H / 2;
  const minDim = Math.min(W, H);

  const { state, config } = store;
  const { amps, transients } = getBandAverages(BAND_COUNT);

  const totalAmp = amps.reduce((s, v) => s + v, 0) / BAND_COUNT;
  const subBass = amps[0];
  const brilliance = amps[6];

  // Config
  const armCount = Math.round(3 + (config.radiolariaArms ?? 0.43) * 9);   // 3–12
  const shellCount = Math.round(2 + (config.radiolariaShells ?? 0.5) * 5); // 2–7
  const spineScale = config.radiolariaSpine ?? 0.5;                         // 0–1
  const glowIntensity = config.radiolariaGlow ?? 1.0;                       // 0–1

  // Mobile guard: limit arms and shells on mobile
  const effectiveArms = isMobile ? Math.min(armCount, 8) : armCount;
  const effectiveShells = isMobile ? Math.min(shellCount, 5) : shellCount;

  // Beat detection
  if (state.beatIntervalSec > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    const beatIdx = adjusted >= 0 ? Math.floor(adjusted / state.beatIntervalSec) : -1;
    if (beatIdx >= 0 && beatIdx !== lastBeatIndex) {
      lastBeatIndex = beatIdx;
      beatPulse = 1.0;
      hueShift = (hueShift + 43) % 360;
    }
  }
  beatPulse *= Math.pow(0.87, dt);
  if (beatPulse < 0.001) beatPulse = 0;

  // Animate
  breathPhase += dt * 0.006 * (0.5 + totalAmp * 1.5);
  spineWave += dt * 0.02;

  // Base radius breathes gently with sub-bass
  const baseRadius = minDim * 0.37 * (0.88 + subBass * 0.12 + beatPulse * 0.06);

  (p as any).colorMode(p['HSB'], 360, 100, 100, 1.0);
  p.background(0, 0, 3);
  p.push();
  p.translate(cx, cy);
  p.blendMode(p['ADD']);

  const armAngle = (Math.PI * 2) / effectiveArms;

  // Pre-compute shell radii (logarithmic spacing = more rings near center)
  const shellRadii: number[] = [];
  for (let s = 0; s < effectiveShells; s++) {
    // Mild log spacing: inner shells closer together, outer wider
    const t = Math.pow((s + 1) / effectiveShells, 0.85);
    shellRadii.push(baseRadius * t * (0.95 + amps[s % BAND_COUNT] * 0.05));
  }
  const outerR = shellRadii[effectiveShells - 1];

  // ── Concentric shell arcs ──────────────────────────────────────────────────
  for (let s = 0; s < effectiveShells; s++) {
    const r = shellRadii[s];
    const shellBand = s % BAND_COUNT;
    const shellAmp = amps[shellBand];

    for (let k = 0; k < effectiveArms; k++) {
      const bandIdx = k % BAND_COUNT;
      const amp = amps[bandIdx];
      const hue = (BAND_HUES[bandIdx] + hueShift) % 360;
      const sat = 55 + amp * 35;
      const bri = 40 + shellAmp * 30 + amp * 25;

      const segStart = k * armAngle - armAngle * 0.48;
      const segEnd = segStart + armAngle * 0.96; // slight gap at arm crossing

      // 3-pass phosphor glow
      p.noFill();
      p.stroke(hue, sat, bri, 0.10 * glowIntensity);
      p.strokeWeight(5.5 * glowIntensity);
      p.arc(0, 0, r * 2, r * 2, segStart, segEnd);

      p.stroke(hue, sat, bri, 0.32 * glowIntensity);
      p.strokeWeight(2.2 * glowIntensity);
      p.arc(0, 0, r * 2, r * 2, segStart, segEnd);

      p.stroke(hue, sat, bri, 0.88);
      p.strokeWeight(0.7);
      p.arc(0, 0, r * 2, r * 2, segStart, segEnd);
    }
  }

  // ── Radial arm lines and spines ───────────────────────────────────────────
  for (let k = 0; k < effectiveArms; k++) {
    const theta = k * armAngle;
    const bandIdx = k % BAND_COUNT;
    const amp = amps[bandIdx];
    const tMult = transients[bandIdx];
    const hue = (BAND_HUES[bandIdx] + hueShift) % 360;
    const sat = 60 + amp * 30;
    const bri = 50 + amp * 45;

    const cosT = Math.cos(theta);
    const sinT = Math.sin(theta);

    // Radial arm from center to outermost shell
    p.noFill();
    p.stroke(hue, sat, bri, 0.10 * glowIntensity);
    p.strokeWeight(4.5 * glowIntensity);
    p.line(0, 0, outerR * cosT, outerR * sinT);

    p.stroke(hue, sat, bri, 0.30 * glowIntensity);
    p.strokeWeight(1.8 * glowIntensity);
    p.line(0, 0, outerR * cosT, outerR * sinT);

    p.stroke(hue, sat, bri, 0.80);
    p.strokeWeight(0.6);
    p.line(0, 0, outerR * cosT, outerR * sinT);

    // Crystalline spine extending beyond outermost shell
    const spineOscillation = Math.sin(spineWave + k * 1.1) * 0.04;
    const spineLen = baseRadius * (0.18 + spineScale * 0.55) * (0.4 + amp * 0.5 + (tMult - 1) * 0.15 + beatPulse * 0.2) * (1 + spineOscillation);
    const spineStart = outerR;
    const spineEnd = outerR + Math.max(0, spineLen);

    const spineSat = 40 + amp * 40;
    const spineBri = 65 + brilliance * 30;

    // Sub-spine: narrower parallel strands (Haeckel spines have secondary fibers)
    const subSpineOffset = baseRadius * 0.03 * (1 + k % 3 * 0.5);
    const perpCos = -sinT;
    const perpSin = cosT;

    for (let sub = -1; sub <= 1; sub += 2) {
      const ox = perpCos * subSpineOffset * sub * 0.35;
      const oy = perpSin * subSpineOffset * sub * 0.35;
      p.stroke(hue, spineSat, spineBri, 0.06 * glowIntensity);
      p.strokeWeight(3 * glowIntensity);
      p.line(spineStart * cosT + ox, spineStart * sinT + oy, spineEnd * cosT + ox, spineEnd * sinT + oy);

      p.stroke(hue, spineSat, spineBri, 0.70);
      p.strokeWeight(0.4);
      p.line(spineStart * cosT + ox, spineStart * sinT + oy, spineEnd * cosT + ox, spineEnd * sinT + oy);
    }

    // Main spine core
    p.stroke(hue, spineSat, spineBri, 0.08 * glowIntensity);
    p.strokeWeight(4.5 * glowIntensity);
    p.line(spineStart * cosT, spineStart * sinT, spineEnd * cosT, spineEnd * sinT);

    p.stroke(hue, spineSat, spineBri, 0.30 * glowIntensity);
    p.strokeWeight(1.6 * glowIntensity);
    p.line(spineStart * cosT, spineStart * sinT, spineEnd * cosT, spineEnd * sinT);

    p.stroke(hue, spineSat, spineBri, 0.90);
    p.strokeWeight(0.5);
    p.line(spineStart * cosT, spineStart * sinT, spineEnd * cosT, spineEnd * sinT);

    // Spine tip node — tiny bright orb
    if (spineLen > 3) {
      p.noStroke();
      p.fill(hue, 30, 95, 0.6 + amp * 0.35);
      const tipSize = (isMobile ? 1.5 : 2) + amp * 3 + beatPulse * 2;
      p.circle(spineEnd * cosT, spineEnd * sinT, tipSize);
    }

    // Node dots at each shell intersection (the "joints" of the lattice cage)
    for (let s = 0; s < effectiveShells; s++) {
      const nr = shellRadii[s];
      const nodeAmp = amps[(k + s) % BAND_COUNT];
      const nodeBri = 75 + nodeAmp * 22;
      const nodeSize = (isMobile ? 1.5 : 2.5) + nodeAmp * 2.5 + (s === effectiveShells - 1 ? 1.5 : 0);
      p.noStroke();
      p.fill(hue, 35, nodeBri, 0.85 + nodeAmp * 0.15);
      p.circle(nr * cosT, nr * sinT, nodeSize);
    }
  }

  // ── Cross-struts between adjacent arms at each shell (lattice filigree) ───
  for (let k = 0; k < effectiveArms; k++) {
    const theta1 = k * armAngle;
    const theta2 = ((k + 1) % effectiveArms) * armAngle;
    const bandIdx = k % BAND_COUNT;
    const amp = amps[bandIdx];
    const hue = (BAND_HUES[bandIdx] + hueShift) % 360;
    const sat = 65 + amp * 25;
    const bri = 30 + amp * 35;

    for (let s = 0; s < effectiveShells; s++) {
      const r = shellRadii[s];
      const x1 = r * Math.cos(theta1);
      const y1 = r * Math.sin(theta1);
      const x2 = r * Math.cos(theta2);
      const y2 = r * Math.sin(theta2);

      // Chord strut at each shell level
      p.noFill();
      p.stroke(hue, sat, bri, 0.07 * glowIntensity);
      p.strokeWeight(2.5 * glowIntensity);
      p.line(x1, y1, x2, y2);

      p.stroke(hue, sat, bri, 0.55);
      p.strokeWeight(0.4);
      p.line(x1, y1, x2, y2);
    }

    // Diagonal cross-braces between adjacent shells (creates the lattice window effect)
    for (let s = 0; s < effectiveShells - 1; s++) {
      const r1 = shellRadii[s];
      const r2 = shellRadii[s + 1];
      const midTheta = (theta1 + theta2) / 2;

      // Mid-point of this arc segment (for the brace anchor)
      const mx = ((r1 + r2) / 2) * Math.cos(midTheta);
      const my = ((r1 + r2) / 2) * Math.sin(midTheta);

      // Inner-outer diagonal
      const xA = r1 * Math.cos(theta1);
      const yA = r1 * Math.sin(theta1);
      const xB = r2 * Math.cos(theta2);
      const yB = r2 * Math.sin(theta2);

      const crossAmp = amps[(k + s + 1) % BAND_COUNT];
      const crossHue = (BAND_HUES[(k + s) % BAND_COUNT] + hueShift) % 360;

      p.stroke(crossHue, sat, bri - 5, 0.04 * glowIntensity);
      p.strokeWeight(1.8 * glowIntensity);
      p.line(xA, yA, xB, yB);

      p.stroke(crossHue, sat, bri - 5, 0.35 + crossAmp * 0.15);
      p.strokeWeight(0.3);
      p.line(xA, yA, xB, yB);

      // Opposite diagonal
      const xC = r1 * Math.cos(theta2);
      const yC = r1 * Math.sin(theta2);
      const xD = r2 * Math.cos(theta1);
      const yD = r2 * Math.sin(theta1);

      // Mid-node at crossing point (X-brace intersection)
      p.noStroke();
      p.fill(crossHue, 40, 80, 0.5 + crossAmp * 0.3);
      p.circle(mx, my, 1.5 + crossAmp * 1.5);

      p.stroke(crossHue, sat, bri - 5, 0.03 * glowIntensity);
      p.strokeWeight(1.8 * glowIntensity);
      p.line(xC, yC, xD, yD);

      p.noFill();
      p.stroke(crossHue, sat, bri - 5, 0.30 + crossAmp * 0.12);
      p.strokeWeight(0.3);
      p.line(xC, yC, xD, yD);
    }
  }

  // ── Central nucleus — glowing silica sphere ────────────────────────────────
  const nucleusR = baseRadius * 0.055 * (1 + subBass * 0.6 + beatPulse * 0.4);
  const nucleusHue = (hueShift + breathPhase * 12) % 360;

  // Soft glow layers outward from center
  const glowSteps = isMobile ? 4 : 8;
  for (let i = glowSteps; i >= 1; i--) {
    const t = i / glowSteps;
    const r = nucleusR * (1 + t * 1.5);
    const a = (1 - t) * 0.3 * glowIntensity * (0.3 + totalAmp * 0.7);
    p.noStroke();
    p.fill(nucleusHue, 35, 90, a);
    p.circle(0, 0, r * 2);
  }
  // Bright core
  p.noStroke();
  p.fill(nucleusHue, 20, 100, 0.92);
  p.circle(0, 0, nucleusR * 0.55 * 2);

  // ── Beat ring pulse ───────────────────────────────────────────────────────
  if (beatPulse > 0.05) {
    const ringR = baseRadius * (1.05 + (1 - beatPulse) * 0.6);
    p.noFill();
    p.stroke(hueShift, 40, 95, beatPulse * 0.35 * glowIntensity);
    p.strokeWeight(3 * beatPulse * glowIntensity);
    p.circle(0, 0, ringR * 2);
    // Second, faster ring
    const ring2R = baseRadius * (1.05 + (1 - beatPulse) * 0.9);
    p.stroke(hueShift, 40, 95, beatPulse * 0.18 * glowIntensity);
    p.strokeWeight(1.5 * beatPulse * glowIntensity);
    p.circle(0, 0, ring2R * 2);
  }

  p.pop();
  p.blendMode(p['BLEND']);
  (p as any).colorMode(p['RGB'], 255);
}
