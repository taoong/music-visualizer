/**
 * Tape — loose magnetic-tape ribbon strips drift through dark studio space.
 * Ping-pong FBO feedback accumulates motion blur as ribbons twist.
 * Warm amber-to-copper palette; two-light studio rig; no rainbow, no neon glow.
 * Inspired by Karsten Schmidt (toxi.cc) continuous curved-surface ribbon work
 * and TouchDesigner SOP-ribbon / feedback-texture patch aesthetics.
 * https://toxi.co.uk/  /  https://derivative.ca/
 */
import * as THREE from 'three';
import { store } from '../state/store';
import { getBandAverages, fovForAspect } from './helpers';
import { isMobile } from '../utils/constants';

// ── Constants ─────────────────────────────────────────────────────────────────

const SEGS = isMobile ? 22 : 44;    // ribbon segments
const CTRL = 6;                      // control points per ribbon
const RIBBON_W = 0.20;               // tape width (world units)
const MAX_RIBBONS = 12;
const DRIFT_SPEED = 0.12;            // noise drift rate
const CAM_RADIUS = 11.0;
const CAM_ORBIT_RATE = 0.00035;      // radians per dt tick

// ── Module state ──────────────────────────────────────────────────────────────

let initialized = false;
let threeCanvas: HTMLCanvasElement | null = null;
let renderer: THREE.WebGLRenderer | null = null;
let vizModeUnsub: (() => void) | null = null;

// Ribbon 3D scene
let ribbonScene: THREE.Scene | null = null;
let camera: THREE.PerspectiveCamera | null = null;

interface RibbonEntry {
  mesh:    THREE.Mesh;
  geo:     THREE.BufferGeometry;
  curve:   THREE.CatmullRomCurve3;
  current: THREE.Vector3[];   // current control-point positions
  phases:  number[];          // 3 × CTRL noise offsets
  initial: THREE.Vector3[];   // resting positions
  mat:     THREE.MeshStandardMaterial;
}
let ribbons: RibbonEntry[] = [];
let currentCount = 0;
let keyLight: THREE.DirectionalLight | null = null;

// Ping-pong FBO
let rtRead: THREE.WebGLRenderTarget | null = null;
let rtWrite: THREE.WebGLRenderTarget | null = null;
let feedbackScene: THREE.Scene | null = null;
let displayScene: THREE.Scene | null = null;
let orthoCamera: THREE.OrthographicCamera | null = null;
let feedbackMat: THREE.ShaderMaterial | null = null;
let displayMat: THREE.MeshBasicMaterial | null = null;

// Uniforms mutated in-place each frame
const uPrev: THREE.IUniform<THREE.Texture | null> = { value: null };
const uDecay: THREE.IUniform<number> = { value: 0.93 };
const uZoom: THREE.IUniform<number> = { value: 0.9985 };
const uAngle: THREE.IUniform<number> = { value: 0.0009 };

// Animation
let time = 0.0;
let camTheta = 0.0;
let camElev = 0.58;   // ~33°
let beatKick = 0.0;

// ── GLSL shaders ──────────────────────────────────────────────────────────────

const FEEDBACK_VERT = /* glsl */`
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position, 1.0); }
`;

const FEEDBACK_FRAG = /* glsl */`
  uniform sampler2D uPrev;
  uniform float uDecay;
  uniform float uZoom;
  uniform float uAngle;
  varying vec2 vUv;
  void main() {
    vec2 uv = vUv - 0.5;
    uv /= uZoom;
    float c = cos(uAngle); float s = sin(uAngle);
    uv = vec2(c*uv.x - s*uv.y, s*uv.x + c*uv.y);
    uv += 0.5;
    gl_FragColor = texture2D(uPrev, uv) * uDecay;
  }
`;

// ── Simple deterministic noise ────────────────────────────────────────────────

function hash(n: number): number {
  const x = Math.sin(n) * 43758.5453123;
  return x - Math.floor(x);
}

function noise1(x: number): number {
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f);
  return hash(i) + (hash(i + 1) - hash(i)) * u;
}

// ── Ribbon geometry helpers ───────────────────────────────────────────────────

function allocRibbonGeo(): THREE.BufferGeometry {
  const vCount = (SEGS + 1) * 2;
  const pos = new THREE.BufferAttribute(new Float32Array(vCount * 3), 3);
  const nor = new THREE.BufferAttribute(new Float32Array(vCount * 3), 3);
  const uvs = new THREE.BufferAttribute(new Float32Array(vCount * 2), 2);

  for (let i = 0; i <= SEGS; i++) {
    uvs.setXY(i * 2,     0, i / SEGS);
    uvs.setXY(i * 2 + 1, 1, i / SEGS);
  }

  const idx: number[] = [];
  for (let i = 0; i < SEGS; i++) {
    const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
    idx.push(a, b, c, b, d, c);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', pos);
  geo.setAttribute('normal',   nor);
  geo.setAttribute('uv',       uvs);
  geo.setIndex(idx);
  return geo;
}

function uploadCurveToGeo(geo: THREE.BufferGeometry, curve: THREE.CatmullRomCurve3): void {
  const pts    = curve.getSpacedPoints(SEGS);
  const frames = curve.computeFrenetFrames(SEGS, false);
  const posA   = geo.attributes.position as THREE.BufferAttribute;
  const norA   = geo.attributes.normal   as THREE.BufferAttribute;
  const hw     = RIBBON_W * 0.5;

  for (let i = 0; i <= SEGS; i++) {
    const p = pts[i];
    const n = frames.normals[i];
    const b = frames.binormals[i];
    posA.setXYZ(i * 2,     p.x + b.x * hw, p.y + b.y * hw, p.z + b.z * hw);
    posA.setXYZ(i * 2 + 1, p.x - b.x * hw, p.y - b.y * hw, p.z - b.z * hw);
    norA.setXYZ(i * 2,     n.x, n.y, n.z);
    norA.setXYZ(i * 2 + 1, n.x, n.y, n.z);
  }
  posA.needsUpdate = true;
  norA.needsUpdate = true;
  geo.computeBoundingSphere();
}

// Seed control points: golden-angle distribution in 3D space.
function seedCtrlPts(idx: number, total: number): THREE.Vector3[] {
  const golden = 2.399963; // golden angle (radians)
  const th = idx * golden;
  const ph = Math.acos(1 - 2 * (idx + 0.5) / Math.max(total, 1));

  const ax = Math.sin(ph) * Math.cos(th);
  const ay = Math.cos(ph) * 0.35;
  const az = Math.sin(ph) * Math.sin(th);
  const al = Math.sqrt(ax * ax + ay * ay + az * az) || 1;

  // Perpendicular (binormal-ish) for S-curve offset
  const bx = -Math.sin(th);
  const bz =  Math.cos(th);
  const bl = Math.sqrt(bx * bx + bz * bz) || 1;

  const pts: THREE.Vector3[] = [];
  for (let j = 0; j < CTRL; j++) {
    const t = (j / (CTRL - 1)) * 2 - 1;                     // -1..1
    const sway = Math.sin(t * Math.PI + idx * 1.7) * 1.3;   // S-curve
    pts.push(new THREE.Vector3(
      ax / al * t * 3.8 + bx / bl * sway * 0.35,
      ay / al * t * 2.0 + Math.sin(j * 1.8 + idx * 0.9) * 0.5,
      az / al * t * 3.8 + bz / bl * sway * 0.35,
    ));
  }
  return pts;
}

// ── Setup ─────────────────────────────────────────────────────────────────────

function makeRenderTarget(w: number, h: number): THREE.WebGLRenderTarget {
  return new THREE.WebGLRenderTarget(w, h, {
    type: THREE.HalfFloatType,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
  });
}

function setup(): void {
  const w = window.innerWidth;
  const h = window.innerHeight;

  // Overlay canvas
  threeCanvas = document.createElement('canvas');
  threeCanvas.style.cssText =
    'position:fixed;top:0;left:0;width:100%;height:100%;z-index:10;pointer-events:none;display:block';
  document.body.appendChild(threeCanvas);

  renderer = new THREE.WebGLRenderer({ canvas: threeCanvas, antialias: !isMobile, alpha: false });
  renderer.setSize(w, h);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, isMobile ? 1 : 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.autoClear = true;

  // ── Ribbon scene ──
  ribbonScene = new THREE.Scene();

  camera = new THREE.PerspectiveCamera(fovForAspect(42, w / h), w / h, 0.1, 200);
  camera.position.set(0, CAM_RADIUS * Math.sin(camElev), CAM_RADIUS * Math.cos(camElev));
  camera.lookAt(0, 0, 0);

  // Warm amber key light + cool steel fill
  keyLight = new THREE.DirectionalLight(0xffbb66, 3.5);
  keyLight.position.set(-4, 5, 3);
  ribbonScene.add(keyLight);

  const fillLight = new THREE.DirectionalLight(0x7aa8cc, 1.4);
  fillLight.position.set(5, -2, -4);
  ribbonScene.add(fillLight);

  ribbonScene.add(new THREE.AmbientLight(0x18100a, 0.6));

  // ── Ping-pong FBO ──
  rtRead  = makeRenderTarget(w, h);
  rtWrite = makeRenderTarget(w, h);

  orthoCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  feedbackMat = new THREE.ShaderMaterial({
    vertexShader:   FEEDBACK_VERT,
    fragmentShader: FEEDBACK_FRAG,
    uniforms: { uPrev: uPrev, uDecay: uDecay, uZoom: uZoom, uAngle: uAngle },
    depthTest: false,
    depthWrite: false,
  });

  const quadGeo = new THREE.PlaneGeometry(2, 2);
  feedbackScene = new THREE.Scene();
  feedbackScene.add(new THREE.Mesh(quadGeo, feedbackMat));

  displayMat = new THREE.MeshBasicMaterial({ map: null, depthTest: false, depthWrite: false });
  displayScene = new THREE.Scene();
  displayScene.add(new THREE.Mesh(quadGeo, displayMat));

  // ── Initial ribbon build ──
  rebuildRibbons(targetCount());

  vizModeUnsub = store.on('vizModeChange', (data) => {
    if (!threeCanvas) return;
    threeCanvas.style.display = data === 'tape' ? 'block' : 'none';
  });

  initialized = true;
}

// ── Ribbon pool management ────────────────────────────────────────────────────

function targetCount(): number {
  const t = Math.max(0, Math.min(1, store.config.tapeCount));
  return Math.round(3 + t * (MAX_RIBBONS - 3));
}

function rebuildRibbons(count: number): void {
  if (!ribbonScene) return;

  // Dispose old
  for (const r of ribbons) {
    ribbonScene.remove(r.mesh);
    r.geo.dispose();
    r.mat.dispose();
  }
  ribbons = [];
  currentCount = count;

  for (let i = 0; i < count; i++) {
    const init = seedCtrlPts(i, count);
    const current = init.map(v => v.clone());
    const phases: number[] = [];
    for (let j = 0; j < CTRL * 3; j++) {
      phases.push(hash(i * 17 + j * 37) * 50);
    }

    const curve = new THREE.CatmullRomCurve3(current.map(v => v.clone()), false, 'catmullrom', 0.5);
    const geo   = allocRibbonGeo();
    uploadCurveToGeo(geo, curve);

    // Warm amber → deep copper gradient across ribbon index
    const t = i / Math.max(count - 1, 1);
    const r = 0.85 - t * 0.22;
    const g = 0.45 - t * 0.18;
    const b = 0.14 + t * 0.04;
    const mat = new THREE.MeshStandardMaterial({
      color:     new THREE.Color(r, g, b),
      metalness: 0.75,
      roughness: 0.30,
      emissive:  new THREE.Color(0, 0, 0),
      side:      THREE.DoubleSide,
    });

    const mesh = new THREE.Mesh(geo, mat);
    ribbonScene.add(mesh);

    ribbons.push({ mesh, geo, curve, current, phases, initial: init.map(v => v.clone()), mat });
  }
}

// ── Draw ──────────────────────────────────────────────────────────────────────

export function drawTape(_p: unknown, dt: number): void {
  if (!initialized) setup();
  if (!renderer || !ribbonScene || !camera || !rtRead || !rtWrite ||
      !feedbackScene || !displayScene || !orthoCamera || !feedbackMat || !displayMat) return;

  time += dt * DRIFT_SPEED;

  const { amps, transients } = getBandAverages(7);

  // Beat detection via transient peak
  const kick = transients.reduce((mx, v) => Math.max(mx, v), 0);
  if (kick > 1.3) beatKick = Math.max(beatKick, (kick - 1.3) * 0.8);
  beatKick *= Math.pow(0.88, dt);

  // Count change (structural slider)
  const desired = targetCount();
  if (desired !== currentCount) rebuildRibbons(desired);

  // Flutter: audio → amplitude of control-point drift
  const flutter = Math.max(0, Math.min(1, store.config.tapeFlutter));
  // Sheen: roughness
  const sheen = Math.max(0, Math.min(1, store.config.tapeSheen));
  const roughness = 0.88 - sheen * 0.83; // 0.88 (matte) → 0.05 (mirror)

  // Update ribbon control points
  const lerpRate = (0.06 + beatKick * 0.18) * dt;
  for (let i = 0; i < ribbons.length; i++) {
    const rb = ribbons[i];
    const band = amps[i % 7] ?? 0;
    const amp  = 0.7 * flutter * (1 + band * 2.0);

    for (let j = 0; j < CTRL; j++) {
      const px = rb.phases[j * 3];
      const py = rb.phases[j * 3 + 1];
      const pz = rb.phases[j * 3 + 2];

      const nx = (noise1(time + px) * 2 - 1) * amp;
      const ny = (noise1(time + py) * 2 - 1) * amp * 0.55;
      const nz = (noise1(time + pz) * 2 - 1) * amp;

      const cx = rb.current[j];
      const ix = rb.initial[j];
      cx.x += (ix.x + nx - cx.x) * lerpRate;
      cx.y += (ix.y + ny - cx.y) * lerpRate;
      cx.z += (ix.z + nz - cx.z) * lerpRate;
    }

    rb.curve.points = rb.current.map(v => v.clone());
    uploadCurveToGeo(rb.geo, rb.curve);

    // Emissive glow driven by band amplitude (warm gold when loud)
    const emissiveScale = band * 0.45;
    rb.mat.emissive.set(emissiveScale * 0.9, emissiveScale * 0.35, emissiveScale * 0.04);
    rb.mat.roughness = roughness;
  }

  // Camera slow orbit (elliptical)
  camTheta += dt * CAM_ORBIT_RATE * (1 + (amps[0] ?? 0) * 0.4);
  const cx = Math.sin(camTheta) * CAM_RADIUS;
  const cy = Math.sin(camTheta * 0.37) * CAM_RADIUS * 0.15 + CAM_RADIUS * Math.sin(camElev);
  const cz = Math.cos(camTheta) * CAM_RADIUS;
  camera.position.set(cx, cy, cz);
  camera.lookAt(0, 0, 0);

  if (camera.aspect !== window.innerWidth / window.innerHeight) {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.fov    = fovForAspect(42, camera.aspect);
    camera.updateProjectionMatrix();
  }

  // Key light sways gently with bass
  if (keyLight) {
    const bL = amps[1] ?? 0;
    keyLight.intensity = 3.5 + bL * 1.8;
  }

  // Feedback uniforms
  uPrev.value = rtRead.texture;
  uDecay.value = 0.91 + sheen * 0.06; // brighter sheen = longer trails
  uAngle.value = 0.0008 + (amps[5] ?? 0) * 0.002;

  // ─ Pass 1: feedback (read from rtRead → write to rtWrite) ─
  renderer.setRenderTarget(rtWrite);
  renderer.autoClear = true;
  renderer.render(feedbackScene, orthoCamera);

  // ─ Pass 2: ribbons on top (no clear) ─
  renderer.autoClear = false;
  ribbonScene.background = null; // transparent so feedback shows through
  renderer.render(ribbonScene, camera);
  renderer.autoClear = true;

  // ─ Pass 3: display rtWrite to screen ─
  displayMat.map = rtWrite.texture;
  displayMat.needsUpdate = true;
  renderer.setRenderTarget(null);
  renderer.render(displayScene, orthoCamera);

  // Swap targets
  const tmp = rtRead; rtRead = rtWrite; rtWrite = tmp;
}

// ── Reset (window resize) ─────────────────────────────────────────────────────

export function resetTape(): void {
  if (!initialized) return;
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer?.setSize(w, h);
  if (camera) {
    camera.aspect = w / h;
    camera.fov    = fovForAspect(42, camera.aspect);
    camera.updateProjectionMatrix();
  }
  // Resize render targets
  rtRead?.setSize(w, h);
  rtWrite?.setSize(w, h);
}

// ── Dispose ───────────────────────────────────────────────────────────────────

export function disposeTape(): void {
  if (!initialized) return;
  vizModeUnsub?.();
  vizModeUnsub = null;

  for (const r of ribbons) {
    r.geo.dispose();
    r.mat.dispose();
  }
  ribbons = [];
  currentCount = 0;

  feedbackMat?.dispose();
  displayMat?.dispose();
  rtRead?.dispose();
  rtWrite?.dispose();

  // Dispose quad geo (shared between feedback/display scenes)
  if (feedbackScene) {
    for (const obj of feedbackScene.children) {
      if ((obj as THREE.Mesh).geometry) (obj as THREE.Mesh).geometry.dispose();
    }
  }
  if (displayScene) {
    for (const obj of displayScene.children) {
      if ((obj as THREE.Mesh).geometry) (obj as THREE.Mesh).geometry.dispose();
    }
  }

  renderer?.dispose();
  threeCanvas?.remove();

  threeCanvas = null; renderer = null;
  ribbonScene = null; camera = null; keyLight = null;
  rtRead = null; rtWrite = null;
  feedbackScene = null; displayScene = null; orthoCamera = null;
  feedbackMat = null; displayMat = null;
  uPrev.value = null;

  time = 0; camTheta = 0; beatKick = 0;
  initialized = false;
}
