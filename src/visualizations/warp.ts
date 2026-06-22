import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { BAND_COUNT, isMobile } from '../utils/constants';

const MAX_STARS = isMobile ? 600 : 1200;
const MIN_STARS = 80;
const SPAWN_Z_MIN = 0.5;
const SPAWN_Z_MAX = 8.0;
const NEAR_CLIP = 0.01;

const BAND_HUES: readonly number[] = [270, 220, 180, 140, 50, 25, 340];

let sx: Float32Array;
let sy: Float32Array;
let sz: Float32Array;
let sBand: Uint8Array;
let sHue: Float32Array;
let starCount = 0;

let lastBeatIndex = -1;
let beatPulse = 0;
let hueShift = 0;
let warpBoost = 0;
let initialized = false;
let prevWidth = 0;
let prevHeight = 0;

let trailBuf: P5Graphics | null = null;
let trailW = 0;
let trailH = 0;

function spawnStar(i: number): void {
  const angle = Math.random() * Math.PI * 2;
  const radius = 0.05 + Math.random() * 0.95;
  sx[i] = Math.cos(angle) * radius;
  sy[i] = Math.sin(angle) * radius;
  sz[i] = SPAWN_Z_MIN + Math.random() * (SPAWN_Z_MAX - SPAWN_Z_MIN);
  sBand[i] = Math.floor(Math.random() * BAND_COUNT);
  sHue[i] = BAND_HUES[sBand[i]] + (Math.random() - 0.5) * 20;
}

function initStars(count: number): void {
  starCount = count;
  sx = new Float32Array(MAX_STARS);
  sy = new Float32Array(MAX_STARS);
  sz = new Float32Array(MAX_STARS);
  sBand = new Uint8Array(MAX_STARS);
  sHue = new Float32Array(MAX_STARS);

  for (let i = 0; i < starCount; i++) {
    spawnStar(i);
    sz[i] = NEAR_CLIP + Math.random() * (SPAWN_Z_MAX - NEAR_CLIP);
  }

  initialized = true;
}

function hsbToRgb(h: number, s: number, b: number): [number, number, number] {
  h = ((h % 360) + 360) % 360;
  s /= 100; b /= 100;
  const k = (n: number) => (n + h / 60) % 6;
  const f = (n: number) => b * (1 - s * Math.max(0, Math.min(1, Math.min(k(n), 4 - k(n)))));
  return [Math.round(f(5) * 255), Math.round(f(3) * 255), Math.round(f(1) * 255)];
}

export function drawWarp(p: P5Instance, dt: number): void {
  const { state, config } = store;
  const { amps } = getBandAverages(BAND_COUNT);

  const W = p.width;
  const H = p.height;
  const cx = W / 2;
  const cy = H / 2;
  const focalLen = Math.min(W, H) * 0.5;

  const targetCount = Math.round(MIN_STARS + config.warpDensity * (MAX_STARS - MIN_STARS));
  const baseSpeed = 0.02 + config.warpSpeed * 0.18;
  const trailAlpha = 8 + (1 - config.warpTrail) * 80;

  if (!initialized || prevWidth !== W || prevHeight !== H) {
    initStars(targetCount);
    trailBuf?.remove();
    trailBuf = null;
    prevWidth = W;
    prevHeight = H;
  }

  if (!trailBuf || trailW !== W || trailH !== H) {
    trailBuf?.remove();
    trailBuf = p.createGraphics(W, H);
    trailBuf.background(0);
    trailW = W;
    trailH = H;
  }

  if (targetCount > starCount && starCount < MAX_STARS) {
    const add = Math.min(targetCount - starCount, MAX_STARS - starCount);
    for (let i = starCount; i < starCount + add; i++) spawnStar(i);
    starCount += add;
  } else if (targetCount < starCount) {
    starCount = Math.max(MIN_STARS, targetCount);
  }

  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    const beatIdx = adjusted >= 0 ? Math.floor(adjusted / state.beatIntervalSec) : -1;
    if (beatIdx >= 0 && beatIdx !== lastBeatIndex) {
      lastBeatIndex = beatIdx;
      beatPulse = 1.0;
      warpBoost = 1.0;
      hueShift = (hueShift + 25) % 360;
    }
  }

  beatPulse *= Math.pow(0.88, dt);
  if (beatPulse < 0.001) beatPulse = 0;
  warpBoost *= Math.pow(0.92, dt);
  if (warpBoost < 0.001) warpBoost = 0;

  let energy = 0;
  for (let i = 0; i < BAND_COUNT; i++) energy += amps[i];
  energy /= BAND_COUNT;

  const speed = (baseSpeed + energy * 0.12 + warpBoost * 0.15) * dt;

  trailBuf.fill(0, 0, 0, trailAlpha);
  trailBuf.noStroke();
  trailBuf.rect(0, 0, W, H);

  for (let i = 0; i < starCount; i++) {
    const band = sBand[i];
    const bandAmp = amps[band];

    const prevZ = sz[i];
    const prevScreenX = cx + (sx[i] / prevZ) * focalLen;
    const prevScreenY = cy + (sy[i] / prevZ) * focalLen;

    sz[i] -= speed * (1 + bandAmp * 2.0);

    if (sz[i] <= NEAR_CLIP) {
      spawnStar(i);
      continue;
    }

    const screenX = cx + (sx[i] / sz[i]) * focalLen;
    const screenY = cy + (sy[i] / sz[i]) * focalLen;

    if (screenX < -50 || screenX > W + 50 || screenY < -50 || screenY > H + 50) {
      spawnStar(i);
      continue;
    }

    const depthFactor = 1 - sz[i] / SPAWN_Z_MAX;
    const brightness = Math.min(100, 30 + depthFactor * 60 + bandAmp * 30 + beatPulse * 15);
    const sat = 50 + bandAmp * 45 + beatPulse * 10;
    const h = (sHue[i] + hueShift) % 360;

    const [r, g, b] = hsbToRgb(h, Math.min(sat, 100), brightness);
    const alpha = Math.min(255, Math.round(40 + depthFactor * 180 + bandAmp * 50));

    const sw = Math.max(0.5, depthFactor * 2.5 + bandAmp * 1.5 + beatPulse * 1.0);
    trailBuf.strokeWeight(sw);
    trailBuf.stroke(r, g, b, alpha);
    trailBuf.line(prevScreenX, prevScreenY, screenX, screenY);

    if (depthFactor > 0.7) {
      const glowAlpha = Math.round((depthFactor - 0.7) * 3.3 * alpha * 0.3);
      trailBuf.strokeWeight(sw * 3);
      trailBuf.stroke(r, g, b, Math.min(glowAlpha, 120));
      trailBuf.line(prevScreenX, prevScreenY, screenX, screenY);
    }
  }

  if (beatPulse > 0.3) {
    trailBuf.noStroke();
    trailBuf.fill(255, 255, 255, Math.round(beatPulse * 25));
    trailBuf.rect(0, 0, W, H);
  }

  p.background(0);
  p.image(trailBuf as unknown as P5Image, 0, 0);
}

export function resetWarp(): void {
  initialized = false;
  lastBeatIndex = -1;
  beatPulse = 0;
  hueShift = 0;
  warpBoost = 0;
  starCount = 0;
  prevWidth = 0;
  prevHeight = 0;
  trailBuf?.remove();
  trailBuf = null;
  trailW = 0;
  trailH = 0;
}
