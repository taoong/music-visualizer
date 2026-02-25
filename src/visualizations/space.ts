/**
 * Space visualization — third-person space racing scene.
 *
 * On each beat: asteroids spawn and all in-flight asteroids get a brief 3×
 * speed burst. The ship alternates swerving left/right to dodge, banking into
 * the turn. Every ~8 beats the ship mis-swerves, an asteroid "hits" it, and
 * the screen flashes briefly. Non-hit asteroids expire silently at HIT_Z
 * (they flew past the ship) — only the designated hit asteroid triggers a flash.
 */
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { isMobile } from '../utils/constants';

// ── Local types ───────────────────────────────────────────────────────────────

interface Asteroid {
  band: number;
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
  x: number; // normalized −1…1
  y: number; // normalized −1…1
  z: number; // 0…1  (0 = far, 1 = near)
}

// ── Module state ──────────────────────────────────────────────────────────────

let asteroids: Asteroid[] = [];
let stars: SpaceStar[] = [];
let lastPlaybackPos = -1;
let screenFlash = 0;
let shipShake = 0;
let lastBeatIndex = -1;
let engineGlow = 0;
let initialized = false;

// Beat-driven state
let speedMult = 1.0;
let burstTimer = 0;         // ms remaining in beat speed burst
let beatCount = 0;
let nextHitBeat = 7 + Math.floor(Math.random() * 4); // first hit at beat 7–10
let shipOffsetX = 0;        // current ship X offset from screen center (pixels)
let shipTargetX = 0;        // target ship X offset
let shipBankAngle = 0;      // smoothed banking rotation (radians)
let hitAsteroidRef: Asteroid | null = null;
let lastDodgeSide = 1;      // alternates ±1 each beat

// ── Constants ─────────────────────────────────────────────────────────────────

const FOCAL_LENGTH = 400;
const LOOKAHEAD_SEC = 2.5;
const Z_SPAWN = FOCAL_LENGTH * LOOKAHEAD_SEC;        // 1000 world units
const STEP_PER_DT = Z_SPAWN / (LOOKAHEAD_SEC * 60); // ~6.67 units/frame at 60fps
const HIT_Z = 30;
const BEAT_BURST_MS = 200;

const BAND_HUES = [270, 30, 60, 120, 180, 240, 0];
const STAR_COUNT_FULL = 180;
const STAR_COUNT_MOBILE = 90;

// ── Helpers ───────────────────────────────────────────────────────────────────

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
 * Draw a spinning irregular asteroid polygon with a crater detail ring.
 * Stroke/fill must be set by the caller before invoking.
 */
function drawAsteroid(p: P5Instance, asteroid: Asteroid, radius: number): void {
  const { numSides, irregularity, rotAngle } = asteroid;

  p.beginShape();
  for (let i = 0; i < numSides; i++) {
    const angle = rotAngle + (i / numSides) * Math.PI * 2;
    p.vertex(Math.cos(angle) * radius * irregularity[i], Math.sin(angle) * radius * irregularity[i]);
  }
  p.endShape(p['CLOSE']);

  // Crater ring (no fill, same stroke)
  p.noFill();
  const cr = radius * 0.45;
  p.beginShape();
  for (let i = 0; i < numSides; i++) {
    const angle = rotAngle + Math.PI / numSides + (i / numSides) * Math.PI * 2;
    p.vertex(Math.cos(angle) * cr * irregularity[(i + 2) % numSides], Math.sin(angle) * cr * irregularity[(i + 2) % numSides]);
  }
  p.endShape(p['CLOSE']);
}

/**
 * Draw the neon-wireframe spaceship centered at (0, 0), nose pointing up.
 * S = minDim * 0.075. glowAmp (0–1) drives afterburner size/brightness.
 * Manages its own stroke/fill internally.
 */
function drawShip(p: P5Instance, S: number, glowAmp: number): void {
  const t = p.millis() * 0.001;

  // ── Afterburner flames (drawn first, behind hull) ───────────────────────
  const mfLen = S * (1.3 + 0.45 * Math.sin(t * 16.0)) * (0.45 + glowAmp * 0.85);
  const mfW   = S * 0.55  * (0.75 + 0.25 * Math.cos(t * 11.5));
  const nfLen = S * (0.85 + 0.30 * Math.sin(t * 19.0 + 1.2)) * (0.30 + glowAmp * 0.75);
  const nfW   = S * 0.28;
  const tailY = S * 1.7;
  const nacY  = S * 0.35 + S * 0.31; // bottom rim of nacelle pod

  p.noStroke();

  // Central exhaust — three-layer flame
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (p as any).fill(220, 90, 80, 14 + glowAmp * 16);
  p.ellipse(0, tailY + mfLen * 0.58, mfW * 1.9, mfLen * 1.45);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (p as any).fill(28, 100, 100, 38 + glowAmp * 42);
  p.ellipse(0, tailY + mfLen * 0.42, mfW, mfLen);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (p as any).fill(48, 55, 100, 58 + glowAmp * 36);
  p.ellipse(0, tailY + mfLen * 0.22, mfW * 0.44, mfLen * 0.52);

  // Nacelle exhausts
  for (const sx of [-S * 2.4, S * 2.4]) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (p as any).fill(220, 90, 80, 11 + glowAmp * 14);
    p.ellipse(sx, nacY + nfLen * 0.52, nfW * 1.7, nfLen * 1.35);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (p as any).fill(28, 100, 100, 30 + glowAmp * 34);
    p.ellipse(sx, nacY + nfLen * 0.36, nfW, nfLen);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (p as any).fill(50, 65, 100, 48 + glowAmp * 28);
    p.ellipse(sx, nacY + nfLen * 0.18, nfW * 0.44, nfLen * 0.52);
  }

  // ── Hull wireframe ──────────────────────────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (p as any).stroke(200, 65, 90, 95);
  p.strokeWeight(1.5);
  p.noFill();

  // Fuselage (narrow, pointed)
  p.beginShape();
  p.vertex( 0,       -S * 2.4); // sharp nose
  p.vertex(-S * 0.28,-S * 1.7); // neck L
  p.vertex(-S * 0.55,-S * 0.2); // shoulder L
  p.vertex(-S * 0.50, S * 0.8); // lower body L
  p.vertex(-S * 0.40, S * 1.5); // tail root L
  p.vertex( 0,        S * 1.7); // tail center
  p.vertex( S * 0.40, S * 1.5); // tail root R
  p.vertex( S * 0.50, S * 0.8); // lower body R
  p.vertex( S * 0.55,-S * 0.2); // shoulder R
  p.vertex( S * 0.28,-S * 1.7); // neck R
  p.endShape(p['CLOSE']);

  // Left delta wing
  p.beginShape();
  p.vertex(-S * 0.55,-S * 0.2); // root front
  p.vertex(-S * 3.0,  S * 0.5); // tip
  p.vertex(-S * 0.50, S * 0.8); // root rear
  p.endShape(p['CLOSE']);

  // Right delta wing
  p.beginShape();
  p.vertex( S * 0.55,-S * 0.2);
  p.vertex( S * 3.0,  S * 0.5);
  p.vertex( S * 0.50, S * 0.8);
  p.endShape(p['CLOSE']);

  // Left tail fin (swept-forward blade)
  p.beginShape();
  p.vertex(-S * 0.50, S * 0.4);
  p.vertex(-S * 1.35,-S * 0.05);
  p.vertex(-S * 0.40, S * 1.5);
  p.endShape(p['CLOSE']);

  // Right tail fin
  p.beginShape();
  p.vertex( S * 0.50, S * 0.4);
  p.vertex( S * 1.35,-S * 0.05);
  p.vertex( S * 0.40, S * 1.5);
  p.endShape(p['CLOSE']);

  // Wing panel lines (detail)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (p as any).stroke(200, 35, 70, 52);
  p.strokeWeight(0.8);
  p.line(-S * 0.35, S * 0.1, -S * 1.9, S * 0.47);
  p.line( S * 0.35, S * 0.1,  S * 1.9, S * 0.47);

  // Fuselage centerline
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (p as any).stroke(200, 25, 80, 42);
  p.strokeWeight(0.7);
  p.line(0, -S * 2.0, 0, S * 1.5);

  // Engine nacelle pods (filled dark blue)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (p as any).stroke(200, 65, 90, 95);
  p.strokeWeight(1.5);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (p as any).fill(210, 70, 30, 60);
  p.ellipse(-S * 2.4, S * 0.35, S * 0.38, S * 0.62);
  p.ellipse( S * 2.4, S * 0.35, S * 0.38, S * 0.62);
  p.noFill();

  // Cockpit canopy outline
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (p as any).stroke(185, 50, 98, 90);
  p.strokeWeight(1.2);
  p.ellipse(0, -S * 1.5, S * 0.52, S * 0.72);

  // Cockpit inner glow
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (p as any).fill(200, 80, 68, 58);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (p as any).stroke(210, 45, 92, 48);
  p.strokeWeight(0.7);
  p.ellipse(0, -S * 1.56, S * 0.30, S * 0.46);

  // Nose tip glow dot
  p.noStroke();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (p as any).fill(200, 40, 100, 55);
  p.ellipse(0, -S * 2.4, S * 0.18, S * 0.18);

  p.noFill();
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Reset space playback state. Call on track load, seek, and window resize.
 */
export function resetSpace(): void {
  asteroids = [];
  lastPlaybackPos = -1;
  screenFlash = 0;
  shipShake = 0;
  lastBeatIndex = -1;
  engineGlow = 0;
  initialized = false;
  speedMult = 1.0;
  burstTimer = 0;
  beatCount = 0;
  nextHitBeat = 7 + Math.floor(Math.random() * 4);
  shipOffsetX = 0;
  shipTargetX = 0;
  shipBankAngle = 0;
  hitAsteroidRef = null;
  lastDodgeSide = 1;
}

/**
 * Main draw function for the space visualization.
 */
export function drawSpace(p: P5Instance, dt: number): void {
  const { state } = store;
  const cx = p.width / 2;
  const cy = p.height / 2;
  const minDim = Math.min(p.width, p.height);
  const W = minDim * 0.35;

  if (!initialized) initSpace();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (p as any).colorMode(p['HSB'], 360, 100, 100, 100);

  const { amps } = getBandAverages(7);
  const bassAmp = amps[1] || 0;

  const pos = audioEngine.getPlaybackPosition();

  // ── Seek detection ────────────────────────────────────────────────────────
  if (Math.abs(pos - lastPlaybackPos) > 0.5) {
    asteroids = [];
    lastBeatIndex = -1;
    hitAsteroidRef = null;
  }
  lastPlaybackPos = pos;

  // ── Beat speed burst decay ────────────────────────────────────────────────
  if (state.isPlaying && burstTimer > 0) {
    burstTimer -= p.deltaTime;
    if (burstTimer <= 0) {
      burstTimer = 0;
      speedMult = 1.0;
    }
  }

  // ── Beat detection: spawn asteroids, trigger dodge / hit ──────────────────
  if (state.isPlaying && state.beatIntervalSec > 0) {
    const beatIdx = Math.floor((pos - state.beatOffset) / state.beatIntervalSec);
    if (beatIdx > lastBeatIndex) {
      lastBeatIndex = beatIdx;
      beatCount++;

      // All in-flight asteroids burst forward on the beat
      speedMult = 3.0;
      burstTimer = BEAT_BURST_MS;

      const isHitBeat = beatCount >= nextHitBeat;
      if (isHitBeat) {
        nextHitBeat = beatCount + 7 + Math.floor(Math.random() * 4);
        shipTargetX = 0; // ship fails to dodge — stays centered
      } else {
        lastDodgeSide = -lastDodgeSide;
        shipTargetX = lastDodgeSide * minDim * 0.13;
      }

      // Spawn 1–2 asteroids aimed at ship height
      const count = 1 + (Math.random() < 0.5 ? 1 : 0);
      for (let i = 0; i < count; i++) {
        const worldX = (Math.random() - 0.5) * 0.04;
        const worldY = 0.04 + (Math.random() - 0.5) * 0.04;
        const numSides = 7 + Math.floor(Math.random() * 5);
        const irreg = new Float32Array(numSides);
        for (let j = 0; j < numSides; j++) irreg[j] = 0.65 + Math.random() * 0.7;

        const ast: Asteroid = {
          band: Math.floor(Math.random() * 7),
          z: Z_SPAWN,
          worldX,
          worldY,
          magnitude: 0.4 + Math.random() * 0.6,
          hitFlash: 0,
          expired: false,
          rotAngle: Math.random() * Math.PI * 2,
          rotSpeed: 0.01 + Math.random() * 0.03,
          irregularity: irreg,
          numSides,
        };

        if (isHitBeat && i === 0) hitAsteroidRef = ast;
        asteroids.push(ast);
      }
    }
  }

  // ── Advance asteroids + detect hits ──────────────────────────────────────
  if (state.isPlaying) {
    for (const ast of asteroids) {
      ast.z -= STEP_PER_DT * dt * speedMult;
      ast.rotAngle += ast.rotSpeed * dt;

      if (ast.z <= HIT_Z && ast.hitFlash === 0) {
        if (ast === hitAsteroidRef) {
          // Actual hit — flash and shake
          ast.hitFlash = ast.magnitude;
          screenFlash = 0.95;
          shipShake = 20;
          hitAsteroidRef = null;
        } else {
          // Dodged — asteroid flies past silently
          ast.expired = true;
        }
      }

      ast.hitFlash *= Math.pow(0.88, dt);
      if (ast.z < -50 && ast.hitFlash < 0.01) ast.expired = true;
    }
    asteroids = asteroids.filter(a => !a.expired);
  }

  // ── Ship X smooth tracking + banking ─────────────────────────────────────
  const prevX = shipOffsetX;
  shipOffsetX += (shipTargetX - shipOffsetX) * Math.min(1, 0.12 * dt);
  const velX = shipOffsetX - prevX;
  // Bank angle: proportional to lateral velocity, normalized to screen size
  shipBankAngle += (velX / minDim * 10.0 - shipBankAngle) * Math.min(1, 0.18 * dt);

  // ── Engine glow tracks bass ───────────────────────────────────────────────
  engineGlow += (bassAmp - engineGlow) * Math.min(1, 0.15 * dt);

  // ── Draw starfield ────────────────────────────────────────────────────────
  for (const star of stars) {
    if (state.isPlaying) {
      star.y += (0.0008 + star.z * 0.0012) * dt;
      if (star.y > 1) star.y -= 2;
    }
    const sx = cx + star.x * p.width * 0.5;
    const sy = cy + star.y * p.height * 0.5;
    const brightness = 30 + star.z * 70;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (p as any).stroke(200, 10, brightness, 80);
    p.strokeWeight(1 + star.z * 1.5);
    p.point(sx, sy);
  }

  // ── Draw asteroids (far → near) ───────────────────────────────────────────
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
    // hitFlash is only non-zero on the hit asteroid
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

    drawAsteroid(p, ast, baseRadius);
    p.pop();
  }

  // ── Screen flash overlay (fast decay = brief) ─────────────────────────────
  if (screenFlash > 0.01) {
    p.noStroke();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (p as any).fill(0, 0, 100, screenFlash * 40);
    p.rect(0, 0, p.width, p.height);
    if (state.isPlaying) screenFlash *= Math.pow(0.75, dt);
  }

  // ── Draw spaceship (always on top) ───────────────────────────────────────
  const S = minDim * 0.075;
  const shipX = cx + shipOffsetX + (Math.random() - 0.5) * shipShake;
  const shipY = cy + minDim * 0.18 + (Math.random() - 0.5) * shipShake;

  p.push();
  p.translate(shipX, shipY);
  p.rotate(shipBankAngle);
  drawShip(p, S, engineGlow);
  p.pop();

  // ── Decay shipShake ───────────────────────────────────────────────────────
  shipShake *= Math.pow(0.85, dt);

  p.colorMode(p['RGB'], 255);
  p.noStroke();
}
