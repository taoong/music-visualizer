/**
 * Space visualization — third-person space racing scene.
 * A neon-wireframe spaceship navigates an asteroid field; asteroids fly toward
 * the viewer in sync with the music.
 *
 * Audio events are pre-computed from the buffer using the same IIR bandpass
 * algorithm as the former wormhole visualization, then spawned with lookahead.
 */
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import type { WormholeEvent } from '../types';
import { isMobile } from '../utils/constants';

// ── Local types ─────────────────────────────────────────────────────────────

interface Asteroid {
  band: number;
  hitTime: number;
  z: number;
  worldX: number;
  worldY: number;
  magnitude: number;
  hitFlash: number;
  expired: boolean;
  rotAngle: number;
  rotSpeed: number;
  irregularity: Float32Array;
  numSides: number;
}

interface SpaceStar {
  x: number;  // normalized −1…1
  y: number;  // normalized −1…1
  z: number;  // 0…1  (0 = far, 1 = near)
}

// ── Module state ─────────────────────────────────────────────────────────────

let spaceEvents: WormholeEvent[] = [];
let asteroids: Asteroid[] = [];
let stars: SpaceStar[] = [];
let timelineIdx = 0;
let lastPlaybackPos = -1;
let screenFlash = 0;
let shipShake = 0;
let lastBeatIndex = -1;
let engineGlow = 0;
let initialized = false;

// ── Perspective constants (identical to former wormhole) ─────────────────────

const FOCAL_LENGTH = 400;
const LOOKAHEAD_SEC = 2.5;
const Z_SPAWN = FOCAL_LENGTH * LOOKAHEAD_SEC;         // 1000 world units
const STEP_PER_DT = Z_SPAWN / (LOOKAHEAD_SEC * 60);  // ~6.67 units/frame at 60fps
const HIT_Z = 30;

// ── Visual constants ─────────────────────────────────────────────────────────

const BAND_HUES = [270, 30, 60, 120, 180, 240, 0]; // violet, orange, yellow, green, cyan, blue, white
const STAR_COUNT_FULL = 180;
const STAR_COUNT_MOBILE = 90;

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Binary search: first index where event.time >= target
 */
function lowerBound(events: WormholeEvent[], target: number): number {
  let lo = 0, hi = events.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (events[mid].time < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function initSpace(): void {
  const starCount = isMobile ? STAR_COUNT_MOBILE : STAR_COUNT_FULL;
  stars = Array.from({ length: starCount }, () => ({
    x: Math.random() * 2 - 1,
    y: Math.random() * 2 - 1,
    z: Math.random(),
  }));
  initialized = true;
}

/**
 * Draw a single asteroid (spinning irregular polygon with crater detail).
 * Assumes p5 translate has been applied to asteroid screen center.
 */
function drawAsteroid(p: P5Instance, asteroid: Asteroid, radius: number, hue: number, alpha: number, brightness: number): void {
  const { numSides, irregularity, rotAngle } = asteroid;

  // Outer hull
  p.beginShape();
  for (let i = 0; i < numSides; i++) {
    const angle = rotAngle + (i / numSides) * Math.PI * 2;
    const r = radius * irregularity[i];
    p.vertex(Math.cos(angle) * r, Math.sin(angle) * r);
  }
  p.endShape(p['CLOSE']);

  // Crater (smaller irregular polygon, no fill)
  p.noFill();
  const craterRadius = radius * 0.45;
  p.beginShape();
  for (let i = 0; i < numSides; i++) {
    const angle = rotAngle + Math.PI / numSides + (i / numSides) * Math.PI * 2;
    const r = craterRadius * irregularity[(i + 2) % numSides];
    p.vertex(Math.cos(angle) * r, Math.sin(angle) * r);
  }
  p.endShape(p['CLOSE']);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (hue === 0) (p as any).stroke(0, 0, 100, alpha); // white band
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  else (p as any).stroke(hue, 80, 100, alpha);
  void brightness; // used by caller for fill
}

/**
 * Draw the neon-wireframe spaceship centered at (0, 0).
 * S = minDim * 0.075
 */
function drawShip(p: P5Instance, S: number, glowAmp: number): void {
  const glowH = S * 0.4 * glowAmp;

  // Hull body (pointed-nose hexagon, mirrored)
  p.beginShape();
  p.vertex(0, -S * 2.0);           // nose
  p.vertex(-S * 0.65, -S * 1.0);  // top-left
  p.vertex(-S * 0.75, S * 0.9);   // bot-left
  p.vertex(0, S * 1.2);            // bottom
  p.vertex(S * 0.75, S * 0.9);    // bot-right
  p.vertex(S * 0.65, -S * 1.0);   // top-right
  p.endShape(p['CLOSE']);

  // Left wing
  p.beginShape();
  p.vertex(-S * 0.75, -S * 0.2);
  p.vertex(-S * 2.4, S * 0.6);
  p.vertex(-S * 0.9, S * 1.0);
  p.endShape(p['CLOSE']);

  // Right wing
  p.beginShape();
  p.vertex(S * 0.75, -S * 0.2);
  p.vertex(S * 2.4, S * 0.6);
  p.vertex(S * 0.9, S * 1.0);
  p.endShape(p['CLOSE']);

  // Cockpit
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (p as any).fill(180, 60, 70, 70);
  p.ellipse(0, -S * 1.3, S * 0.55, S * 0.35);
  p.noFill();

  // Engine pods (orange glow driven by bassAmp)
  const podW = S * 0.45 + S * 0.25 * glowAmp;
  const podH = S * 0.28 + S * 0.15 * glowAmp;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (p as any).fill(30, 90, 90, 50 + 40 * glowAmp);
  p.ellipse(-S * 2.2, S * 0.65, podW, podH);
  p.ellipse(S * 2.2, S * 0.65, podW, podH);

  // Central engine
  const centH = S * 0.3 + glowH;
  const centW = S * 0.55 + S * 0.2 * glowAmp;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (p as any).fill(30, 100, 100, 60 + 35 * glowAmp);
  p.ellipse(0, S * 1.2 + glowH * 0.5, centW, centH);

  p.noFill();
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Analyze audio buffer and pre-compute event timeline for the space visualization.
 * Uses IIR bandpass filtering to detect amplitude spikes per frequency band.
 * O(N × 7), single-pass, memory-efficient.
 */
export function analyzeSpaceEvents(buffer: AudioBuffer): void {
  spaceEvents = [];

  const sampleRate = buffer.sampleRate;
  const channelData = buffer.getChannelData(0);
  const hopSamples = Math.round(sampleRate * 0.01); // 10 ms per hop

  const cutoffs = [60, 250, 500, 2000, 4000, 6000, 20000];
  const NUM_BANDS = cutoffs.length;
  const alpha = cutoffs.map(c => 1 - Math.exp((-2 * Math.PI * c) / sampleRate));

  const lpState = new Float32Array(NUM_BANDS);
  const bandEnergy = new Float32Array(NUM_BANDS);
  const runningAvg = new Float32Array(NUM_BANDS).fill(0.001);

  const totalHops = Math.floor(channelData.length / hopSamples);

  for (let hop = 0; hop < totalHops; hop++) {
    const hopStart = hop * hopSamples;
    const hopEnd = Math.min(hopStart + hopSamples, channelData.length);

    for (let i = hopStart; i < hopEnd; i++) {
      const absSample = Math.abs(channelData[i]);
      for (let b = 0; b < NUM_BANDS; b++) {
        lpState[b] += alpha[b] * (absSample - lpState[b]);
      }
    }

    bandEnergy[0] = lpState[0];
    for (let b = 1; b < NUM_BANDS; b++) {
      bandEnergy[b] = Math.max(0, lpState[b] - lpState[b - 1]);
    }

    const hopTime = hopStart / sampleRate;
    for (let b = 0; b < NUM_BANDS; b++) {
      // Asymmetric running average: slow attack, fast release
      const avgRate = bandEnergy[b] > runningAvg[b] ? 0.003 : 0.02;
      runningAvg[b] += avgRate * (bandEnergy[b] - runningAvg[b]);
      if (runningAvg[b] > 0 && bandEnergy[b] / runningAvg[b] > 1.8) {
        const ratio = bandEnergy[b] / runningAvg[b];
        spaceEvents.push({
          time: hopTime,
          band: b,
          magnitude: Math.min((ratio - 1.8) / 4, 1),
          spawnSeed: Math.random(),
        });
      }
    }
  }

  spaceEvents.sort((a, b) => a.time - b.time);
}

/**
 * Reset space playback state. Call on track load, seek, and window resize.
 * Does not clear spaceEvents (those persist for the track lifecycle).
 */
export function resetSpace(): void {
  asteroids = [];
  timelineIdx = 0;
  lastPlaybackPos = -1;
  screenFlash = 0;
  shipShake = 0;
  lastBeatIndex = -1;
  engineGlow = 0;
  initialized = false; // reinitialize stars on next draw (handles resize)
}

/**
 * Main draw function for the space visualization.
 */
export function drawSpace(p: P5Instance, dt: number): void {
  const { state, config } = store;
  const cx = p.width / 2;
  const cy = p.height / 2;
  const minDim = Math.min(p.width, p.height);
  const W = minDim * 0.35; // world-unit → pixels scale

  if (!initialized) initSpace();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (p as any).colorMode(p['HSB'], 360, 100, 100, 100);

  const { amps } = getBandAverages(7);
  const bassAmp = amps[1] || 0;
  const subAmp  = amps[0] || 0;

  const pos = audioEngine.getPlaybackPosition();

  // ── Seek detection ──────────────────────────────────────────────────────────
  if (Math.abs(pos - lastPlaybackPos) > 0.5) {
    asteroids = [];
    timelineIdx = lowerBound(spaceEvents, pos - LOOKAHEAD_SEC);
  }
  lastPlaybackPos = pos;

  // ── Spawn asteroids from event timeline ─────────────────────────────────────
  const densityFraction = config.intensity / 2;

  if (state.isPlaying) {
    while (
      timelineIdx < spaceEvents.length &&
      spaceEvents[timelineIdx].time <= pos + LOOKAHEAD_SEC
    ) {
      const ev = spaceEvents[timelineIdx];
      if (ev.time >= pos && ev.spawnSeed < densityFraction) {
        const timeUntilHit = ev.time - pos;
        const zInitial = Math.max(HIT_Z + 1, (timeUntilHit / LOOKAHEAD_SEC) * Z_SPAWN);
        const numSides = 7 + Math.floor(Math.random() * 5); // 7–11
        const irreg = new Float32Array(numSides);
        for (let i = 0; i < numSides; i++) irreg[i] = 0.65 + Math.random() * 0.7;

        asteroids.push({
          band: ev.band,
          hitTime: ev.time,
          z: zInitial,
          // Wide rectangular spawn layout (bias upward)
          worldX: Math.random() * 2.4 - 1.2,
          worldY: Math.random() * 1.4 - 0.9,
          magnitude: ev.magnitude,
          hitFlash: 0,
          expired: false,
          rotAngle: Math.random() * Math.PI * 2,
          rotSpeed: 0.01 + Math.random() * 0.03,
          irregularity: irreg,
          numSides,
        });
      }
      timelineIdx++;
    }
  }

  // ── Advance asteroids + detect hits ─────────────────────────────────────────
  if (state.isPlaying) {
    for (const ast of asteroids) {
      ast.z -= STEP_PER_DT * dt;
      ast.rotAngle += ast.rotSpeed * dt;
      if (ast.z <= HIT_Z && ast.hitFlash === 0) {
        ast.hitFlash = ast.magnitude;
        if (ast.band <= 1) {
          screenFlash = Math.min(1, screenFlash + ast.magnitude * 0.4);
          shipShake = Math.max(shipShake, 6 * (bassAmp + subAmp) * 0.5);
        }
      }
      ast.hitFlash *= Math.pow(0.88, dt);
      if (ast.z < -50 && ast.hitFlash < 0.01) ast.expired = true;
    }
    asteroids = asteroids.filter(a => !a.expired);
  }

  // ── Beat detection → ship shake ─────────────────────────────────────────────
  if (state.isPlaying && state.beatIntervalSec > 0) {
    const beatIdx = Math.floor((pos - state.beatOffset) / state.beatIntervalSec);
    if (beatIdx > lastBeatIndex) {
      lastBeatIndex = beatIdx;
      shipShake = Math.max(shipShake, 6 * bassAmp);
    }
  }

  // ── Engine glow smoothing ────────────────────────────────────────────────────
  engineGlow += (bassAmp - engineGlow) * Math.min(1, 0.15 * dt);

  // ── Draw starfield ───────────────────────────────────────────────────────────
  for (const star of stars) {
    // Parallax drift: near stars (high z) move faster
    if (state.isPlaying) {
      star.y += (0.0008 + star.z * 0.0012) * dt;
      if (star.y > 1) star.y -= 2;
    }
    const sx = cx + star.x * p.width * 0.5;
    const sy = cy + star.y * p.height * 0.5;
    const brightness = 30 + star.z * 70;
    const starSize = 1 + star.z * 1.5;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (p as any).stroke(200, 10, brightness, 80);
    p.strokeWeight(starSize);
    p.point(sx, sy);
  }

  // ── Draw asteroids (far → near) ──────────────────────────────────────────────
  asteroids.sort((a, b) => b.z - a.z);

  for (const ast of asteroids) {
    if (ast.z <= 0) continue;

    const perspFactor = FOCAL_LENGTH / ast.z;
    const screenX = ast.worldX * W * perspFactor + cx;
    const screenY = ast.worldY * W * perspFactor + cy;
    const baseRadius = (12 + ast.magnitude * 20) * perspFactor;
    if (baseRadius < 0.5) continue;

    const hue = BAND_HUES[ast.band];
    const normalizedZ = ast.z / Z_SPAWN;
    const alphaBase = (1 - normalizedZ) * 80 + 15;
    const alpha = Math.min(100, alphaBase + ast.hitFlash * 90);
    const brightness = 55 + ast.hitFlash * 45;
    const hasFill = ast.z < FOCAL_LENGTH * 0.5;

    p.push();
    p.translate(screenX, screenY);
    p.strokeWeight(Math.max(1, 1.5 * perspFactor));

    if (hue === 0) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (p as any).stroke(0, 0, 100, alpha);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (hasFill) (p as any).fill(0, 0, brightness, alpha * 0.45);
      else p.noFill();
    } else {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (p as any).stroke(hue, 80, 100, alpha);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (hasFill) (p as any).fill(hue, 70, brightness, alpha * 0.45);
      else p.noFill();
    }

    drawAsteroid(p, ast, baseRadius, hue, alpha, brightness);
    p.pop();
  }

  // ── Screen flash overlay ─────────────────────────────────────────────────────
  if (screenFlash > 0.01) {
    p.noStroke();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (p as any).fill(0, 0, 100, screenFlash * 35);
    p.rect(0, 0, p.width, p.height);
    if (state.isPlaying) screenFlash *= Math.pow(0.82, dt);
  }

  // ── Draw spaceship (always on top) ───────────────────────────────────────────
  const S = minDim * 0.075;
  const shipX = cx + (Math.random() - 0.5) * shipShake;
  const shipY = cy + minDim * 0.18 + (Math.random() - 0.5) * shipShake;

  p.push();
  p.translate(shipX, shipY);
  p.noFill();
  p.strokeWeight(1.5);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (p as any).stroke(200, 70, 80, 95); // hull: cyan-blue

  drawShip(p, S, engineGlow);
  p.pop();

  // ── Decay engine glow + shipShake ────────────────────────────────────────────
  shipShake *= Math.pow(0.85, dt);

  // Reset colorMode to RGB
  p.colorMode(p['RGB'], 255);
  p.noStroke();
}
