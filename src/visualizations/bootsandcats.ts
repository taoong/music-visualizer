/**
 * Boots and Cats visualization — audio-reactive emojis with 3D perspective effect
 * 👢 for kicks (sub/bass), 🐱 for snares (low-mid/mid), ➕ for hihats (upper-mid/presence/brilliance)
 * Emojis spawn big at center and fly outward while shrinking, simulating depth
 *
 * Detection: uses spectral-shape classification — detect onset via deltaValues,
 * then classify by which frequency region (low/mid/high) dominates in smoothedBands.
 */
import { store } from '../state/store';

interface FallingEmoji {
  emoji: string;
  x: number;
  y: number;
  targetX: number;
  targetY: number;
  startSize: number;
  progress: number;
  opacity: number;
  rotation: number;
  rotationSpeed: number;
  spawnTime: number;
}

const MAX_EMOJIS = 50;
const GLOBAL_COOLDOWN_MS = 250;
const FLIGHT_DURATION_MS = 900;
const START_SIZE_MIN = 180;
const START_SIZE_MAX = 260;
const END_SIZE = 10;
const ONSET_THRESHOLD = 0.15;

let emojis: FallingEmoji[] = [];
let prevTotalDelta = 0;
let lastSpawnTime = 0;

/** Compute average amplitude across all spikes in a band */
function bandAvg(bandIdx: number): number {
  const bins = store.audioState.smoothedBands[bandIdx];
  let sum = 0;
  for (let i = 0; i < bins.length; i++) sum += bins[i];
  return sum / bins.length;
}

function spawnEmoji(emoji: string, totalEnergy: number, p: P5Instance): void {
  if (emojis.length >= MAX_EMOJIS) {
    emojis.shift();
  }

  const cx = p.width / 2;
  const cy = p.height / 2;

  const angle = Math.random() * Math.PI * 2;
  const dist = Math.max(p.width, p.height) * 0.9;
  const targetX = cx + Math.cos(angle) * dist;
  const targetY = cy + Math.sin(angle) * dist;

  const sizeFactor = Math.min(totalEnergy * 2, 1);
  const startSize = START_SIZE_MIN + sizeFactor * (START_SIZE_MAX - START_SIZE_MIN);

  emojis.push({
    emoji,
    x: cx,
    y: cy,
    targetX,
    targetY,
    startSize,
    progress: 0,
    opacity: 255,
    rotation: 0,
    rotationSpeed: (Math.random() - 0.5) * 0.15,
    spawnTime: performance.now(),
  });
}

export function drawBootsAndCats(p: P5Instance, dt: number): void {
  const { audioState } = store;
  const now = performance.now();
  const dv = audioState.deltaValues;

  // Sum all band deltas to detect any onset
  let totalDelta = 0;
  for (let b = 0; b < 7; b++) totalDelta += dv[b];

  // Rising-edge onset detection on total delta
  const onsetFired = totalDelta > ONSET_THRESHOLD && prevTotalDelta <= ONSET_THRESHOLD;
  prevTotalDelta = totalDelta;

  if (onsetFired && now - lastSpawnTime > GLOBAL_COOLDOWN_MS) {
    // Classify by spectral shape: which frequency region dominates?
    const lowEnergy = bandAvg(0) + bandAvg(1);           // Sub + Bass
    const midEnergy = bandAvg(2) + bandAvg(3);           // Low-Mid + Mid
    const highEnergy = bandAvg(4) + bandAvg(5) + bandAvg(6); // Upper-Mid + Presence + Brilliance
    const totalEnergy = lowEnergy + midEnergy + highEnergy;

    if (totalEnergy > 0) {
      let emoji: string;
      if (lowEnergy >= midEnergy && lowEnergy >= highEnergy) {
        emoji = '👢';
      } else if (highEnergy >= midEnergy) {
        emoji = '➕';
      } else {
        emoji = '🐱';
      }

      spawnEmoji(emoji, totalEnergy, p);
      lastSpawnTime = now;
    }
  }

  // Remove completed emojis (reverse loop for safe splice)
  for (let i = emojis.length - 1; i >= 0; i--) {
    const elapsed = now - emojis[i].spawnTime;
    if (elapsed >= FLIGHT_DURATION_MS) {
      emojis.splice(i, 1);
    }
  }

  // Draw oldest first so newest appears on top
  p.textAlign(p['CENTER'], p['CENTER']);

  for (let i = 0; i < emojis.length; i++) {
    const e = emojis[i];

    // Advance progress
    const elapsed = now - e.spawnTime;
    e.progress = Math.min(elapsed / FLIGHT_DURATION_MS, 1);

    // Configurable ease-in: slider left = explosive, slider right = gentle
    const accelKnob = store.config.bootsAcceleration;
    const exponent = 5 - accelKnob * 3.5;
    const eased = Math.pow(e.progress, exponent);

    // Interpolate position
    const cx = p.width / 2;
    const cy = p.height / 2;
    e.x = cx + (e.targetX - cx) * eased;
    e.y = cy + (e.targetY - cy) * eased;

    // Interpolate size (large → small)
    const size = e.startSize + (END_SIZE - e.startSize) * eased;

    // Rotation
    e.rotation += e.rotationSpeed * dt;

    // Opacity: full until 70% progress, then fade out
    if (e.progress > 0.7) {
      e.opacity = 255 * (1 - (e.progress - 0.7) / 0.3);
    } else {
      e.opacity = 255;
    }

    const alpha = Math.round(e.opacity);

    // Spawn flash: soft radial glow
    if (e.progress < 0.15) {
      p.push();
      p.noStroke();
      const flashBase = (1 - e.progress / 0.15) * 30;
      const radius = size * 0.9;
      const rings = 30;
      for (let r = rings; r >= 1; r--) {
        const t = r / rings;
        const ringAlpha = flashBase * (1 - t) * (1 - t);
        (p as any).fill(255, 255, 255, ringAlpha);
        const d = radius * 2 * t;
        p.ellipse(e.x, e.y, d, d);
      }
      p.pop();
    }

    // Draw emoji
    p.push();
    p.translate(e.x, e.y);
    p.rotate(e.rotation);
    p.textSize(size);
    (p as any).fill(255, 255, 255, alpha);
    p.noStroke();
    p.text(e.emoji, 0, 0);
    p.pop();
  }

  // Draw labels at bottom
  p.push();
  p.textSize(14);
  (p as any).fill(255, 255, 255, 80);
  p.textAlign(p['CENTER'], p['CENTER']);
  p.text('👢 kicks  ·  🐱 snares  ·  ➕ hihats', p.width / 2, p.height - 20);
  p.pop();
}

export function resetBootsAndCats(): void {
  emojis = [];
  prevTotalDelta = 0;
  lastSpawnTime = 0;
}
