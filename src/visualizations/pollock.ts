/**
 * Pollock — Audio-reactive drip-painting action painting.
 *
 * Inspired by Jackson Pollock's "drip technique" — his method of
 * pouring and flinging paint from sticks and brushes onto raw canvas
 * laid on the floor (1947–1951). Specifically "No. 5, 1948" (private
 * collection, last sold $140M) and "Blue Poles" (Number 11, 1952,
 * National Gallery of Australia, https://nga.gov.au/international/catalogue/detail.cfm?irn=29615).
 *
 * Seven paint streams (one per frequency band) drip from drifting
 * source points at the canvas top. Band amplitude drives flow rate
 * and stroke weight. Chaos morphs from controlled rhythmic streams
 * to turbulent explosive splatter. Beats fire dramatic horizontal
 * flings that arc across the canvas with micro-droplet trails.
 * The painting accumulates on a persistent buffer — at the earth-tone
 * end of Palette the buffer barely fades (echoing Pollock's layered
 * oil pigments), at the neon end it pulses with ephemeral transience.
 *
 * Sliders
 *   Viscosity — paint consistency (0 = watery thin streams, 1 = heavy thick drips)
 *   Chaos     — gesture turbulence (0 = controlled drips, 1 = wild splatter)
 *   Palette   — color + persistence (0 = Pollock earth tones / slow accumulation,
 *                                    1 = vivid neon / fast fading)
 */

import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { BAND_COUNT, isMobile } from '../utils/constants';

// Earth-tone palette (Pollock's actual pigments: cadmium red, raw sienna, yellow ochre,
// titanium white, cerulean blue, cobalt blue, dioxazine violet)
const EARTH_H: readonly number[] = [  5,  28,  46,  50, 200, 225, 270];
const EARTH_S: readonly number[] = [ 90,  85,  75,   5,  80,  85,  75];
const EARTH_B: readonly number[] = [ 80,  72,  78,  95,  68,  66,  66];

// Vivid neon targets
const NEON_H:  readonly number[] = [  0,  28,  55,   0, 185, 230, 285];
const NEON_S:  readonly number[] = [100, 100, 100,   0, 100, 100, 100];
const NEON_B:  readonly number[] = [100, 100, 100, 100, 100, 100, 100];

type Drip = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  band: number;
  width: number;
  prevX: number;
  prevY: number;
  age: number;
  nx: number; // Perlin seed x
  ny: number; // Perlin seed y
};

type Fling = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  band: number;
  width: number;
  prevX: number;
  prevY: number;
};

type Splat = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  band: number;
  r: number;
  a: number; // alpha 0–100 (HSB scale)
};

let trail: any = null;
let prevW = 0;
let prevH = 0;

let drips: Drip[] = [];
let flings: Fling[] = [];
let splats: Splat[] = [];
let sourceX: number[] = [];
let sourceVx: number[] = [];
let lastBeatIndex = -1;
let hueShift = 0;
let frameT = 0;

const MAX_DRIPS  = isMobile ? 30 :  70;
const MAX_SPLATS = isMobile ? 60 : 200;

export function resetPollock(): void {
  trail?.remove();
  trail = null;
  prevW = 0;
  prevH = 0;
  drips = [];
  flings = [];
  splats = [];
  sourceX = [];
  sourceVx = [];
  lastBeatIndex = -1;
  hueShift = 0;
  frameT = 0;
}

function lerpN(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function bandColor(band: number, pt: number): [number, number, number] {
  const h = (lerpN(EARTH_H[band], NEON_H[band], pt) + hueShift) % 360;
  const s =  lerpN(EARTH_S[band], NEON_S[band], pt);
  const b =  lerpN(EARTH_B[band], NEON_B[band], pt);
  return [h, s, b];
}

export function drawPollock(p: P5Instance, dt: number): void {
  const { state, config } = store;
  const { amps } = getBandAverages(BAND_COUNT);

  const W = p.width;
  const H = p.height;

  frameT += dt;

  // Init / resize trail buffer
  if (!trail || prevW !== W || prevH !== H) {
    trail?.remove();
    trail = (p as any).createGraphics(W, H);
    trail.background(18, 13, 10); // dark raw-canvas ground
    prevW = W;
    prevH = H;
    drips = [];
    flings = [];
    splats = [];
    sourceX = [];
    sourceVx = [];
    lastBeatIndex = -1;
    frameT = 0;
  }

  // Init source points — evenly spread along top edge, each drifts independently
  if (sourceX.length === 0) {
    for (let i = 0; i < BAND_COUNT; i++) {
      sourceX.push(W * (0.06 + 0.88 * (i / (BAND_COUNT - 1))));
      sourceVx.push((Math.random() - 0.5) * 0.5);
    }
  }

  const viscosity = config.pollockViscosity;
  const chaos     = config.pollockChaos;
  const palette   = config.pollockPalette;

  // Beat detection
  let onBeat = false;
  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    const beatIdx = adjusted >= 0 ? Math.floor(adjusted / state.beatIntervalSec) : -1;
    if (beatIdx >= 0 && beatIdx !== lastBeatIndex) {
      lastBeatIndex = beatIdx;
      onBeat = true;
      hueShift = (hueShift + 30 + Math.random() * 30) % 360;
    }
  }

  // Drift source positions via Perlin noise
  for (let i = 0; i < BAND_COUNT; i++) {
    const t = frameT * 0.0015;
    sourceVx[i] += (p.noise(i * 9.3, t) - 0.5) * 0.5 * dt;
    sourceVx[i] *= Math.pow(0.93, dt);
    sourceX[i] += sourceVx[i] * dt;
    if (sourceX[i] < W * 0.04) { sourceX[i] = W * 0.04; sourceVx[i] =  Math.abs(sourceVx[i]) * 0.6; }
    if (sourceX[i] > W * 0.96) { sourceX[i] = W * 0.96; sourceVx[i] = -Math.abs(sourceVx[i]) * 0.6; }
  }

  // Spawn drips proportional to band amplitude
  for (let i = 0; i < BAND_COUNT; i++) {
    const amp = amps[i];
    // Spawn probability: higher viscosity and amplitude = more drips
    const prob = amp * (0.15 + viscosity * 0.45) * dt;
    if (drips.length < MAX_DRIPS && Math.random() < prob) {
      const w = 0.7 + viscosity * 6 + amp * 5;
      const sx = sourceX[i] + (Math.random() - 0.5) * (8 + chaos * 24);
      drips.push({
        x: sx,   y: -w * 0.5,
        vx: (Math.random() - 0.5) * (0.3 + chaos * 2.5),
        vy: 0.4 + Math.random() * 1.2,
        band: i, width: w,
        prevX: sx, prevY: -w * 0.5,
        age: 0,
        nx: Math.random() * 500,
        ny: Math.random() * 500,
      });
    }
  }

  // On beat: fire a paint fling across canvas + splat burst
  if (onBeat) {
    const domBand = amps.reduce((best, a, i) => (a > amps[best] ? i : best), 0);
    const fW = 1.5 + viscosity * 9 + amps[domBand] * 7;
    const fromLeft = Math.random() < 0.5;
    const sy = H * (0.1 + Math.random() * 0.8);
    const ey = H * (0.1 + Math.random() * 0.8);
    const spd = 5 + chaos * 11;
    const steps = Math.max(1, W / spd);

    flings.push({
      x:  fromLeft ? -12 : W + 12,
      y:  sy,
      vx: (fromLeft ? 1 : -1) * spd,
      vy: (ey - sy) / steps,
      band: domBand,
      width: fW,
      prevX: fromLeft ? -12 : W + 12,
      prevY: sy,
    });

    // Burst of micro-splats at a random interior point
    const sCount = isMobile ? 8 : 22;
    const cx = W * (0.15 + Math.random() * 0.7);
    const cy = H * (0.15 + Math.random() * 0.7);
    for (let s = 0; s < sCount; s++) {
      const ang = Math.random() * Math.PI * 2;
      const spd2 = (0.4 + Math.random() * 4) * (1 + chaos * 2);
      splats.push({
        x: cx, y: cy,
        vx: Math.cos(ang) * spd2,
        vy: Math.sin(ang) * spd2 - 0.8,
        band: Math.floor(Math.random() * BAND_COUNT),
        r: 0.8 + Math.random() * 4 * (0.3 + viscosity * 0.7),
        a: 65 + Math.random() * 35,
      });
    }
  }

  // === Draw to trail buffer ===
  trail.colorMode(trail.HSB, 360, 100, 100, 100);

  // Fade: earth-tone = barely fades (painting accumulates), neon = fades quickly
  const fadeA = 0.15 + palette * 5.5; // 0.15–5.65 on 0–100 alpha scale
  trail.noStroke();
  trail.fill(25, 44, 7, fadeA); // dark warm brown matching background
  trail.rect(0, 0, W, H);

  // Update + draw drips
  const gravity = (0.04 + viscosity * 0.06) * dt;
  for (let i = drips.length - 1; i >= 0; i--) {
    const d = drips[i];
    d.prevX = d.x;
    d.prevY = d.y;

    // Perlin-noise lateral wobble + gravity
    const noiseVal = p.noise(d.nx + frameT * 0.003, d.ny + frameT * 0.003);
    d.vx += (noiseVal - 0.5) * chaos * 0.6 * dt;
    d.vx *= Math.pow(0.96, dt);
    d.vy += gravity;
    d.x  += d.vx * dt;
    d.y  += d.vy * dt;
    d.age++;

    const [h, s, b] = bandColor(d.band, palette);
    trail.stroke(h, s, b, 78 + Math.random() * 22);
    trail.strokeWeight(d.width);
    trail.line(d.prevX, d.prevY, d.x, d.y);

    // Micro-splats from turbulent drips
    if (chaos > 0.35 && Math.random() < chaos * 0.035 * dt && splats.length < MAX_SPLATS) {
      const ang = Math.random() * Math.PI * 2;
      splats.push({
        x: d.x, y: d.y,
        vx: Math.cos(ang) * (0.4 + Math.random() * 2 * chaos),
        vy: Math.sin(ang) * (0.4 + Math.random() * 2 * chaos) - 0.5,
        band: d.band,
        r: 0.4 + Math.random() * 2,
        a: 40 + Math.random() * 45,
      });
    }

    if (d.y > H + 30 || d.age > 350) drips.splice(i, 1);
  }

  // Update + draw flings
  for (let i = flings.length - 1; i >= 0; i--) {
    const f = flings[i];
    f.prevX = f.x;
    f.prevY = f.y;

    f.vy += 0.03 * dt;
    f.vx += (Math.random() - 0.5) * chaos * 0.12;
    f.x  += f.vx * dt;
    f.y  += f.vy * dt;

    const [h, s, b] = bandColor(f.band, palette);
    trail.stroke(h, s, b, 75 + Math.random() * 20);
    trail.strokeWeight(f.width);
    trail.line(f.prevX, f.prevY, f.x, f.y);

    // Drip drops from the fling's forward edge
    if (Math.random() < 0.22 + chaos * 0.40 && splats.length < MAX_SPLATS) {
      splats.push({
        x: f.x, y: f.y,
        vx: (Math.random() - 0.5) * (0.8 + chaos),
        vy: Math.random() * 1.5,
        band: f.band,
        r: 0.8 + Math.random() * 3.5 * viscosity,
        a: 50 + Math.random() * 35,
      });
    }

    if (f.x < -100 || f.x > W + 100 || f.y > H + 80 || f.y < -80) flings.splice(i, 1);
  }

  // Update + draw splats
  for (let i = splats.length - 1; i >= 0; i--) {
    const s = splats[i];
    s.vy += 0.10 * dt;
    s.vx *= Math.pow(0.965, dt);
    s.vy *= Math.pow(0.975, dt);
    s.x  += s.vx * dt;
    s.y  += s.vy * dt;
    s.a  *= Math.pow(0.965, dt);

    const [h, sa, b] = bandColor(s.band, palette);
    trail.fill(h, sa, b, s.a);
    trail.noStroke();
    trail.ellipse(s.x, s.y, s.r * 2, s.r * 2);

    if (s.a < 2.5 || s.y > H + 20) splats.splice(i, 1);
  }

  trail.colorMode(trail.RGB, 255);

  // Composite trail to main canvas
  p.image(trail, 0, 0, W, H);
}
