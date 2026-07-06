/**
 * Mobile — kinetic sculpture visualization
 *
 * Audio-reactive interpretation of Alexander Calder's hanging mobiles.
 * Hierarchical horizontal arms balance on thin wires; each arm's pendulum
 * physics is driven by a dedicated frequency band. Flat geometric shapes
 * in Calder's primary palette (red, blue, yellow, black) hang from the
 * terminal wires. Beat impulses ripple angular velocity through the hierarchy;
 * amplitude sways each arm with matching intensity.
 *
 * Inspired by "Calder: Composing Motion" at Acquavella Galleries, February 2024
 * https://www.acquavellagalleries.com/exhibitions/calder
 *
 * Sliders:
 *   Shapes — hierarchy depth: 4 shapes (minimal) → 8 shapes (full)
 *   Swing  — audio-driven oscillation amplitude (0–1)
 *   Wind   — ambient drift / turbulence (0–1)
 */
import { store } from '../state/store';
import { getBandAverages } from './helpers';
import { BAND_COUNT, isMobile as isMobileDevice } from '../utils/constants';
import { audioEngine } from '../audio/engine';

// Calder primary palette [r, g, b]
const PAL: [number, number, number][] = [
  [218, 48,  34 ],  // vermilion red
  [22,  98,  192],  // cobalt blue
  [242, 196, 38 ],  // cadmium yellow
  [20,  20,  20 ],  // matte black
  [218, 48,  34 ],  // red (5th–8th repeat with same Calder intent)
  [22,  98,  192],
  [242, 196, 38 ],
  [20,  20,  20 ],
];

// Shape types cycled across leaves: 0=disc, 1=triangle, 2=teardrop, 3=oval
const SHAPE_SEQ = [0, 2, 1, 3, 0, 1, 2, 3];

// Geometry scale: mobile is ~55 % size on mobile
const S = isMobileDevice ? 0.55 : 1.0;

// ── Node types ────────────────────────────────────────────────────────────────
interface ArmNode {
  kind: 'arm';
  halfLen: number;     // half-length of horizontal arm bar
  wireLen: number;     // length of wire from parent endpoint to this arm's pivot
  angle: number;       // tilt deviation from horizontal (radians; 0 = level)
  vel: number;         // angular velocity (rad / frame-unit)
  bandIdx: number;     // audio band that drives this arm
  phase: number;       // phase offset for ambient oscillation
  pivotX: number;      // absolute pivot position (computed each frame)
  pivotY: number;
  childL: MobileNode;  // left child (hangs from left arm endpoint)
  childR: MobileNode;  // right child (hangs from right arm endpoint)
}

interface ShapeNode {
  kind: 'shape';
  wireLen: number;     // length of hanging wire
  wireAngle: number;   // swing deviation from vertical (radians)
  wireVel: number;     // angular velocity of wire
  bandIdx: number;
  phase: number;
  paletteIdx: number;
  shapeType: number;   // 0=disc, 1=triangle, 2=teardrop, 3=oval
  size: number;        // nominal radius
  rot: number;         // shape's own slow rotation
  wireTopX: number;    // absolute wire-top position (= parent arm endpoint)
  wireTopY: number;
  cx: number;          // absolute shape-center position
  cy: number;
}

type MobileNode = ArmNode | ShapeNode;

// ── Module state ──────────────────────────────────────────────────────────────
let time = 0;
let lastBeatIdx = -1;
let prevComplexity = -1;   // 0 = 4-shape tree, 1 = 8-shape tree
let rootArm: ArmNode | null = null;
let allArms: ArmNode[] = [];
let allShapes: ShapeNode[] = [];

// ── Tree construction ─────────────────────────────────────────────────────────
let _shapeSerial = 0;   // resets each time buildMobile() is called

// Arm dimension tables per depth level (desktop; scaled by S on mobile)
const HALF_LEN  = [142, 90, 56];
const WIRE_LEN  = [92,  66, 50];
const SHAPE_SZ  = [24,  20, 16];
const SHAPE_WL  = [62,  52, 44]; // shape wire length per depth

function makeShapeNode(armDepth: number): ShapeNode {
  const i = _shapeSerial++;
  return {
    kind: 'shape',
    wireLen: (SHAPE_WL[armDepth] ?? 40) * S,
    wireAngle: 0,
    wireVel: 0,
    bandIdx: i % BAND_COUNT,
    phase: i * 1.618,
    paletteIdx: i % PAL.length,
    shapeType: SHAPE_SEQ[i % SHAPE_SEQ.length],
    size: (SHAPE_SZ[armDepth] ?? 14) * S,
    rot: i * 0.785,   // 45° stagger so shapes start at different orientations
    wireTopX: 0, wireTopY: 0,
    cx: 0, cy: 0,
  };
}

function makeArmNode(depth: number, maxDepth: number, bandBase: number): ArmNode {
  const arm: ArmNode = {
    kind: 'arm',
    halfLen: (HALF_LEN[depth] ?? 38) * S,
    wireLen: (WIRE_LEN[depth] ?? 40) * S,
    angle: 0,
    vel: 0,
    bandIdx: Math.min(bandBase, BAND_COUNT - 1),
    phase: depth * 1.9 + bandBase * 0.6,
    pivotX: 0, pivotY: 0,
    // Placeholders; assigned below to satisfy TS
    childL: null as unknown as MobileNode,
    childR: null as unknown as MobileNode,
  };

  if (depth >= maxDepth) {
    arm.childL = makeShapeNode(depth + 1);
    arm.childR = makeShapeNode(depth + 1);
  } else {
    arm.childL = makeArmNode(depth + 1, maxDepth, bandBase + 2);
    arm.childR = makeArmNode(depth + 1, maxDepth, bandBase + 3);
  }

  allArms.push(arm);
  return arm;
}

function buildMobile(nShapes: number): void {
  allArms = [];
  allShapes = [];
  _shapeSerial = 0;

  // nShapes=4 → maxDepth=1 (root arm → 2 sub-arms → 4 shapes)
  // nShapes=8 → maxDepth=2 (root → 2 → 4 → 8 shapes)
  const maxDepth = nShapes >= 6 ? 2 : 1;

  rootArm = makeArmNode(0, maxDepth, 0);

  function collect(node: MobileNode): void {
    if (node.kind === 'shape') {
      allShapes.push(node);
    } else {
      collect(node.childL);
      collect(node.childR);
    }
  }
  collect(rootArm);
}

// ── Position computation (top-down traversal) ─────────────────────────────────
function computePositions(node: MobileNode, attachX: number, attachY: number): void {
  if (node.kind === 'arm') {
    // Pivot hangs directly below attach point (wires don't swing — only arms tilt)
    node.pivotX = attachX;
    node.pivotY = attachY + node.wireLen;

    const cos = Math.cos(node.angle);
    const sin = Math.sin(node.angle);
    // Left endpoint goes up when arm tilts right (+angle)
    const lx = node.pivotX - node.halfLen * cos;
    const ly = node.pivotY - node.halfLen * sin;
    const rx = node.pivotX + node.halfLen * cos;
    const ry = node.pivotY + node.halfLen * sin;

    computePositions(node.childL, lx, ly);
    computePositions(node.childR, rx, ry);
  } else {
    // Wire top at attach point; bottom swings as a pendulum
    node.wireTopX = attachX;
    node.wireTopY = attachY;
    node.cx = attachX + Math.sin(node.wireAngle) * node.wireLen;
    node.cy = attachY + Math.cos(node.wireAngle) * node.wireLen;
  }
}

// ── Drawing helpers ───────────────────────────────────────────────────────────
function drawWiresAndArms(
  ctx: CanvasRenderingContext2D,
  node: MobileNode,
  attachX: number,
  attachY: number,
): void {
  const wireW = isMobileDevice ? 1.1 : 1.4;

  if (node.kind === 'arm') {
    // Wire from attach point to pivot
    ctx.lineWidth = wireW;
    ctx.strokeStyle = '#525252';
    ctx.beginPath();
    ctx.moveTo(attachX, attachY);
    ctx.lineTo(node.pivotX, node.pivotY);
    ctx.stroke();

    // Horizontal arm bar
    const cos = Math.cos(node.angle);
    const sin = Math.sin(node.angle);
    const lx = node.pivotX - node.halfLen * cos;
    const ly = node.pivotY - node.halfLen * sin;
    const rx = node.pivotX + node.halfLen * cos;
    const ry = node.pivotY + node.halfLen * sin;

    ctx.lineWidth = isMobileDevice ? 1.6 : 2.0;
    ctx.strokeStyle = '#484848';
    ctx.beginPath();
    ctx.moveTo(lx, ly);
    ctx.lineTo(rx, ry);
    ctx.stroke();

    // Balance point dot
    const dotR = isMobileDevice ? 2 : 2.8;
    ctx.fillStyle = '#5a5a5a';
    ctx.beginPath();
    ctx.arc(node.pivotX, node.pivotY, dotR, 0, Math.PI * 2);
    ctx.fill();

    drawWiresAndArms(ctx, node.childL, lx, ly);
    drawWiresAndArms(ctx, node.childR, rx, ry);
  } else {
    // Shape's hanging wire
    ctx.lineWidth = isMobileDevice ? 0.9 : 1.1;
    ctx.strokeStyle = '#525252';
    ctx.beginPath();
    ctx.moveTo(attachX, attachY);
    ctx.lineTo(node.cx, node.cy);
    ctx.stroke();
  }
}

function drawShapeNode(ctx: CanvasRenderingContext2D, s: ShapeNode, alpha: number): void {
  const [r, g, b] = PAL[s.paletteIdx];
  const sz = s.size;

  ctx.save();
  ctx.translate(s.cx, s.cy);
  ctx.rotate(s.rot);
  ctx.globalAlpha = alpha;

  ctx.fillStyle = `rgb(${r},${g},${b})`;

  switch (s.shapeType) {
    case 0: {
      // Solid disc
      ctx.beginPath();
      ctx.arc(0, 0, sz, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case 1: {
      // Equilateral triangle
      const h = sz * 1.18;
      const hw = sz * 0.88;
      ctx.beginPath();
      ctx.moveTo(0, -h);
      ctx.lineTo(-hw, h * 0.5);
      ctx.lineTo(hw, h * 0.5);
      ctx.closePath();
      ctx.fill();
      break;
    }
    case 2: {
      // Teardrop (elongated organic form)
      ctx.beginPath();
      ctx.moveTo(0, -sz * 1.35);
      ctx.bezierCurveTo( sz * 0.88, -sz * 0.18, sz * 0.88,  sz * 0.82, 0, sz);
      ctx.bezierCurveTo(-sz * 0.88,  sz * 0.82, -sz * 0.88, -sz * 0.18, 0, -sz * 1.35);
      ctx.closePath();
      ctx.fill();
      break;
    }
    case 3: {
      // Flat oval (Calder often used this leaf silhouette)
      ctx.beginPath();
      ctx.ellipse(0, 0, sz * 0.72, sz * 1.1, 0, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
  }

  ctx.globalAlpha = 1;
  ctx.restore();
}

// ── Reset ─────────────────────────────────────────────────────────────────────
export function resetMobile(): void {
  time = 0;
  lastBeatIdx = -1;
  prevComplexity = -1;
  rootArm = null;
  allArms = [];
  allShapes = [];
}

// ── Draw ──────────────────────────────────────────────────────────────────────
export function drawMobile(p: P5Instance, dt: number): void {
  const { state, config } = store;
  const { amps } = getBandAverages(BAND_COUNT);

  const nShapes  = Math.round(Math.max(4, Math.min(8, config.mobileShapes)));
  const swingAmt = config.mobileSwing;  // 0–1
  const windAmt  = config.mobileWind;   // 0–1

  // Rebuild tree when complexity threshold crosses
  const complexity = nShapes >= 6 ? 1 : 0;
  if (complexity !== prevComplexity) {
    buildMobile(nShapes);
    prevComplexity = complexity;
  }
  if (!rootArm) return;

  // Beat detection
  let isBeat = false;
  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adj = pos - state.beatOffset;
    if (adj >= 0) {
      const bi = Math.floor(adj / state.beatIntervalSec);
      if (bi !== lastBeatIdx) {
        lastBeatIdx = bi;
        isBeat = true;
      }
    }
  }

  time += dt * 0.012;

  // Physics constants
  const k   = 0.055;  // arm spring stiffness
  const d   = 0.10;   // arm damping
  const ks  = 0.11;   // shape wire stiffness (slightly stiffer)
  const ds  = 0.13;   // shape wire damping

  const swingScale = 0.35 + swingAmt * 1.3;
  const windScale  = windAmt * 0.014;

  // Beat: scatter angular impulses through all joints
  if (isBeat) {
    const kick = 0.22 * swingScale;
    for (const arm of allArms) {
      arm.vel += (Math.random() - 0.5) * kick;
    }
    for (const sh of allShapes) {
      sh.wireVel += (Math.random() - 0.5) * kick * 0.65;
    }
  }

  // Update arm tilt physics
  for (const arm of allArms) {
    const amp  = amps[arm.bandIdx] * swingScale;
    const wind = Math.sin(time * 0.28 + arm.phase) * windScale;
    arm.vel += (-k * arm.angle - d * arm.vel + amp * 0.055 + wind) * dt;
    arm.angle += arm.vel * dt;
    // Clamp tilt to ±40° so arms never flip
    arm.angle = Math.max(-0.70, Math.min(0.70, arm.angle));
  }

  // Update shape wire pendulums
  for (const sh of allShapes) {
    const amp  = amps[sh.bandIdx] * swingScale;
    const wind = Math.sin(time * 0.38 + sh.phase + 1.3) * windScale * 0.55;
    sh.wireVel += (-ks * sh.wireAngle - ds * sh.wireVel + amp * 0.04 + wind) * dt;
    sh.wireAngle += sh.wireVel * dt;
    sh.wireAngle = Math.max(-0.48, Math.min(0.48, sh.wireAngle));

    // Slow shape self-rotation — faster under high amplitude
    sh.rot += (0.004 + amps[sh.bandIdx] * 0.018) * dt;
  }

  // Compute absolute positions (top-down traversal from ceiling hook)
  const W = p.width;
  const H = p.height;
  const hookX = W / 2;
  const hookY = Math.min(isMobileDevice ? 38 : 52, H * 0.08);

  computePositions(rootArm, hookX, hookY);

  // ── Render ─────────────────────────────────────────────────────────────────
  const ctx = (p as any).drawingContext as CanvasRenderingContext2D;
  ctx.lineCap  = 'round';
  ctx.lineJoin = 'round';

  // Dark background
  ctx.fillStyle = '#111111';
  ctx.fillRect(0, 0, W, H);

  // Ceiling dot + initial wire drawn as part of recursive pass
  ctx.fillStyle = '#5a5a5a';
  ctx.beginPath();
  ctx.arc(hookX, hookY, isMobileDevice ? 3 : 4, 0, Math.PI * 2);
  ctx.fill();

  // First pass: wires and arm bars
  drawWiresAndArms(ctx, rootArm, hookX, hookY);

  // Second pass: subtle bloom halos behind shapes
  for (const sh of allShapes) {
    const [r, g, b] = PAL[sh.paletteIdx];
    const bloomR = sh.size * 1.9;
    ctx.globalAlpha = 0.12 + amps[sh.bandIdx] * 0.08;
    ctx.fillStyle = `rgb(${r},${g},${b})`;
    ctx.beginPath();
    ctx.arc(sh.cx, sh.cy, bloomR, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  // Third pass: solid shapes
  for (const sh of allShapes) {
    drawShapeNode(ctx, sh, 1.0);
  }

  // Restore p5 expected state
  ctx.fillStyle = '#000000';
  ctx.globalAlpha = 1;
}
