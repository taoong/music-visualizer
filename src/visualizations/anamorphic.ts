/**
 * Anamorphic — Three.js WebGL overlay visualization
 * 7 torus rings arranged for anamorphic perspective: they appear as perfect
 * concentric circles from one camera position (θ ≈ 0); camera orbiting
 * around Y reveals the true 3D depth stack. Inspired by Georges Rousse and
 * Felice Varini room-scale geometric anamorphoses.
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

const NUM_RINGS = 7;
const CAM_ORBIT_RADIUS = 14;
const Z_MID = 4.5;
const FOV = 55;
// Apparent screen-radii of the rings when viewed from alignment position
const SCREEN_RADII = [0.50, 0.75, 1.05, 1.40, 1.80, 2.25, 2.75];
// Max Z spread for depth=1; ring i sits at Z_POSITIONS_MAX[i]
const Z_POSITIONS_MAX: number[] = new Array(NUM_RINGS)
  .fill(0)
  .map((_, i) => i * (9.0 / (NUM_RINGS - 1)));
// Camera-to-pivot distance at θ=0 (reference depth for perspective formula)
const CAM_REF_DEPTH = CAM_ORBIT_RADIUS - Z_MID; // 9.5

// Warm amber → cool ice-blue gradient across bands (no rainbow hue-jump)
const RING_COLORS = [
  new THREE.Color(1.00, 0.65, 0.30), // 0 warm amber        (sub-bass)
  new THREE.Color(0.95, 0.60, 0.40), // 1 amber-orange
  new THREE.Color(0.90, 0.55, 0.60), // 2 warm rose
  new THREE.Color(0.75, 0.55, 0.75), // 3 neutral violet
  new THREE.Color(0.60, 0.60, 0.90), // 4 soft periwinkle
  new THREE.Color(0.50, 0.65, 1.00), // 5 cool sky-blue
  new THREE.Color(0.40, 0.75, 1.00), // 6 ice blue          (brilliance)
];

const TUBE_RADIUS   = 0.045;
const RADIAL_SEGS   = isMobile ? 20 : 36;
const TUBULAR_SEGS  = isMobile ? 60 : 120;

// Module-scoped state (no classes)
let initialized = false;
let threeCanvas: HTMLCanvasElement | null = null;
let renderer: THREE.WebGLRenderer | null = null;
let scene: THREE.Scene | null = null;
let camera: THREE.PerspectiveCamera | null = null;
let composer: EffectComposer | null = null;
let bloomPass: InstanceType<typeof UnrealBloomPass> | null = null;
let vizModeUnsub: (() => void) | null = null;
const ringMeshes: THREE.Mesh[] = [];
const ringMats: THREE.MeshStandardMaterial[] = [];
let theta = 0;
let beatKick = 0;
let lastBeatIndex = -1;

function computeWorldRadius(ringIndex: number, zPos: number): number {
  const depth = CAM_ORBIT_RADIUS - zPos;
  return SCREEN_RADII[ringIndex] * depth / CAM_REF_DEPTH;
}

function setup(): void {
  threeCanvas = document.createElement('canvas');
  threeCanvas.style.cssText =
    'position:fixed;top:0;left:0;width:100%;height:100%;z-index:10;pointer-events:none;display:block';
  document.body.appendChild(threeCanvas);

  renderer = new THREE.WebGLRenderer({ canvas: threeCanvas, antialias: !isMobile, alpha: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, isMobile ? 1 : 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  scene = new THREE.Scene();

  camera = new THREE.PerspectiveCamera(FOV, window.innerWidth / window.innerHeight, 0.1, 500);
  camera.position.set(0, 0, CAM_ORBIT_RADIUS);
  camera.lookAt(0, 0, Z_MID);

  scene.add(new THREE.AmbientLight(0xffffff, 0.10));
  const keyLight = new THREE.DirectionalLight(0xffd080, 2.5);
  keyLight.position.set(5, 6, 10);
  scene.add(keyLight);
  const fillLight = new THREE.DirectionalLight(0x8090ff, 1.0);
  fillLight.position.set(-6, 2, -5);
  scene.add(fillLight);
  const rimLight = new THREE.DirectionalLight(0xffffff, 0.4);
  rimLight.position.set(0, -4, -8);
  scene.add(rimLight);

  for (let i = 0; i < NUM_RINGS; i++) {
    const geo = new THREE.TorusGeometry(1, TUBE_RADIUS, RADIAL_SEGS, TUBULAR_SEGS);
    const mat = new THREE.MeshStandardMaterial({
      color: RING_COLORS[i],
      emissive: RING_COLORS[i],
      emissiveIntensity: 0.0,
      metalness: 0.15,
      roughness: 0.25,
    });
    const mesh = new THREE.Mesh(geo, mat);
    scene.add(mesh);
    ringMeshes.push(mesh);
    ringMats.push(mat);
  }

  const res = new THREE.Vector2(window.innerWidth, window.innerHeight);
  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  if (!isMobile) {
    bloomPass = new UnrealBloomPass(res, 0.6, 0.4, 0.3);
    composer.addPass(bloomPass);
  }
  composer.addPass(new OutputPass());

  vizModeUnsub = store.on('vizModeChange', (data) => {
    if (!threeCanvas) return;
    threeCanvas.style.display = data === 'anamorphic' ? 'block' : 'none';
  });

  initialized = true;
}

export function drawAnamorphic(_p: unknown, dt: number): void {
  if (!initialized) setup();
  if (!renderer || !scene || !camera || !composer) return;

  const { amps } = getBandAverages(7);
  const cfg = store.config;
  const { state } = store;

  // Beat detection: decaying kick impulse
  if (state.beatIntervalSec > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    const beatIdx = adjusted >= 0 ? Math.floor(adjusted / state.beatIntervalSec) : -1;
    if (beatIdx > lastBeatIndex) {
      lastBeatIndex = beatIdx;
      beatKick = 1.0;
    }
  }
  beatKick *= Math.pow(0.94, dt);

  // Continuous orbit; beat adds a small velocity kick (no state cut)
  theta += dt * 0.015 * cfg.anamorphicFlow + beatKick * 0.012;

  camera.position.set(
    Math.sin(theta) * CAM_ORBIT_RADIUS,
    2.5 * Math.sin(theta * 0.4),
    Math.cos(theta) * CAM_ORBIT_RADIUS
  );
  camera.lookAt(0, 0, Z_MID);

  const depth = cfg.anamorphicDepth;
  const glow  = cfg.anamorphicGlow;

  for (let i = 0; i < NUM_RINGS; i++) {
    // Depth slider interpolates from flat (all at Z_MID) to full 3D spread
    const zTarget = Z_POSITIONS_MAX[i];
    const z = Z_MID + (zTarget - Z_MID) * depth;
    const r = computeWorldRadius(i, z);
    const band = amps[i] ?? 0;
    const ampPulse = 1.0 + band * 0.22;

    ringMeshes[i].position.set(0, 0, z);
    // TorusGeometry has radius=1 by default; scale to world radius
    ringMeshes[i].scale.set(r * ampPulse, r * ampPulse, r * ampPulse);
    ringMats[i].emissiveIntensity = glow * (0.25 + band * 1.8);
  }

  if (bloomPass) {
    bloomPass.strength = 0.15 + glow * 1.1;
  }

  composer.render();
}

export function resetAnamorphic(): void {
  if (!initialized) return;
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer?.setSize(w, h);
  if (camera) { camera.aspect = w / h; camera.updateProjectionMatrix(); }
  composer?.setSize(w, h);
}

export function disposeAnamorphic(): void {
  if (!initialized) return;

  vizModeUnsub?.();
  vizModeUnsub = null;

  for (let i = 0; i < ringMeshes.length; i++) {
    ringMeshes[i].geometry.dispose();
    ringMats[i].dispose();
  }
  ringMeshes.length = 0;
  ringMats.length = 0;

  bloomPass = null;
  composer?.dispose();
  composer = null;
  renderer?.dispose();
  renderer = null;
  threeCanvas?.remove();
  threeCanvas = null;
  scene = null;
  camera = null;

  theta = 0;
  beatKick = 0;
  lastBeatIndex = -1;
  initialized = false;
}
