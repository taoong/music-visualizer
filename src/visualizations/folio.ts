/**
 * Folio — Seven translucent color-gel planes drifting in 3D space
 * Inspired by Olafur Eliasson "Your Colour Memory" (2010, Tanya Bonakdar Gallery)
 * https://olafureliasson.net/archive/artwork/WEK100503/your-colour-memory
 *
 * Additive-blended transparent planes create emergent compound colors where they
 * overlap — the visual language of stage color gels in architectural space.
 * Custom vertex displacement driven by audio makes each plane breathe with the music.
 * Camera follows a continuous Lissajous path, never static; beats fire decaying kicks.
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { store } from '../state/store';
import { getBandAverages, fovForAspect } from './helpers';
import { audioEngine } from '../audio/engine';
import { isMobile } from '../utils/constants';

// ── Palette: warm and cool alternating — NOT rainbow ─────────────────────────

const PLANE_COLORS = [
  0xc05028, // terracotta
  0x1e4878, // deep slate
  0xe88020, // amber
  0x48207a, // plum
  0xb83850, // rose
  0x1a5848, // forest teal
  0xd06818, // burnt orange
];

// Base world-space positions for each plane [x, y, z]
const BASE_POS: [number, number, number][] = [
  [ 0.0,  0.0,  0.0],
  [ 0.6,  0.3, -1.4],
  [-0.4,  0.5, -0.6],
  [ 0.3, -0.4,  0.9],
  [-0.7,  0.0,  1.6],
  [ 0.4,  0.6, -0.3],
  [-0.2, -0.5,  0.5],
];

// Base Euler rotations [rx, ry, rz]
const BASE_ROT: [number, number, number][] = [
  [ 0.00,  0.00,  0.00],
  [ 0.22, -0.28,  0.10],
  [-0.18,  0.32, -0.14],
  [ 0.14, -0.24,  0.18],
  [-0.28,  0.10, -0.09],
  [ 0.19,  0.28,  0.22],
  [-0.10, -0.14,  0.18],
];

// Per-plane drift frequency multipliers
const DRIFT_FREQ = [0.37, 0.53, 0.47, 0.61, 0.43, 0.57, 0.39];
const ROT_RATE   = [3e-4, -4e-4, 3.5e-4, -2.5e-4, 5e-4, -3e-4, 4e-4];

// ── GLSL ──────────────────────────────────────────────────────────────────────

const VERTEX_SHADER = /* glsl */`
  uniform float uTime;
  uniform float uBandAmp;
  uniform float uBeatKick;
  uniform float uWarp;
  varying vec2 vUv;

  float hash2(vec2 p) {
    p = fract(p * vec2(443.897, 441.423));
    p += dot(p.yx, p.xy + 19.19);
    return fract(p.x * p.y);
  }

  float valueNoise2D(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(hash2(i),              hash2(i + vec2(1.0, 0.0)), u.x),
      mix(hash2(i + vec2(0.0, 1.0)), hash2(i + vec2(1.0, 1.0)), u.x),
      u.y
    );
  }

  void main() {
    vUv = uv;
    vec3 pos = position;

    // Two noise octaves at different frequencies and drift speeds
    float n1 = valueNoise2D(pos.xy * 0.75 + uTime * 0.38);
    float n2 = valueNoise2D(pos.xy * 1.50 - uTime * 0.27 + 5.3);
    float noise = n1 * 0.65 + n2 * 0.35;

    // Displace along local Z (plane normal), scaled by audio + beat kick
    float dispAmp = uWarp * (uBandAmp * 0.55 + uBeatKick * 0.25 + 0.04);
    pos.z += (noise * 2.0 - 1.0) * dispAmp;

    gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
  }
`;

const FRAGMENT_SHADER = /* glsl */`
  uniform vec3 uColor;
  uniform float uBandAmp;
  uniform float uBeatKick;
  varying vec2 vUv;

  void main() {
    // Feathered rectangular aperture — soft edge fade
    vec2 d = abs(vUv - 0.5) * 2.0;
    float rect = 1.0 - smoothstep(0.5, 0.98, max(d.x, d.y));

    // Inner luminosity driven by audio amplitude and beat kicks
    float brightness = 0.10 + uBandAmp * 0.65 + uBeatKick * 0.45;

    vec3 col = uColor * brightness;
    float alpha = rect * (0.08 + uBandAmp * 0.28 + uBeatKick * 0.22);

    gl_FragColor = vec4(col, clamp(alpha, 0.0, 0.88));
  }
`;

// ── Types ─────────────────────────────────────────────────────────────────────

interface PlaneUniforms {
  uTime:    THREE.IUniform<number>;
  uBandAmp: THREE.IUniform<number>;
  uBeatKick: THREE.IUniform<number>;
  uColor:   THREE.IUniform<THREE.Color>;
  uWarp:    THREE.IUniform<number>;
  [key: string]: THREE.IUniform<unknown>;
}

// ── Module state ──────────────────────────────────────────────────────────────

let threeCanvas: HTMLCanvasElement | null = null;
let renderer: THREE.WebGLRenderer | null = null;
let scene: THREE.Scene | null = null;
let camera: THREE.PerspectiveCamera | null = null;
let composer: EffectComposer | null = null;

let planes: THREE.Mesh[] = [];
let planeMaterials: THREE.ShaderMaterial[] = [];
let planeUniforms: PlaneUniforms[] = [];
let driftPhases: number[] = [];
let beatKicks: number[] = [];
let planeBaseX: number[] = [];
let planeBaseY: number[] = [];

let time = 0;
let lastBeatIndex = -1;
let initialized = false;

// ── Setup ─────────────────────────────────────────────────────────────────────

function setup(): void {
  threeCanvas = document.createElement('canvas');
  threeCanvas.style.cssText =
    'position:fixed;top:0;left:0;width:100%;height:100%;z-index:10;pointer-events:none;display:block';
  document.body.appendChild(threeCanvas);

  const dpr = isMobile ? 1 : Math.min(window.devicePixelRatio, 2);
  renderer = new THREE.WebGLRenderer({ canvas: threeCanvas, antialias: !isMobile, alpha: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(dpr);
  renderer.setClearColor(0x000000, 0);
  renderer.sortObjects = true;

  const aspect = window.innerWidth / window.innerHeight;
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(fovForAspect(50, aspect), aspect, 0.1, 100);
  camera.position.set(0, 0, 5.5);

  // Fewer segments on mobile — vertex displacement is lighter
  const segs = isMobile ? 8 : 18;

  for (let i = 0; i < 7; i++) {
    const geo = new THREE.PlaneGeometry(4.2, 3.2, segs, segs);

    const ufm: PlaneUniforms = {
      uTime:     { value: 0.0 },
      uBandAmp:  { value: 0.0 },
      uBeatKick: { value: 0.0 },
      uColor:    { value: new THREE.Color(PLANE_COLORS[i]) },
      uWarp:     { value: 0.5 },
    };
    planeUniforms.push(ufm);

    const mat = new THREE.ShaderMaterial({
      vertexShader:   VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      uniforms:       ufm,
      transparent:    true,
      side:           THREE.DoubleSide,
      blending:       THREE.AdditiveBlending,
      depthWrite:     false,
    });
    planeMaterials.push(mat);

    const mesh = new THREE.Mesh(geo, mat);
    const bp = BASE_POS[i]!;
    const br = BASE_ROT[i]!;
    mesh.position.set(bp[0], bp[1], bp[2]);
    mesh.rotation.set(br[0], br[1], br[2]);

    planeBaseX.push(bp[0]);
    planeBaseY.push(bp[1]);
    driftPhases.push(i * 0.9);
    beatKicks.push(0);

    scene.add(mesh);
    planes.push(mesh);
  }

  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  if (!isMobile) {
    const bloom = new UnrealBloomPass(
      new THREE.Vector2(window.innerWidth, window.innerHeight),
      0.35, 0.6, 0.0
    );
    composer.addPass(bloom);
  }
  composer.addPass(new OutputPass());

  initialized = true;
}

// ── Draw ──────────────────────────────────────────────────────────────────────

export function drawFolio(_p: unknown, dt: number): void {
  if (!initialized) setup();

  const { amps } = getBandAverages(7);
  const driftSpeed  = 0.08 + store.config.folioDrift  * 0.92;
  const warp        = store.config.folioWarp;
  const planesCount = Math.round(3 + store.config.folioPlanes * 4); // 3–7

  time += dt * 0.00035 * driftSpeed;

  // Beat detection
  const { state } = store;
  if (state.beatIntervalSec > 0 && state.isPlaying) {
    const pos     = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    const beatIdx  = adjusted >= 0 ? Math.floor(adjusted / state.beatIntervalSec) : -1;
    if (beatIdx > lastBeatIndex) {
      lastBeatIndex = beatIdx;
      for (let i = 0; i < 7; i++) beatKicks[i] = 1.0;
    }
  }

  for (let i = 0; i < 7; i++) {
    const visible = i < planesCount;
    planes[i]!.visible = visible;
    if (!visible) continue;

    // Decay beat kick
    beatKicks[i]! *= Math.pow(0.86, dt);

    // Drift phase advances continuously
    driftPhases[i]! += dt * driftSpeed * 0.0014 * DRIFT_FREQ[i]!;
    const ph = driftPhases[i]!;

    // Audio-influenced drift target — wider range when louder
    const bandAmp = amps[i] ?? 0;
    const driftAmp = 0.28 + bandAmp * 0.38;
    const targetX = planeBaseX[i]! + Math.sin(ph * 0.37 + i * 2.3) * driftAmp;
    const targetY = planeBaseY[i]! + Math.cos(ph * 0.53 + i * 1.7) * driftAmp * 0.6;

    // Smooth lerp — CHOP-style continuous easing
    const mesh = planes[i]!;
    mesh.position.x += (targetX - mesh.position.x) * 0.025 * dt;
    mesh.position.y += (targetY - mesh.position.y) * 0.025 * dt;

    // Slow continuous rotation — beat kicks add a small angular impulse
    mesh.rotation.y += dt * driftSpeed * ROT_RATE[i]!;
    mesh.rotation.x += dt * driftSpeed * ROT_RATE[i]! * 0.6;

    // Kick: brief rotation impulse, decays with beatKick value
    mesh.rotation.z += beatKicks[i]! * 0.0004 * dt;

    const ufm = planeUniforms[i]!;
    ufm.uTime.value    = time + i * 1.37;
    ufm.uBandAmp.value = bandAmp;
    ufm.uBeatKick.value = beatKicks[i]!;
    ufm.uWarp.value    = warp;
  }

  // Camera on a Lissajous figure-8 path — slow, continuous, never snapping
  if (camera) {
    const camT = time * 0.45;
    camera.position.x = Math.sin(camT)         * 1.6;
    camera.position.y = Math.sin(camT * 1.3 + 0.5) * 0.9;
    camera.position.z = 5.5 + Math.sin(camT * 0.7) * 0.45;
    camera.lookAt(0, 0, 0);
  }

  if (composer) composer.render();
}

// ── Reset ─────────────────────────────────────────────────────────────────────

export function resetFolio(): void {
  if (!initialized) return;
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer?.setSize(w, h);
  if (camera) {
    camera.aspect = w / h;
    camera.fov    = fovForAspect(50, camera.aspect);
    camera.updateProjectionMatrix();
  }
  composer?.setSize(w, h);
}

// ── Dispose ───────────────────────────────────────────────────────────────────

export function disposeFolio(): void {
  if (!initialized) return;
  for (const mesh of planes)   mesh.geometry.dispose();
  for (const mat  of planeMaterials) mat.dispose();
  planes          = [];
  planeMaterials  = [];
  planeUniforms   = [];
  driftPhases     = [];
  beatKicks       = [];
  planeBaseX      = [];
  planeBaseY      = [];
  composer?.dispose();
  renderer?.dispose();
  threeCanvas?.remove();
  threeCanvas = null;
  renderer    = null;
  scene       = null;
  camera      = null;
  composer    = null;
  time            = 0;
  lastBeatIndex   = -1;
  initialized     = false;
}
