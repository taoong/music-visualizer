/**
 * Image Grid — Three.js WebGL overlay visualization
 * 16×16 mosaic of 3D tiles viewed from bird's-eye angle.
 * Each tile height is driven by its column's frequency band.
 * Beat causes a radiating height-wave from the grid center outward.
 * When an image is loaded, tile tops show corresponding image regions.
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { getUserImageUrl } from './userImage';

// ── Constants ─────────────────────────────────────────────────────────────────

const COLS        = 16;
const ROWS        = 16;
const TOTAL_CELLS = COLS * ROWS;   // 256
const CELL_SIZE   = 5;             // world units per cell (grid = 80×80)
const GAP         = 0.25;          // small gap between tiles
const BASE_H      = 0.4;           // min scale.y (flat at silence)
const MAX_AMP_H   = 10;            // additional height from amplitude
const BEAT_LIFT   = 12;            // height added by the beat wave
const WAVE_SPEED  = 2.0;           // units/frame (dt-normalized)
const WAVE_WIDTH  = 8;             // ring thickness in world units

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
let imageUnsub     : (() => void) | null = null;

// Per-cell state (flat arrays indexed by row*COLS+col)
let cellMeshes     : THREE.Mesh[] = [];
let topMats        : THREE.MeshStandardMaterial[] = [];
let sideMat        : THREE.MeshStandardMaterial | null = null;
let imageTexture   : THREE.Texture | null = null;
let groundMesh     : THREE.Mesh | null = null;

// Beat wave
let lastBeatIndex    = -1;
let beatWaveRadius   = -1;     // world units from grid center; -1 = inactive
let beatWaveStrength = 0;
let cameraTheta      = 0;

// ── Helper ────────────────────────────────────────────────────────────────────

function colToBand(col: number): number {
  return Math.floor(col / COLS * 7);
}

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
  scene.fog = new THREE.FogExp2(0x000000, 0.003);

  // Camera — mostly top-down with slight forward tilt so rising tiles are visible
  camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 800);
  camera.position.set(0, 90, 30);
  camera.lookAt(0, 0, 0);

  // Lights
  scene.add(new THREE.AmbientLight(0x222222, 0.8));
  const pt = new THREE.PointLight(0xffffff, 1.5, 400);
  pt.position.set(0, 100, 0);
  scene.add(pt);

  // Ground plane
  const groundGeo = new THREE.PlaneGeometry(200, 200);
  const groundMat = new THREE.MeshStandardMaterial({ color: 0x080808 });
  groundMesh = new THREE.Mesh(groundGeo, groundMat);
  groundMesh.rotation.x = -Math.PI / 2;
  scene.add(groundMesh);

  // Shared side material (dark, used on all non-top faces)
  sideMat = new THREE.MeshStandardMaterial({ color: 0x111111, emissive: 0x000000 });

  // Build 256 cell meshes
  cellMeshes = [];
  topMats = [];

  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      const band  = colToBand(col);
      const color = BAND_COLORS[band];

      // BoxGeometry height=1; translate so pivot is at base (bottom Y=0, top Y=scale.y)
      const geo = new THREE.BoxGeometry(CELL_SIZE - GAP, 1, CELL_SIZE - GAP);
      geo.translate(0, 0.5, 0);

      // Modify top-face UVs (face index 2 = +Y)
      // BoxGeometry UV layout: +X=0-3, -X=4-7, +Y=8-11, -Y=12-15, +Z=16-19, -Z=20-23
      const uvAttr = geo.attributes['uv'] as THREE.BufferAttribute;
      const uMin = col / COLS;
      const uMax = (col + 1) / COLS;
      const vMin = (ROWS - row - 1) / ROWS;  // flipped: UV V=1 is top of image
      const vMax = (ROWS - row) / ROWS;
      uvAttr.setXY(8,  uMin, vMax);
      uvAttr.setXY(9,  uMax, vMax);
      uvAttr.setXY(10, uMin, vMin);
      uvAttr.setXY(11, uMax, vMin);
      uvAttr.needsUpdate = true;

      // Per-cell top material; sides share a common dark material
      const topMat = new THREE.MeshStandardMaterial({
        color,
        emissive: color,
        emissiveIntensity: 0.15,
        metalness: 0.2,
        roughness: 0.5,
      });

      // Multi-material: [px, nx, py(top), ny, pz, nz] — group 2 = top face
      const mesh = new THREE.Mesh(geo, [sideMat!, sideMat!, topMat, sideMat!, sideMat!, sideMat!]);
      mesh.scale.y = BASE_H;
      mesh.position.x = (col - COLS / 2 + 0.5) * CELL_SIZE;
      mesh.position.y = 0;
      mesh.position.z = (row - ROWS / 2 + 0.5) * CELL_SIZE;
      scene!.add(mesh);

      cellMeshes.push(mesh);
      topMats.push(topMat);
    }
  }

  // If an image is already loaded when this viz first activates, apply it
  const existingUrl = getUserImageUrl();
  if (existingUrl) applyImage(existingUrl);

  // Post-processing: RenderPass → UnrealBloomPass (idx 1) → OutputPass
  const res = new THREE.Vector2(window.innerWidth, window.innerHeight);
  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  composer.addPass(new UnrealBloomPass(res, 1.2, 0.4, 0.1));
  composer.addPass(new OutputPass());

  // Hide canvas when switching away from this viz
  vizModeUnsub = store.on('vizModeChange', (data) => {
    if (!threeCanvas) return;
    threeCanvas.style.display = data === 'imagegrid' ? 'block' : 'none';
  });

  // React to image load / remove
  imageUnsub = store.on('imageChange', (data) => {
    if (data) {
      const url = getUserImageUrl();
      if (url) applyImage(url);
    } else {
      clearImage();
    }
  });

  initialized = true;
}

// ── Image helpers ─────────────────────────────────────────────────────────────

function applyImage(url: string): void {
  new THREE.TextureLoader().load(url, (tex) => {
    tex.colorSpace = THREE.SRGBColorSpace;
    imageTexture?.dispose();
    imageTexture = tex;
    for (let i = 0; i < TOTAL_CELLS; i++) {
      topMats[i].map = tex;
      topMats[i].emissiveMap = tex;
      topMats[i].color.set(0xffffff);    // let image show through
      topMats[i].emissive.set(0x888888); // emissive so image is visible under dim lighting
      topMats[i].needsUpdate = true;
    }
  });
}

function clearImage(): void {
  imageTexture?.dispose();
  imageTexture = null;
  for (let i = 0; i < TOTAL_CELLS; i++) {
    const col  = i % COLS;
    const band = colToBand(col);
    topMats[i].map = null;
    topMats[i].emissiveMap = null;
    topMats[i].color.setHex(BAND_COLORS[band]);
    topMats[i].emissive.setHex(BAND_COLORS[band]);
    topMats[i].emissiveIntensity = 0.15;
    topMats[i].needsUpdate = true;
  }
}

// ── Draw (called by p5 draw loop at ~60fps) ───────────────────────────────────

export function drawImageGrid(_p: unknown, dt: number): void {
  if (!initialized) setup();

  const { amps } = getBandAverages(7);
  const { state } = store;

  // Beat detection (same pattern as neon.ts)
  if (state.beatIntervalSec > 0 && state.isPlaying) {
    const pos      = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    const beatIdx  = adjusted >= 0 ? Math.floor(adjusted / state.beatIntervalSec) : -1;
    if (beatIdx > lastBeatIndex) {
      lastBeatIndex    = beatIdx;
      beatWaveRadius   = 0;
      beatWaveStrength = 1.0;
    }
  }

  // Advance beat wave outward
  if (beatWaveRadius >= 0) {
    beatWaveRadius   += dt * WAVE_SPEED;
    beatWaveStrength *= Math.pow(0.97, dt);
  }

  // Update each cell
  for (let i = 0; i < TOTAL_CELLS; i++) {
    const mesh   = cellMeshes[i];
    const topMat = topMats[i];
    if (!mesh || !topMat) continue;

    const col  = i % COLS;
    const row  = Math.floor(i / COLS);
    const band = colToBand(col);
    const amp  = amps[band] ?? 0;

    let targetH = BASE_H + amp * MAX_AMP_H;

    // Beat wave contribution — ring radiates from grid center
    let wave = 0;
    if (beatWaveRadius >= 0) {
      const dx   = (col - COLS / 2 + 0.5) * CELL_SIZE;
      const dz   = (row - ROWS / 2 + 0.5) * CELL_SIZE;
      const dist = Math.sqrt(dx * dx + dz * dz);
      wave = Math.max(0, 1 - Math.abs(dist - beatWaveRadius) / WAVE_WIDTH) * beatWaveStrength * BEAT_LIFT;
    }

    targetH += wave;
    mesh.scale.y += (targetH - mesh.scale.y) * 0.25 * dt;
    topMat.emissiveIntensity = Math.max(0, Math.min(2, 0.15 + amp * 1.5 + (wave / BEAT_LIFT) * 1.2));
  }

  // Camera orbit — bird's-eye angle, slow rotation driven by rotationSpeed
  if (camera) {
    cameraTheta         += dt * 0.0009 * store.config.rotationSpeed;
    camera.position.x    = Math.sin(cameraTheta) * 50;
    camera.position.z    = Math.cos(cameraTheta) * 50 + 15;
    camera.position.y    = 90;
    camera.lookAt(0, 0, 0);
  }

  // Bloom strength from intensity slider (UnrealBloomPass is at index 1)
  if (composer && composer.passes[1]) {
    (composer.passes[1] as UnrealBloomPass).strength = 0.6 * store.config.intensity;
  }

  composer?.render();
}

// ── Reset (called on window resize) ──────────────────────────────────────────

export function resetImageGrid(): void {
  if (!initialized) return;
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer?.setSize(w, h);
  if (camera) { camera.aspect = w / h; camera.updateProjectionMatrix(); }
  composer?.setSize(w, h);
}

// ── Dispose (called on page unload) ──────────────────────────────────────────

export function disposeImageGrid(): void {
  if (!initialized) return;
  vizModeUnsub?.();
  imageUnsub?.();
  vizModeUnsub = null;
  imageUnsub   = null;

  for (const m of cellMeshes) m.geometry.dispose();
  for (const mat of topMats) mat.dispose();
  sideMat?.dispose();
  imageTexture?.dispose();
  groundMesh?.geometry.dispose();
  (groundMesh?.material as THREE.Material | undefined)?.dispose();

  composer?.dispose();
  renderer?.dispose();
  threeCanvas?.remove();

  threeCanvas = null; renderer = null; scene = null; camera = null;
  composer = null; groundMesh = null; sideMat = null; imageTexture = null;
  cellMeshes = []; topMats = [];

  lastBeatIndex = -1; beatWaveRadius = -1; beatWaveStrength = 0; cameraTheta = 0;
  initialized = false;
}
