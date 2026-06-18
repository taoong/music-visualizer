import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { BAND_COUNT, isMobile } from '../utils/constants';

const MAX_STROKES = isMobile ? 120 : 250;
const POINTS_PER_STROKE = isMobile ? 24 : 40;

const BAND_HUES = [10, 35, 55, 140, 210, 260, 310];
const BAND_SAT = [85, 80, 75, 70, 65, 75, 80];

interface Stroke {
  cx: number[];
  cy: number[];
  hue: number;
  sat: number;
  weight: number;
  progress: number;
  speed: number;
  opacity: number;
  band: number;
  len: number;
}

let strokes: Stroke[] = [];
let trail: any = null;
let lastBeatIndex = -1;
let hueShift = 0;
let time = 0;
let prevW = 0;
let prevH = 0;

function buildStroke(
  w: number, h: number,
  bandIdx: number, amp: number,
  p: P5Instance,
): Stroke {
  const edge = Math.floor(Math.random() * 4);
  let sx: number, sy: number;
  switch (edge) {
    case 0: sx = Math.random() * w; sy = -20; break;
    case 1: sx = w + 20; sy = Math.random() * h; break;
    case 2: sx = Math.random() * w; sy = h + 20; break;
    default: sx = -20; sy = Math.random() * h; break;
  }

  const tx = w * (0.15 + Math.random() * 0.7);
  const ty = h * (0.15 + Math.random() * 0.7);

  const nPts = POINTS_PER_STROKE;
  const cx = new Array(nPts);
  const cy = new Array(nPts);

  for (let i = 0; i < nPts; i++) {
    const t = i / (nPts - 1);
    const baseX = sx + (tx - sx) * t;
    const baseY = sy + (ty - sy) * t;
    const drift = Math.sin(t * Math.PI) * (80 + amp * 120);
    const angle = p.noise(baseX * 0.003, baseY * 0.003, time * 0.5) * Math.PI * 2;
    cx[i] = baseX + Math.cos(angle) * drift;
    cy[i] = baseY + Math.sin(angle) * drift;
  }

  return {
    cx, cy,
    hue: (BAND_HUES[bandIdx] + hueShift) % 360,
    sat: BAND_SAT[bandIdx],
    weight: 3 + amp * 18 + Math.random() * 6,
    progress: 0,
    speed: 0.02 + amp * 0.04 + Math.random() * 0.02,
    opacity: 0.5 + amp * 0.4,
    band: bandIdx,
    len: nPts,
  };
}

export function drawBrush(p: P5Instance, dt: number): void {
  const { state, config } = store;
  const { amps, transients } = getBandAverages(BAND_COUNT);
  const w = p.width;
  const h = p.height;

  time += dt * 0.01;

  const strokeRate = 0.2 + config.brushStrokes * 0.8;
  const baseWeight = 0.3 + config.brushWeight * 1.4;
  const trailFade = 2 + (1 - config.brushTrail) * 30;

  if (!trail || prevW !== w || prevH !== h) {
    trail = (p as any).createGraphics(w, h);
    trail.background(12, 10, 14);
    prevW = w;
    prevH = h;
  }

  let energy = 0;
  for (let i = 0; i < amps.length; i++) energy += amps[i];
  energy /= amps.length;

  let maxBand = 0;
  let maxAmp = 0;
  for (let b = 0; b < BAND_COUNT; b++) {
    if (amps[b] > maxAmp) { maxAmp = amps[b]; maxBand = b; }
  }

  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    const currentBeatIndex = adjusted >= 0 ? Math.floor(adjusted / state.beatIntervalSec) : -1;

    if (currentBeatIndex >= 0 && currentBeatIndex !== lastBeatIndex) {
      lastBeatIndex = currentBeatIndex;
      hueShift = (hueShift + 15 + Math.random() * 20) % 360;

      const count = Math.max(1, Math.round(strokeRate * 3));
      for (let s = 0; s < count; s++) {
        const band = s === 0 ? maxBand : Math.floor(Math.random() * BAND_COUNT);
        if (strokes.length < MAX_STROKES) {
          strokes.push(buildStroke(w, h, band, amps[band], p));
        }
      }
    }
  }

  if (energy > 0.15) {
    const spawnChance = strokeRate * energy * 0.3 * dt;
    if (Math.random() < spawnChance && strokes.length < MAX_STROKES) {
      const band = maxBand;
      strokes.push(buildStroke(w, h, band, amps[band], p));
    }
  }

  for (let b = 0; b < BAND_COUNT; b++) {
    if (transients[b] > 1.6 && Math.random() < 0.4 * strokeRate) {
      if (strokes.length < MAX_STROKES) {
        strokes.push(buildStroke(w, h, b, amps[b], p));
      }
    }
  }

  trail.colorMode(trail.HSB, 360, 100, 100, 100);

  trail.noStroke();
  trail.fill(0, 0, 5, trailFade);
  trail.rect(0, 0, w, h);

  const completed: number[] = [];
  for (let si = 0; si < strokes.length; si++) {
    const s = strokes[si];
    const prevProg = s.progress;
    s.progress = Math.min(1, s.progress + s.speed * dt);

    const startI = Math.max(0, Math.floor(prevProg * (s.len - 1)));
    const endI = Math.min(s.len - 1, Math.ceil(s.progress * (s.len - 1)));

    if (endI <= startI) continue;

    const w2 = s.weight * baseWeight;
    const bandAmp = amps[s.band];

    for (let pass = 0; pass < 3; pass++) {
      const passAlpha = pass === 0 ? s.opacity * 12 : pass === 1 ? s.opacity * 30 : s.opacity * 65;
      const passWeight = pass === 0 ? w2 * 3.5 : pass === 1 ? w2 * 1.8 : w2;
      const passSat = pass === 0 ? s.sat * 0.3 : pass === 1 ? s.sat * 0.7 : s.sat;
      const passBright = pass === 0 ? 60 + bandAmp * 30 : pass === 1 ? 70 + bandAmp * 25 : 85 + bandAmp * 15;

      trail.stroke(s.hue, passSat, Math.min(100, passBright), passAlpha);
      trail.strokeWeight(passWeight);
      trail.noFill();

      for (let i = startI; i < endI; i++) {
        const t = i / (s.len - 1);
        const taper = Math.sin(t * Math.PI);
        const sw = passWeight * (0.3 + taper * 0.7);
        trail.strokeWeight(sw);
        trail.line(s.cx[i], s.cy[i], s.cx[i + 1], s.cy[i + 1]);
      }
    }

    if (s.progress >= 1) completed.push(si);
  }

  for (let i = completed.length - 1; i >= 0; i--) {
    strokes.splice(completed[i], 1);
  }

  trail.colorMode(trail.RGB, 255);

  p.image(trail, 0, 0, w, h);

  if (energy > 0.3) {
    (p as any).colorMode(p['HSB'], 360, 100, 100, 100);
    const splatterCount = Math.floor(energy * 8 * strokeRate);
    for (let i = 0; i < splatterCount; i++) {
      const band = Math.floor(Math.random() * BAND_COUNT);
      const amp = amps[band];
      if (amp < 0.2) continue;
      const sx = Math.random() * w;
      const sy = Math.random() * h;
      const r = 1 + amp * 4;
      const hue = (BAND_HUES[band] + hueShift) % 360;
      (p as any).noStroke();
      (p as any).fill(hue, BAND_SAT[band] * 0.8, 80 + amp * 20, 40 + amp * 30);
      p.ellipse(sx, sy, r, r);
    }
    (p as any).colorMode(p['RGB'], 255);
  }
}

export function resetBrush(): void {
  strokes = [];
  if (trail) {
    trail.remove();
    trail = null;
  }
  lastBeatIndex = -1;
  hueShift = 0;
  time = 0;
  prevW = 0;
  prevH = 0;
}
