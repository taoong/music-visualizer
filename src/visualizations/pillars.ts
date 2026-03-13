/**
 * Frequency Pillars — Three.js WebGL overlay visualization
 * 7 glowing pillars arranged in a circle, each permanently assigned to a
 * frequency band. Height driven by amplitude. Beat → flash + ring shockwave +
 * particle bursts from pillar tops.
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { store } from '../state/store';
import { getBandAverages } from './helpers';
import { audioEngine } from '../audio/engine';

// ── Constants ─────────────────────────────────────────────────────────────────

const PILLAR_RADIUS        = 70;   // circle radius the 7 pillars sit on
const PILLAR_W             = 8;    // box width (X)
const PILLAR_D             = 8;    // box depth (Z)
const PILLAR_MIN_H         = 5;    // height at zero amplitude
const PILLAR_MAX_H         = 120;  // height at full amplitude
const PARTICLES_PER_PILLAR = 20;
const TOTAL_PARTICLES      = 140;  // 7 × 20

// Per-band emissive colors
const BAND_COLORS = [
  0xaa44ff, // 0 Sub       – violet
  0x4466ff, // 1 Bass      – blue
  0x00ddff, // 2 Low-Mid   – cyan
  0x00ff88, // 3 Mid       – green
  0xffff00, // 4 Upper-Mid – yellow
  0xff8800, // 5 Presence  – orange
  0xff2244, // 6 Brilliance– red
] as const;

// ── Module state ──────────────────────────────────────────────────────────────

let initialized    = false;
let threeCanvas    : HTMLCanvasElement | null = null;
let renderer       : THREE.WebGLRenderer | null = null;
let scene          : THREE.Scene | null = null;
let camera         : THREE.PerspectiveCamera | null = null;
let composer       : EffectComposer | null = null;
let vizModeUnsub   : (() => void) | null = null;

let pillarMeshes   : THREE.Mesh[] = [];
let pillarMaterials: THREE.MeshStandardMaterial[] = [];
let floorMesh      : THREE.Mesh | null = null;
let ringMesh       : THREE.Mesh | null = null;
let ringMaterial   : THREE.MeshBasicMaterial | null = null;
let particleMeshes : THREE.Mesh[] = [];
let particleMaterials: THREE.MeshBasicMaterial[] = [];
let particleGeo    : THREE.IcosahedronGeometry | null = null;

// Particle physics — parallel Float32Arrays for cache efficiency
const pVelX    = new Float32Array(TOTAL_PARTICLES);
const pVelY    = new Float32Array(TOTAL_PARTICLES);
const pVelZ    = new Float32Array(TOTAL_PARTICLES);
const pLife    = new Float32Array(TOTAL_PARTICLES);    // countdown; 0 = dead
const pMaxLife = new Float32Array(TOTAL_PARTICLES);    // initial life for opacity lerp

let lastBeatIndex = -1;
let beatFlash     = 0;
let beatRingScale = 0;
let beatRingAlpha = 0;
let cameraTheta   = 0;

// ── Setup ─────────────────────────────────────────────────────────────────────

function setup(): void {
  // Overlay canvas (same CSS pattern as neon.ts / liquidmetal.ts)
  threeCanvas = document.createElement('canvas');
  threeCanvas.style.cssText =
    'position:fixed;top:0;left:0;width:100%;height:100%;z-index:10;pointer-events:none;display:block';
  document.body.appendChild(threeCanvas);

  // Renderer
  renderer = new THREE.WebGLRenderer({ canvas: threeCanvas, antialias: true, alpha: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  // Scene
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);
  scene.fog = new THREE.FogExp2(0x000000, 0.004);

  // Camera — elevated angle showing the full pillar circle + floor
  camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 1000);
  camera.position.set(0, 110, 160);
  camera.lookAt(0, 30, 0);

  // Lights
  scene.add(new THREE.AmbientLight(0x111111, 0.6));

  const pointLight = new THREE.PointLight(0xffffff, 1.2, 300);
  pointLight.position.set(0, 80, 0);
  scene.add(pointLight);

  const dirLight = new THREE.DirectionalLight(0x3333aa, 0.4);
  dirLight.position.set(0, -50, -100); // below-back
  scene.add(dirLight);

  // Reflective floor
  const floorGeo = new THREE.PlaneGeometry(500, 500);
  const floorMat = new THREE.MeshStandardMaterial({
    color: 0x111111,
    metalness: 0.8,
    roughness: 0.2,
  });
  floorMesh = new THREE.Mesh(floorGeo, floorMat);
  floorMesh.rotation.x = -Math.PI / 2;
  scene.add(floorMesh);

  // Beat ring — expands outward on each beat
  const ringGeo = new THREE.RingGeometry(2, 5, 64);
  ringMaterial = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  ringMesh = new THREE.Mesh(ringGeo, ringMaterial);
  ringMesh.rotation.x = -Math.PI / 2;
  ringMesh.position.y = 0.5;
  scene.add(ringMesh);

  // 7 pillars arranged in a circle
  pillarMeshes = [];
  pillarMaterials = [];
  for (let i = 0; i < 7; i++) {
    const angle = (i / 7) * Math.PI * 2;
    const color = BAND_COLORS[i];

    // BoxGeometry height=1; translate so pivot is at base (bottom Y=0, top Y=scale.y)
    const geo = new THREE.BoxGeometry(PILLAR_W, 1, PILLAR_D);
    geo.translate(0, 0.5, 0);

    const mat = new THREE.MeshStandardMaterial({
      color,
      emissive: color,
      emissiveIntensity: 0.3,
      metalness: 0.3,
      roughness: 0.6,
    });

    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(
      Math.cos(angle) * PILLAR_RADIUS,
      0,
      Math.sin(angle) * PILLAR_RADIUS,
    );
    mesh.scale.y = PILLAR_MIN_H;
    scene.add(mesh);
    pillarMeshes.push(mesh);
    pillarMaterials.push(mat);
  }

  // Particle pool — shared geometry, individual materials (one per particle)
  particleGeo = new THREE.IcosahedronGeometry(0.8, 0);
  particleMeshes = [];
  particleMaterials = [];
  for (let i = 0; i < TOTAL_PARTICLES; i++) {
    const band = Math.floor(i / PARTICLES_PER_PILLAR);
    const mat = new THREE.MeshBasicMaterial({
      color: BAND_COLORS[band],
      transparent: true,
      opacity: 0,
    });
    const mesh = new THREE.Mesh(particleGeo, mat);
    mesh.position.y = -500; // parked off-screen
    scene.add(mesh);
    particleMeshes.push(mesh);
    particleMaterials.push(mat);
  }

  // Post-processing: RenderPass → UnrealBloomPass (idx 1) → OutputPass
  const res = new THREE.Vector2(window.innerWidth, window.innerHeight);
  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  composer.addPass(new UnrealBloomPass(res, 1.5, 0.4, 0.1));
  composer.addPass(new OutputPass());

  // Hide canvas when switching away from this viz
  vizModeUnsub = store.on('vizModeChange', (data) => {
    if (!threeCanvas) return;
    threeCanvas.style.display = data === 'pillars' ? 'block' : 'none';
  });

  initialized = true;
}

// ── Beat handler ──────────────────────────────────────────────────────────────

function onBeat(amps: number[]): void {
  beatFlash = 1.0;
  beatRingScale = 1.0;
  beatRingAlpha = 0.85;

  // Tint ring to the dominant band's color
  const maxIdx = amps.reduce((best, a, i, arr) => (a > arr[best] ? i : best), 0);
  if (ringMaterial) ringMaterial.color.setHex(BAND_COLORS[maxIdx]);

  // Burst particles from each pillar top
  for (let b = 0; b < 7; b++) {
    const mesh = pillarMeshes[b];
    if (!mesh) continue;
    const px  = mesh.position.x;
    const pz  = mesh.position.z;
    const topY = mesh.scale.y; // pivot at base → top Y = scale.y

    for (let k = 0; k < PARTICLES_PER_PILLAR; k++) {
      const idx = b * PARTICLES_PER_PILLAR + k;
      if (pLife[idx] > 0) continue; // already alive — skip
      const pm = particleMeshes[idx];
      if (!pm) continue;

      pm.position.set(
        px + (Math.random() - 0.5) * PILLAR_W,
        topY,
        pz + (Math.random() - 0.5) * PILLAR_D,
      );
      pVelX[idx] = (Math.random() - 0.5) * 1.5;
      pVelY[idx] = 3 + Math.random() * 3;
      pVelZ[idx] = (Math.random() - 0.5) * 1.5;
      pLife[idx]    = 0.5 + Math.random() * 0.5;
      pMaxLife[idx] = pLife[idx];
    }
  }
}

// ── Draw (called by p5 draw loop at ~60fps) ───────────────────────────────────

export function drawPillars(_p: unknown, dt: number): void {
  if (!initialized) setup();

  const { amps } = getBandAverages(7);
  const { state } = store;

  // Beat detection (same guard pattern as neon.ts)
  if (state.beatIntervalSec > 0 && state.isPlaying) {
    const pos      = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    const beatIdx  = adjusted >= 0 ? Math.floor(adjusted / state.beatIntervalSec) : -1;
    if (beatIdx > lastBeatIndex) {
      lastBeatIndex = beatIdx;
      onBeat(amps);
    }
  }

  // Decay beat effects
  beatFlash     *= Math.pow(0.88, dt);
  beatRingAlpha *= Math.pow(0.90, dt);
  beatRingScale += dt * 6;

  // Update pillar heights and emissive glow
  for (let i = 0; i < 7; i++) {
    const mesh = pillarMeshes[i];
    const mat  = pillarMaterials[i];
    if (!mesh || !mat) continue;

    const amp     = amps[i] ?? 0;
    const targetH = PILLAR_MIN_H + amp * (PILLAR_MAX_H - PILLAR_MIN_H);
    mesh.scale.y += (targetH - mesh.scale.y) * 0.3 * dt; // fast lerp — amps already smoothed

    mat.emissiveIntensity = Math.max(0, Math.min(3, 0.3 + amp * 1.8 + beatFlash * 0.8));
  }

  // Update beat ring
  if (ringMesh && ringMaterial) {
    ringMesh.scale.setScalar(Math.min(beatRingScale, 90));
    ringMaterial.opacity = Math.max(0, beatRingAlpha);
  }

  // Update particles
  for (let i = 0; i < TOTAL_PARTICLES; i++) {
    if (pLife[i] <= 0) continue;

    pLife[i] -= dt * 0.016;
    pVelY[i] -= 0.015 * dt; // gravity

    const pm   = particleMeshes[i];
    const pmat = particleMaterials[i];
    if (!pm || !pmat) continue;

    pm.position.x += pVelX[i] * dt;
    pm.position.y += pVelY[i] * dt;
    pm.position.z += pVelZ[i] * dt;

    if (pLife[i] <= 0) {
      pm.position.y = -500;
      pmat.opacity  = 0;
    } else {
      pmat.opacity = pLife[i] / pMaxLife[i];
    }
  }

  // Camera orbit — slow rotation around the pillar circle
  if (camera) {
    cameraTheta          += dt * 0.0003 * store.config.rotationSpeed;
    camera.position.x     = Math.sin(cameraTheta) * 160;
    camera.position.z     = Math.cos(cameraTheta) * 160;
    camera.position.y     = 110;
    camera.lookAt(0, 30, 0);
  }

  // Bloom strength from intensity slider (UnrealBloomPass is at index 1)
  if (composer && composer.passes[1]) {
    (composer.passes[1] as UnrealBloomPass).strength = 1.5 * store.config.intensity;
  }

  composer?.render();
}

// ── Reset (called on window resize) ──────────────────────────────────────────

export function resetPillars(): void {
  if (!initialized) return;
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer?.setSize(w, h);
  if (camera) { camera.aspect = w / h; camera.updateProjectionMatrix(); }
  composer?.setSize(w, h);
}

// ── Dispose (called on page unload) ──────────────────────────────────────────

export function disposePillars(): void {
  if (!initialized) return;
  vizModeUnsub?.();
  vizModeUnsub = null;

  for (const m of pillarMeshes) m.geometry.dispose();
  for (const mat of pillarMaterials) mat.dispose();
  floorMesh?.geometry.dispose();
  (floorMesh?.material as THREE.Material | undefined)?.dispose();
  ringMesh?.geometry.dispose();
  ringMaterial?.dispose();
  particleGeo?.dispose();                    // shared geometry — dispose once
  for (const mat of particleMaterials) mat.dispose();

  composer?.dispose();
  renderer?.dispose();
  threeCanvas?.remove();

  threeCanvas = null; renderer = null; scene = null; camera = null;
  composer = null; floorMesh = null; ringMesh = null; ringMaterial = null;
  pillarMeshes = []; pillarMaterials = [];
  particleMeshes = []; particleMaterials = []; particleGeo = null;

  pVelX.fill(0); pVelY.fill(0); pVelZ.fill(0); pLife.fill(0); pMaxLife.fill(0);
  lastBeatIndex = -1; beatFlash = 0; beatRingScale = 0; beatRingAlpha = 0; cameraTheta = 0;
  initialized = false;
}
