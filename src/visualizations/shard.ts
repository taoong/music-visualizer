/**
 * Shard — crystalline glass polyhedra cluster
 *
 * 7 irregular crystal shards orbit a shared centre, one per frequency band.
 * Each shard is a randomly-distorted icosahedron / octahedron / tetrahedron
 * (chosen by the Facets slider) rendered with MeshPhysicalMaterial — pale
 * ice-blue glass with transmission, two-tone directional lighting, no additive
 * neon glow.  Shard scale is driven by its band's amplitude; beat fires a
 * radial scatter burst then the shards ease home.
 *
 * Inspired by Tokujin Yoshioka "Venus – Crystal Nature" (2022, Kyushu National
 * Museum / teamLab Planets) and the copper-sulphate crystallisation installation
 * "Seizure" by Roger Hiorns (2008).
 */
import * as THREE from 'three';
import { ConvexGeometry } from 'three/addons/geometries/ConvexGeometry.js';
import { store } from '../state/store';
import { getBandAverages } from './helpers';
import { audioEngine } from '../audio/engine';
import { isMobile } from '../utils/constants';

// ── Module state ──────────────────────────────────────────────────────────────

let initialized    = false;
let threeCanvas    : HTMLCanvasElement | null = null;
let renderer       : THREE.WebGLRenderer | null = null;
let scene          : THREE.Scene | null = null;
let camera         : THREE.PerspectiveCamera | null = null;
let vizModeUnsub   : (() => void) | null = null;

// Per-shard state
const NUM_SHARDS = 7;
const shardMeshes   : THREE.Mesh[]    = [];
const shardMaterials: THREE.MeshPhysicalMaterial[] = [];
const shardGeoms    : THREE.BufferGeometry[] = [];

// Shard orbital bases on a Fibonacci sphere
const shardBasePos  : THREE.Vector3[] = [];
const shardAngVel   : THREE.Vector3[] = [];   // per-axis rotation velocity
const shardPhase    : number[]        = [];   // random phase offset for gentle drift

// Beat state
let lastBeatIndex = -1;
let scatterT      = 0;  // 0=home, 1=fully scattered (decays to 0)
const scatterDir  : THREE.Vector3[] = [];

// Timing
let animTime      = 0;
let cameraTheta   = 0;
let cameraPhi     = 0.25;  // gentle tilt above equator

// Cached config
let cachedFacets  = -1;

// ── Geometry helpers ──────────────────────────────────────────────────────────

function seededRng(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) & 0xffffffff;
    return (s >>> 1) / 0x7fffffff;
  };
}

/**
 * Build a crystal shard geometry.
 * facetsVal  0–1 controls base shape: 0→tetrahedron (4 pts), 0.5→octahedron
 * (8 pts), 1→icosahedron (12 pts) + extra noisy hull points.
 */
function buildShardGeometry(bandIdx: number, facetsVal: number): THREE.BufferGeometry {
  const rng = seededRng(bandIdx * 31337 + 7919);

  // Pick base point count from facets slider
  const pointCount = 5 + Math.round(facetsVal * 10);  // 5–15 points

  // Distribute points over a unit sphere via rejection sampling of random
  // directions, then push them to the surface with slight per-point radius jitter
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i < pointCount; i++) {
    const theta = Math.acos(2 * rng() - 1);
    const phi   = rng() * Math.PI * 2;
    const r     = 0.7 + rng() * 0.6;          // radius 0.7–1.3 for crystal facets
    pts.push(new THREE.Vector3(
      r * Math.sin(theta) * Math.cos(phi),
      r * Math.sin(theta) * Math.sin(phi),
      r * Math.cos(theta),
    ));
  }

  // Ensure we always have a non-degenerate hull by adding 6 axis-aligned caps
  const capR = 0.5 + rng() * 0.3;
  pts.push(
    new THREE.Vector3( capR, 0, 0), new THREE.Vector3(-capR, 0, 0),
    new THREE.Vector3(0,  capR * (1.4 + rng() * 0.4), 0),  // taller top
    new THREE.Vector3(0, -capR * (0.8 + rng() * 0.3), 0),  // shorter base
    new THREE.Vector3(0, 0,  capR), new THREE.Vector3(0, 0, -capR),
  );

  try {
    return new ConvexGeometry(pts);
  } catch {
    // Fallback for degenerate cases
    return new THREE.OctahedronGeometry(1.0);
  }
}

// ── Setup ─────────────────────────────────────────────────────────────────────

function setup(): void {
  threeCanvas = document.createElement('canvas');
  threeCanvas.style.cssText =
    'position:fixed;top:0;left:0;width:100%;height:100%;z-index:10;pointer-events:none;display:block';
  document.body.appendChild(threeCanvas);

  const w = window.innerWidth;
  const h = window.innerHeight;
  const pr = isMobile ? Math.min(window.devicePixelRatio, 1.0) : Math.min(window.devicePixelRatio, 1.5);

  renderer = new THREE.WebGLRenderer({
    canvas: threeCanvas,
    antialias: !isMobile,
    alpha: false,
  });
  renderer.setSize(w, h);
  renderer.setPixelRatio(pr);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  // Transmission requires the renderer to accumulate a background pass
  renderer.shadowMap.enabled = false;

  // ── Scene ──
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x030508);
  scene.fog = new THREE.FogExp2(0x030508, 0.08);

  // ── Camera ──
  camera = new THREE.PerspectiveCamera(55, w / h, 0.1, 60);
  camera.position.set(0, 3, 10);
  camera.lookAt(0, 0, 0);

  // ── Lights ──
  // Warm key light from upper-left — rakes across facets creating highlights
  const keyLight = new THREE.DirectionalLight(0xfff4e8, 2.8);
  keyLight.position.set(-4, 6, 3);
  scene.add(keyLight);

  // Cool fill from opposite side — dark shadow sides get a blue-grey cast
  const fillLight = new THREE.DirectionalLight(0x8aaed8, 0.9);
  fillLight.position.set(5, -2, -3);
  scene.add(fillLight);

  // Rim light — catches edges of shards for crystal clarity
  const rimLight = new THREE.DirectionalLight(0xb8d4ff, 1.4);
  rimLight.position.set(0, -4, -8);
  scene.add(rimLight);

  // Low ambient so shadows aren't pitch black
  const ambient = new THREE.AmbientLight(0x10182a, 1.0);
  scene.add(ambient);

  // ── Fibonacci sphere base positions ──
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < NUM_SHARDS; i++) {
    const y = 1 - (i / (NUM_SHARDS - 1)) * 2;
    const r = Math.sqrt(1 - y * y);
    const theta = goldenAngle * i;
    shardBasePos.push(new THREE.Vector3(r * Math.cos(theta), y, r * Math.sin(theta)));
    shardAngVel.push(new THREE.Vector3(
      (Math.random() - 0.5) * 0.8,
      (Math.random() - 0.5) * 0.8,
      (Math.random() - 0.5) * 0.8,
    ));
    shardPhase.push(Math.random() * Math.PI * 2);
    scatterDir.push(new THREE.Vector3(
      (Math.random() - 0.5) * 2,
      (Math.random() - 0.5) * 2,
      (Math.random() - 0.5) * 2,
    ).normalize());
  }

  // ── Create shards ──
  const facetsVal = store.config.shardFacets;
  cachedFacets = facetsVal;
  buildAllShards(facetsVal);

  // ── Subtle floor plane for depth reference ──
  const floorGeo = new THREE.PlaneGeometry(30, 30);
  const floorMat = new THREE.MeshStandardMaterial({
    color: 0x060c18,
    roughness: 0.9,
    metalness: 0.1,
  });
  const floor = new THREE.Mesh(floorGeo, floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -4;
  scene.add(floor);

  // Resize handler
  const onResize = () => {
    const nw = window.innerWidth;
    const nh = window.innerHeight;
    renderer?.setSize(nw, nh);
    if (camera) camera.aspect = nw / nh;
    camera?.updateProjectionMatrix();
  };
  window.addEventListener('resize', onResize);
  (threeCanvas as HTMLCanvasElement & { _resizeHandler?: () => void })._resizeHandler = onResize;

  vizModeUnsub = store.on('vizModeChange', () => { disposeShard(); });

  initialized = true;
}

function buildAllShards(facetsVal: number): void {
  if (!scene) return;

  // Remove old shards
  for (const mesh of shardMeshes) scene.remove(mesh);
  for (const geo  of shardGeoms)  geo.dispose();
  for (const mat  of shardMaterials) mat.dispose();
  shardMeshes.length    = 0;
  shardGeoms.length     = 0;
  shardMaterials.length = 0;

  // Ice-blue crystal palette per band — cool, non-rainbow
  // 7 subtle hue variations all in the blue-white range
  const baseHues = [220, 200, 215, 205, 225, 195, 210];

  for (let i = 0; i < NUM_SHARDS; i++) {
    const geo = isMobile
      ? new THREE.OctahedronGeometry(1.0 + (i % 3) * 0.1, 0)
      : buildShardGeometry(i, facetsVal);
    shardGeoms.push(geo);

    const hue = baseHues[i];
    const color = new THREE.Color().setHSL(hue / 360, 0.25, 0.72);
    const clarity = store.config.shardClarity;

    const mat = new THREE.MeshPhysicalMaterial({
      color,
      metalness:     0.0,
      roughness:     0.08 + (1 - clarity) * 0.35,
      transmission:  isMobile ? 0 : clarity * 0.82,
      ior:           1.48,
      thickness:     0.5,
      transparent:   true,
      opacity:       0.7 + clarity * 0.28,
      envMapIntensity: 1.5,
      side: THREE.FrontSide,
    });
    shardMaterials.push(mat);

    const mesh = new THREE.Mesh(geo, mat);
    // Random initial rotation so shards don't all look identical
    mesh.rotation.set(Math.random() * Math.PI * 2, Math.random() * Math.PI * 2, Math.random() * Math.PI * 2);
    shardMeshes.push(mesh);
    scene.add(mesh);
  }
}

// ── Draw ──────────────────────────────────────────────────────────────────────

export function drawShard(_p: unknown, dt: number): void {
  if (!initialized) setup();
  if (!renderer || !scene || !camera) return;

  const { config, state } = store;
  const { amps: bands, transients } = getBandAverages(NUM_SHARDS);
  const scatter = config.shardScatter;
  const clarity = config.shardClarity;
  const facets  = config.shardFacets;

  // Rebuild geometry when Facets slider changes (structural)
  if (!isMobile && Math.abs(facets - cachedFacets) > 0.001) {
    cachedFacets = facets;
    buildAllShards(facets);
  }

  animTime  += dt * 0.016;  // roughly 1 unit = 1 second

  // ── Beat detection (matches pattern in neon.ts / melt.ts) ──
  if (state.beatIntervalSec > 0 && state.isPlaying) {
    const pos      = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    const beatIdx  = adjusted >= 0 ? Math.floor(adjusted / state.beatIntervalSec) : -1;
    if (beatIdx > lastBeatIndex) {
      lastBeatIndex = beatIdx;
      scatterT = 1.0;
    }
  }

  // Decay scatter
  scatterT = Math.max(0, scatterT - dt * 0.04);

  // ── Camera orbit ──
  cameraTheta += dt * 0.003;
  cameraPhi    = 0.22 + Math.sin(animTime * 0.18) * 0.12;
  const camR   = 9.0 + Math.sin(animTime * 0.11) * 0.8;
  camera.position.set(
    camR * Math.sin(cameraTheta) * Math.cos(cameraPhi),
    camR * Math.sin(cameraPhi) + 0.5,
    camR * Math.cos(cameraTheta) * Math.cos(cameraPhi),
  );
  camera.lookAt(0, 0.2, 0);
  camera.updateProjectionMatrix();

  // ── Overall loudness for cluster scale ──
  let overallAmp = 0;
  for (let b = 0; b < NUM_SHARDS; b++) overallAmp += bands[b] ?? 0;
  overallAmp /= NUM_SHARDS;

  // Ease-out scatter: quadratic falloff
  const scatterEase = scatterT * scatterT;

  for (let i = 0; i < NUM_SHARDS; i++) {
    const mesh = shardMeshes[i];
    const mat  = shardMaterials[i];
    if (!mesh || !mat) continue;

    const band  = Math.min(bands[i] ?? 0, 1.0);
    const base  = shardBasePos[i];
    const phase = shardPhase[i];

    // Orbital radius driven by scatter slider + slight audio modulation
    const orbR = (1.8 + scatter * 2.5) * (1 + overallAmp * 0.25);

    // Scatter burst position
    const scatterOffset = scatterDir[i].clone().multiplyScalar(scatterEase * 2.5);

    // Gentle hover drift
    const hoverOffset = new THREE.Vector3(
      Math.sin(animTime * 0.7 + phase) * 0.12,
      Math.cos(animTime * 0.5 + phase) * 0.15,
      Math.sin(animTime * 0.6 + phase + 1.0) * 0.10,
    );

    mesh.position.set(
      base.x * orbR + hoverOffset.x + scatterOffset.x,
      base.y * orbR + hoverOffset.y + scatterOffset.y,
      base.z * orbR + hoverOffset.z + scatterOffset.z,
    );

    // Size: audio amplitude scales each shard
    const baseScale = isMobile ? 0.55 : 0.7;
    const targetScale = baseScale * (0.6 + band * 1.1 + overallAmp * 0.3);
    const curS = mesh.scale.x;
    const lerpF = 1 - Math.pow(0.05, dt * 0.06);
    mesh.scale.setScalar(curS + (targetScale - curS) * lerpF);

    // Rotation driven by band amplitude
    const rotSpeed = dt * 0.002 * (0.5 + band * 1.5);
    const av = shardAngVel[i];
    mesh.rotation.x += av.x * rotSpeed;
    mesh.rotation.y += av.y * rotSpeed;
    mesh.rotation.z += av.z * rotSpeed;

    // Material: update roughness + opacity from clarity slider
    mat.roughness  = 0.06 + (1 - clarity) * 0.40;
    if (!isMobile) {
      mat.transmission = clarity * 0.82;
    }
    mat.opacity    = 0.65 + clarity * 0.32;
    mat.needsUpdate = true;

    // Emissive glow proportional to band amplitude (very subtle, warm)
    const emissiveStr = band * 0.08 * (1 + (transients[i] ?? 1) * 0.5);
    mat.emissive.setRGB(emissiveStr * 0.4, emissiveStr * 0.3, emissiveStr * 0.5);
  }

  renderer.render(scene, camera);
}

// ── Reset ─────────────────────────────────────────────────────────────────────

export function resetShard(): void {
  lastBeatIndex = -1;
  scatterT      = 0;
  animTime      = 0;
  cameraTheta   = 0;
}

// ── Dispose ───────────────────────────────────────────────────────────────────

export function disposeShard(): void {
  if (!initialized) return;

  vizModeUnsub?.();
  vizModeUnsub = null;

  const handler = (threeCanvas as HTMLCanvasElement & { _resizeHandler?: () => void })?._resizeHandler;
  if (handler) window.removeEventListener('resize', handler);

  for (const geo  of shardGeoms)     geo.dispose();
  for (const mat  of shardMaterials) mat.dispose();
  shardMeshes.length    = 0;
  shardGeoms.length     = 0;
  shardMaterials.length = 0;
  shardBasePos.length   = 0;
  shardAngVel.length    = 0;
  shardPhase.length     = 0;
  scatterDir.length     = 0;

  renderer?.dispose();
  threeCanvas?.remove();

  threeCanvas = null;
  renderer    = null;
  scene       = null;
  camera      = null;
  cachedFacets = -1;
  lastBeatIndex = -1;
  scatterT     = 0;
  animTime     = 0;
  cameraTheta  = 0;
  initialized  = false;
}
