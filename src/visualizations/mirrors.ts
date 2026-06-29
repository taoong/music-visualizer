/**
 * Mirrors — Audio-reactive scattered reflected light.
 *
 * Inspired by Julio Le Parc's "Continuel-Lumière" (Continual Light Mobile)
 * series (1960–2026), especially the large-scale installation at Tate Modern's
 * "Julio Le Parc: Light. Colour. Action" retrospective (Jun 2026 – May 2027,
 * https://www.tate.org.uk/whats-on/tate-modern/julio-le-parc).
 *
 * Le Parc's kinetic sculptures use small metallic discs and strips that
 * oscillate under ambient air currents, catching spotlight beams and
 * scattering reflected light across dark walls and ceilings. The result
 * is a shimmering, constantly shifting field of dancing light spots —
 * organic, mesmerising, never repeating.
 *
 * N virtual reflective elements produce light spots on a dark canvas.
 * Each element oscillates via multi-frequency sine waves, creating
 * organic compound motion. 7 groups map to freq bands; amplitude drives
 * spot brightness and oscillation range; additive blending creates bright
 * focal clusters where spots overlap; beat scatters spots outward and
 * shifts hue.
 *
 * Sliders
 *   Reflections — number of mirror elements (light spot density)
 *   Scatter     — how widely the reflected light dances across the canvas
 *   Shimmer     — oscillation speed / how actively the mirrors move
 */
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { BAND_COUNT, isMobile } from '../utils/constants';

const MAX_PER_BAND = isMobile ? 14 : 24;

const BAND_HUES: readonly number[] = [45, 30, 50, 200, 340, 270, 195];

type Mirror = {
  homeX: number;
  homeY: number;
  phasesX: number[];
  phasesY: number[];
  freqs: number[];
  size: number;
  shimmerPhase: number;
  shimmerFreq: number;
};

let mirrors: Mirror[] = [];
let lastBeatIndex = -1;
let hueShift = 0;
let beatImpulse = 0;
let mirrorsPerBand = 0;

function hsbToRgb(h: number, s: number, br: number): [number, number, number] {
  s /= 100;
  br /= 100;
  const k = (n: number) => (n + h / 60) % 6;
  const f = (n: number) => br * (1 - s * Math.max(0, Math.min(1, Math.min(k(n), 4 - k(n)))));
  return [Math.round(f(5) * 255), Math.round(f(3) * 255), Math.round(f(1) * 255)];
}

export function resetMirrors(): void {
  mirrors = [];
  lastBeatIndex = -1;
  hueShift = 0;
  beatImpulse = 0;
  mirrorsPerBand = 0;
}

export function drawMirrors(p: P5Instance, dt: number): void {
  const { state, config } = store;
  const { amps } = getBandAverages(BAND_COUNT);

  const W = p.width;
  const H = p.height;

  const reflections = config.mirrorsReflections;
  const scatter = config.mirrorsScatter;
  const shimmer = config.mirrorsShimmer;

  const targetPerBand = Math.max(3, Math.round(MAX_PER_BAND * (0.25 + reflections * 0.75)));

  if (mirrors.length === 0 || mirrorsPerBand !== targetPerBand) {
    mirrors = [];
    mirrorsPerBand = targetPerBand;
    for (let b = 0; b < BAND_COUNT; b++) {
      for (let i = 0; i < mirrorsPerBand; i++) {
        const nHarmonics = 2 + Math.floor(Math.random() * 2);
        const phasesX: number[] = [];
        const phasesY: number[] = [];
        const freqs: number[] = [];
        for (let k = 0; k < nHarmonics; k++) {
          phasesX.push(Math.random() * Math.PI * 2);
          phasesY.push(Math.random() * Math.PI * 2);
          freqs.push(0.15 + Math.random() * 1.6);
        }
        mirrors.push({
          homeX: 0.06 + Math.random() * 0.88,
          homeY: 0.06 + Math.random() * 0.88,
          phasesX,
          phasesY,
          freqs,
          size: 0.4 + Math.random() * 1.0,
          shimmerPhase: Math.random() * Math.PI * 2,
          shimmerFreq: 1.2 + Math.random() * 3.5,
        });
      }
    }
  }

  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    const beatIdx = adjusted >= 0 ? Math.floor(adjusted / state.beatIntervalSec) : -1;
    if (beatIdx >= 0 && beatIdx !== lastBeatIndex) {
      lastBeatIndex = beatIdx;
      hueShift = (hueShift + 22) % 360;
      beatImpulse = 1.0;
    }
  }

  beatImpulse *= Math.pow(0.86, dt);

  const time = p.frameCount * 0.005 * (0.15 + shimmer * 0.85);
  const scatterRange = 0.02 + scatter * 0.44;

  p.background(4, 3, 10);
  p.noStroke();
  (p as any).blendMode(p['ADD']);

  for (let b = 0; b < BAND_COUNT; b++) {
    const amp = amps[b];
    const hue = (BAND_HUES[b] + hueShift) % 360;
    const sat = 20 + amp * 30;

    for (let i = 0; i < mirrorsPerBand; i++) {
      const m = mirrors[b * mirrorsPerBand + i];

      let oscX = 0;
      let oscY = 0;
      for (let k = 0; k < m.freqs.length; k++) {
        const w = 1 / (k + 1);
        oscX += Math.sin(time * m.freqs[k] + m.phasesX[k]) * w;
        oscY += Math.sin(time * m.freqs[k] * 1.27 + m.phasesY[k]) * w;
      }
      const harmonicNorm = m.freqs.length === 2 ? 1.5 : 1.833;
      oscX = (oscX / harmonicNorm) * scatterRange * (0.25 + amp * 0.75);
      oscY = (oscY / harmonicNorm) * scatterRange * (0.25 + amp * 0.75);

      const pushX = (m.homeX - 0.5) * beatImpulse * 0.22;
      const pushY = (m.homeY - 0.5) * beatImpulse * 0.22;

      const spotX = (m.homeX + oscX + pushX) * W;
      const spotY = (m.homeY + oscY + pushY) * H;

      const shimmerVal = 0.55 + 0.45 * Math.sin(time * m.shimmerFreq * 2.5 + m.shimmerPhase);
      const brightness = amp * shimmerVal * m.size;
      if (brightness < 0.008) continue;

      const baseSize = (10 + amp * 30) * m.size * (isMobile ? 0.7 : 1.0);
      const bri = Math.min(brightness * 95, 90);
      const [r, g, bv] = hsbToRgb(hue, sat, bri);

      const a1 = Math.min(brightness * 16, 22);
      const a2 = Math.min(brightness * 38, 50);
      const a3 = Math.min(brightness * 75, 110);

      p.fill(r, g, bv, a1);
      p.ellipse(spotX, spotY, baseSize * 4, baseSize * 4);
      p.fill(r, g, bv, a2);
      p.ellipse(spotX, spotY, baseSize * 2, baseSize * 2);
      p.fill(r, g, bv, a3);
      p.ellipse(spotX, spotY, baseSize * 0.8, baseSize * 0.8);
    }
  }

  (p as any).blendMode(p['BLEND']);
}
