/**
 * Chrome — polished mirror-sphere field
 *
 * N chrome balls in a staggered two-row hex grid; each maps to a frequency
 * band whose amplitude drives continuous CHOP-style scale/lift easing; warm
 * amber key + cool steel fill studio rig; PMREMGenerator gradient env map
 * gives convincing mirror reflections; camera orbits slowly at ~20° elevation.
 *
 * Inspired by Anish Kapoor "Cloud Gate" (2006, Millennium Park, Chicago) —
 * the 110-ton polished stainless-steel bean sculpture whose seamless surface
 * distorts and multiplies the cityscape in mercury-like reflections.
 * https://en.wikipedia.org/wiki/Cloud_Gate
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

// ── Module state ──────────────────────────────────────────────────────────────

let initialized = false;
let threeCanvas: HTMLCanvasElement | null = null;
let renderer: THREE.WebGLRenderer | null = null;
let scene: THREE.Scene | null = null;
let camera: THREE.PerspectiveCamera | null = null;
let composer: EffectComposer | null = null;
let vizModeUnsub: (() => void) | null = null;

let chromeMat: THREE.MeshStandardMaterial | null = null;
let floorMat: THREE.MeshStandardMaterial | null = null;
let floorMesh: THREE.Mesh | null = null;
let envMapRT: THREE.WebGLRenderTarget | null = null;

const MAX_COUNT = isMobile ? 6 : 12;
const sphereMeshes: THREE.Mesh[] = [];
const currentScales = new Float32Array(MAX_COUNT).fill(0.9);

let time = 0;
let cameraTheta = 0;
let lastBeatIndex = -1;
let beatKick = 0;

// ── Staggered hex-grid base positions ────────────────────────────────────────
// Two-row offset layout — deliberately non-radial to break house style.

const DESKTOP_POSITIONS: Array<[number, number, number]> = [
  [-2.7, 0,  1.1], [-0.9, 0,  1.1], [ 0.9, 0,  1.1], [ 2.7, 0,  1.1],
  [-1.8, 0, -0.5], [ 0.0, 0, -0.5], [ 1.8, 0, -0.5], [ 3.6, 0, -0.5],
  [-2.7, 0, -2.1], [-0.9, 0, -2.1], [ 0.9, 0, -2.1], [ 2.7, 0, -2.1],
];

const MOBILE_POSITIONS: Array<[number, number, number]> = [
  [-1.8, 0,  0.9], [ 0.0, 0,  0.9], [ 1.8, 0,  0.9],
  [-0.9, 0, -0.9], [ 0.9, 0, -0.9], [ 2.7, 0, -0.9],
];

const BASE_POSITIONS = isMobile ? MOBILE_POSITIONS : DESKTOP_POSITIONS;

// ── Gradient environment map (warm amber / cool steel studio) ─────────────────

function createEnvTexture(): THREE.DataTexture {
  const W = 256;
  const H = 128;
  const data = new Uint8Array(W * H * 4);

  for (let y = 0; y < H; y++) {
    const fy = y / (H - 1);
    // Brightness peaks at the horizon (fy ≈ 0.5), dark at top/bottom
    const vFalloff = Math.exp(-Math.pow((fy - 0.5) * 4.5, 2));

    for (let x = 0; x < W; x++) {
      const fx = x / (W - 1); // equirectangular: 0=left, 0.5=right, wraps

      // Warm amber lobe at fx ≈ 0.15 (front-right), mirror at fx ≈ 1.15
      const warmA = Math.exp(-Math.pow((fx - 0.15) * 5.0, 2))
                  + Math.exp(-Math.pow((fx - 1.15) * 5.0, 2));
      // Cool steel-blue lobe at fx ≈ 0.65 (back-left)
      const coolA  = Math.exp(-Math.pow((fx - 0.65) * 5.0, 2));

      const r = (90 * warmA + 18 * coolA + 7)  * vFalloff * 0.85;
      const g = (55 * warmA + 30 * coolA + 7)  * vFalloff * 0.85;
      const b = (14 * warmA + 72 * coolA + 10) * vFalloff * 0.85;

      const i = (y * W + x) * 4;
      data[i]     = Math.min(255, Math.round(r));
      data[i + 1] = Math.min(255, Math.round(g));
      data[i + 2] = Math.min(255, Math.round(b));
      data[i + 3] = 255;
    }
  }

  const tex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.needsUpdate = true;
  return tex;
}

// ── Setup ─────────────────────────────────────────────────────────────────────

function setup(): void {
  threeCanvas = document.createElement('canvas');
  threeCanvas.style.cssText =
    'position:fixed;top:0;left:0;width:100%;height:100%;z-index:10;pointer-events:none;display:block';
  document.body.appendChild(threeCanvas);

  renderer = new THREE.WebGLRenderer({ canvas: threeCanvas, antialias: !isMobile, alpha: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, isMobile ? 1.0 : 2.0));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.4;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x08080c);
  scene.fog = new THREE.FogExp2(0x08080c, 0.03);

  camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 100);
  camera.position.set(0, 4.5, 12);
  camera.lookAt(0, 0, 0);

  // Build gradient env map via PMREMGenerator
  const rawEnv = createEnvTexture();
  const pmrem = new THREE.PMREMGenerator(renderer);
  envMapRT = pmrem.fromEquirectangular(rawEnv);
  rawEnv.dispose();
  pmrem.dispose();
  scene.environment = envMapRT.texture;

  // Warm amber key light + cool steel fill + dim ambient
  const keyLight = new THREE.DirectionalLight(0xffd08a, 2.8);
  keyLight.position.set(5, 7, 4);
  scene.add(keyLight);
  const fillLight = new THREE.DirectionalLight(0x8090c8, 0.7);
  fillLight.position.set(-4, 3, -5);
  scene.add(fillLight);
  scene.add(new THREE.AmbientLight(0x101018, 0.5));

  // Shared chrome material (roughness updated from slider each frame)
  chromeMat = new THREE.MeshStandardMaterial({
    metalness: 1.0,
    roughness: 0.04,
    envMap: envMapRT.texture,
    envMapIntensity: 1.0,
    color: 0xffffff,
  });

  // Sphere meshes — all share one geometry
  const segs = isMobile ? 32 : 64;
  const sphereGeo = new THREE.SphereGeometry(0.65, segs, segs);

  for (let i = 0; i < MAX_COUNT; i++) {
    const mesh = new THREE.Mesh(sphereGeo, chromeMat);
    const pos = BASE_POSITIONS[i] ?? [0, 0, 0];
    mesh.position.set(pos[0], pos[1], pos[2]);
    mesh.visible = false;
    scene.add(mesh);
    sphereMeshes.push(mesh);
  }

  // Dark floor plane with subtle specular
  floorMat = new THREE.MeshStandardMaterial({
    color: 0x0d0d14,
    metalness: 0.1,
    roughness: 0.9,
    envMap: envMapRT.texture,
    envMapIntensity: 0.3,
  });
  floorMesh = new THREE.Mesh(new THREE.PlaneGeometry(28, 20), floorMat);
  floorMesh.rotation.x = -Math.PI / 2;
  floorMesh.position.y = -0.65;
  scene.add(floorMesh);

  // Post-processing: subtle bloom for specular bleed
  const res = new THREE.Vector2(window.innerWidth, window.innerHeight);
  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(res, 0.5, 0.4, 0.65);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  vizModeUnsub = store.on('vizModeChange', (data) => {
    if (!threeCanvas) return;
    threeCanvas.style.display = data === 'chrome' ? 'block' : 'none';
  });

  initialized = true;
}

// ── Draw (called by p5 draw loop at ~60fps) ───────────────────────────────────

export function drawChrome(_p: unknown, dt: number): void {
  if (!initialized) setup();

  time += dt * 0.016;

  const { amps } = getBandAverages(7);
  const cfg = store.config;

  // Count slider → visible sphere count (structural)
  const count = Math.max(1, Math.round(1 + cfg.chromeCount * (MAX_COUNT - 1)));

  // Roughness slider → material character (structural)
  if (chromeMat) chromeMat.roughness = cfg.chromeRoughness * 0.30;

  // Beat detection
  const { state } = store;
  if (state.beatIntervalSec > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adj = pos - state.beatOffset;
    const beatIdx = adj >= 0 ? Math.floor(adj / state.beatIntervalSec) : -1;
    if (beatIdx > lastBeatIndex) {
      lastBeatIndex = beatIdx;
      beatKick = 0.30;
    }
  }
  // Beat kick decays exponentially — frame-rate independent
  beatKick *= Math.pow(0.87, dt);

  // Overall amplitude for camera speed modulation
  let overallAmp = 0;
  for (let i = 0; i < 7; i++) overallAmp += amps[i] ?? 0;
  overallAmp /= 7;

  // Update spheres: CHOP-style continuous lerp toward audio-driven target
  for (let i = 0; i < MAX_COUNT; i++) {
    const mesh = sphereMeshes[i];
    if (!mesh) continue;
    mesh.visible = i < count;
    if (!mesh.visible) continue;

    const bandIdx = i % 7;
    const amp = amps[bandIdx] ?? 0;
    const liftRange = 0.5 + cfg.chromeLift * 0.9;    // 0.5–1.4
    const targetScale = 0.8 + amp * liftRange + beatKick;

    // Smooth lerp — rate proportional to dt so it's frame-rate independent
    const lerpRate = Math.min(1, 0.09 * dt);
    currentScales[i] = currentScales[i]! + (targetScale - currentScales[i]!) * lerpRate;

    const s = currentScales[i]!;
    mesh.scale.set(s, s, s);

    // Gentle Y lift proportional to amplitude
    const baseY = BASE_POSITIONS[i]?.[1] ?? 0;
    mesh.position.y = baseY + amp * 0.25 * cfg.chromeLift;
  }

  // Camera: slow elliptical orbit at ~20° elevation
  cameraTheta += dt * (0.00035 + overallAmp * 0.00015);
  if (camera) {
    const R = 12;
    camera.position.x = Math.sin(cameraTheta) * R;
    camera.position.y = 4.0 + Math.sin(time * 0.28) * 0.6;  // gentle handheld sway
    camera.position.z = Math.cos(cameraTheta) * R * 0.85;    // slightly elliptical
    camera.lookAt(0, 0, 0);
  }

  if (composer) {
    // Subtle bloom scaled by amplitude
    const bloomPass = composer.passes[1] as InstanceType<typeof UnrealBloomPass>;
    if (bloomPass) bloomPass.strength = 0.3 + overallAmp * 0.5;
    composer.render();
  }
}

// ── Reset (resize) ────────────────────────────────────────────────────────────

export function resetChrome(): void {
  if (!initialized) return;
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer?.setSize(w, h);
  if (camera) { camera.aspect = w / h; camera.updateProjectionMatrix(); }
  composer?.setSize(w, h);
}

// ── Dispose ───────────────────────────────────────────────────────────────────

export function disposeChrome(): void {
  if (!initialized) return;
  vizModeUnsub?.();
  vizModeUnsub = null;

  // Dispose shared sphere geometry (all meshes reference the same instance)
  if (sphereMeshes.length > 0) sphereMeshes[0]?.geometry.dispose();
  sphereMeshes.length = 0;

  chromeMat?.dispose();
  chromeMat = null;
  floorMesh?.geometry.dispose();
  floorMat?.dispose();
  floorMesh = null;
  floorMat = null;

  envMapRT?.dispose();  // also disposes envMapRT.texture
  envMapRT = null;

  composer?.dispose();
  renderer?.dispose();
  threeCanvas?.remove();

  threeCanvas = null;
  renderer = null;
  scene = null;
  camera = null;
  composer = null;

  time = 0;
  cameraTheta = 0;
  lastBeatIndex = -1;
  beatKick = 0;
  currentScales.fill(0.9);
  initialized = false;
}
