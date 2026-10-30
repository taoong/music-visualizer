/**
 * Loom — 3D woven mesh visualization
 * Warp and weft cylinder-thread segments cross in genuine 3D; each of 7 frequency
 * bands drives the over/under crossing depth of its column of warp threads.
 * The Z displacement follows a closed-form cosine formula that guarantees warp
 * and weft are always in the correct over/under relationship.
 *
 * Inspired by Anni Albers' textile studies (Bauhaus, 1920s–30s, https://www.anniealbers.com/),
 * and the TouchDesigner fiber-mesh audio patches used in VJ performance work.
 * Two-point studio lighting (warm key + cool fill); matte thread surfaces; no rainbow,
 * no neon glow — the music drives form and depth, not colour or brightness.
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages, fovForAspect } from './helpers';
import { isMobile } from '../utils/constants';

// ── Module state ──────────────────────────────────────────────────────────────
let threeCanvas: HTMLCanvasElement | null = null;
let renderer: THREE.WebGLRenderer | null = null;
let scene: THREE.Scene | null = null;
let camera: THREE.PerspectiveCamera | null = null;
let composer: EffectComposer | null = null;
let bloomPass: UnrealBloomPass | null = null;
let warpMesh: THREE.InstancedMesh | null = null;
let weftMesh: THREE.InstancedMesh | null = null;
let warpMat: THREE.MeshStandardMaterial | null = null;
let weftMat: THREE.MeshStandardMaterial | null = null;
let cylGeo: THREE.CylinderGeometry | null = null;
let vizModeUnsub: (() => void) | null = null;
let resizeObserver: ResizeObserver | null = null;
let initialized = false;

let time = 0;
let orbitAngle = 0.35; // start slightly off-axis so depth is immediately apparent
let beatKick = 0;
let lastBeatIndex = -1;

// Pre-allocated helpers — reused every frame to avoid GC pressure
const _pA = new THREE.Vector3();
const _pB = new THREE.Vector3();
const _mid = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _scale = new THREE.Vector3();
const _mat4 = new THREE.Matrix4();
const Y_AXIS = new THREE.Vector3(0, 1, 0);

// ── Geometry constants ────────────────────────────────────────────────────────
const PANEL_SIZE = 3.0;
const HALF       = PANEL_SIZE / 2;
// Number of sample points along each thread — fixed resolution regardless of density
const BASE_SEGS    = isMobile ? 32 : 64;
const MAX_DENSITY  = isMobile ? 10 : 14;
// Each thread has (BASE_SEGS − 1) cylinder instances
const MAX_INSTANCES = MAX_DENSITY * (BASE_SEGS - 1);
const CYL_SIDES    = isMobile ? 4 : 6;

// ── Setup ─────────────────────────────────────────────────────────────────────
function setup(): void {
  threeCanvas = document.createElement('canvas');
  threeCanvas.style.cssText =
    'position:fixed;top:0;left:0;width:100%;height:100%;z-index:10;pointer-events:none;display:block';
  document.body.appendChild(threeCanvas);

  const w = window.innerWidth;
  const h = window.innerHeight;
  const aspect = w / h;

  renderer = new THREE.WebGLRenderer({ canvas: threeCanvas, antialias: !isMobile, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, isMobile ? 1 : 2));
  renderer.setSize(w, h);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = !isMobile;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x07070b);

  camera = new THREE.PerspectiveCamera(fovForAspect(40, aspect), aspect, 0.1, 50);
  camera.position.set(0, 1.8, 5.0);
  camera.lookAt(0, 0, 0);

  // Warm key light (upper-right)
  const keyLight = new THREE.DirectionalLight(0xffd080, 2.2);
  keyLight.position.set(3, 4, 2);
  if (!isMobile) {
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.set(1024, 1024);
    keyLight.shadow.camera.left   = -4;
    keyLight.shadow.camera.right  =  4;
    keyLight.shadow.camera.top    =  4;
    keyLight.shadow.camera.bottom = -4;
    keyLight.shadow.camera.near   = 0.5;
    keyLight.shadow.camera.far    = 20;
  }
  scene.add(keyLight);

  // Cool fill light (lower-left-back)
  const fillLight = new THREE.DirectionalLight(0x809aff, 0.5);
  fillLight.position.set(-3, -1.5, -2);
  scene.add(fillLight);

  scene.add(new THREE.AmbientLight(0xffffff, 0.06));

  // Thin cylinder base geometry (radius=1, height=1 — scaled per-instance)
  cylGeo = new THREE.CylinderGeometry(1, 1, 1, CYL_SIDES, 1);
  cylGeo.computeVertexNormals();

  // Warp material: warm linen/cream
  warpMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(0xd4c4a0),
    roughness: 0.85,
    metalness: 0.02,
  });
  // Weft material: cool slate-blue
  weftMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(0x7090a8),
    roughness: 0.85,
    metalness: 0.02,
  });

  // InstancedMesh — allocate max capacity, update .count each frame
  warpMesh = new THREE.InstancedMesh(cylGeo, warpMat, MAX_INSTANCES);
  warpMesh.castShadow   = !isMobile;
  warpMesh.receiveShadow = !isMobile;
  warpMesh.count = 0;
  scene.add(warpMesh);

  weftMesh = new THREE.InstancedMesh(cylGeo.clone(), weftMat, MAX_INSTANCES);
  weftMesh.castShadow   = !isMobile;
  weftMesh.receiveShadow = !isMobile;
  weftMesh.count = 0;
  scene.add(weftMesh);

  // Dark ground plane — catches key-light shadows
  const groundGeo = new THREE.PlaneGeometry(12, 12);
  const groundMat = new THREE.MeshStandardMaterial({ color: 0x060610, roughness: 1.0, metalness: 0 });
  const ground = new THREE.Mesh(groundGeo, groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -HALF - 0.55;
  ground.receiveShadow = !isMobile;
  scene.add(ground);

  // Post-processing (very subtle bloom — just lifts specular highlights)
  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  if (!isMobile) {
    bloomPass = new UnrealBloomPass(new THREE.Vector2(w, h), 0.08, 0.45, 0.88);
    composer.addPass(bloomPass);
  }
  composer.addPass(new OutputPass());

  resizeObserver = new ResizeObserver(() => {
    if (!renderer || !camera || !composer) return;
    const nw = window.innerWidth;
    const nh = window.innerHeight;
    renderer.setSize(nw, nh);
    composer.setSize(nw, nh);
    camera.aspect = nw / nh;
    camera.updateProjectionMatrix();
    if (bloomPass) bloomPass.resolution.set(nw, nh);
  });
  resizeObserver.observe(document.documentElement);

  vizModeUnsub = store.on('vizModeChange', () => disposeLoom());
  initialized = true;
}

// ── Thread geometry update ────────────────────────────────────────────────────

/**
 * Write one cylinder instance between two 3D points into `mesh` at `idx`.
 * Returns the next free index (or the same idx if the segment was degenerate).
 */
function putSeg(mesh: THREE.InstancedMesh, idx: number, a: THREE.Vector3, b: THREE.Vector3, r: number): number {
  _mid.addVectors(a, b).multiplyScalar(0.5);
  _dir.subVectors(b, a);
  const len = _dir.length();
  if (len < 1e-7) return idx;
  _dir.divideScalar(len);
  // Rotate the cylinder's Y axis to align with the AB direction
  _q.setFromUnitVectors(Y_AXIS, _dir);
  _scale.set(r, len, r);
  _mat4.compose(_mid, _q, _scale);
  mesh.setMatrixAt(idx, _mat4);
  return idx + 1;
}

/**
 * Rebuild warp and weft InstancedMesh transforms for the current frame.
 *
 * Z formula (derived so peaks align exactly at crossing intersections):
 *   warp thread i:  z(y) = amp  * cos(y·ω + i·π + HALF·ω)
 *   weft thread j:  z(x) = −amp * cos(x·ω + j·π + HALF·ω)
 * where ω = π / spacing (one half-period per crossing).
 * This guarantees z_warp(i,j) − z_weft(j,i) = 2·amp·(−1)^(i+j),
 * so warp is always "over" weft when (i+j) is even and "under" when odd.
 */
function updateThreads(n: number, amps: number[], scale: number): void {
  if (!warpMesh || !weftMesh) return;

  const spacing = PANEL_SIZE / (n - 1);
  const r       = 0.016 * spacing;       // thread radius proportional to thread spacing
  const omega   = Math.PI / spacing;      // half-period per crossing interval
  const phi     = HALF * omega;           // phase shift to align peaks at crossing points

  let wi = 0; // warp instance index
  let fi = 0; // weft (fill) instance index

  // ── Warp threads (run along Y, fixed X) ──
  for (let i = 0; i < n; i++) {
    const xi      = -HALF + i * spacing;
    const bandIdx = Math.min(6, Math.floor((i / n) * 7));
    const amp     = amps[bandIdx] * scale;
    const phase   = i * Math.PI + phi;

    let prevY = -HALF;
    let prevZ = amp * Math.cos(prevY * omega + phase);
    _pA.set(xi, prevY, prevZ);

    for (let s = 1; s < BASE_SEGS; s++) {
      const y = -HALF + (s / (BASE_SEGS - 1)) * PANEL_SIZE;
      const z = amp * Math.cos(y * omega + phase);
      _pB.set(xi, y, z);
      wi = putSeg(warpMesh, wi, _pA, _pB, r);
      _pA.copy(_pB);
    }
  }

  // ── Weft threads (run along X, fixed Y) ──
  for (let j = 0; j < n; j++) {
    const yj      = -HALF + j * spacing;
    const bandIdx = Math.min(6, Math.floor((j / n) * 7));
    const amp     = amps[bandIdx] * scale;
    const phase   = j * Math.PI + phi;

    let prevX = -HALF;
    let prevZ = -amp * Math.cos(prevX * omega + phase);
    _pA.set(prevX, yj, prevZ);

    for (let s = 1; s < BASE_SEGS; s++) {
      const x = -HALF + (s / (BASE_SEGS - 1)) * PANEL_SIZE;
      const z = -amp * Math.cos(x * omega + phase);
      _pB.set(x, yj, z);
      fi = putSeg(weftMesh, fi, _pA, _pB, r);
      _pA.copy(_pB);
    }
  }

  warpMesh.count = wi;
  warpMesh.instanceMatrix.needsUpdate = true;
  weftMesh.count = fi;
  weftMesh.instanceMatrix.needsUpdate = true;
}

// ── Draw ──────────────────────────────────────────────────────────────────────

export function drawLoom(_p: unknown, dt: number): void {
  if (!initialized) setup();
  if (!renderer || !scene || !camera || !composer || !warpMat || !weftMat) return;

  const { state } = store;
  const { amps } = getBandAverages(7);

  time += dt;

  // Beat detection — CHOP style: impulse kick added on each beat, decays continuously
  if (state.beatIntervalSec > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adj = pos - state.beatOffset;
    const beatIdx = adj >= 0 ? Math.floor(adj / state.beatIntervalSec) : -1;
    if (beatIdx > lastBeatIndex) {
      lastBeatIndex = beatIdx;
      beatKick += 0.0018;
    }
  }
  beatKick *= Math.pow(0.92, dt);

  // Continuous orbit — beat kick nudges speed, never snaps to new angle
  orbitAngle += (0.003 + beatKick) * dt;

  const orbitR = 4.8;
  const camX   = Math.sin(orbitAngle) * orbitR;
  const camZ   = Math.cos(orbitAngle) * orbitR;
  const camY   = 1.8 + Math.sin(orbitAngle * 0.39) * 0.9;
  camera.position.set(camX, camY, camZ);
  camera.lookAt(0, 0, 0);

  // Read slider config
  const densityVal = store.config.loomDensity;  // 0–1
  const reliefVal  = store.config.loomRelief;   // 0–1
  const textureVal = store.config.loomTexture;  // 0–1

  // Density 0–1 → thread count 6–MAX_DENSITY (structural: fewer/more threads)
  const minN = 6;
  const n    = Math.max(2, Math.round(minN + densityVal * (MAX_DENSITY - minN)));

  // Relief 0–1 → max crossing Z displacement 0–0.38 (audio drives within this envelope)
  const reliefScale = reliefVal * 0.38;

  // Texture 0–1 → roughness 0.2 (silky) → 1.0 (coarse burlap)
  const roughness = 0.2 + textureVal * 0.8;
  if (warpMat.roughness !== roughness) {
    warpMat.roughness = roughness;
    weftMat.roughness = roughness;
  }

  // Bloom strength proportional to metalness/highlights
  if (bloomPass) {
    bloomPass.strength = 0.04 + (1 - textureVal) * 0.08; // silky → slightly more bloom
  }

  updateThreads(n, amps, reliefScale);

  composer.render();
}

// ── Reset / Dispose ───────────────────────────────────────────────────────────

export function resetLoom(): void {
  time = 0;
  orbitAngle = 0.35;
  beatKick = 0;
  lastBeatIndex = -1;
}

export function disposeLoom(): void {
  if (!initialized) return;
  initialized = false;

  vizModeUnsub?.();
  vizModeUnsub = null;
  resizeObserver?.disconnect();
  resizeObserver = null;

  warpMesh?.geometry.dispose();
  warpMesh = null;
  weftMesh?.geometry.dispose();
  weftMesh = null;
  cylGeo?.dispose();
  cylGeo = null;
  warpMat?.dispose();
  warpMat = null;
  weftMat?.dispose();
  weftMat = null;

  bloomPass = null;
  composer?.dispose();
  composer = null;
  renderer?.dispose();
  renderer = null;
  scene = null;
  camera = null;

  threeCanvas?.remove();
  threeCanvas = null;
}
