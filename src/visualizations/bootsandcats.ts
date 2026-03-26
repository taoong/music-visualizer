/**
 * Boots and Cats visualization — audio-reactive falling emojis with real 2D physics
 * 👢 for kicks (sub/bass), 🐱 for snares (low-mid/mid), ➕ for hihats (upper-mid/presence/brilliance)
 * Uses matter-js for rigid-body physics: gravity, collision, rotation, friction
 */
import Matter from 'matter-js';
import { store } from '../state/store';

interface FallingEmoji {
  emoji: string;
  body: Matter.Body;
  size: number;
  opacity: number;
  scale: number;
  spawnTime: number;
  settled: boolean;
  settledTime: number;
}

const MAX_EMOJIS = 50;
const GROUND_FRACTION = 0.85;
const FADE_DURATION = 2000;
const DEBOUNCE_MS = 120;
const TRANSIENT_THRESHOLD = 1.3;
const WALL_THICKNESS = 50;

let emojis: FallingEmoji[] = [];
let lastTrigger = { boot: 0, cat: 0, plus: 0 };
let engine: Matter.Engine | null = null;
let ground: Matter.Body | null = null;
let wallLeft: Matter.Body | null = null;
let wallRight: Matter.Body | null = null;
let lastWidth = 0;
let lastHeight = 0;

function ensureEngine(p: P5Instance): void {
  const needsRebuild = !engine || Math.abs(p.width - lastWidth) > 1 || Math.abs(p.height - lastHeight) > 1;
  if (!needsRebuild) return;

  // Full rebuild on resize or first init
  if (engine) {
    Matter.Engine.clear(engine);
  }
  engine = Matter.Engine.create({ gravity: { x: 0, y: 1, scale: 0.001 } });
  lastWidth = p.width;
  lastHeight = p.height;

  const groundY = p.height * GROUND_FRACTION;
  ground = Matter.Bodies.rectangle(p.width / 2, groundY + WALL_THICKNESS / 2, p.width * 3, WALL_THICKNESS, {
    isStatic: true,
    friction: 0.5,
    restitution: 0.2,
  });
  wallLeft = Matter.Bodies.rectangle(-WALL_THICKNESS / 2, p.height / 2, WALL_THICKNESS, p.height * 2, {
    isStatic: true,
    friction: 0.3,
    restitution: 0.3,
  });
  wallRight = Matter.Bodies.rectangle(p.width + WALL_THICKNESS / 2, p.height / 2, WALL_THICKNESS, p.height * 2, {
    isStatic: true,
    friction: 0.3,
    restitution: 0.3,
  });
  Matter.World.add(engine.world, [ground, wallLeft, wallRight]);

  // Re-add existing emoji bodies
  for (const e of emojis) {
    Matter.World.add(engine.world, e.body);
  }
}

function spawnEmoji(emoji: string, intensity: number, p: P5Instance): void {
  ensureEngine(p);
  if (!engine) return;

  if (emojis.length >= MAX_EMOJIS) {
    // Remove oldest settled emoji, or oldest overall
    const settledIdx = emojis.findIndex(e => e.settled);
    const removeIdx = settledIdx >= 0 ? settledIdx : 0;
    const removed = emojis.splice(removeIdx, 1)[0];
    Matter.World.remove(engine.world, removed.body);
  }

  const size = Math.min(Math.max(40 + (intensity - TRANSIENT_THRESHOLD) * 80, 40), 80);
  const radius = size * 0.4;
  const centerX = p.width / 2;

  const body = Matter.Bodies.circle(centerX, -size, radius, {
    restitution: 0.4,
    friction: 0.3,
    frictionAir: 0.01,
    density: 0.001,
  });

  // Small random horizontal velocity so they scatter on collision
  Matter.Body.setVelocity(body, {
    x: (Math.random() - 0.5) * 3,
    y: 2,
  });
  // Slight random angular velocity for visual variety
  Matter.Body.setAngularVelocity(body, (Math.random() - 0.5) * 0.1);

  Matter.World.add(engine.world, body);

  emojis.push({
    emoji,
    body,
    size,
    opacity: 255,
    scale: 0,
    spawnTime: performance.now(),
    settled: false,
    settledTime: 0,
  });
}

function isBodySettled(body: Matter.Body): boolean {
  const speed = body.speed;
  const angularSpeed = body.angularSpeed;
  return speed < 0.5 && angularSpeed < 0.05;
}

export function drawBootsAndCats(p: P5Instance, dt: number): void {
  ensureEngine(p);
  if (!engine) return;

  const { audioState } = store;
  const now = performance.now();
  const groundY = p.height * GROUND_FRACTION;

  // Step physics
  const deltaMs = Math.min(dt * 16.667, 33.333); // cap at ~30fps equivalent
  Matter.Engine.update(engine, deltaMs);

  // Check transients and spawn emojis
  const tv = audioState.transientValues;

  // Boot: sub + bass
  const bootIntensity = Math.max(tv[0], tv[1]);
  if (bootIntensity > TRANSIENT_THRESHOLD && now - lastTrigger.boot > DEBOUNCE_MS) {
    spawnEmoji('👢', bootIntensity, p);
    lastTrigger.boot = now;
  }

  // Cat: low-mid + mid
  const catIntensity = Math.max(tv[2], tv[3]);
  if (catIntensity > TRANSIENT_THRESHOLD && now - lastTrigger.cat > DEBOUNCE_MS) {
    spawnEmoji('🐱', catIntensity, p);
    lastTrigger.cat = now;
  }

  // Plus: upper-mid + presence + brilliance
  const plusIntensity = Math.max(tv[4], tv[5], tv[6]);
  if (plusIntensity > TRANSIENT_THRESHOLD && now - lastTrigger.plus > DEBOUNCE_MS) {
    spawnEmoji('➕', plusIntensity, p);
    lastTrigger.plus = now;
  }

  // Draw ground line with glow
  p.push();
  p.noFill();
  p.strokeWeight(2);
  for (let i = 3; i >= 0; i--) {
    const alpha = 60 - i * 15;
    (p as any).stroke(100, 255, 200, alpha);
    p.strokeWeight(2 + i * 3);
    p.line(0, groundY, p.width, groundY);
  }
  p.pop();

  // Update and draw emojis
  p.textAlign(p['CENTER'], p['CENTER']);

  for (let i = emojis.length - 1; i >= 0; i--) {
    const e = emojis[i];
    const pos = e.body.position;
    const angle = e.body.angle;

    // Animate pop-in scale
    if (e.scale < 1) {
      e.scale = Math.min(1, e.scale + 0.15 * dt);
    }

    // Check if settled
    if (!e.settled && isBodySettled(e.body) && pos.y > 0) {
      e.settled = true;
      e.settledTime = now;
    }
    // Un-settle if something bumps it
    if (e.settled && !isBodySettled(e.body)) {
      e.settled = false;
      e.settledTime = 0;
    }

    // Fade out settled emojis
    if (e.settled) {
      const elapsed = now - e.settledTime;
      e.opacity = Math.max(0, 255 * (1 - elapsed / FADE_DURATION));
      if (e.opacity <= 0) {
        Matter.World.remove(engine.world, e.body);
        emojis.splice(i, 1);
        continue;
      }
    }

    // Remove emojis that fell way below screen (shouldn't happen with ground, but safety)
    if (pos.y > p.height + 200) {
      Matter.World.remove(engine.world, e.body);
      emojis.splice(i, 1);
      continue;
    }

    const drawSize = e.size * e.scale;
    const alpha = Math.round(e.opacity);

    // Spawn flash
    if (e.scale < 0.8) {
      p.push();
      p.noStroke();
      const flashAlpha = Math.round((1 - e.scale / 0.8) * 180);
      (p as any).fill(255, 255, 255, flashAlpha);
      p.ellipse(pos.x, pos.y, drawSize * 2.5, drawSize * 2.5);
      p.pop();
    }

    // Draw emoji with physics rotation
    p.push();
    p.translate(pos.x, pos.y);
    p.rotate(angle);
    p.textSize(drawSize);
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
  if (engine) {
    Matter.Engine.clear(engine);
  }
  engine = null;
  ground = null;
  wallLeft = null;
  wallRight = null;
  emojis = [];
  lastTrigger = { boot: 0, cat: 0, plus: 0 };
  lastWidth = 0;
  lastHeight = 0;
}
