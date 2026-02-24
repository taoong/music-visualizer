/**
 * Wormhole visualization — Guitar Hero/StepMania-style geometric objects flying toward viewer.
 * Events are pre-computed from the audio buffer so objects appear in the distance before arriving.
 */
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import type { WormholeEvent, ActiveObject } from '../types';

// Module-scoped state
let wormholeEvents: WormholeEvent[] = [];
let activeObjects: ActiveObject[] = [];
let timelineIdx = 0;
let tunnelAngle = 0;
let lastPlaybackPos = -1;
let screenFlash = 0;

// Perspective and timing constants
const FOCAL_LENGTH = 400;
const LOOKAHEAD_SEC = 2.5;
const Z_SPAWN = FOCAL_LENGTH * LOOKAHEAD_SEC; // 1000 world units
const STEP_PER_DT = Z_SPAWN / (LOOKAHEAD_SEC * 60); // ~6.67 units/frame at 60fps
const HIT_Z = 30;
const LANE_RADIUS = 0.6; // world-unit radius for lane circle

// Band visual properties
const BAND_HUES = [270, 30, 60, 120, 180, 240, 0]; // violet, orange, yellow, green, cyan, blue, white
const BAND_SHAPES = ['octagon', 'diamond', 'triangle', 'circle', 'pentagon', 'star', 'cross'];

/**
 * Analyze audio buffer and pre-compute event timeline.
 * Uses IIR bandpass filtering to detect amplitude spikes per frequency band.
 * O(N × 7), single-pass, memory-efficient.
 */
export function analyzeWormholeEvents(buffer: AudioBuffer): void {
  wormholeEvents = [];

  const sampleRate = buffer.sampleRate;
  const channelData = buffer.getChannelData(0);
  const hopSamples = Math.round(sampleRate * 0.01); // 10ms per hop

  // IIR LP filter cutoffs (Hz) for 7 frequency bands
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

    // Update IIR LP filters with samples in this hop
    for (let i = hopStart; i < hopEnd; i++) {
      const absSample = Math.abs(channelData[i]);
      for (let b = 0; b < NUM_BANDS; b++) {
        lpState[b] += alpha[b] * (absSample - lpState[b]);
      }
    }

    // Extract per-band energies (bandpass via LP subtraction)
    bandEnergy[0] = lpState[0];
    for (let b = 1; b < NUM_BANDS; b++) {
      bandEnergy[b] = Math.max(0, lpState[b] - lpState[b - 1]);
    }

    // Detect spikes relative to running average.
    // Asymmetric rates: slow attack (don't let peaks pull the average up),
    // fast release (quickly track back to the quiet floor between beats).
    // This prevents the average from converging to the kick level over time,
    // which would cause consistent periodic events to stop being detected.
    const hopTime = hopStart / sampleRate;
    for (let b = 0; b < NUM_BANDS; b++) {
      const avgRate = bandEnergy[b] > runningAvg[b] ? 0.003 : 0.02;
      runningAvg[b] += avgRate * (bandEnergy[b] - runningAvg[b]);
      if (runningAvg[b] > 0 && bandEnergy[b] / runningAvg[b] > 1.8) {
        const ratio = bandEnergy[b] / runningAvg[b];
        wormholeEvents.push({
          time: hopTime,
          band: b,
          magnitude: Math.min((ratio - 1.8) / 4, 1),
        });
      }
    }
  }

  wormholeEvents.sort((a, b) => a.time - b.time);
}

/**
 * Reset wormhole playback state. Call on track load, seek, and window resize.
 * Does not clear wormholeEvents (those persist for the track lifecycle).
 */
export function resetWormhole(): void {
  activeObjects = [];
  timelineIdx = 0;
  tunnelAngle = 0;
  lastPlaybackPos = -1;
  screenFlash = 0;
}

/**
 * Binary search: first index where event.time >= target
 */
function lowerBound(events: WormholeEvent[], target: number): number {
  let lo = 0,
    hi = events.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (events[mid].time < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Draw a band-specific shape centered at (0,0).
 * Assumes p5 translate has been applied; caller sets stroke/fill before calling.
 */
function drawShape(p: P5Instance, shape: string, radius: number): void {
  switch (shape) {
    case 'octagon': {
      p.beginShape();
      for (let i = 0; i < 8; i++) {
        const angle = (i / 8) * Math.PI * 2 - Math.PI / 8;
        p.vertex(Math.cos(angle) * radius, Math.sin(angle) * radius);
      }
      p.endShape(p['CLOSE']);
      // Inner octagon ring (no fill)
      p.noFill();
      p.beginShape();
      for (let i = 0; i < 8; i++) {
        const angle = (i / 8) * Math.PI * 2 - Math.PI / 8;
        p.vertex(Math.cos(angle) * radius * 0.6, Math.sin(angle) * radius * 0.6);
      }
      p.endShape(p['CLOSE']);
      break;
    }
    case 'diamond': {
      p.beginShape();
      p.vertex(0, -radius);
      p.vertex(radius * 0.6, 0);
      p.vertex(0, radius);
      p.vertex(-radius * 0.6, 0);
      p.endShape(p['CLOSE']);
      break;
    }
    case 'triangle': {
      p.beginShape();
      for (let i = 0; i < 3; i++) {
        const angle = (i / 3) * Math.PI * 2 - Math.PI / 2;
        p.vertex(Math.cos(angle) * radius, Math.sin(angle) * radius);
      }
      p.endShape(p['CLOSE']);
      break;
    }
    case 'circle': {
      p.ellipse(0, 0, radius * 2, radius * 2);
      break;
    }
    case 'pentagon': {
      p.beginShape();
      for (let i = 0; i < 5; i++) {
        const angle = (i / 5) * Math.PI * 2 - Math.PI / 2;
        p.vertex(Math.cos(angle) * radius, Math.sin(angle) * radius);
      }
      p.endShape(p['CLOSE']);
      break;
    }
    case 'star': {
      p.beginShape();
      for (let i = 0; i < 10; i++) {
        const angle = (i / 10) * Math.PI * 2 - Math.PI / 2;
        const r = i % 2 === 0 ? radius : radius * 0.45;
        p.vertex(Math.cos(angle) * r, Math.sin(angle) * r);
      }
      p.endShape(p['CLOSE']);
      break;
    }
    case 'cross': {
      const w = radius * 0.35;
      p.beginShape();
      p.vertex(-w, -radius);
      p.vertex(w, -radius);
      p.vertex(w, -w);
      p.vertex(radius, -w);
      p.vertex(radius, w);
      p.vertex(w, w);
      p.vertex(w, radius);
      p.vertex(-w, radius);
      p.vertex(-w, w);
      p.vertex(-radius, w);
      p.vertex(-radius, -w);
      p.vertex(-w, -w);
      p.endShape(p['CLOSE']);
      break;
    }
    default:
      break;
  }
}

export function drawWormhole(p: P5Instance, dt: number): void {
  const { state, config } = store;
  const cx = p.width / 2;
  const cy = p.height / 2;
  const minDim = Math.min(p.width, p.height);
  const W = minDim * 0.35; // world-unit → pixels scale at the focal plane

  // Band amplitude data for reactivity
  const { amps } = getBandAverages(7);
  const bassAmp = amps[1] || 0;

  const pos = audioEngine.getPlaybackPosition();

  // --- Seek detection: large jump in position means user seeked ---
  if (Math.abs(pos - lastPlaybackPos) > 0.5) {
    activeObjects = [];
    timelineIdx = lowerBound(wormholeEvents, pos - LOOKAHEAD_SEC);
  }
  lastPlaybackPos = pos;

  // --- Spawn new objects (only while playing) ---
  // spawnThreshold filters to only the strongest amplitude peaks.
  // Ceiling is 1.2 so intensity=0 truly spawns nothing (magnitude max is 1.0).
  // intensity=0 → 1.2 (nothing); intensity=1.0 → 0.85; intensity=2.0 → 0.5 (most events)
  const spawnThreshold = 1.2 - (config.intensity / 2) * 0.7;

  if (state.isPlaying) {
    while (
      timelineIdx < wormholeEvents.length &&
      wormholeEvents[timelineIdx].time <= pos + LOOKAHEAD_SEC
    ) {
      const ev = wormholeEvents[timelineIdx];
      // Only spawn events that haven't passed yet and clear the magnitude threshold
      if (ev.time >= pos && ev.magnitude >= spawnThreshold) {
        const timeUntilHit = ev.time - pos;
        // Place at z proportional to time-until-hit for correct initial position
        const zInitial = Math.max(HIT_Z + 1, (timeUntilHit / LOOKAHEAD_SEC) * Z_SPAWN);
        const laneAngle = (ev.band / 7) * Math.PI * 2;
        activeObjects.push({
          band: ev.band,
          hitTime: ev.time,
          z: zInitial,
          worldX: Math.cos(laneAngle) * LANE_RADIUS,
          worldY: Math.sin(laneAngle) * LANE_RADIUS,
          magnitude: ev.magnitude,
          hitFlash: 0,
          expired: false,
        });
      }
      timelineIdx++;
    }
  }

  // --- Advance objects and detect hits (only while playing) ---
  if (state.isPlaying) {
    for (const obj of activeObjects) {
      obj.z -= STEP_PER_DT * dt;
      if (obj.z <= HIT_Z && obj.hitFlash === 0) {
        obj.hitFlash = obj.magnitude;
        // Screen flash only for sub-bass (band 0) and bass (band 1) hits
        if (obj.band <= 1) {
          screenFlash = Math.min(1, screenFlash + obj.magnitude * 0.4);
        }
      }
      obj.hitFlash *= Math.pow(0.88, dt);
      if (obj.z < -50 && obj.hitFlash < 0.01) {
        obj.expired = true;
      }
    }
    activeObjects = activeObjects.filter(o => !o.expired);
  }

  // --- Update tunnel rotation (only while playing) ---
  if (state.isPlaying) {
    tunnelAngle += (0.003 + bassAmp * 0.01) * dt;
  }

  // Set HSB color mode with alpha channel (0–100 range)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (p as any).colorMode(p['HSB'], 360, 100, 100, 100);

  // --- Draw tunnel background rings (far-to-near, i=0 farthest) ---
  const bassPulse = bassAmp * minDim * 0.03;
  for (let i = 0; i < 16; i++) {
    const zDepth = (1 - i / 15) * Z_SPAWN * 0.95;
    const perspScale = FOCAL_LENGTH / (FOCAL_LENGTH + zDepth);
    const ringRadius = minDim * 0.45 * perspScale + bassPulse * perspScale;
    const sides = 6 + (i % 3);
    const hue = (tunnelAngle * 50 + i * 25) % 360;
    const brightness = 10 + (i / 15) * 55;
    const alpha = 25 + (i / 15) * 40;
    const twistAngle = tunnelAngle * (1 + i * 0.04) + i * 0.18;

    p.noFill();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (p as any).stroke(hue, 70, brightness, alpha);
    p.strokeWeight(1);
    p.beginShape();
    for (let v = 0; v <= sides; v++) {
      const angle = (v / sides) * Math.PI * 2 + twistAngle;
      p.vertex(cx + Math.cos(angle) * ringRadius, cy + Math.sin(angle) * ringRadius);
    }
    p.endShape(p['CLOSE']);
  }

  // --- Draw objects sorted far-to-near (descending z) ---
  activeObjects.sort((a, b) => b.z - a.z);

  for (const obj of activeObjects) {
    if (obj.z <= 0) continue; // behind viewer

    const perspFactor = FOCAL_LENGTH / obj.z;
    const screenX = obj.worldX * W * perspFactor + cx;
    const screenY = obj.worldY * W * perspFactor + cy;
    const objRadius = (8 + obj.magnitude * 12) * perspFactor;
    if (objRadius < 0.5) continue; // too small to render

    const hue = BAND_HUES[obj.band];
    const shape = BAND_SHAPES[obj.band];
    const isWhite = obj.band === 6;

    // Alpha increases as object approaches; hit flash adds extra brightness
    const normalizedZ = obj.z / Z_SPAWN;
    const alphaBase = (1 - normalizedZ) * 85 + 15;
    const alpha = Math.min(100, alphaBase + obj.hitFlash * 90);
    const brightness = 55 + obj.hitFlash * 45;

    // Fill only when close enough to be impactful
    const hasFill = obj.z < FOCAL_LENGTH * 0.5;

    p.push();
    p.translate(screenX, screenY);
    p.strokeWeight(Math.max(1, 1.5 * perspFactor));

    if (isWhite) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (p as any).stroke(0, 0, 100, alpha);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (hasFill) (p as any).fill(0, 0, brightness, alpha * 0.55);
      else p.noFill();
    } else {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (p as any).stroke(hue, 80, 100, alpha);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (hasFill) (p as any).fill(hue, 70, brightness, alpha * 0.5);
      else p.noFill();
    }

    drawShape(p, shape, objRadius);
    p.pop();
  }

  // --- Screen flash overlay (drawn last, on top of everything) ---
  if (screenFlash > 0.01) {
    p.noStroke();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (p as any).fill(0, 0, 100, screenFlash * 35);
    p.rect(0, 0, p.width, p.height);
    if (state.isPlaying) {
      screenFlash *= Math.pow(0.82, dt);
    }
  }

  // Reset to RGB color mode
  p.colorMode(p['RGB'], 255);
  p.noStroke();
}
