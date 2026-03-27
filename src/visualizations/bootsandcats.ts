/**
 * Boots and Cats visualization — audio-reactive emojis with 3D perspective effect
 * 👢 for kicks (sub/bass), 🐱 for snares (low-mid/mid), ➕ for hihats (upper-mid/presence/brilliance)
 * Emojis spawn big at center and fly outward while shrinking, simulating depth
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
const TRANSIENT_THRESHOLD = 1.4;
const FLIGHT_DURATION_MS = 1800;
const START_SIZE_MIN = 180;
const START_SIZE_MAX = 260;
const END_SIZE = 10;

let emojis: FallingEmoji[] = [];
let prevBoot = 0;
let prevCat = 0;
let prevPlus = 0;
let lastSpawnTime = 0;

function spawnEmoji(emoji: string, intensity: number, p: P5Instance): void {
  if (emojis.length >= MAX_EMOJIS) {
    emojis.shift();
  }

  const cx = p.width / 2;
  const cy = p.height / 2;

  // Random angle for flight direction
  const angle = Math.random() * Math.PI * 2;
  // Distance well beyond screen edge
  const dist = Math.max(p.width, p.height) * 0.9;
  const targetX = cx + Math.cos(angle) * dist;
  const targetY = cy + Math.sin(angle) * dist;

  const sizeFactor = Math.min((intensity - TRANSIENT_THRESHOLD) / 1.5, 1);
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

  // Check transients and spawn emojis
  const tv = audioState.transientValues;

  const bootIntensity = Math.max(tv[0], tv[1]);
  const catIntensity = Math.max(tv[2], tv[3]);
  const plusIntensity = Math.max(tv[4], tv[5], tv[6]);

  // Rising-edge detection: only trigger on upward threshold crossing
  const bootFired = bootIntensity > TRANSIENT_THRESHOLD && prevBoot <= TRANSIENT_THRESHOLD;
  const catFired = catIntensity > TRANSIENT_THRESHOLD && prevCat <= TRANSIENT_THRESHOLD;
  const plusFired = plusIntensity > TRANSIENT_THRESHOLD && prevPlus <= TRANSIENT_THRESHOLD;

  prevBoot = bootIntensity;
  prevCat = catIntensity;
  prevPlus = plusIntensity;

  // Winner-takes-all + global cooldown
  if (now - lastSpawnTime > GLOBAL_COOLDOWN_MS) {
    let bestEmoji: string | null = null;
    let bestIntensity = 0;
    if (bootFired && bootIntensity > bestIntensity) { bestEmoji = '👢'; bestIntensity = bootIntensity; }
    if (catFired && catIntensity > bestIntensity) { bestEmoji = '🐱'; bestIntensity = catIntensity; }
    if (plusFired && plusIntensity > bestIntensity) { bestEmoji = '➕'; bestIntensity = plusIntensity; }

    if (bestEmoji) {
      spawnEmoji(bestEmoji, bestIntensity, p);
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

    // Configurable ease-in: higher exponent = more aggressive acceleration
    // Slider 0→1 maps to exponent 1.5→5 (gentle drift → explosive launch)
    const accelKnob = store.config.bootsAcceleration;
    const exponent = 1.5 + accelKnob * 3.5;
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

    // Spawn flash at center
    if (e.progress < 0.15) {
      p.push();
      p.noStroke();
      const flashAlpha = Math.round((1 - e.progress / 0.15) * 150);
      (p as any).fill(255, 255, 255, flashAlpha);
      p.ellipse(e.x, e.y, size * 1.8, size * 1.8);
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
  prevBoot = 0;
  prevCat = 0;
  prevPlus = 0;
  lastSpawnTime = 0;
}
