/**
 * Stelae — Three.js WebGL overlay visualization.
 * A field of rectangular matte-concrete monoliths viewed from within at human
 * height; 7 frequency bands drive column heights across the grid; a first-
 * person camera traces a slow Lissajous path through the narrow gaps between
 * towering stelae; dramatic directional sidelight, no rainbow palette.
 *
 * Inspired by Peter Eisenman's "Memorial to the Murdered Jews of Europe"
 * (Denkmal für die ermordeten Juden Europas, Berlin, 2005,
 * https://www.stiftung-denkmal.de/en/) — 2711 concrete stelae on undulating
 * ground that visitors walk through, disoriented by changing heights.
 *
 * Sliders: Grid (column density 4–16 per side — structural), Height
 * (amplitude sensitivity), Warmth (light temperature: cool overcast → warm
 * golden hour).
 */
import * as THREE from 'three';
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { isMobile } from '../utils/constants';

// ── Constants ─────────────────────────────────────────────────────────────────

const SPACING      = 1.5;   // centre-to-centre gap between stelae
const STELE_W      = 0.88;  // stele footprint width (X)
const STELE_D      = 0.88;  // stele footprint depth (Z)
const BASE_H       = 0.12;  // minimum height (always visible above ground)
const CAM_EYE_Y    = 2.5;   // eye height above ground
const CAM_FOV      = 70;

// Lissajous camera speeds — ratio ≈ golden, so path never exactly repeats
const LISSA_SX     = 0.095; // radians per normalised dt tick
const LISSA_SZ     = 0.059;

// 7 spectral zone centres in normalised field X (−1 → +1)
const ZONE_X: number[] = [-0.857, -0.571, -0.286, 0.0, 0.286, 0.571, 0.857];
// Gaussian sigma² — each zone covers roughly ⅓ of field width
const SIGMA_SQ = 0.065;

// ── Module state ──────────────────────────────────────────────────────────────

let initialized   = false;
let threeCanvas   : HTMLCanvasElement | null = null;
let renderer      : THREE.WebGLRenderer | null = null;
let scene         : THREE.Scene | null = null;
let camera        : THREE.PerspectiveCamera | null = null;
let vizModeUnsub  : (() => void) | null = null;

let instancedMesh : THREE.InstancedMesh | null = null;
let stelaMat      : THREE.MeshStandardMaterial | null = null;
let groundMesh    : THREE.Mesh | null = null;
let groundMat     : THREE.MeshStandardMaterial | null = null;
let dirLight      : THREE.DirectionalLight | null = null;
let ambLight      : THREE.AmbientLight | null = null;
let sceneFog      : THREE.Fog | null = null;

let lastGridN     = 0;
const dummy       = new THREE.Object3D();

let time          = 0;
let beatFlash     = 0;
let camShakeX     = 0;
let camShakeZ     = 0;
let lastBeatIdx   = -1;

// ── Helpers ───────────────────────────────────────────────────────────────────

function currentGridN(): number {
  // stelaeGrid 0–1 → 4–16
  return Math.max(4, Math.min(16, Math.round(store.config.stelaeGrid * 12 + 4)));
}

function buildField(N: number): void {
  if (!scene || !stelaMat) return;

  if (instancedMesh) {
    instancedMesh.geometry.dispose();
    scene.remove(instancedMesh);
    instancedMesh = null;
  }

  const count   = N * N;
  const geo     = new THREE.BoxGeometry(STELE_W, 1, STELE_D);
  instancedMesh = new THREE.InstancedMesh(geo, stelaMat, count);
  instancedMesh.castShadow    = !isMobile;
  instancedMesh.receiveShadow = !isMobile;
  scene.add(instancedMesh);
  lastGridN = N;

  // Place all instances at base height so no garbage transforms show
  const offset = ((N - 1) * SPACING) / 2;
  for (let iz = 0; iz < N; iz++) {
    for (let ix = 0; ix < N; ix++) {
      const idx = iz * N + ix;
      dummy.position.set(ix * SPACING - offset, BASE_H * 0.5, iz * SPACING - offset);
      dummy.scale.set(1, BASE_H, 1);
      dummy.updateMatrix();
      instancedMesh.setMatrixAt(idx, dummy.matrix);
    }
  }
  instancedMesh.instanceMatrix.needsUpdate = true;
}

function setup(): void {
  threeCanvas = document.createElement('canvas');
  threeCanvas.style.cssText =
    'position:fixed;top:0;left:0;width:100%;height:100%;z-index:10;pointer-events:none;display:block';
  document.body.appendChild(threeCanvas);

  const w = window.innerWidth;
  const h = window.innerHeight;

  renderer = new THREE.WebGLRenderer({
    canvas:    threeCanvas,
    antialias: !isMobile,
    alpha:     true,
  });
  renderer.setSize(w, h);
  renderer.setPixelRatio(isMobile ? 1.0 : Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = !isMobile;
  renderer.shadowMap.type    = THREE.PCFSoftShadowMap;
  renderer.toneMapping       = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x07060a);

  sceneFog    = new THREE.Fog(0x07060a, 6, 36);
  scene.fog   = sceneFog;

  camera = new THREE.PerspectiveCamera(CAM_FOV, w / h, 0.2, 60);
  camera.position.set(0, CAM_EYE_Y, 0);

  // Hemisphere fill — very dim
  ambLight = new THREE.AmbientLight(0x181828, 1.2);
  scene.add(ambLight);

  // Directional key light — rakes across the field from one side
  dirLight = new THREE.DirectionalLight(0xffd090, 2.2);
  dirLight.position.set(14, 20, 5);
  if (!isMobile) {
    dirLight.castShadow       = true;
    dirLight.shadow.mapSize.set(1024, 1024);
    const sc = dirLight.shadow.camera as THREE.OrthographicCamera;
    sc.near = 1; sc.far = 55;
    sc.left = -22; sc.right = 22;
    sc.top  =  22; sc.bottom = -22;
    dirLight.shadow.bias = -0.001;
  }
  scene.add(dirLight);

  // Ground
  groundMat  = new THREE.MeshStandardMaterial({ color: 0x121014, roughness: 1.0, metalness: 0.0 });
  const groundGeo = new THREE.PlaneGeometry(80, 80);
  groundMesh = new THREE.Mesh(groundGeo, groundMat);
  groundMesh.rotation.x = -Math.PI / 2;
  if (!isMobile) groundMesh.receiveShadow = true;
  scene.add(groundMesh);

  // Stele material — matte concrete
  stelaMat = new THREE.MeshStandardMaterial({
    color:     0x7c7c7c,
    roughness: 0.95,
    metalness: 0.02,
  });

  buildField(currentGridN());

  vizModeUnsub = store.on('vizModeChange', () => { disposeStelae(); });
  initialized  = true;
}

// ── Draw ──────────────────────────────────────────────────────────────────────

export function drawStelae(_p: unknown, dt: number): void {
  if (!initialized) setup();
  if (!renderer || !scene || !camera || !instancedMesh || !dirLight || !sceneFog) return;

  const { amps, transients } = getBandAverages(7);
  const cfg   = store.config;
  const state = store.state;

  time += 0.016 * dt;

  // Rebuild InstancedMesh if slider changed the grid
  const N = currentGridN();
  if (N !== lastGridN) buildField(N);

  // ── Beat detection ────────────────────────────────────────────────────────
  if (state.beatIntervalSec > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adj = pos - state.beatOffset;
    const idx = adj >= 0 ? Math.floor(adj / state.beatIntervalSec) : -1;
    if (idx > lastBeatIdx) {
      lastBeatIdx = idx;
      beatFlash   = 1.0;
      camShakeX   = (Math.random() - 0.5) * 0.30;
      camShakeZ   = (Math.random() - 0.5) * 0.14;
    }
  }
  const decay = Math.pow(0.72, dt);
  beatFlash *= decay;
  camShakeX *= decay;
  camShakeZ *= decay;

  // ── Light / atmosphere (Warmth slider) ───────────────────────────────────
  const wm = cfg.stelaeWarmth; // 0 = cool overcast, 1 = warm golden hour
  dirLight.color.setRGB(
    0.65 + wm * 0.35,   // R: steely blue → warm amber
    0.77 + wm * 0.04,
    0.88 - wm * 0.33,
  );
  dirLight.intensity = 2.2 + beatFlash * 1.8;

  // Match background/fog to warmth so atmospheric depth is consistent
  const bgR = 0.027 + wm * 0.018;
  const bgG = 0.023 + wm * 0.002;
  const bgB = 0.039 - wm * 0.018;
  (scene.background as THREE.Color).setRGB(bgR, bgG, bgB);
  sceneFog.color.setRGB(bgR, bgG, bgB);

  // ── Update stele heights ─────────────────────────────────────────────────
  const offset = ((N - 1) * SPACING) / 2;
  const heightScale = cfg.stelaeHeight; // 0–2

  // Global transient boost
  let transAvg = 0;
  for (let b = 0; b < 7; b++) transAvg += transients[b];
  transAvg /= 7;
  const transBoost = Math.max(0, (transAvg - 1.0) * 0.35) * heightScale;

  for (let iz = 0; iz < N; iz++) {
    for (let ix = 0; ix < N; ix++) {
      const idx  = iz * N + ix;
      const normX = N > 1 ? (ix / (N - 1)) * 2 - 1 : 0;

      let h = BASE_H;
      for (let b = 0; b < 7; b++) {
        const dx = normX - ZONE_X[b];
        const gw = Math.exp(-(dx * dx) / SIGMA_SQ);
        h += amps[b] * gw * heightScale * 4.5;
      }
      h += transBoost;
      h = Math.max(BASE_H, h);

      const x = ix * SPACING - offset;
      const z = iz * SPACING - offset;
      dummy.position.set(x, h * 0.5, z);
      dummy.scale.set(1, h, 1);
      dummy.updateMatrix();
      instancedMesh.setMatrixAt(idx, dummy.matrix);
    }
  }
  instancedMesh.instanceMatrix.needsUpdate = true;

  // ── Camera path ──────────────────────────────────────────────────────────
  // Lissajous curve whose radius scales to 50% of the current field half-size
  const fieldHalf = offset * 0.5;
  const cx = Math.sin(time * LISSA_SX) * fieldHalf + camShakeX;
  const cz = Math.sin(time * LISSA_SZ + 1.3) * fieldHalf + camShakeZ;
  const cy = CAM_EYE_Y + Math.sin(time * 0.35) * 0.09;

  // Lookahead: step slightly ahead along the Lissajous to derive look direction
  const ahead = 0.35;
  const lx = Math.sin((time + ahead) * LISSA_SX) * fieldHalf;
  const lz = Math.sin((time + ahead) * LISSA_SZ + 1.3) * fieldHalf;

  camera.position.set(cx, cy, cz);
  camera.lookAt(lx, CAM_EYE_Y - 0.25, lz);

  renderer.render(scene, camera);
}

// ── Reset (resize) ────────────────────────────────────────────────────────────

export function resetStelae(): void {
  if (!initialized) return;
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer?.setSize(w, h);
  if (camera) { camera.aspect = w / h; camera.updateProjectionMatrix(); }
}

// ── Dispose ───────────────────────────────────────────────────────────────────

export function disposeStelae(): void {
  if (!initialized) return;
  vizModeUnsub?.();
  vizModeUnsub = null;

  instancedMesh?.geometry.dispose();
  stelaMat?.dispose();
  groundMesh?.geometry.dispose();
  groundMat?.dispose();
  renderer?.dispose();
  threeCanvas?.remove();

  threeCanvas   = null;
  renderer      = null;
  scene         = null;
  camera        = null;
  instancedMesh = null;
  stelaMat      = null;
  groundMesh    = null;
  groundMat     = null;
  dirLight      = null;
  ambLight      = null;
  sceneFog      = null;
  lastGridN     = 0;
  time          = 0;
  beatFlash     = 0;
  camShakeX     = 0;
  camShakeZ     = 0;
  lastBeatIdx   = -1;
  initialized   = false;
}
