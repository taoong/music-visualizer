/**
 * Highway visualization — perspective road with oncoming car-dodge mechanic.
 *
 * On each beat: oncoming cars spawn and all in-flight cars get a brief 3×
 * speed burst. The player car alternates swerving between lanes to dodge.
 * Every ~8 beats the player fails to dodge and a car hits it, flashing the
 * screen briefly. Non-hit cars expire silently at HIT_Z.
 */
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';

// ── Local types ───────────────────────────────────────────────────────────────

interface RoadCar {
  lane: number;       // 0=left, 1=center, 2=right
  z: number;          // depth: Z_SPAWN (far) → 0 (near/player)
  hue: number;        // HSB hue for car color
  isHitCar: boolean;  // will this car collide with player?
  hitFlash: number;   // brightness spike on collision (decays)
  expired: boolean;
}

// ── Module state ──────────────────────────────────────────────────────────────

let cars: RoadCar[] = [];
let roadScrollZ = 0;
let lastPlaybackPos = -1;
let screenFlash = 0;
let carShake = 0;
let lastBeatIndex = -1;
let headlightGlow = 0;
let initialized = false;

// Beat-driven state
let speedMult = 1.0;
let burstTimer = 0;
let beatCount = 0;
let nextHitBeat = 7 + Math.floor(Math.random() * 4);
let playerLane = 1;           // current lane 0|1|2
let playerTargetLane = 1;     // lane we're moving toward
let playerOffsetX = 0;        // smooth pixel X offset from screen center
let carBankAngle = 0;         // steering lean (radians)
let hitCarRef: RoadCar | null = null;
let lastDodgeLane = -1;       // track last dodge lane to avoid repeating

// ── Constants ─────────────────────────────────────────────────────────────────

const Z_SPAWN = 1000;
const HIT_Z = 30;
const STEP_PER_DT = 6.67;
const HORIZON_Y_RATIO = 0.35;
const NEAR_Y_RATIO = 0.88;
const NEAR_HW_RATIO = 0.38;
const HORIZON_HW = 15;
const DASH_SPACING = 120;
const BURST_SPEED = 3.0;
const BURST_DURATION = 200;

const BAND_HUES = [270, 30, 60, 120, 180, 240, 0];

// ── Perspective helpers ───────────────────────────────────────────────────────

/** Convert depth z to t: 0=far/horizon, 1=near/player */
function zToT(z: number): number {
  return 1 - Math.min(z / Z_SPAWN, 1);
}

/** Screen Y for a given t */
function tToScreenY(t: number, horizY: number, nearY: number): number {
  return horizY + t * (nearY - horizY);
}

/** Road half-width for a given t */
function roadHWAt(t: number, nearHW: number): number {
  return HORIZON_HW + t * (nearHW - HORIZON_HW);
}

/** Screen X for lane (0,1,2) at depth t, relative to center */
function laneOffsetX(lane: number, t: number, nearHW: number): number {
  return (lane - 1) * (roadHWAt(t, nearHW) * 0.67);
}

// ── Drawing helpers ───────────────────────────────────────────────────────────

function drawRoad(
  p: P5Instance,
  cx: number,
  horizY: number,
  nearY: number,
  nearHW: number,
  scrollZ: number
): void {
  // Asphalt trapezoid
  p.noStroke();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (p as any).fill(25, 10, 18);
  p.beginShape();
  p.vertex(cx - HORIZON_HW, horizY);
  p.vertex(cx + HORIZON_HW, horizY);
  p.vertex(cx + nearHW, nearY);
  p.vertex(cx - nearHW, nearY);
  p.endShape(p['CLOSE']);

  // White edge lines
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (p as any).stroke(0, 0, 90);
  p.strokeWeight(2);
  p.line(cx - HORIZON_HW, horizY, cx - nearHW, nearY);
  p.line(cx + HORIZON_HW, horizY, cx + nearHW, nearY);

  // Dashed lane dividers at ±1/3 of road width
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (p as any).stroke(0, 0, 70, 80);
  p.strokeWeight(1.5);

  for (const divFrac of [-1 / 3, 1 / 3]) {
    // Step from scrollZ up to Z_SPAWN drawing alternating dashes
    for (let z = scrollZ; z < Z_SPAWN; z += DASH_SPACING) {
      const dashEnd = z + DASH_SPACING * 0.45;

      const t1 = zToT(z);
      const t2 = zToT(Math.min(dashEnd, Z_SPAWN - 1));

      const hw1 = roadHWAt(t1, nearHW);
      const hw2 = roadHWAt(t2, nearHW);

      const x1 = cx + divFrac * hw1 * 2;
      const x2 = cx + divFrac * hw2 * 2;
      const y1 = tToScreenY(t1, horizY, nearY);
      const y2 = tToScreenY(t2, horizY, nearY);

      if (y1 < nearY && y2 > horizY) {
        p.line(x1, y1, x2, y2);
      }
    }
  }
}

function drawOncomingCar(
  p: P5Instance,
  x: number,
  y: number,
  carW: number,
  carH: number,
  hue: number,
  flash: number
): void {
  const sat = 75;
  const bri = 65 + flash * 35;
  const alpha = Math.min(100, 70 + flash * 30);

  // Car body
  p.noStroke();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (p as any).fill(hue, sat, bri, alpha);
  p.rect(x - carW / 2, y - carH, carW, carH, carW * 0.12);

  // Windshield strip
  const wShield = carW * 0.72;
  const wH = carH * 0.28;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (p as any).fill(hue, 30, 90, alpha * 0.85);
  p.rect(x - wShield / 2, y - carH + carH * 0.08, wShield, wH, 2);

  // Headlights (two small rects at front/bottom of car)
  const hlW = carW * 0.18;
  const hlH = carH * 0.09;
  const hlY = y - hlH;
  const glowBri = 85 + flash * 15;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (p as any).fill(45, 20, glowBri, alpha);
  p.rect(x - carW * 0.3 - hlW / 2, hlY, hlW, hlH, 2);
  p.rect(x + carW * 0.3 - hlW / 2, hlY, hlW, hlH, 2);
}

function drawPlayerCar(
  p: P5Instance,
  x: number,
  y: number,
  S: number,
  glowAmp: number,
  bankAngle: number
): void {
  p.push();
  p.translate(x, y);
  p.rotate(bankAngle);

  const carW = S * 1.8;
  const carH = S * 3.0;

  // Taillight glow behind car
  const tlGlow = 0.35 + glowAmp * 0.55;
  p.noStroke();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (p as any).fill(0, 90, 80, tlGlow * 22);
  p.ellipse(0, S * 0.6, carW * 1.5, S * 1.4);

  // Car body — dark gray top view (rear of car, looking forward)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (p as any).fill(0, 0, 30);
  p.noStroke();
  p.rect(-carW / 2, -carH, carW, carH, carW * 0.15);

  // Roof panel (darker center strip)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (p as any).fill(0, 0, 20);
  p.rect(-carW * 0.28, -carH + carH * 0.1, carW * 0.56, carH * 0.65, 4);

  // Rear windshield
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (p as any).fill(200, 20, 60, 75);
  p.rect(-carW * 0.35, -carH * 0.02, carW * 0.70, carH * 0.15, 3);

  // Headlights (front of car at top since we see rear, but car drives toward us)
  const hlW = carW * 0.22;
  const hlH = S * 0.22;
  const hlGlow = 0.4 + glowAmp * 0.6;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (p as any).fill(45, 10, 100, hlGlow * 95);
  p.ellipse(-carW * 0.28, -carH + hlH, hlW, hlH * 1.4);
  p.ellipse( carW * 0.28, -carH + hlH, hlW, hlH * 1.4);

  // Taillights
  const tlW = carW * 0.20;
  const tlH = S * 0.16;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (p as any).fill(0, 100, 90, tlGlow * 100);
  p.rect(-carW / 2 + 2, -tlH, tlW, tlH, 2);
  p.rect( carW / 2 - tlW - 2, -tlH, tlW, tlH, 2);

  // Wheel arches (four corners)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (p as any).fill(0, 0, 12);
  const wW = carW * 0.28;
  const wH = S * 0.38;
  p.rect(-carW / 2 - wW * 0.15, -carH * 0.3 - wH / 2, wW, wH, 4);
  p.rect( carW / 2 - wW * 0.85, -carH * 0.3 - wH / 2, wW, wH, 4);
  p.rect(-carW / 2 - wW * 0.15, -carH * 0.75 - wH / 2, wW, wH, 4);
  p.rect( carW / 2 - wW * 0.85, -carH * 0.75 - wH / 2, wW, wH, 4);

  p.pop();
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Reset highway playback state. Call on track load, seek, and window resize.
 */
export function resetHighway(): void {
  cars = [];
  roadScrollZ = 0;
  lastPlaybackPos = -1;
  screenFlash = 0;
  carShake = 0;
  lastBeatIndex = -1;
  headlightGlow = 0;
  initialized = true;
  speedMult = 1.0;
  burstTimer = 0;
  beatCount = 0;
  nextHitBeat = 7 + Math.floor(Math.random() * 4);
  playerLane = 1;
  playerTargetLane = 1;
  playerOffsetX = 0;
  carBankAngle = 0;
  hitCarRef = null;
  lastDodgeLane = -1;
}

/**
 * Main draw function for the highway visualization.
 */
export function drawHighway(p: P5Instance, dt: number): void {
  const { state } = store;
  const w = p.width;
  const h = p.height;
  const cx = w / 2;
  const nearHW = w * NEAR_HW_RATIO;
  const horizY = h * HORIZON_Y_RATIO;
  const nearY = h * NEAR_Y_RATIO;
  const minDim = Math.min(w, h);

  if (!initialized) resetHighway();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (p as any).colorMode(p['HSB'], 360, 100, 100, 100);

  const { amps } = getBandAverages(7);
  const bassAmp = amps[1] || 0;

  const pos = audioEngine.getPlaybackPosition();

  // ── Seek detection ────────────────────────────────────────────────────────
  if (Math.abs(pos - lastPlaybackPos) > 0.5) {
    cars = [];
    lastBeatIndex = -1;
    hitCarRef = null;
    roadScrollZ = 0;
  }
  lastPlaybackPos = pos;

  // ── Speed burst decay ──────────────────────────────────────────────────────
  if (state.isPlaying && burstTimer > 0) {
    burstTimer -= p.deltaTime;
    if (burstTimer <= 0) {
      burstTimer = 0;
      speedMult = 1.0;
    }
  }

  // ── Beat detection: spawn cars, trigger dodge / hit ───────────────────────
  if (state.isPlaying && state.beatIntervalSec > 0) {
    const beatIdx = Math.floor((pos - state.beatOffset) / state.beatIntervalSec);
    if (beatIdx > lastBeatIndex) {
      lastBeatIndex = beatIdx;
      beatCount++;

      speedMult = BURST_SPEED;
      burstTimer = BURST_DURATION;

      const isHitBeat = beatCount >= nextHitBeat;
      if (isHitBeat) {
        nextHitBeat = beatCount + 7 + Math.floor(Math.random() * 4);
        // Player fails to dodge — stays in current lane
        playerTargetLane = playerLane;
      } else {
        // Pick a lane different from current and last dodge
        const available = [0, 1, 2].filter(l => l !== playerLane && l !== lastDodgeLane);
        const dodge = available.length > 0 ? available[Math.floor(Math.random() * available.length)] : (playerLane === 0 ? 2 : 0);
        lastDodgeLane = playerLane;
        playerLane = dodge;
        playerTargetLane = dodge;
      }

      // Spawn 1–2 oncoming cars
      const count = 1 + (Math.random() < 0.45 ? 1 : 0);
      for (let i = 0; i < count; i++) {
        const spawnLane = Math.floor(Math.random() * 3);
        const bandIdx = Math.floor(Math.random() * 7);
        const hue = BAND_HUES[bandIdx] === 0 ? 210 : BAND_HUES[bandIdx];

        const car: RoadCar = {
          lane: spawnLane,
          z: Z_SPAWN,
          hue,
          isHitCar: false,
          hitFlash: 0,
          expired: false,
        };

        if (isHitBeat && i === 0) {
          // Force hit car into player's lane (playerTargetLane = playerLane on hit)
          car.lane = playerLane;
          car.isHitCar = true;
          hitCarRef = car;
        }

        cars.push(car);
      }
    }
  }

  // ── Advance cars + detect hits ────────────────────────────────────────────
  if (state.isPlaying) {
    for (const car of cars) {
      car.z -= STEP_PER_DT * dt * speedMult;
      car.hitFlash *= Math.pow(0.88, dt);

      if (car.z <= HIT_Z && !car.expired) {
        if (car === hitCarRef) {
          car.hitFlash = 1.0;
          screenFlash = 0.95;
          carShake = 20;
          hitCarRef = null;
          car.expired = true;
        } else {
          car.expired = true;
        }
      }

      if (car.z < -80 && car.hitFlash < 0.01) car.expired = true;
    }
    cars = cars.filter(c => !c.expired);
  }

  // ── Player X smoothing + banking ──────────────────────────────────────────
  const targetOffsetX = laneOffsetX(playerTargetLane, 1.0, nearHW);
  const prevOffsetX = playerOffsetX;
  playerOffsetX += (targetOffsetX - playerOffsetX) * Math.min(1, 0.12 * dt);
  const velX = playerOffsetX - prevOffsetX;
  carBankAngle += (velX / minDim * 8.0 - carBankAngle) * Math.min(1, 0.18 * dt);

  // ── Headlight glow tracks bass ─────────────────────────────────────────────
  headlightGlow += (bassAmp - headlightGlow) * Math.min(1, 0.15 * dt);

  // ── Scroll road markings ───────────────────────────────────────────────────
  if (state.isPlaying) {
    roadScrollZ += STEP_PER_DT * dt * speedMult;
    if (roadScrollZ >= DASH_SPACING) roadScrollZ -= DASH_SPACING;
  }

  // ── Render: sky ───────────────────────────────────────────────────────────
  p.noStroke();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (p as any).fill(220, 30, 12);
  p.rect(0, 0, w, horizY);

  // Horizon gradient suggestion (subtle lighter strip at horizon)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (p as any).fill(220, 20, 22, 80);
  p.rect(0, horizY - 8, w, 16);

  // ── Render: road ──────────────────────────────────────────────────────────
  drawRoad(p, cx, horizY, nearY, nearHW, roadScrollZ);

  // Ground below road bottom (covers canvas from nearY to bottom)
  p.noStroke();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (p as any).fill(100, 15, 12);
  p.rect(0, nearY, w, h - nearY);

  // ── Render: oncoming cars (sorted back-to-front) ──────────────────────────
  const sortedCars = [...cars].sort((a, b) => b.z - a.z);

  for (const car of sortedCars) {
    if (car.z <= 0) continue;

    const t = zToT(car.z);
    const screenY = tToScreenY(t, horizY, nearY);
    const screenX = cx + laneOffsetX(car.lane, t, nearHW);
    const hw = roadHWAt(t, nearHW);
    const carW = hw * 0.6;
    const carH = carW * 1.7;

    if (carW < 1) continue;

    drawOncomingCar(p, screenX, screenY, carW, carH, car.hue, car.hitFlash);
  }

  // ── Screen flash overlay ───────────────────────────────────────────────────
  if (screenFlash > 0.01) {
    p.noStroke();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (p as any).fill(0, 0, 100, screenFlash * 40);
    p.rect(0, 0, w, h);
    if (state.isPlaying) screenFlash *= Math.pow(0.75, dt);
  }

  // ── Render: player car ────────────────────────────────────────────────────
  const S = minDim * 0.065;
  const shakeX = (Math.random() - 0.5) * carShake;
  const shakeY = (Math.random() - 0.5) * carShake;
  drawPlayerCar(
    p,
    cx + playerOffsetX + shakeX,
    nearY + S * 0.5 + shakeY,
    S,
    headlightGlow,
    carBankAngle
  );

  // ── Decay carShake ─────────────────────────────────────────────────────────
  carShake *= Math.pow(0.85, dt);

  p.colorMode(p['RGB'], 255);
  p.noStroke();
}
