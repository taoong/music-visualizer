/**
 * Boots and Cats visualization — audio-reactive falling emojis
 * 👢 for kicks (sub/bass), 🐱 for snares (low-mid/mid), ➕ for hihats (upper-mid/presence/brilliance)
 */
import { store } from '../state/store';

interface FallingEmoji {
  emoji: string;
  x: number;
  y: number;
  vy: number;
  size: number;
  opacity: number;
  grounded: boolean;
  groundedTime: number;
  wobbleOffset: number;
}

const MAX_EMOJIS = 50;
const GRAVITY = 0.4;
const BOUNCE_DAMPING = 0.4;
const GROUND_FRACTION = 0.85; // ground line at 85% of screen height
const FADE_DURATION = 2000; // ms to fade after landing
const DEBOUNCE_MS = 120; // minimum ms between spawns per type
const TRANSIENT_THRESHOLD = 1.3;

let emojis: FallingEmoji[] = [];
let lastTrigger = { boot: 0, cat: 0, plus: 0 };

function spawnEmoji(emoji: string, intensity: number, p: P5Instance): void {
  if (emojis.length >= MAX_EMOJIS) {
    // Remove oldest grounded emoji, or oldest overall
    const groundedIdx = emojis.findIndex(e => e.grounded);
    emojis.splice(groundedIdx >= 0 ? groundedIdx : 0, 1);
  }

  const size = 40 + (intensity - TRANSIENT_THRESHOLD) * 80;
  emojis.push({
    emoji,
    x: Math.random() * (p.width * 0.8) + p.width * 0.1,
    y: -size,
    vy: 0,
    size: Math.min(Math.max(size, 40), 80),
    opacity: 255,
    grounded: false,
    groundedTime: 0,
    wobbleOffset: Math.random() * Math.PI * 2,
  });
}

export function drawBootsAndCats(p: P5Instance, dt: number): void {
  const { audioState } = store;
  const now = performance.now();
  const groundY = p.height * GROUND_FRACTION;

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

    if (!e.grounded) {
      // Apply gravity
      e.vy += GRAVITY * dt;
      e.y += e.vy * dt;

      // Horizontal wobble
      e.x += Math.sin(now * 0.003 + e.wobbleOffset) * 0.8 * dt;

      // Check ground collision
      if (e.y >= groundY - e.size * 0.3) {
        e.y = groundY - e.size * 0.3;
        if (Math.abs(e.vy) > 2) {
          e.vy = -e.vy * BOUNCE_DAMPING;
        } else {
          e.vy = 0;
          e.grounded = true;
          e.groundedTime = now;
        }
      }
    } else {
      // Fade out grounded emojis
      const elapsed = now - e.groundedTime;
      e.opacity = Math.max(0, 255 * (1 - elapsed / FADE_DURATION));
      if (e.opacity <= 0) {
        emojis.splice(i, 1);
        continue;
      }
    }

    // Draw emoji
    p.push();
    p.textSize(e.size);
    const alpha = Math.round(e.opacity);
    (p as any).fill(255, 255, 255, alpha);
    p.noStroke();
    p.text(e.emoji, e.x, e.y);
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
  lastTrigger = { boot: 0, cat: 0, plus: 0 };
}
