/**
 * Highway visualization — perspective road with oncoming car-dodge mechanic.
 *
 * On each beat: oncoming cars spawn and get a brief 3× speed burst.
 * The player car always swerves to a different lane to dodge — it never crashes.
 */
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';

// ── Local types ───────────────────────────────────────────────────────────────

interface RoadCar {
  lane: number;    // 0=left, 1=center, 2=right
  z: number;       // depth: Z_SPAWN (far) → 0 (near)
  hue: number;     // HSB hue
  expired: boolean;
}

// ── Module state ──────────────────────────────────────────────────────────────

let cars: RoadCar[] = [];
let roadScrollZ = 0;
let lastPlaybackPos = -1;
let lastBeatIndex = -1;
let headlightGlow = 0;
let initialized = false;

let speedMult = 1.0;
let burstTimer = 0;
let beatCount = 0;
let playerLane = 1;
let playerTargetLane = 1;
let playerOffsetX = 0;
let carBankAngle = 0;
let lastDodgeLane = -1;

// ── Constants ─────────────────────────────────────────────────────────────────

const Z_SPAWN = 1000;
const Z_CAR_DEPTH = 80;    // car length in z-units (≈ 4.5 m at this scale)
const STEP_PER_DT = 11.0;
const HORIZON_Y_RATIO = 0.35;
const NEAR_Y_RATIO = 0.88;
const NEAR_HW_RATIO = 0.46;
const HORIZON_HW = 15;
const DASH_SPACING = 120;
const BURST_SPEED = 3.0;
const BURST_DURATION = 200;

const BAND_HUES = [270, 30, 60, 120, 180, 210, 150];

// ── Perspective helpers ───────────────────────────────────────────────────────

function zToT(z: number): number {
  return 1 - Math.min(z / Z_SPAWN, 1);
}

function tToScreenY(t: number, horizY: number, nearY: number): number {
  return horizY + t * (nearY - horizY);
}

function roadHWAt(t: number, nearHW: number): number {
  return HORIZON_HW + t * (nearHW - HORIZON_HW);
}

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
  scrollZ: number,
  bottomY: number
): void {
  p.noStroke();

  // Road half-width at the canvas bottom (linear extrapolation beyond nearY)
  const bottomT = (bottomY - horizY) / (nearY - horizY);
  const bottomHW = roadHWAt(bottomT, nearHW);

  // Asphalt trapezoid — extends all the way to the canvas bottom
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (p as any).fill(0, 0, 16);
  p.beginShape();
  p.vertex(cx - HORIZON_HW, horizY);
  p.vertex(cx + HORIZON_HW, horizY);
  p.vertex(cx + bottomHW, bottomY);
  p.vertex(cx - bottomHW, bottomY);
  p.endShape(p['CLOSE']);

  // Solid white edge lines — also extend to canvas bottom
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (p as any).stroke(0, 0, 88);
  p.strokeWeight(2);
  p.line(cx - HORIZON_HW, horizY, cx - bottomHW, bottomY);
  p.line(cx + HORIZON_HW, horizY, cx + bottomHW, bottomY);

  // Dashed lane dividers — at ±1/3 of road half-width (between lane centers)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (p as any).stroke(0, 0, 65, 85);
  p.strokeWeight(3);

  for (const divSide of [-1, 1]) {
    for (let z = scrollZ; z < Z_SPAWN; z += DASH_SPACING) {
      const dashEnd = z + DASH_SPACING * 0.72;
      const t1 = zToT(z);
      const t2 = zToT(Math.min(dashEnd, Z_SPAWN - 1));
      const hw1 = roadHWAt(t1, nearHW);
      const hw2 = roadHWAt(t2, nearHW);
      // Dividers sit between adjacent lane centers: ± hw * 0.335
      const x1 = cx + divSide * hw1 * 0.335;
      const x2 = cx + divSide * hw2 * 0.335;
      const y1 = tToScreenY(t1, horizY, nearY);
      const y2 = tToScreenY(t2, horizY, nearY);
      if (y1 < nearY && y2 > horizY) {
        p.line(x1, y1, x2, y2);
      }
    }
  }

  p.noStroke();
}

/**
 * Draw a fully opaque 3D car box from its front-face and back-face geometry.
 *
 * Front/back face described by center-X, bottom-Y, width, height at each
 * respective depth. Faces: left-side → right-side → roof → front (painter's order).
 */
function drawOncomingCar(
  p: P5Instance,
  fx: number, fy: number, fw: number, fh: number,   // front face
  bx: number, by: number, bw: number, bh: number,   // back face
  hue: number
): void {
  p.noStroke();

  // Precomputed corners
  const ftl = { x: fx - fw / 2, y: fy - fh };  // front top-left
  const ftr = { x: fx + fw / 2, y: fy - fh };
  const fbl = { x: fx - fw / 2, y: fy };
  const fbr = { x: fx + fw / 2, y: fy };
  const btl = { x: bx - bw / 2, y: by - bh };  // back top-left
  const btr = { x: bx + bw / 2, y: by - bh };
  const bbl = { x: bx - bw / 2, y: by };
  const bbr = { x: bx + bw / 2, y: by };

  // === Left side face (shadow) ===
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (p as any).fill(hue, 80, 28);
  p.beginShape();
  p.vertex(ftl.x, ftl.y);
  p.vertex(btl.x, btl.y);
  p.vertex(bbl.x, bbl.y);
  p.vertex(fbl.x, fbl.y);
  p.endShape(p['CLOSE']);

  // === Right side face (lighter shadow) ===
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (p as any).fill(hue, 75, 35);
  p.beginShape();
  p.vertex(ftr.x, ftr.y);
  p.vertex(btr.x, btr.y);
  p.vertex(bbr.x, bbr.y);
  p.vertex(fbr.x, fbr.y);
  p.endShape(p['CLOSE']);

  // === Roof face ===
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (p as any).fill(hue, 65, 48);
  p.beginShape();
  p.vertex(ftl.x, ftl.y);
  p.vertex(ftr.x, ftr.y);
  p.vertex(btr.x, btr.y);
  p.vertex(btl.x, btl.y);
  p.endShape(p['CLOSE']);

  // === Front face — main body ===
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (p as any).fill(hue, 78, 68);
  p.rect(ftl.x, ftl.y, fw, fh);

  // === Front face — windshield (dark glass) ===
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (p as any).fill(210, 35, 18);
  p.rect(fx - fw * 0.38, fy - fh + fh * 0.07, fw * 0.76, fh * 0.40, 2);

  // === Headlights ===
  const hlW = fw * 0.22;
  const hlH = fh * 0.12;
  const hlY = fy - fh * 0.17;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (p as any).fill(50, 5, 100);
  p.rect(fx - fw * 0.44, hlY, hlW, hlH, 2);
  p.rect(fx + fw * 0.44 - hlW, hlY, hlW, hlH, 2);

  // Headlight bloom
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (p as any).fill(48, 40, 100, 60);
  p.ellipse(fx - fw * 0.33, hlY + hlH / 2, hlW * 1.8, hlH * 2.0);
  p.ellipse(fx + fw * 0.33, hlY + hlH / 2, hlW * 1.8, hlH * 2.0);

  // === Grille ===
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (p as any).fill(hue, 55, 20);
  p.rect(fx - fw * 0.28, fy - fh * 0.09, fw * 0.56, fh * 0.07, 1);

  // === Bumper highlight ===
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (p as any).stroke(0, 0, 55);
  p.strokeWeight(Math.max(0.5, fw * 0.025));
  p.line(ftl.x + fw * 0.06, fy - 1, ftr.x - fw * 0.06, fy - 1);
  p.noStroke();
}

/**
 * Draw the player car from a rear-3/4 perspective view.
 * (x, y) = rear bumper center at the near-plane bottom of the road.
 */
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

  const bW = S * 2.2;    // rear face width
  const bH = S * 1.65;   // rear face height
  const rW = bW * 0.78;  // roof width (perspective taper)
  const rH = S * 1.05;   // roof depth (height of roof trapezoid above rear face)
  const tlGlow = 0.45 + glowAmp * 0.55;

  p.noStroke();

  // Ground shadow
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (p as any).fill(0, 0, 0, 25);
  p.ellipse(0, 6, bW * 1.35, S * 0.45);

  // === Left side panel ===
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (p as any).fill(0, 0, 20);
  p.beginShape();
  p.vertex(-bW / 2,           -bH);
  p.vertex(-bW / 2 - S * 0.28, -bH + S * 0.18);
  p.vertex(-bW / 2 - S * 0.28,  S * 0.06);
  p.vertex(-bW / 2,             0);
  p.endShape(p['CLOSE']);

  // === Right side panel ===
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (p as any).fill(0, 0, 15);
  p.beginShape();
  p.vertex( bW / 2,            -bH);
  p.vertex( bW / 2 + S * 0.28, -bH + S * 0.18);
  p.vertex( bW / 2 + S * 0.28,  S * 0.06);
  p.vertex( bW / 2,              0);
  p.endShape(p['CLOSE']);

  // === Roof (trapezoid converging toward vanishing point) ===
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (p as any).fill(0, 0, 26);
  p.beginShape();
  p.vertex(-bW / 2,  -bH);
  p.vertex( bW / 2,  -bH);
  p.vertex( rW / 2,  -bH - rH);
  p.vertex(-rW / 2,  -bH - rH);
  p.endShape(p['CLOSE']);

  // Roof window strip
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (p as any).fill(200, 30, 35, 80);
  p.beginShape();
  p.vertex(-bW * 0.34,  -bH);
  p.vertex( bW * 0.34,  -bH);
  p.vertex( rW * 0.34,  -bH - rH * 0.98);
  p.vertex(-rW * 0.34,  -bH - rH * 0.98);
  p.endShape(p['CLOSE']);

  // === Rear face (main body) ===
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (p as any).fill(0, 0, 30);
  p.rect(-bW / 2, -bH, bW, bH, bW * 0.07);

  // === Rear window ===
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (p as any).fill(210, 30, 38, 90);
  p.rect(-bW * 0.37, -bH + bH * 0.06, bW * 0.74, bH * 0.42, 3);

  // === Trunk panel line ===
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (p as any).stroke(0, 0, 48);
  p.strokeWeight(1);
  p.line(-bW * 0.46, -bH * 0.24, bW * 0.46, -bH * 0.24);
  p.noStroke();

  // === Taillights ===
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (p as any).fill(0, 100, 90, tlGlow * 100);
  p.rect(-bW / 2 + 2, -bH * 0.22, bW * 0.25, bH * 0.19, 2);
  p.rect( bW / 2 - 2 - bW * 0.25, -bH * 0.22, bW * 0.25, bH * 0.19, 2);

  // Taillight glow bloom
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (p as any).fill(0, 90, 80, tlGlow * 20);
  p.ellipse(-bW * 0.37, -bH * 0.125, bW * 0.38, bH * 0.30);
  p.ellipse( bW * 0.37, -bH * 0.125, bW * 0.38, bH * 0.30);

  // === Bumper ===
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (p as any).fill(0, 0, 18);
  p.rect(-bW * 0.47, -bH * 0.20, bW * 0.94, bH * 0.20, 3);

  // Bumper center vent/detail
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (p as any).fill(0, 0, 38);
  p.rect(-bW * 0.20, -bH * 0.165, bW * 0.40, bH * 0.08, 2);

  // Reverse light (center, white)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (p as any).fill(0, 0, 82, 55);
  p.ellipse(0, -bH * 0.11, bW * 0.11, bH * 0.08);

  // === Wheels ===
  const wRX = bW / 2 + S * 0.20;
  const wRY = 0;
  const wRw = S * 0.45;
  const wRh = S * 0.60;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (p as any).fill(0, 0, 10);
  p.ellipse(-wRX, wRY, wRw, wRh);
  p.ellipse( wRX, wRY, wRw, wRh);
  // Rim
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (p as any).fill(0, 0, 52);
  p.ellipse(-wRX, wRY, wRw * 0.58, wRh * 0.58);
  p.ellipse( wRX, wRY, wRw * 0.58, wRh * 0.58);

  p.pop();
}

// ── Public API ────────────────────────────────────────────────────────────────

export function resetHighway(): void {
  cars = [];
  roadScrollZ = 0;
  lastPlaybackPos = -1;
  lastBeatIndex = -1;
  headlightGlow = 0;
  initialized = true;
  speedMult = 1.0;
  burstTimer = 0;
  beatCount = 0;
  playerLane = 1;
  playerTargetLane = 1;
  playerOffsetX = 0;
  carBankAngle = 0;
  lastDodgeLane = -1;
}

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

  // ── Speed (intensity knob) and beat-division knob ─────────────────────────
  // baseSpeed scales STEP_PER_DT by the Intensity slider (0–2).
  // division controls how many raw beats are skipped between each swerve/spawn.
  const baseSpeed = STEP_PER_DT * store.config.intensity;
  const division = Math.max(1, Math.round(store.config.beatDivision));

  // ── Beat detection: always dodge, spawn cars ──────────────────────────────
  if (state.isPlaying && state.beatIntervalSec > 0) {
    const beatIdx = Math.floor((pos - state.beatOffset) / state.beatIntervalSec);
    if (beatIdx > lastBeatIndex) {
      lastBeatIndex = beatIdx;
      beatCount++;

      // Only swerve + spawn on every Nth beat (controlled by Beat Frequency knob)
      if (beatCount % division === 0) {
        speedMult = BURST_SPEED;
        burstTimer = BURST_DURATION;

        // Lanes that already have a car close enough to be a threat
        const dangerLanes = new Set(cars.filter(c => c.z < 450).map(c => c.lane));

        // Prefer a lane that has no close cars, is not current, and is not the last dodge
        const safeDiff = [0, 1, 2].filter(l => l !== playerLane && !dangerLanes.has(l) && l !== lastDodgeLane);
        const safe     = [0, 1, 2].filter(l => l !== playerLane && !dangerLanes.has(l));
        const anyDiff  = [0, 1, 2].filter(l => l !== playerLane);
        const pool = safeDiff.length > 0 ? safeDiff
                   : safe.length    > 0 ? safe
                   : anyDiff;
        const dodge = pool[Math.floor(Math.random() * pool.length)];
        lastDodgeLane = playerLane;
        playerLane = dodge;
        playerTargetLane = dodge;

        // Spawn 1–2 oncoming cars — never in the player's new lane so they
        // don't arrive right as the player lands there
        const spawnPool = [0, 1, 2].filter(l => l !== playerTargetLane);
        const count = 1 + (Math.random() < 0.45 ? 1 : 0);
        for (let i = 0; i < count; i++) {
          const bandIdx = Math.floor(Math.random() * 7);
          cars.push({
            lane: spawnPool[Math.floor(Math.random() * spawnPool.length)],
            z: Z_SPAWN,
            hue: BAND_HUES[bandIdx],
            expired: false,
          });
        }
      }
    }
  }

  // ── Advance cars ──────────────────────────────────────────────────────────
  if (state.isPlaying) {
    for (const car of cars) {
      // Trucks that have passed the player exit at 2× speed — mimics the
      // rapid apparent motion of a vehicle that has just overtaken you.
      const exitMult = car.z <= 0 ? 2.0 : 1.0;
      car.z -= baseSpeed * dt * speedMult * exitMult;
    }
    // Remove cars flagged expired during the previous frame's render pass
    cars = cars.filter(c => !c.expired);
  }

  // ── Player X smoothing + banking ──────────────────────────────────────────
  const targetOffsetX = laneOffsetX(playerTargetLane, 1.0, nearHW);
  const prevOffsetX = playerOffsetX;
  playerOffsetX += (targetOffsetX - playerOffsetX) * Math.min(1, 0.18 * dt);
  const velX = playerOffsetX - prevOffsetX;
  carBankAngle += (velX / minDim * 8.0 - carBankAngle) * Math.min(1, 0.18 * dt);

  // ── Headlight glow tracks bass ─────────────────────────────────────────────
  headlightGlow += (bassAmp - headlightGlow) * Math.min(1, 0.15 * dt);

  // ── Scroll road markings ───────────────────────────────────────────────────
  if (state.isPlaying) {
    roadScrollZ += baseSpeed * dt * speedMult;
    if (roadScrollZ >= DASH_SPACING) roadScrollZ -= DASH_SPACING;
  }

  // ── Render: sky ───────────────────────────────────────────────────────────
  p.noStroke();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (p as any).fill(220, 30, 10);
  p.rect(0, 0, w, horizY);

  // Horizon glow strip
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (p as any).fill(220, 20, 20, 70);
  p.rect(0, horizY - 10, w, 20);

  // ── Render: road ──────────────────────────────────────────────────────────
  drawRoad(p, cx, horizY, nearY, nearHW, roadScrollZ, h);

  // ── Render: oncoming cars (back → front) ──────────────────────────────────
  // Painter's algorithm: far trucks first, then player car, then trucks that
  // have already passed the player (z ≤ 0) so they occlude the player car.
  const sortedCars = [...cars].sort((a, b) => b.z - a.z);

  // Pass 1 — approaching trucks (z > 0): drawn behind the player car
  for (const car of sortedCars) {
    if (car.z <= 0) continue;

    const tF = zToT(car.z);
    const tB = zToT(Math.min(car.z + Z_CAR_DEPTH, Z_SPAWN - 1));

    const hwF = roadHWAt(tF, nearHW);
    const hwB = roadHWAt(tB, nearHW);
    const fw = hwF * 0.40;
    const bw = hwB * 0.40;
    const fh = fw * 1.5;
    const bh = bw * 1.5;

    if (fw < 1) continue;

    const fy = tToScreenY(tF, horizY, nearY);
    const by = tToScreenY(tB, horizY, nearY);
    const fx = cx + laneOffsetX(car.lane, tF, nearHW);
    const bx = cx + laneOffsetX(car.lane, tB, nearHW);

    drawOncomingCar(p, fx, fy, fw, fh, bx, by, bw, bh, car.hue);
  }

  // ── Render: player car (between the two truck passes) ────────────────────
  const S = minDim * 0.065;
  drawPlayerCar(
    p,
    cx + playerOffsetX,
    nearY + S * 0.4,
    S,
    headlightGlow,
    carBankAngle
  );

  // Pass 2 — trucks that have passed the player (z ≤ 0): drawn on top,
  // occluding the player car as they exit the bottom of the screen.
  //
  // Size is capped at the near-plane (z=0) values so the truck never expands
  // beyond the size it was when it passed the player.  The Y position uses
  // unclamped t (> 1 for z < 0) so the truck continues moving downward
  // naturally rather than suddenly stopping or falling at a fixed rate.
  const fwExit = roadHWAt(1.0, nearHW) * 0.40;
  const fhExit = fwExit * 1.5;

  for (const car of sortedCars) {
    if (car.z > 0) continue;

    // Unclamped t gives the correct Y position below the near plane
    const tF = 1 - car.z / Z_SPAWN;
    const fy = tToScreenY(tF, horizY, nearY);

    // Expire when the top of the truck has fully exited the canvas
    if (fy - fhExit > h) {
      car.expired = true;
      continue;
    }

    // X pinned at the near-plane lane position (no lateral drift)
    const fx = cx + laneOffsetX(car.lane, 1.0, nearHW);

    // Draw as a flat face (degenerate box) — the truck has passed, so we
    // just show its face sliding off the bottom at consistent size
    drawOncomingCar(p, fx, fy, fwExit, fhExit, fx, fy, fwExit, fhExit, car.hue);
  }

  p.colorMode(p['RGB'], 255);
  p.noStroke();
}
