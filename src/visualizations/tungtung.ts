/**
 * Tung Tung Sahur — beat-synced dancing alien visualization
 *
 * Charcoal-grey humanoid with large oval head dances on a dark stage
 * with spotlight, disco floor, beat particles, and text flashes.
 */
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { BAND_COUNT } from '../utils/constants';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type P5Any = any;

// ---------------------------------------------------------------------------
// Pose system
// ---------------------------------------------------------------------------
interface Pose {
  headTilt: number;
  torsoLean: number;
  bodyY: number;
  torsoSquash: number;
  leftShoulder: number;
  leftElbow: number;
  rightShoulder: number;
  rightElbow: number;
  leftHip: number;
  leftKnee: number;
  rightHip: number;
  rightKnee: number;
}

const POSES: Pose[] = [
  // 0 — neutral standing
  { headTilt: 0, torsoLean: 0, bodyY: 0, torsoSquash: 1,
    leftShoulder: 0, leftElbow: 0, rightShoulder: 0, rightElbow: 0,
    leftHip: 0, leftKnee: 0, rightHip: 0, rightKnee: 0 },
  // 1 — lean left, right arm up
  { headTilt: -0.12, torsoLean: -0.15, bodyY: -0.01, torsoSquash: 1,
    leftShoulder: 0.3, leftElbow: 0.4, rightShoulder: -2.2, rightElbow: 0.8,
    leftHip: 0.1, leftKnee: 0.15, rightHip: -0.1, rightKnee: 0 },
  // 2 — lean right, left arm up
  { headTilt: 0.12, torsoLean: 0.15, bodyY: -0.01, torsoSquash: 1,
    leftShoulder: -2.2, leftElbow: 0.8, rightShoulder: 0.3, rightElbow: 0.4,
    leftHip: -0.1, leftKnee: 0, rightHip: 0.1, rightKnee: 0.15 },
  // 3 — crouch bounce, both arms out
  { headTilt: 0, torsoLean: 0, bodyY: 0.06, torsoSquash: 0.88,
    leftShoulder: -1.2, leftElbow: 0.3, rightShoulder: -1.2, rightElbow: 0.3,
    leftHip: 0.25, leftKnee: 0.35, rightHip: 0.25, rightKnee: 0.35 },
  // 4 — left arm pump high
  { headTilt: -0.08, torsoLean: -0.08, bodyY: -0.02, torsoSquash: 1.02,
    leftShoulder: -2.8, leftElbow: 0.2, rightShoulder: 0.5, rightElbow: 0.6,
    leftHip: 0.05, leftKnee: 0.1, rightHip: -0.05, rightKnee: 0 },
  // 5 — right arm pump high
  { headTilt: 0.08, torsoLean: 0.08, bodyY: -0.02, torsoSquash: 1.02,
    leftShoulder: 0.5, leftElbow: 0.6, rightShoulder: -2.8, rightElbow: 0.2,
    leftHip: -0.05, leftKnee: 0, rightHip: 0.05, rightKnee: 0.1 },
  // 6 — wide stance groove
  { headTilt: 0, torsoLean: 0, bodyY: 0.04, torsoSquash: 0.92,
    leftShoulder: -0.8, leftElbow: 1.2, rightShoulder: -0.8, rightElbow: 1.2,
    leftHip: 0.35, leftKnee: 0.2, rightHip: 0.35, rightKnee: 0.2 },
  // 7 — sway right with vibe arms
  { headTilt: 0.15, torsoLean: 0.12, bodyY: 0.02, torsoSquash: 0.96,
    leftShoulder: -1.5, leftElbow: 1.0, rightShoulder: -0.4, rightElbow: 0.8,
    leftHip: -0.1, leftKnee: 0.05, rightHip: 0.2, rightKnee: 0.25 },
];

// Dance sequence — indices into POSES
const DANCE_SEQ = [0, 1, 3, 2, 4, 6, 5, 7, 3, 1, 6, 2, 5, 0, 7, 4];

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------
let lastBeatIndex = -1;
let seqIndex = 0;
let previousPose: Pose = { ...POSES[0] };
let targetPose: Pose = { ...POSES[0] };
let beatProgress = 0;

// Particles
interface Particle {
  x: number; y: number;
  vx: number; vy: number;
  life: number; maxLife: number;
  hue: number;
}
let particles: Particle[] = [];

// Text flash
let textFlashAlpha = 0;
let textFlashScale = 1;
let strongBeatCount = 0;

// Glow
let glowIntensity = 0;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function lerpPose(a: Pose, b: Pose, t: number): Pose {
  const e = easeInOutCubic(t);
  const out = {} as Pose;
  for (const key of Object.keys(a) as (keyof Pose)[]) {
    out[key] = a[key] + (b[key] - a[key]) * e;
  }
  return out;
}

function spawnParticles(x: number, y: number, count: number, hue: number): void {
  for (let i = 0; i < count; i++) {
    const angle = Math.random() * Math.PI * 2;
    const speed = 1.5 + Math.random() * 3;
    particles.push({
      x, y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed - 2,
      life: 1, maxLife: 0.4 + Math.random() * 0.3,
      hue: (hue + Math.random() * 40 - 20 + 360) % 360,
    });
  }
}

// ---------------------------------------------------------------------------
// Character drawing
// ---------------------------------------------------------------------------
function drawCharacter(p: P5Instance, pose: Pose, sc: number, cx: number, baseY: number, bassAmp: number, midAmp: number, energy: number): void {
  const q = p as P5Any;
  const ctx = p.drawingContext;

  // Dimensions relative to scale
  const headW = sc * 0.22;
  const headH = sc * 0.28;
  const torsoH = sc * 0.3 * pose.torsoSquash;
  const torsoW_top = sc * 0.12;
  const torsoW_bot = sc * 0.08;
  const upperArmLen = sc * 0.2;
  const lowerArmLen = sc * 0.18;
  const upperLegLen = sc * 0.22;
  const lowerLegLen = sc * 0.2;
  const limbW = sc * 0.032 + energy * sc * 0.008;

  // Audio-reactive bounce
  const bounceY = pose.bodyY * sc + bassAmp * sc * 0.06;

  // Torso origin (neck base)
  const neckX = cx + pose.torsoLean * sc * 0.3;
  const neckY = baseY - torsoH - upperLegLen - lowerLegLen + bounceY;

  const hipX = cx;
  const hipY = neckY + torsoH;

  // Colors
  const bodyR = 55, bodyG = 55, bodyB = 60;
  const limbR = 48, limbG = 48, limbB = 52;

  p.push();
  q.colorMode(q.RGB, 255);

  // --- Shadow ---
  p.noStroke();
  q.fill(0, 0, 0, 60);
  const shadowW = sc * 0.25 + bassAmp * sc * 0.05;
  p.ellipse(cx, baseY + sc * 0.01, shadowW, sc * 0.03);

  // --- Legs ---
  q.stroke(limbR, limbG, limbB);
  p.strokeWeight(limbW);
  q.strokeCap(q.ROUND);
  p.noFill();

  // Left leg
  const lHipX = hipX - torsoW_bot * 0.5;
  const lKneeX = lHipX + Math.sin(pose.leftHip) * upperLegLen;
  const lKneeY = hipY + Math.cos(pose.leftHip) * upperLegLen;
  const lFootX = lKneeX + Math.sin(pose.leftHip + pose.leftKnee) * lowerLegLen;
  const lFootY = lKneeY + Math.cos(pose.leftHip + pose.leftKnee) * lowerLegLen;
  p.line(lHipX, hipY, lKneeX, lKneeY);
  p.line(lKneeX, lKneeY, lFootX, lFootY);
  // Foot
  p.noStroke();
  q.fill(limbR, limbG, limbB);
  p.ellipse(lFootX, lFootY, sc * 0.04, sc * 0.025);

  // Right leg
  const rHipX = hipX + torsoW_bot * 0.5;
  const rKneeX = rHipX - Math.sin(pose.rightHip) * upperLegLen;
  const rKneeY = hipY + Math.cos(pose.rightHip) * upperLegLen;
  const rFootX = rKneeX - Math.sin(pose.rightHip + pose.rightKnee) * lowerLegLen;
  const rFootY = rKneeY + Math.cos(pose.rightHip + pose.rightKnee) * lowerLegLen;
  q.stroke(limbR, limbG, limbB);
  p.noFill();
  p.strokeWeight(limbW);
  p.line(rHipX, hipY, rKneeX, rKneeY);
  p.line(rKneeX, rKneeY, rFootX, rFootY);
  p.noStroke();
  q.fill(limbR, limbG, limbB);
  p.ellipse(rFootX, rFootY, sc * 0.04, sc * 0.025);

  // --- Torso ---
  p.noStroke();
  q.fill(bodyR, bodyG, bodyB);
  p.quad(
    neckX - torsoW_top, neckY,
    neckX + torsoW_top, neckY,
    hipX + torsoW_bot, hipY,
    hipX - torsoW_bot, hipY,
  );

  // --- Arms ---
  q.stroke(limbR, limbG, limbB);
  p.strokeWeight(limbW);
  q.strokeCap(q.ROUND);
  p.noFill();

  const armExtend = 1 + midAmp * 0.15;

  // Left arm
  const lShX = neckX - torsoW_top;
  const lShY = neckY + sc * 0.03;
  const lElbowX = lShX + Math.sin(pose.leftShoulder) * upperArmLen * armExtend;
  const lElbowY = lShY - Math.cos(pose.leftShoulder) * upperArmLen * armExtend;
  const lHandAngle = pose.leftShoulder + pose.leftElbow;
  const lHandX = lElbowX + Math.sin(lHandAngle) * lowerArmLen * armExtend;
  const lHandY = lElbowY - Math.cos(lHandAngle) * lowerArmLen * armExtend;
  p.line(lShX, lShY, lElbowX, lElbowY);
  p.line(lElbowX, lElbowY, lHandX, lHandY);
  // Hand
  p.noStroke();
  q.fill(limbR, limbG, limbB);
  p.ellipse(lHandX, lHandY, sc * 0.035, sc * 0.035);

  // Right arm
  const rShX = neckX + torsoW_top;
  const rShY = neckY + sc * 0.03;
  const rElbowX = rShX - Math.sin(pose.rightShoulder) * upperArmLen * armExtend;
  const rElbowY = rShY - Math.cos(pose.rightShoulder) * upperArmLen * armExtend;
  const rHandAngle = pose.rightShoulder + pose.rightElbow;
  const rHandX = rElbowX - Math.sin(rHandAngle) * lowerArmLen * armExtend;
  const rHandY = rElbowY - Math.cos(rHandAngle) * lowerArmLen * armExtend;
  q.stroke(limbR, limbG, limbB);
  p.noFill();
  p.strokeWeight(limbW);
  p.line(rShX, rShY, rElbowX, rElbowY);
  p.line(rElbowX, rElbowY, rHandX, rHandY);
  p.noStroke();
  q.fill(limbR, limbG, limbB);
  p.ellipse(rHandX, rHandY, sc * 0.035, sc * 0.035);

  // --- Head ---
  const headX = neckX + pose.headTilt * sc * 0.15;
  const headY = neckY - headH * 0.45;

  // Glow on beat
  if (glowIntensity > 0.05) {
    ctx.save();
    ctx.shadowColor = `rgba(180, 180, 255, ${glowIntensity * 0.6})`;
    ctx.shadowBlur = sc * 0.08 * glowIntensity;
    q.fill(bodyR, bodyG, bodyB);
    p.noStroke();
    p.ellipse(headX, headY, headW, headH);
    ctx.restore();
  } else {
    q.fill(bodyR, bodyG, bodyB);
    p.noStroke();
    p.ellipse(headX, headY, headW, headH);
  }

  // Face — eyes
  q.fill(20, 20, 22);
  const eyeOffX = headW * 0.22;
  const eyeY = headY - headH * 0.05;
  p.ellipse(headX - eyeOffX, eyeY, sc * 0.03, sc * 0.04);
  p.ellipse(headX + eyeOffX, eyeY, sc * 0.03, sc * 0.04);

  // Mouth — small arc
  p.noFill();
  q.stroke(20, 20, 22);
  p.strokeWeight(sc * 0.008);
  p.arc(headX, headY + headH * 0.15, sc * 0.06, sc * 0.03, 0, Math.PI);

  p.pop();
}

// ---------------------------------------------------------------------------
// Disco floor
// ---------------------------------------------------------------------------
function drawDiscoFloor(p: P5Instance, amps: number[], baseY: number, w: number): void {
  const q = p as P5Any;
  const tileCount = 14;
  const tileW = w / tileCount;
  const floorH = p.height - baseY;
  const tileH = Math.min(tileW * 0.6, floorH / 2);

  q.colorMode(q.HSB, 360, 100, 100);
  p.noStroke();

  for (let i = 0; i < tileCount; i++) {
    const bandIdx = i % BAND_COUNT;
    const amp = amps[bandIdx];
    const hue = (bandIdx * 51 + store.state.circleOutlineHue) % 360;
    const bright = 15 + amp * 50;
    const sat = 60 + amp * 30;

    const x = (p.width - w) / 2 + i * tileW;
    q.fill(hue, sat, bright, 0.8);
    p.rect(x, baseY + 2, tileW - 2, tileH - 2, 2);

    // Reflection
    q.fill(hue, sat, bright * 0.3, 0.3);
    p.rect(x, baseY + tileH + 2, tileW - 2, tileH * 0.5, 2);
  }

  q.colorMode(q.RGB, 255);
}

// ---------------------------------------------------------------------------
// Main draw & reset
// ---------------------------------------------------------------------------
export function drawTungTung(p: P5Instance, dt: number): void {
  const q = p as P5Any;
  const { state } = store;
  const { amps, transients } = getBandAverages(BAND_COUNT);

  const bassAmp = amps[0] + amps[1]; // sub + bass
  const midAmp = amps[3] + amps[4];  // mid + upper-mid
  const energy = amps.reduce((a, b) => a + b, 0) / amps.length;
  const transientMax = Math.max(...transients);

  // --- Beat tracking ---
  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    const interval = state.beatIntervalSec;
    const currentBeatIndex = adjusted >= 0 ? Math.floor(adjusted / interval) : -1;

    if (currentBeatIndex >= 0 && currentBeatIndex !== lastBeatIndex) {
      // New beat — advance pose
      previousPose = lerpPose(previousPose, targetPose, beatProgress);
      seqIndex = (seqIndex + 1) % DANCE_SEQ.length;
      targetPose = { ...POSES[DANCE_SEQ[seqIndex]] };
      lastBeatIndex = currentBeatIndex;
      strongBeatCount++;

      // Glow burst
      glowIntensity = 1;

      // Particles from current hand positions (approximate)
      const s = Math.min(p.width, p.height) * 0.55;
      const cx = p.width / 2;
      const by = p.height * 0.78;
      const neckY = by - s * 0.3 - s * 0.42;
      spawnParticles(cx - s * 0.15, neckY + s * 0.05, 5 + Math.floor(Math.random() * 6), (strongBeatCount * 60) % 360);
      spawnParticles(cx + s * 0.15, neckY + s * 0.05, 5 + Math.floor(Math.random() * 6), (strongBeatCount * 60 + 30) % 360);

      // Text flash on every 4th beat
      if (strongBeatCount % 4 === 0) {
        textFlashAlpha = 1;
        textFlashScale = 0.5;
      }
    }

    // Compute beat progress
    if (interval > 0 && adjusted >= 0) {
      beatProgress = Math.min(1, (adjusted % interval) / interval);
    }
  } else {
    // Slow idle sway when not playing
    beatProgress = Math.min(1, beatProgress + 0.008 * dt);
  }

  const currentPose = lerpPose(previousPose, targetPose, beatProgress);

  // Decay glow
  glowIntensity *= Math.pow(0.88, dt);
  if (transientMax > 1.3) glowIntensity = Math.min(glowIntensity + 0.4, 1);

  // --- Background & spotlight ---
  q.background(8, 8, 12);

  const scale = Math.min(p.width, p.height) * 0.55;
  const cx = p.width / 2;
  const baseY = p.height * 0.78;

  // Spotlight gradient
  const ctx = p.drawingContext;
  const grad = ctx.createRadialGradient(cx, baseY - scale * 0.3, 0, cx, baseY - scale * 0.3, scale * 0.7);
  grad.addColorStop(0, 'rgba(60, 60, 80, 0.25)');
  grad.addColorStop(0.6, 'rgba(20, 20, 30, 0.1)');
  grad.addColorStop(1, 'rgba(8, 8, 12, 0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, p.width, p.height);

  // Spotlight cone from above
  p.noStroke();
  q.fill(255, 255, 255, 6 + glowIntensity * 8);
  p.triangle(
    cx - scale * 0.02, 0,
    cx + scale * 0.02, 0,
    cx + scale * 0.4, baseY + scale * 0.05,
  );
  p.triangle(
    cx - scale * 0.02, 0,
    cx + scale * 0.02, 0,
    cx - scale * 0.4, baseY + scale * 0.05,
  );

  // --- Disco floor ---
  drawDiscoFloor(p, amps, baseY, p.width * 0.7);

  // --- Character ---
  drawCharacter(p, currentPose, scale, cx, baseY, bassAmp, midAmp, energy);

  // --- Particles ---
  q.colorMode(q.HSB, 360, 100, 100);
  p.noStroke();
  for (let i = particles.length - 1; i >= 0; i--) {
    const pt = particles[i];
    pt.x += pt.vx * dt;
    pt.y += pt.vy * dt;
    pt.vy += 0.15 * dt; // gravity
    pt.life -= (dt * 0.016) / pt.maxLife;
    if (pt.life <= 0) {
      particles.splice(i, 1);
      continue;
    }
    const alpha = pt.life * 0.8;
    const size = 3 + pt.life * 5;
    q.fill(pt.hue, 80, 90, alpha);
    p.ellipse(pt.x, pt.y, size, size);
  }
  q.colorMode(q.RGB, 255);

  // --- "TUNG TUNG" text flash ---
  if (textFlashAlpha > 0.01) {
    textFlashScale += (1.8 - textFlashScale) * 0.15 * dt;
    textFlashAlpha *= Math.pow(0.92, dt);

    p.push();
    p.textAlign(p['CENTER'], p['CENTER']);
    q.textStyle(q.BOLD);
    const fontSize = scale * 0.14 * textFlashScale;
    p.textSize(fontSize);
    q.fill(255, 255, 255, textFlashAlpha * 220);

    ctx.save();
    ctx.shadowColor = `rgba(180, 140, 255, ${textFlashAlpha * 0.7})`;
    ctx.shadowBlur = 20;
    p.text('TUNG TUNG', cx, baseY - scale * 0.65);
    ctx.restore();

    p.textSize(fontSize * 0.55);
    q.fill(200, 200, 255, textFlashAlpha * 150);
    p.text('SAHUR', cx, baseY - scale * 0.65 + fontSize * 0.6);
    p.pop();
  }
}

export function resetTungTung(): void {
  lastBeatIndex = -1;
  seqIndex = 0;
  previousPose = { ...POSES[0] };
  targetPose = { ...POSES[0] };
  beatProgress = 0;
  particles = [];
  textFlashAlpha = 0;
  textFlashScale = 1;
  strongBeatCount = 0;
  glowIntensity = 0;
}
