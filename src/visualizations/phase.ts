/**
 * Phase — Polyrhythmic geometric rings.
 *
 * Inspired by Daito Manabe's "Phase Forms" (2025), a 75-minute audiovisual
 * performance built on mathematical polyrhythms (Rhizomatiks).
 * https://daito.ws/en/archive/daito-manabe-phase-forms2025/
 *
 * N concentric rings of arc segments rotate at mathematically related speeds
 * (polyrhythmic ratios: 1:1, 3:2, 4:3, 5:4, 5:3, 7:4, 6:5). Each ring is
 * driven by a frequency band. When arcs on adjacent rings momentarily align,
 * a bright resonance flash connects them. Beat detection fires angular
 * impulse and global hue shift.
 *
 * Sliders
 *   Rings   — Number of concentric rings (3–7)
 *   Density — Arc segments per ring (3–12)
 *   Glow    — Neon glow intensity
 */
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { BAND_COUNT, isMobile } from '../utils/constants';

const TWO_PI = Math.PI * 2;

const POLYRHYTHM_RATIOS = [1, 3 / 2, 4 / 3, 5 / 4, 5 / 3, 7 / 4, 6 / 5];

const BAND_HUES = [280, 220, 170, 130, 50, 20, 340];

const GLOW_PASSES = [
  { widthMult: 5.0, alphaMult: 0.15 },
  { widthMult: 2.5, alphaMult: 0.4 },
  { widthMult: 1.0, alphaMult: 1.0 },
];

let angles: number[] = [];
let lastBeatIndex = -1;
let hueShift = 0;
let beatImpulse = 0;
let time = 0;

export function resetPhase(): void {
  angles = new Array(BAND_COUNT).fill(0);
  lastBeatIndex = -1;
  hueShift = 0;
  beatImpulse = 0;
  time = 0;
}

export function drawPhase(p: P5Instance, dt: number): void {
  const W = p.width;
  const H = p.height;
  const cx = W / 2;
  const cy = H / 2;
  const minDim = Math.min(W, H);

  const bands = getBandAverages();
  const totalAmp = bands.reduce((s, v) => s + v, 0) / BAND_COUNT;

  const cfg = store.config;
  const ringCount = Math.round(3 + (cfg.phaseRings ?? 0.57) * 4);
  const arcSegments = Math.round(3 + (cfg.phaseDensity ?? 0.5) * 9);
  const glowIntensity = cfg.phaseGlow ?? 1.0;

  const bpmData = store.state.bpm;
  const beatIntervalSec = bpmData > 0 ? 60 / bpmData : 0;
  const beatOffset = store.state.beatOffset ?? 0;

  if (beatIntervalSec > 0) {
    const pos = audioEngine.getPlaybackPosition();
    const beatIndex = Math.floor((pos - beatOffset) / beatIntervalSec);
    if (beatIndex !== lastBeatIndex && lastBeatIndex >= 0) {
      beatImpulse = 1.0;
      hueShift = (hueShift + 30) % 360;
    }
    lastBeatIndex = beatIndex;
  }

  beatImpulse *= Math.pow(0.92, dt);

  const baseSpeed = 0.3 + totalAmp * 0.6 + beatImpulse * 2.0;
  for (let i = 0; i < BAND_COUNT; i++) {
    const ratio = POLYRHYTHM_RATIOS[i % POLYRHYTHM_RATIOS.length];
    const direction = i % 2 === 0 ? 1 : -1;
    angles[i] = (angles[i] + direction * baseSpeed * ratio * dt * 0.02) % TWO_PI;
  }

  time += dt * 0.01;

  (p as any).colorMode(p['HSB'], 360, 100, 100, 1.0);
  p.background(0, 0, 4);

  const maxRadius = minDim * 0.42;
  const minRadius = minDim * 0.06;

  for (let ring = 0; ring < ringCount; ring++) {
    const bandIdx = ring % BAND_COUNT;
    const amp = bands[bandIdx];
    const radius = minRadius + (maxRadius - minRadius) * (ring / (ringCount - 1 || 1));
    const angle = angles[bandIdx];
    const arcLen = (TWO_PI / arcSegments) * (0.3 + amp * 0.6);
    const gap = TWO_PI / arcSegments;
    const hue = (BAND_HUES[bandIdx] + hueShift) % 360;
    const brightness = 40 + amp * 60;
    const sat = 70 + amp * 30;
    const strokeW = (isMobile ? 1.5 : 2.5) + amp * (isMobile ? 1.5 : 2.5);

    for (let seg = 0; seg < arcSegments; seg++) {
      const segStart = angle + seg * gap;
      const segEnd = segStart + arcLen;

      for (const pass of GLOW_PASSES) {
        const w = strokeW * pass.widthMult * glowIntensity;
        const a = pass.alphaMult * (0.4 + amp * 0.6);
        p.noFill();
        p.stroke(hue, sat, brightness, a);
        p.strokeWeight(w);
        p.arc(cx, cy, radius * 2, radius * 2, segStart, segEnd);
      }
    }

    if (ring > 0) {
      const prevBandIdx = (ring - 1) % BAND_COUNT;
      const prevAngle = angles[prevBandIdx];
      const prevRadius = minRadius + (maxRadius - minRadius) * ((ring - 1) / (ringCount - 1 || 1));
      const prevAmp = bands[prevBandIdx];

      for (let seg = 0; seg < arcSegments; seg++) {
        const curMid = angle + seg * gap + arcLen / 2;
        for (let pseg = 0; pseg < arcSegments; pseg++) {
          const prevGap = TWO_PI / arcSegments;
          const prevArcLen = (TWO_PI / arcSegments) * (0.3 + prevAmp * 0.6);
          const prevMid = prevAngle + pseg * prevGap + prevArcLen / 2;

          let diff = ((curMid - prevMid) % TWO_PI + TWO_PI) % TWO_PI;
          if (diff > Math.PI) diff = TWO_PI - diff;

          const threshold = 0.15 + (1 - totalAmp) * 0.15;
          if (diff < threshold) {
            const resonance = 1 - diff / threshold;
            const rAlpha = resonance * resonance * (0.3 + beatImpulse * 0.5) * glowIntensity;
            const midAngle = (curMid + prevMid) / 2;
            const x1 = cx + Math.cos(midAngle) * prevRadius;
            const y1 = cy + Math.sin(midAngle) * prevRadius;
            const x2 = cx + Math.cos(midAngle) * radius;
            const y2 = cy + Math.sin(midAngle) * radius;

            const resHue = (hue + 180) % 360;
            p.stroke(resHue, 60, 100, rAlpha);
            p.strokeWeight((isMobile ? 1 : 1.5) * glowIntensity);
            p.line(x1, y1, x2, y2);
          }
        }
      }
    }
  }

  const centerGlow = totalAmp * 0.4 + beatImpulse * 0.6;
  if (centerGlow > 0.05) {
    const cHue = (hueShift + time * 20) % 360;
    for (let r = minDim * 0.08; r > 0; r -= minDim * 0.015) {
      const a = centerGlow * (1 - r / (minDim * 0.08)) * 0.15 * glowIntensity;
      p.noStroke();
      p.fill(cHue, 50, 90, a);
      p.ellipse(cx, cy, r * 2, r * 2);
    }
  }

  (p as any).colorMode(p['RGB'], 255);
}
