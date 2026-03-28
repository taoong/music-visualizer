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
const FLIGHT_DURATION_MS = 900;
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
  // If multiple groups fire and no clear winner (within 20% of each other), spawn cat
  if (now - lastSpawnTime > GLOBAL_COOLDOWN_MS) {
    const fired: { emoji: string; intensity: number }[] = [];
    if (bootFired) fired.push({ emoji: '👢', intensity: bootIntensity });
    if (catFired) fired.push({ emoji: '🐱', intensity: catIntensity });
    if (plusFired) fired.push({ emoji: '➕', intensity: plusIntensity });

    if (fired.length > 0) {
      fired.sort((a, b) => b.intensity - a.intensity);
      const best = fired[0];

      // If 2+ groups fired and the top two are close, it's a broad hit → cat
      const noClearWinner = fired.length >= 2
        && fired[1].intensity / best.intensity > 0.8;

      if (noClearWinner) {
        spawnEmoji('🐱', best.intensity, p);
      } else {
        spawnEmoji(best.emoji, best.intensity, p);
      }
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
  prevBoot = 0;
  prevCat = 0;
  prevPlus = 0;
  lastSpawnTime = 0;
}
