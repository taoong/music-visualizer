/**
 * Loop — nested Lissajous 3D tube sculptures in a dark gallery space.
 *
 * 7 TubeGeometry meshes (one per frequency band) trace closed Lissajous space curves
 * at the same scale, overlapping and interweaving like a knot sculpture.
 * Sub-bass drives the warm-amber tubes; brilliance the innermost cool-blue ones.
 * A warm tungsten key light orbits the sculpture continuously, casting shifting
 * specular highlights across the smooth metallic surfaces. Audio amplitude drives
 * per-tube emissive glow. No rainbow, no centre pulse, no radial symmetry.
 *
 * Inspired by Bruce Nauman "Twenty-Five Feet of Wall with Face and Body Parts"
 * (1985, neon tube installations) and Squidsoup "Submergence" suspended light
 * fields (https://www.squidsoup.org/portfolio/submergence-2/).
 *
 * Sliders:
 *   Form  — structural: Lissajous complexity tier (simple loops → intricate knots)
 *   Glow  — emissive brightness + bloom intensity
 *   Drift — camera + key-light orbit speed
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { store } from '../state/store';
import { getBandAverages } from './helpers';
import { audioEngine } from '../audio/engine';
import { isMobile } from '../utils/constants';

// ── Module state ───────────────────────────────────────────────────────────────

let initialized = false;
let threeCanvas: HTMLCanvasElement | null = null;
let renderer: THREE.WebGLRenderer | null = null;
let scene: THREE.Scene | null = null;
let camera: THREE.PerspectiveCamera | null = null;
let composer: EffectComposer | null = null;
let keyLight: THREE.DirectionalLight | null = null;
let vizModeUnsub: (() => void) | null = null;

const tubes: THREE.Mesh[] = [];
const tubeMats: THREE.MeshStandardMaterial[] = [];
const smoothedGlow = new Float32Array(7);

let time = 0;
let cameraTheta = 0;
let lightTheta = 0;
let beatPulse = 0;
let lastBeatIndex = -1;
let lastFormTier = -1;

// ── Warm-amber → cool-steel-blue palette (not rainbow-per-band) ───────────────

const TUBE_COLORS: THREE.Color[] = [
  new THREE.Color(1.00, 0.65, 0.20),  // sub-bass:   warm amber
  new THREE.Color(1.00, 0.72, 0.28),  // bass:       golden amber
  new THREE.Color(1.00, 0.82, 0.45),  // lowMid:     warm gold
  new THREE.Color(0.90, 0.88, 0.70),  // mid:        pale warm white
  new THREE.Color(0.75, 0.84, 0.95),  // upperMid:   cool silver-blue
  new THREE.Color(0.55, 0.70, 1.00),  // presence:   powder blue
  new THREE.Color(0.40, 0.60, 0.95),  // brilliance: cool blue
];

// ── Lissajous ratio tiers ──────────────────────────────────────────────────────

interface Ratios { a: number; b: number; c: number; d1: number; d2: number }

const TIERS: Ratios[][] = [
  // Tier 0 — simple: low-integer ratios, mostly planar or gently 3D loops
  [
    { a:1, b:1, c:2, d1:0.52, d2:0.00 },
    { a:1, b:2, c:1, d1:0.78, d2:0.00 },
    { a:2, b:1, c:1, d1:0.00, d2:0.52 },
    { a:1, b:2, c:3, d1:0.52, d2:1.04 },
    { a:2, b:3, c:1, d1:0.00, d2:0.78 },
    { a:3, b:1, c:2, d1:1.04, d2:0.00 },
    { a:2, b:2, c:3, d1:0.52, d2:0.52 },
  ],
  // Tier 1 — medium: 3–5 ratios, genuine 3D interweaving
  [
    { a:1, b:3, c:4, d1:0.42, d2:1.10 },
    { a:3, b:4, c:2, d1:0.70, d2:0.35 },
    { a:4, b:3, c:1, d1:0.00, d2:1.00 },
    { a:2, b:5, c:3, d1:0.90, d2:0.00 },
    { a:5, b:3, c:2, d1:0.52, d2:0.78 },
    { a:3, b:2, c:5, d1:1.20, d2:0.42 },
    { a:4, b:5, c:3, d1:0.35, d2:1.05 },
  ],
  // Tier 2 — complex: larger coprime ratios → intricate space knots
  [
    { a:3, b:5, c:7, d1:0.60, d2:1.20 },
    { a:5, b:7, c:3, d1:0.90, d2:0.30 },
    { a:7, b:3, c:5, d1:0.30, d2:0.90 },
    { a:5, b:3, c:8, d1:1.10, d2:0.50 },
    { a:3, b:8, c:5, d1:0.50, d2:1.10 },
    { a:7, b:5, c:3, d1:0.70, d2:1.30 },
    { a:5, b:8, c:7, d1:1.30, d2:0.70 },
  ],
];

const LISSAJOUS_R = 55; // bounding radius

// ── Build a single tube geometry along a Lissajous curve ─────────────────────

function buildTubeGeo(r: Ratios): THREE.BufferGeometry {
  const nPath    = isMobile ?  60 : 150;
  const nTubular = isMobile ?  70 : 200;
  const nRadial  = isMobile ?   6 :  10;
  const tubeR    = isMobile ? 1.5 : 2.5;

  const pts: THREE.Vector3[] = [];
  for (let i = 0; i < nPath; i++) {
    const t = (i / nPath) * Math.PI * 2;
    pts.push(new THREE.Vector3(
      LISSAJOUS_R * Math.sin(r.a * t + r.d1),
      LISSAJOUS_R * Math.sin(r.b * t + r.d2),
      LISSAJOUS_R * Math.sin(r.c * t),
    ));
  }

  const curve = new THREE.CatmullRomCurve3(pts, true, 'centripetal', 0.5);
  return new THREE.TubeGeometry(curve, nTubular, tubeR, nRadial, true);
}

// ── Build / rebuild all 7 tube meshes ────────────────────────────────────────

function buildTubes(tier: number): void {
  if (!scene) return;
  for (const m of tubes) { m.geometry.dispose(); scene.remove(m); }
  for (const mat of tubeMats) mat.dispose();
  tubes.length = 0;
  tubeMats.length = 0;

  for (let k = 0; k < 7; k++) {
    const col = TUBE_COLORS[k]!.clone();
    const mat = new THREE.MeshStandardMaterial({
      color: col.clone().multiplyScalar(0.12),
      emissive: col,
      emissiveIntensity: 0.05,
      roughness: 0.15,
      metalness: 0.45,
    });
    tubeMats.push(mat);
    const geo = buildTubeGeo(TIERS[tier]![k]!);
    const mesh = new THREE.Mesh(geo, mat);
    scene.add(mesh);
    tubes.push(mesh);
  }
}

// ── Setup ─────────────────────────────────────────────────────────────────────

function setup(): void {
  threeCanvas = document.createElement('canvas');
  threeCanvas.style.cssText =
    'position:fixed;top:0;left:0;width:100%;height:100%;z-index:10;pointer-events:none;display:block';
  document.body.appendChild(threeCanvas);

  renderer = new THREE.WebGLRenderer({ canvas: threeCanvas, antialias: !isMobile, alpha: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, isMobile ? 1 : 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x020208);

  camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 800);
  camera.position.set(0, 40, 185);
  camera.lookAt(0, 0, 0);

  // Very dim ambient so dark-side tubes aren't invisible
  scene.add(new THREE.AmbientLight(0x0d0d1a, 0.9));

  // Warm tungsten key light — orbits the sculpture
  keyLight = new THREE.DirectionalLight(0xffd5aa, 2.2);
  keyLight.position.set(100, 70, 60);
  scene.add(keyLight);

  // Cool steel-blue fill — stationary behind camera
  const fill = new THREE.DirectionalLight(0x6688cc, 0.55);
  fill.position.set(-80, 20, -60);
  scene.add(fill);

  // Post-processing
  const res = new THREE.Vector2(window.innerWidth, window.innerHeight);
  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  if (!isMobile) composer.addPass(new UnrealBloomPass(res, 0.8, 0.5, 0.2));
  composer.addPass(new OutputPass());

  vizModeUnsub = store.on('vizModeChange', (data) => {
    if (!threeCanvas) return;
    threeCanvas.style.display = data === 'loop' ? 'block' : 'none';
  });

  initialized = true;
}

// ── Draw (called by p5 render loop at ~60 fps) ────────────────────────────────

export function drawLoop(_p: unknown, dt: number): void {
  if (!initialized) setup();

  time += dt * 0.016;

  const cfg   = store.config;
  const { amps } = getBandAverages(7);

  // Structural: rebuild tube geometry when form tier changes
  const tier = Math.min(2, Math.floor(cfg.loopForm * 3));
  if (tier !== lastFormTier) {
    lastFormTier = tier;
    buildTubes(tier);
  }

  // Beat detection
  const { state } = store;
  if (state.beatIntervalSec > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adj = pos - state.beatOffset;
    const beatIdx = adj >= 0 ? Math.floor(adj / state.beatIntervalSec) : -1;
    if (beatIdx > lastBeatIndex) {
      lastBeatIndex = beatIdx;
      beatPulse = 1.0;
    }
  }
  beatPulse *= Math.pow(0.90, dt);

  // Per-tube glow — CHOP-style continuous lerp toward audio amplitude
  const glowMult = 0.3 + cfg.loopGlow * 2.0;
  for (let k = 0; k < 7; k++) {
    const target = amps[k] ?? 0;
    const alpha = 1 - Math.exp(-0.15 * dt);
    smoothedGlow[k] += (target - smoothedGlow[k]) * alpha;
    const mat = tubeMats[k];
    if (mat) mat.emissiveIntensity = 0.04 + smoothedGlow[k] * 2.5 * glowMult;
  }

  // Key light: orbit sculpture + beat flash
  const driftSpeed = 0.4 + cfg.loopDrift * 1.5;
  lightTheta += dt * 0.001 * driftSpeed * 0.65;
  if (keyLight) {
    keyLight.position.set(100 * Math.sin(lightTheta), 70, 80 * Math.cos(lightTheta));
    keyLight.intensity = 2.0 + beatPulse * 1.8;
  }

  // Camera: slow orbit with gentle altitude oscillation
  cameraTheta += dt * 0.001 * driftSpeed;
  if (camera) {
    const camY = 35 + 20 * Math.sin(time * 0.18);
    camera.position.set(
      Math.sin(cameraTheta) * 185,
      camY,
      Math.cos(cameraTheta) * 185,
    );
    camera.lookAt(0, 0, 0);
  }

  // Bloom strength tracks Glow slider
  if (!isMobile && composer && composer.passes.length >= 3) {
    const bloom = composer.passes[1] as InstanceType<typeof UnrealBloomPass>;
    if (bloom) bloom.strength = 0.3 + cfg.loopGlow * 1.5;
  }

  composer?.render();
}

// ── Reset (resize) ────────────────────────────────────────────────────────────

export function resetLoop(): void {
  if (!initialized) return;
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer?.setSize(w, h);
  if (camera) { camera.aspect = w / h; camera.updateProjectionMatrix(); }
  composer?.setSize(w, h);
}

// ── Dispose ───────────────────────────────────────────────────────────────────

export function disposeLoop(): void {
  if (!initialized) return;
  vizModeUnsub?.();
  vizModeUnsub = null;
  if (scene) {
    for (const m of tubes) { m.geometry.dispose(); scene.remove(m); }
    for (const mat of tubeMats) mat.dispose();
  }
  tubes.length = 0;
  tubeMats.length = 0;
  composer?.dispose();
  renderer?.dispose();
  threeCanvas?.remove();
  threeCanvas = null;
  renderer = null;
  scene = null;
  camera = null;
  composer = null;
  keyLight = null;
  time = 0;
  cameraTheta = 0;
  lightTheta = 0;
  beatPulse = 0;
  lastBeatIndex = -1;
  lastFormTier = -1;
  smoothedGlow.fill(0);
  initialized = false;
}
