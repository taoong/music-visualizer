/**
 * Boots and Cats visualization — audio-reactive emojis with 3D perspective effect
 * 👢 for kicks (sub/bass), 🐱 for snares (low-mid/mid), ➕ for hihats (upper-mid/presence/brilliance)
 * Emojis spawn big at center and fly outward while shrinking, simulating depth
 *
 * Detection: reads raw FFT directly and does its own onset detection with fast release,
 * bypassing the shared smoothedBands/deltaValues pipeline for responsive triggering.
 */
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';

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

// Spawn/flight constants (unchanged)
const MAX_EMOJIS = 50;
const FLIGHT_DURATION_MS = 900;
const START_SIZE_MIN = 180;
const START_SIZE_MAX = 260;
const END_SIZE = 10;

// Onset detection constants
const ONSET_RATIO = 1.8;        // spike must be 80% above running average
const MIN_ENERGY = 0.01;        // ignore silence/noise floor
const AVG_ATTACK = 0.3;         // running average rises fast
const AVG_RELEASE = 0.25;       // running average falls fast (~130ms recovery)
const GLOBAL_COOLDOWN_MS = 60;  // minimum ms between spawns

let emojis: FallingEmoji[] = [];
let lastSpawnTime = 0;

// Per-group running averages for onset detection
let lowAvg = 0;
let midAvg = 0;
let highAvg = 0;

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
  const now = performance.now();

  // ── Step 1: Read raw FFT and compute 3 energy groups ──
  const fft = audioEngine.getFreqFFT();
  let lowEnergy = 0;
  let midEnergy = 0;
  let highEnergy = 0;

  if (fft) {
    const vals = fft.getValue();
    const sampleRate = Tone.context.sampleRate;
    const fftSize = vals.length * 2;
    const binHz = sampleRate / fftSize;

    // Frequency group boundaries (matching the 7-band definitions)
    // Low: 20-250 Hz (Sub + Bass)
    // Mid: 250-2000 Hz (Low-Mid + Mid)
    // High: 2000-20000 Hz (Upper-Mid + Presence + Brilliance)
    const lowLoBin = Math.max(1, Math.floor(20 / binHz));
    const lowHiBin = Math.min(vals.length - 1, Math.ceil(250 / binHz));
    const midLoBin = Math.max(1, Math.floor(250 / binHz));
    const midHiBin = Math.min(vals.length - 1, Math.ceil(2000 / binHz));
    const highLoBin = Math.max(1, Math.floor(2000 / binHz));
    const highHiBin = Math.min(vals.length - 1, Math.ceil(20000 / binHz));

    let lowSum = 0, lowCount = 0;
    for (let i = lowLoBin; i <= lowHiBin; i++) {
      lowSum += Math.pow(10, vals[i] / 20);
      lowCount++;
    }
    lowEnergy = lowCount > 0 ? lowSum / lowCount : 0;

    let midSum = 0, midCount = 0;
    for (let i = midLoBin; i <= midHiBin; i++) {
      midSum += Math.pow(10, vals[i] / 20);
      midCount++;
    }
    midEnergy = midCount > 0 ? midSum / midCount : 0;

    let highSum = 0, highCount = 0;
    for (let i = highLoBin; i <= highHiBin; i++) {
      highSum += Math.pow(10, vals[i] / 20);
      highCount++;
    }
    highEnergy = highCount > 0 ? highSum / highCount : 0;
  }

  // ── Step 2: Update per-group running averages with fast attack/release ──
  const lowAlpha = lowEnergy > lowAvg ? AVG_ATTACK : AVG_RELEASE;
  lowAvg += (lowEnergy - lowAvg) * lowAlpha;

  const midAlpha = midEnergy > midAvg ? AVG_ATTACK : AVG_RELEASE;
  midAvg += (midEnergy - midAvg) * midAlpha;

  const highAlpha = highEnergy > highAvg ? AVG_ATTACK : AVG_RELEASE;
  highAvg += (highEnergy - highAvg) * highAlpha;

  // ── Step 3: Detect onset per group ──
  const lowOnset = lowEnergy > lowAvg * ONSET_RATIO && lowAvg > MIN_ENERGY;
  const midOnset = midEnergy > midAvg * ONSET_RATIO && midAvg > MIN_ENERGY;
  const highOnset = highEnergy > highAvg * ONSET_RATIO && highAvg > MIN_ENERGY;

  // ── Step 4: Classify by strongest onset group ──
  if ((lowOnset || midOnset || highOnset) && now - lastSpawnTime > GLOBAL_COOLDOWN_MS) {
    const lowStrength = lowOnset && lowAvg > 0 ? lowEnergy / lowAvg : 0;
    const midStrength = midOnset && midAvg > 0 ? midEnergy / midAvg : 0;
    const highStrength = highOnset && highAvg > 0 ? highEnergy / highAvg : 0;

    let emoji: string;
    if (lowStrength >= midStrength && lowStrength >= highStrength) {
      emoji = '👢';
    } else if (highStrength >= midStrength) {
      emoji = '➕';
    } else {
      emoji = '🐱';
    }

    // ── Step 5: Size based on total energy ──
    const totalEnergy = lowEnergy + midEnergy + highEnergy;
    spawnEmoji(emoji, totalEnergy, p);
    lastSpawnTime = now;
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
  lastSpawnTime = 0;
  lowAvg = 0;
  midAvg = 0;
  highAvg = 0;
}
