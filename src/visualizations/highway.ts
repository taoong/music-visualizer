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
  speed: number;   // z-units per dt tick — calculated at spawn to arrive on the beat
}

// ── Module state ──────────────────────────────────────────────────────────────

let cars: RoadCar[] = [];
let roadScrollZ = 0;
let lastPlaybackPos = -1;
let lastBeatIndex = -1;
let headlightGlow = 0;
let initialized = false;

let beatCount = 0;
let playerLane = 1;
let playerTargetLane = 1;
let playerOffsetX = 0;
let cameraOffsetX = 0;
let lastDodgeLane = -1;

// ── Constants ─────────────────────────────────────────────────────────────────

const Z_SPAWN = 1000;
const Z_CAR_DEPTH = 50;    // car length in z-units
const NEAR_Y_RATIO = 0.88;
const HORIZON_HW = 15;
const DASH_SPACING = 120;
const TREE_SPACING = 150;
const BAND_HUES = [270, 30, 60, 120, 180, 210, 150];
const PLAYER_Z_DEPTH = 60;  // z-units representing player car length (for perspective side panels)
const PERSP_POW = 4;          // perspective warp: t^PERSP_POW compresses horizon, opens near camera

// ── Perspective helpers ───────────────────────────────────────────────────────

function zToT(z: number): number {
  return 1 - Math.min(z / Z_SPAWN, 1);
}

function perspT(t: number): number {
  return Math.pow(t, PERSP_POW);
}

function tToScreenY(t: number, horizY: number, nearY: number): number {
  return horizY + perspT(t) * (nearY - horizY);
}

function roadHWAt(t: number, nearHW: number): number {
  return HORIZON_HW + perspT(t) * (nearHW - HORIZON_HW);
}

function laneOffsetX(lane: number, t: number, nearHW: number): number {
  return (lane - 1) * (roadHWAt(t, nearHW) * 0.67);
}

/** Screen Y — linear continuation below near plane (t > 1). */
function tToScreenYEx(t: number, horizY: number, nearY: number): number {
  if (t <= 1) return tToScreenY(t, horizY, nearY);
  return nearY + (t - 1) * PERSP_POW * (nearY - horizY);
}

/** Road half-width — linear continuation below near plane. */
function roadHWAtEx(t: number, nearHW: number): number {
  if (t <= 1) return roadHWAt(t, nearHW);
  return nearHW + (t - 1) * PERSP_POW * (nearHW - HORIZON_HW);
}

/** perspT — linear continuation below near plane. */
function perspTEx(t: number): number {
  if (t <= 1) return perspT(t);
  return 1 + (t - 1) * PERSP_POW;
}

// ── Drawing helpers ───────────────────────────────────────────────────────────

function drawRoad(
  p: P5Instance,
  vanishX: number,
  cameraOffsetX: number,
  horizY: number,
  nearY: number,
  nearHW: number,
  scrollZ: number,
  bottomY: number
): void {
  p.noStroke();

  // Road half-width at the canvas bottom (linear extrapolation beyond nearY)
  const bottomT  = (bottomY - horizY) / (nearY - horizY);
  const bottomCX = vanishX + cameraOffsetX * bottomT;
  // Linear extrapolation for the canvas-bottom clip — bottomT is a screen-space
  // ratio (can be > 1), not a real z-depth t, so bypass perspT here.
  const bottomHW = HORIZON_HW + bottomT * (nearHW - HORIZON_HW);

  // Asphalt trapezoid — extends all the way to the canvas bottom
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (p as any).fill(0, 0, 16);
  p.beginShape();
  p.vertex(vanishX - HORIZON_HW, horizY);
  p.vertex(vanishX + HORIZON_HW, horizY);
  p.vertex(bottomCX + bottomHW, bottomY);
  p.vertex(bottomCX - bottomHW, bottomY);
  p.endShape(p['CLOSE']);

  // Solid white edge lines — also extend to canvas bottom
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (p as any).stroke(0, 0, 88);
  p.strokeWeight(2);
  p.line(vanishX - HORIZON_HW, horizY, bottomCX - bottomHW, bottomY);
  p.line(vanishX + HORIZON_HW, horizY, bottomCX + bottomHW, bottomY);

  // Dashed lane dividers — at ±1/3 of road half-width (between lane centers)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (p as any).stroke(0, 0, 65, 85);

  for (const divSide of [-1, 1]) {
    for (let z = (DASH_SPACING - scrollZ) - DASH_SPACING; z < Z_SPAWN; z += DASH_SPACING) {
      const t1 = 1 - z / Z_SPAWN;
      // World-space dash length scales with t1 so screen-space length grows as t1²,
      // matching the quadratic road-width expansion for correct depth perception.
      const worldDashLen = DASH_SPACING * 0.5 * Math.min(Math.max(t1, 0), 1.0);
      const dashEnd = z + worldDashLen;
      const t2 = 1 - dashEnd / Z_SPAWN;
      const hw1 = roadHWAtEx(t1, nearHW);
      const hw2 = roadHWAtEx(t2, nearHW);
      // Dividers sit between adjacent lane centers: ± hw * 0.335
      const cx1 = vanishX + cameraOffsetX * perspTEx(t1);
      const cx2 = vanishX + cameraOffsetX * perspTEx(t2);
      const x1 = cx1 + divSide * hw1 * 0.335;
      const x2 = cx2 + divSide * hw2 * 0.335;
      const y1 = tToScreenYEx(t1, horizY, nearY);
      const y2 = tToScreenYEx(t2, horizY, nearY);
      if (y2 > horizY) {
        // Scale stroke weight with t1 (near-end): thin at horizon, bold near player
        p.strokeWeight(Math.max(0.5, 3 * Math.min(t1, 1)));
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

/** Draw a single pine-tree silhouette. baseY is the ground contact point. */
function drawTreeSilhouette(p: P5Instance, x: number, baseY: number, sz: number): void {
  p.noStroke();
  const trkW = sz * 0.13;
  const trkH = sz * 0.38;

  // Trunk
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (p as any).fill(28, 55, 12);
  p.rect(x - trkW / 2, baseY - trkH, trkW, trkH);

  // Lower foliage layer (wider)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (p as any).fill(130, 65, 22);
  p.triangle(x, baseY - trkH - sz * 1.4, x - sz * 0.60, baseY - trkH, x + sz * 0.60, baseY - trkH);

  // Upper foliage layer (narrower)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (p as any).fill(130, 60, 18);
  p.triangle(x, baseY - trkH - sz * 2.1, x - sz * 0.38, baseY - trkH - sz * 0.85, x + sz * 0.38, baseY - trkH - sz * 0.85);
}

/** Draw perspective-correct pine trees on both road shoulders. */
function drawRoadside(
  p: P5Instance,
  vanishX: number,
  cameraOffsetX: number,
  horizY: number,
  nearY: number,
  nearHW: number,
  scrollZ: number
): void {
  const phase = scrollZ % TREE_SPACING;
  for (let z = TREE_SPACING - phase; z < Z_SPAWN; z += TREE_SPACING) {
    const t = zToT(z);
    if (t < 0.04) continue;

    const y      = tToScreenY(t, horizY, nearY);
    const hw     = roadHWAt(t, nearHW);
    const sz     = perspT(t) * nearHW * 0.22;
    if (sz < 1.5) continue;

    // Slight deterministic lateral stagger so trees don't look like a perfect grid
    const idx    = Math.floor((scrollZ + z) / TREE_SPACING);
    const jitter = Math.sin(idx * 1.618) * perspT(t) * nearHW * 0.10;

    const treeCX = vanishX + cameraOffsetX * perspT(t);
    drawTreeSilhouette(p, treeCX - hw - sz * 0.75 + jitter, y, sz);
    drawTreeSilhouette(p, treeCX + hw + sz * 0.75 - jitter, y, sz);
  }
}

/**
 * Draw the player car from a rear perspective view using proper 3D face geometry.
 *
 * nx/ny = rear face center-x, bottom-y   (near — rear bumper, closest to camera)
 * fx/fy = front face center-x, bottom-y  (far — front bumper, further away)
 * nw/nh = near face width/height; fw/fh = far face width/height (smaller per perspective)
 *
 * This mirrors the same approach used by drawOncomingCar so the car sits flat on
 * the road with all four wheels on the ground rather than being rotated.
 */
function drawPlayerCar(
  p: P5Instance,
  nx: number, ny: number, nw: number, nh: number,
  fx: number, fy: number, fw: number, fh: number,
  glowAmp: number
): void {
  const rNW = nw * 0.60;  // narrow fastback roofline
  const rFW = fw * 0.60;
  const tlGlow = 0.45 + glowAmp * 0.55;

  p.noStroke();

  // Ground shadow
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (p as any).fill(0, 0, 0, 25);
  p.ellipse(nx, ny + 6, nw * 1.35, nh * 0.27);

  // === Front wheels (drawn before side panels so body partially occludes inner half) ===
  const wFX = fw * 0.591;
  const wFw = fw * 0.205;
  const wFh = fw * 0.273;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (p as any).fill(0, 0, 10);
  p.ellipse(fx - wFX, fy, wFw, wFh);
  p.ellipse(fx + wFX, fy, wFw, wFh);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (p as any).fill(0, 0, 52);
  p.ellipse(fx - wFX, fy, wFw * 0.58, wFh * 0.58);
  p.ellipse(fx + wFX, fy, wFw * 0.58, wFh * 0.58);

  // === Side panel — only the lane-facing side is visible ===
  if (fx < nx - 1) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (p as any).fill(0, 0, 20);
    p.beginShape();
    p.vertex(nx - nw / 2, ny - nh);
    p.vertex(fx - fw / 2, fy - fh);
    p.vertex(fx - fw / 2, fy);
    p.vertex(nx - nw / 2, ny);
    p.endShape(p['CLOSE']);
  } else if (fx > nx + 1) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (p as any).fill(0, 0, 15);
    p.beginShape();
    p.vertex(nx + nw / 2, ny - nh);
    p.vertex(fx + fw / 2, fy - fh);
    p.vertex(fx + fw / 2, fy);
    p.vertex(nx + nw / 2, ny);
    p.endShape(p['CLOSE']);
  }

  // === Roof: narrow fastback taper ===
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (p as any).fill(0, 0, 26);
  p.beginShape();
  p.vertex(nx - rNW / 2, ny - nh);
  p.vertex(nx + rNW / 2, ny - nh);
  p.vertex(fx + rFW / 2, fy - fh);
  p.vertex(fx - rFW / 2, fy - fh);
  p.endShape(p['CLOSE']);

  // Roof glass strip (narrow, sports car)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (p as any).fill(200, 30, 35, 80);
  p.beginShape();
  p.vertex(nx - nw * 0.26, ny - nh);
  p.vertex(nx + nw * 0.26, ny - nh);
  p.vertex(fx + fw * 0.26, fy - fh);
  p.vertex(fx - fw * 0.26, fy - fh);
  p.endShape(p['CLOSE']);

  // === Rear face (main body) ===
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (p as any).fill(0, 0, 30);
  p.rect(nx - nw / 2, ny - nh, nw, nh, nw * 0.06);

  // === Rear window — large, takes up most of body height (fastback style) ===
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (p as any).fill(210, 30, 38, 90);
  p.rect(nx - nw * 0.30, ny - nh + nh * 0.05, nw * 0.60, nh * 0.52, 4);

  // === Deck lid crease line ===
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (p as any).stroke(0, 0, 52);
  p.strokeWeight(1);
  p.line(nx - nw * 0.44, ny - nh * 0.38, nx + nw * 0.44, ny - nh * 0.38);
  p.noStroke();

  // === Taillights — wide horizontal slashes (sports car style) ===
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (p as any).fill(0, 100, 90, tlGlow * 100);
  p.rect(nx - nw * 0.47, ny - nh * 0.32, nw * 0.32, nh * 0.11, 2);
  p.rect(nx + nw * 0.47 - nw * 0.32, ny - nh * 0.32, nw * 0.32, nh * 0.11, 2);

  // Center connecting light bar
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (p as any).fill(0, 90, 60, tlGlow * 80);
  p.rect(nx - nw * 0.15, ny - nh * 0.29, nw * 0.30, nh * 0.04, 0);

  // Taillight glow bloom
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (p as any).fill(0, 90, 80, tlGlow * 20);
  p.ellipse(nx - nw * 0.32, ny - nh * 0.265, nw * 0.38, nh * 0.22);
  p.ellipse(nx + nw * 0.32, ny - nh * 0.265, nw * 0.38, nh * 0.22);

  // === Bumper / diffuser (lower 22% of body) ===
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (p as any).fill(0, 0, 18);
  p.rect(nx - nw * 0.47, ny - nh * 0.22, nw * 0.94, nh * 0.22, 3);

  // Diffuser vents (3 horizontal slots)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (p as any).fill(0, 0, 8);
  const ventW = nw * 0.19;
  const ventH = nh * 0.07;
  const ventY = ny - nh * 0.14;
  p.rect(nx - nw * 0.34, ventY, ventW, ventH, 1);
  p.rect(nx - ventW / 2, ventY, ventW, ventH, 1);
  p.rect(nx + nw * 0.34 - ventW, ventY, ventW, ventH, 1);

  // === Rear spoiler ===
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (p as any).fill(0, 0, 22);
  p.rect(nx - nw * 0.44, ny - nh - nh * 0.11, nw * 0.88, nh * 0.07, 1);
  // Spoiler end mounts
  p.rect(nx - nw * 0.44, ny - nh - nh * 0.11, nh * 0.06, nh * 0.11);
  p.rect(nx + nw * 0.44 - nh * 0.06, ny - nh - nh * 0.11, nh * 0.06, nh * 0.11);

  // === Wheels (rear axle) ===
  const wRX = nw * 0.591;
  const wRw = nw * 0.205;
  const wRh = nw * 0.273;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (p as any).fill(0, 0, 10);
  p.ellipse(nx - wRX, ny, wRw, wRh);
  p.ellipse(nx + wRX, ny, wRw, wRh);
  // Rim
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (p as any).fill(0, 0, 52);
  p.ellipse(nx - wRX, ny, wRw * 0.58, wRh * 0.58);
  p.ellipse(nx + wRX, ny, wRw * 0.58, wRh * 0.58);
}

// ── Public API ────────────────────────────────────────────────────────────────

export function resetHighway(): void {
  cars = [];
  roadScrollZ = 0;
  lastPlaybackPos = -1;
  lastBeatIndex = -1;
  headlightGlow = 0;
  initialized = true;
  beatCount = 0;
  playerLane = 1;
  playerTargetLane = 1;
  playerOffsetX = 0;
  cameraOffsetX = 0;
  lastDodgeLane = -1;
}

export function drawHighway(p: P5Instance, dt: number): void {
  const { state } = store;
  const w = p.width;
  const h = p.height;
  const cx = w / 2;
  const nearHW = w * store.config.highwayRoadWidth;
  const horizY = h * store.config.highwayHorizon;
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

  // ── Speed knob drives both road speed and beat division ───────────────────
  // intensity (0–2) controls road scroll speed continuously, and also sets
  // the beat division in discrete steps so cars always align with the beat:
  //   < 0.5 → every 4 beats   0.5–1.0 → every 2 beats   ≥ 1.0 → every beat
  const intensity = store.config.intensity;
  const division = intensity < 0.5 ? 4 : intensity < 1.0 ? 2 : 1;

  // Road scroll speed derived from traffic car speed so markings feel consistent.
  // refCarSpeed = same formula used for spawning cars.
  // baseSpeed = half of car approach speed × intensity knob.
  const travelSec = state.beatIntervalSec > 0
    ? Math.max(0.01, (division - 0.3) * state.beatIntervalSec)
    : 1.0;
  const refCarSpeed = Z_SPAWN / (travelSec * 60);
  const baseSpeed = refCarSpeed * 1.0 * intensity;

  // ── Beat detection: always dodge, spawn cars ──────────────────────────────
  if (state.isPlaying && state.beatIntervalSec > 0) {
    const beatIdx = Math.floor((pos - state.beatOffset) / state.beatIntervalSec - 0.05);
    if (beatIdx > lastBeatIndex) {
      lastBeatIndex = beatIdx;
      beatCount++;

      // Only swerve + spawn on every Nth beat (controlled by Beat Frequency knob)
      if (beatCount % division === 0) {
        // Speed for cars spawned now: travel Z_SPAWN units in
        // `(division - 0.3) * beatIntervalSec` seconds so they pass the player
        // 30% of a beat before the next trigger beat.
        const carSpeed = refCarSpeed;  // already computed above

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

        // Spawn one car in each non-target lane (always 2 cars).
        // This guarantees a car in the lane the player just left, so every
        // swerve looks forced rather than optional.
        const spawnPool = [0, 1, 2].filter(l => l !== playerTargetLane);
        for (const lane of spawnPool) {
          const bandIdx = Math.floor(Math.random() * 7);
          cars.push({
            lane,
            z: Z_SPAWN,
            hue: BAND_HUES[bandIdx],
            expired: false,
            speed: carSpeed,
          });
        }
      }
    }
  }

  // ── Advance cars ──────────────────────────────────────────────────────────
  if (state.isPlaying) {
    for (const car of cars) {
      car.z -= car.speed * dt;
    }
    // Remove cars flagged expired during the previous frame's render pass
    cars = cars.filter(c => !c.expired);
  }

  // ── Player X smoothing ────────────────────────────────────────────────────
  const targetOffsetX = laneOffsetX(playerTargetLane, 1.0, nearHW);
  playerOffsetX += (targetOffsetX - playerOffsetX) * Math.min(1, 0.18 * dt);

  // Camera partially follows player — vanishing point shifts only a fraction of
  // the lane offset so the road stays near-center while the car sits in its lane.
  cameraOffsetX += (-playerOffsetX * store.config.highwayCamFollow - cameraOffsetX) * Math.min(1, 0.08 * dt);
  const vanishX = cx - cameraOffsetX;

  // ── Headlight glow tracks bass ─────────────────────────────────────────────
  headlightGlow += (bassAmp - headlightGlow) * Math.min(1, 0.15 * dt);

  // ── Scroll road markings ───────────────────────────────────────────────────
  if (state.isPlaying) {
    roadScrollZ += baseSpeed * dt;
  }

  // ── World pan: shift entire scene so car moves toward screen center ─────────
  // cameraOffsetX targets -playerOffsetX * follow, so at follow=1 the world
  // pans enough that the player's lane appears at cx (car centered on screen).
  p.push();
  p.translate(cameraOffsetX, 0);

  // ── Render: sky + ground (pre-rotation, oversized to survive any roll) ────
  p.noStroke();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (p as any).fill(220, 30, 10);           // sky colour
  p.rect(-w, -h, w * 3, h * 3);          // oversized to survive any rotation
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (p as any).fill(100, 35, 8);            // dark ground outside road
  p.rect(-w, horizY, w * 3, h * 3);

  // ── Camera roll: rotate entire world around the vanishing point ───────────
  const cameraRoll = -cameraOffsetX / (nearHW * 2) * 0.07;
  p.push();
  p.translate(vanishX, horizY);
  p.rotate(cameraRoll);
  p.translate(-vanishX, -horizY);

  // Horizon glow (inside rotation so it tilts with the road)
  p.noStroke();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (p as any).fill(220, 20, 20, 70);
  p.rect(-w * 2, horizY - 10, w * 5, 20);  // wide enough to survive rotation

  // ── Render: road ──────────────────────────────────────────────────────────
  drawRoad(p, vanishX, cameraOffsetX, horizY, nearY, nearHW, roadScrollZ % DASH_SPACING, h);
  drawRoadside(p, vanishX, cameraOffsetX, horizY, nearY, nearHW, roadScrollZ);

  // ── Render: oncoming cars (back → front) ──────────────────────────────────
  // Painter's algorithm: far cars first, then player car, then cars that
  // have already passed the player (z ≤ 0) so they occlude the player car.
  const sortedCars = [...cars].sort((a, b) => b.z - a.z);

  // Pass 1 — approaching cars (z > 0): drawn behind the player car
  for (const car of sortedCars) {
    if (car.z <= 0) continue;

    const tF = zToT(car.z);
    const tB = zToT(Math.min(car.z + Z_CAR_DEPTH, Z_SPAWN - 1));

    const hwF = roadHWAt(tF, nearHW);
    const hwB = roadHWAt(tB, nearHW);
    const fw = hwF * 0.30;
    const bw = hwB * 0.30;
    const fh = fw * 0.70;
    const bh = bw * 0.70;

    if (fw < 1) continue;

    const fy = tToScreenY(tF, horizY, nearY);
    const by = tToScreenY(tB, horizY, nearY);
    const fx = vanishX + cameraOffsetX * perspT(tF) + laneOffsetX(car.lane, tF, nearHW);
    const bx = vanishX + cameraOffsetX * perspT(tB) + laneOffsetX(car.lane, tB, nearHW);

    drawOncomingCar(p, fx, fy, fw, fh, bx, by, bw, bh, car.hue);
  }

  // ── Render: player car (between the two car passes) ──────────────────────
  const S = minDim * 0.065;
  const nw = S * 2.6;   // wider stance (was 2.2)
  const nh = S * 1.1;   // low sports car body (was 1.65)

  // Perspective scale: front of car is PLAYER_Z_DEPTH units further than rear bumper.
  // pScale < 1 — the far face is smaller and shifted toward the vanishing point.
  const tFront = zToT(PLAYER_Z_DEPTH);
  const pScale = roadHWAt(tFront, nearHW) / roadHWAt(1.0, nearHW);

  // Near face (rear bumper): player's current position on the near plane
  const nx = cx + playerOffsetX;
  const ny = nearY + S * 0.4;

  // Far face (front bumper): perspective-correct — converges toward vanishX
  const fx = vanishX + cameraOffsetX * perspT(tFront) + playerOffsetX * pScale;
  const fy = tToScreenY(tFront, horizY, nearY) + S * 0.4;
  const fw = nw * pScale;
  const fh = nh * pScale;

  drawPlayerCar(p, nx, ny, nw, nh, fx, fy, fw, fh, headlightGlow);

  // Pass 2 — cars that have passed the player (z ≤ 0): drawn on top,
  // occluding the player car as they exit the bottom of the screen.
  //
  // Mirrors the approaching-car code (Pass 1) but uses the *Ex extended
  // helpers so that both size and lane position continue to evolve past the
  // near plane (t > 1) — this prevents the "frozen / straight-on" look for
  // off-centre cars and keeps the exit trajectory visually continuous.
  for (const car of sortedCars) {
    if (car.z > 0) continue;

    const tF = 1 - car.z / Z_SPAWN;                    // leading face, t > 1
    const tB = 1 - (car.z + Z_CAR_DEPTH) / Z_SPAWN;   // trailing face

    const hwF = roadHWAtEx(tF, nearHW);
    const hwB = roadHWAtEx(tB, nearHW);
    const fw = hwF * 0.30;
    const bw = hwB * 0.30;
    const fh = fw * 0.70;
    const bh = bw * 0.70;

    const fy = tToScreenYEx(tF, horizY, nearY);
    const by = tToScreenYEx(tB, horizY, nearY);

    // Expire when the trailing (upper) face has fully cleared the canvas
    if (by - bh > h) {
      car.expired = true;
      continue;
    }

    const fx = vanishX + cameraOffsetX * perspTEx(tF) + (car.lane - 1) * hwF * 0.67;
    const bx = vanishX + cameraOffsetX * perspTEx(tB) + (car.lane - 1) * hwB * 0.67;

    drawOncomingCar(p, fx, fy, fw, fh, bx, by, bw, bh, car.hue);
  }

  p.pop(); // end camera roll transform
  p.pop(); // end world pan
  p.colorMode(p['RGB'], 255);
  p.noStroke();
}
