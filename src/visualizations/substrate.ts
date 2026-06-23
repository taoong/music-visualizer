import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { BAND_COUNT, isMobile } from '../utils/constants';

const SCALE = isMobile ? 3 : 2;
const MAX_CRACKS = isMobile ? 50 : 100;
const SAND_REACH = isMobile ? 14 : 22;

const BAND_HUES = [280, 220, 175, 130, 50, 20, 320];

interface Crack {
  x: number;
  y: number;
  dx: number;
  dy: number;
  angleDeg: number;
  band: number;
  alive: boolean;
}

let cracks: Crack[] = [];
let angleGrid: Int16Array | null = null;
let pg: any = null;
let gW = 0;
let gH = 0;
let lastBeatIndex = -1;
let hueShift = 0;
let gridClearTimer = 0;

function degreesToDxDy(deg: number): [number, number] {
  const rad = (deg * Math.PI) / 180;
  return [Math.cos(rad), Math.sin(rad)];
}

function makeCrack(x: number, y: number, angleDeg: number, band: number): Crack {
  const [dx, dy] = degreesToDxDy(angleDeg);
  return { x, y, dx, dy, angleDeg, band, alive: true };
}

function seedCrack(band: number): boolean {
  if (!angleGrid) return false;
  for (let attempt = 0; attempt < 30; attempt++) {
    const x = Math.floor(Math.random() * gW);
    const y = Math.floor(Math.random() * gH);
    if (angleGrid[y * gW + x] >= 0) continue;
    const angleDeg = Math.floor(Math.random() * 180);
    angleGrid[y * gW + x] = angleDeg;
    cracks.push(makeCrack(x, y, angleDeg, band));
    return true;
  }
  return false;
}

function spawnFromExisting(band: number): boolean {
  if (!angleGrid || gW === 0) return false;
  for (let attempt = 0; attempt < 30; attempt++) {
    const rx = Math.floor(Math.random() * gW);
    const ry = Math.floor(Math.random() * gH);
    const existingAngle = angleGrid[ry * gW + rx];
    if (existingAngle < 0) continue;

    const perpAngle =
      (existingAngle + (Math.random() < 0.5 ? 90 : -90) + 360) % 360;
    const [dx, dy] = degreesToDxDy(perpAngle);
    const nx = Math.round(rx + dx);
    const ny = Math.round(ry + dy);
    if (nx < 0 || nx >= gW || ny < 0 || ny >= gH) continue;
    if (angleGrid[ny * gW + nx] >= 0) continue;

    angleGrid[ny * gW + nx] = perpAngle;
    cracks.push(makeCrack(nx, ny, perpAngle, band));
    return true;
  }
  return false;
}

function pickWeightedBand(amps: number[]): number {
  let total = 0;
  for (let i = 0; i < BAND_COUNT; i++) total += amps[i] + 0.05;
  let r = Math.random() * total;
  for (let i = 0; i < BAND_COUNT; i++) {
    r -= amps[i] + 0.05;
    if (r <= 0) return i;
  }
  return BAND_COUNT - 1;
}

function hsbToRgb(
  h: number,
  s: number,
  b: number,
): [number, number, number] {
  h = ((h % 360) + 360) % 360;
  const s01 = s / 100;
  const b01 = b / 100;
  const c = b01 * s01;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = b01 - c;
  let r1: number, g1: number, b1: number;
  if (h < 60) [r1, g1, b1] = [c, x, 0];
  else if (h < 120) [r1, g1, b1] = [x, c, 0];
  else if (h < 180) [r1, g1, b1] = [0, c, x];
  else if (h < 240) [r1, g1, b1] = [0, x, c];
  else if (h < 300) [r1, g1, b1] = [x, 0, c];
  else [r1, g1, b1] = [c, 0, x];
  return [
    Math.round((r1 + m) * 255),
    Math.round((g1 + m) * 255),
    Math.round((b1 + m) * 255),
  ];
}

export function resetSubstrate(): void {
  cracks = [];
  angleGrid = null;
  if (pg) {
    pg.remove();
    pg = null;
  }
  gW = 0;
  gH = 0;
  lastBeatIndex = -1;
  hueShift = 0;
  gridClearTimer = 0;
}

export function drawSubstrate(p: P5Instance, dt: number): void {
  const W = p.width;
  const H = p.height;
  const newGW = Math.ceil(W / SCALE);
  const newGH = Math.ceil(H / SCALE);

  if (!pg || gW !== newGW || gH !== newGH) {
    if (pg) pg.remove();
    pg = (p as any).createGraphics(newGW, newGH);
    pg.pixelDensity(1);
    pg.background(12, 12, 18);
    angleGrid = new Int16Array(newGW * newGH).fill(-1);
    gW = newGW;
    gH = newGH;
    cracks = [];
    lastBeatIndex = -1;
    for (let i = 0; i < 3; i++) seedCrack(i % BAND_COUNT);
  }

  const { amps } = getBandAverages(BAND_COUNT);
  const config = store.config;
  const state = store.state;

  const density = config.substrateDensity;
  const speed = config.substrateSpeed;
  const fade = config.substrateFade;

  let totalAmp = 0;
  for (let i = 0; i < BAND_COUNT; i++) totalAmp += amps[i];
  totalAmp /= BAND_COUNT;

  let beat = false;
  if (state.detectedBPM > 0 && state.isPlaying && state.beatIntervalSec > 0) {
    const pos = audioEngine.getPlaybackPosition();
    const beatIdx =
      pos - state.beatOffset >= 0
        ? Math.floor((pos - state.beatOffset) / state.beatIntervalSec)
        : -1;
    if (beatIdx >= 0 && beatIdx !== lastBeatIndex) {
      beat = true;
      hueShift = (hueShift + 30) % 360;
    }
    lastBeatIndex = beatIdx;
  }

  // Fade background
  const fadeAlpha = (1 - fade) * 14 + 1;
  pg.noStroke();
  pg.fill(12, 12, 18, fadeAlpha);
  pg.rect(0, 0, gW, gH);

  // Periodically clear angle grid cells so new cracks can grow in faded areas
  gridClearTimer += dt;
  if (gridClearTimer > 2) {
    gridClearTimer = 0;
    const clearRate = (1 - fade) * 0.08 + 0.005;
    const clearCount = Math.floor(gW * gH * clearRate);
    for (let i = 0; i < clearCount; i++) {
      angleGrid![Math.floor(Math.random() * gW * gH)] = -1;
    }
  }

  // Growth steps
  const baseSteps = 1 + speed * 5;
  const ampBoost = 1 + totalAmp * 2.5;
  const stepsPerFrame = Math.max(1, Math.round(baseSteps * ampBoost * dt));

  // Max active cracks
  const maxCracks = Math.floor(MAX_CRACKS * (0.25 + density * 0.75));

  // Advance cracks
  for (const crack of cracks) {
    if (!crack.alive) continue;

    for (let s = 0; s < stepsPerFrame; s++) {
      const nx = Math.round(crack.x + crack.dx);
      const ny = Math.round(crack.y + crack.dy);

      if (nx < 0 || nx >= gW || ny < 0 || ny >= gH) {
        crack.alive = false;
        break;
      }

      const nIdx = ny * gW + nx;
      if (angleGrid![nIdx] >= 0) {
        crack.alive = false;
        break;
      }

      angleGrid![nIdx] = crack.angleDeg;
      crack.x = nx;
      crack.y = ny;

      const hue = (BAND_HUES[crack.band] + hueShift) % 360;
      const bandAmp = amps[crack.band];
      const bri = 55 + bandAmp * 45;

      // Outer glow
      const [gr, gg, gb] = hsbToRgb(hue, 40, bri * 0.5);
      pg.stroke(gr, gg, gb, 50);
      pg.strokeWeight(2.5);
      pg.point(nx, ny);

      // Core crack line
      const [cr, cg, cb] = hsbToRgb(hue, 65, bri);
      pg.stroke(cr, cg, cb, 200);
      pg.strokeWeight(1);
      pg.point(nx, ny);

      // Sand deposition
      if (Math.random() < 0.4) {
        depositSand(nx, ny, crack, hue, bandAmp);
      }
    }
  }

  // Remove dead cracks
  cracks = cracks.filter((c) => c.alive);

  // Beat burst
  if (beat) {
    const burstCount = Math.floor(4 + density * 12);
    for (let i = 0; i < burstCount; i++) {
      const band = pickWeightedBand(amps);
      if (!spawnFromExisting(band)) seedCrack(band);
    }
  }

  // Continuous spawning
  while (cracks.length < maxCracks) {
    const band = pickWeightedBand(amps);
    if (!spawnFromExisting(band)) {
      if (!seedCrack(band)) break;
    }
  }

  p.image(pg as unknown as P5Image, 0, 0, W, H);
}

function depositSand(
  x: number,
  y: number,
  crack: Crack,
  hue: number,
  amp: number,
): void {
  if (!pg || !angleGrid) return;
  const perpDx = -crack.dy;
  const perpDy = crack.dx;
  const side = Math.random() < 0.5 ? 1 : -1;
  const reach = Math.floor(SAND_REACH * (0.3 + amp * 0.7));

  for (let d = 1; d <= reach; d++) {
    const sx = Math.round(x + perpDx * d * side);
    const sy = Math.round(y + perpDy * d * side);
    if (sx < 0 || sx >= gW || sy < 0 || sy >= gH) break;
    if (d > 1 && angleGrid[sy * gW + sx] >= 0) break;

    const alpha = Math.max(3, 28 - d * 1.8);
    const sat = 20 + d * 2.5;
    const bri = 55 + amp * 30;
    const [sr, sg, sb] = hsbToRgb(hue, sat, bri);
    pg.stroke(sr, sg, sb, alpha);
    pg.strokeWeight(1);
    pg.point(sx, sy);
  }
}
