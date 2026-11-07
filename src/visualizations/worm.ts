/**
 * Worm — 3D signal-worm: a tube that extrudes through space over time, its
 * radius driven by audio amplitude. Each segment encodes one moment of sound;
 * the whole creature is a living record of the last few seconds of music.
 *
 * Inspired by Tony Cragg's "Rational Beings" coiled sculpture series (1996,
 * https://www.tonycragg.com/works/?category=sculpture) and VJ Addie Wagenknecht's
 * real-time tube-extrusion TouchDesigner patches used in live performance contexts.
 * The warm terracotta/clay palette and single-source studio lighting draw from
 * physical ceramic sculpture rather than the usual neon-on-black aesthetic.
 *
 * Key technique: pre-allocated BufferGeometry updated in-place every frame via
 * a circular ring buffer. No geometry recreation = no GC pressure.
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { store } from '../state/store';
import { getBandAverages, fovForAspect } from './helpers';
import { isMobile } from '../utils/constants';

// ── Geometry constants ────────────────────────────────────────────────────────

const HISTORY   = isMobile ? 120 : 300;   // ring segments in history buffer
const RADIAL    = isMobile ? 7   : 12;    // vertices around tube cross-section
const BASE_R    = 2.2;                     // base helix radius in world units
const TUBE_R    = 0.08;                    // tube cross-section radius
const HEIGHT    = 3.0;                     // vertical extent of worm path

// ── Module state ──────────────────────────────────────────────────────────────

let threeCanvas: HTMLCanvasElement | null = null;
let renderer: THREE.WebGLRenderer | null = null;
let scene: THREE.Scene | null = null;
let camera: THREE.PerspectiveCamera | null = null;
let composer: EffectComposer | null = null;
let tubeMesh: THREE.Mesh | null = null;
let tubeMaterial: THREE.MeshStandardMaterial | null = null;
let keyLight: THREE.DirectionalLight | null = null;
let initialized = false;

// Camera motion state
let camTheta = 0;      // azimuth angle (radians)
let camPhi   = 0.3;   // elevation angle (radians)
let camFov   = 50;
let beatKick = 0;      // decaying beat impulse for FOV punch

// History ring buffer: each entry stores [coilsParam, amplitude, perlinOffset]
const ampHistory   = new Float32Array(HISTORY);    // per-ring amplitude [0,1]
const noiseOffsetX = new Float32Array(HISTORY);    // per-ring Perlin offset X
const noiseOffsetZ = new Float32Array(HISTORY);    // per-ring Perlin offset Z
let   historyHead  = 0;  // next write index (mod HISTORY)
let   historyFull  = false;

// Perlin-noise state for worm path generation
let noiseX = 0;
let noiseZ = 0;
let noiseVX = 0.4;
let noiseVZ = 0.3;

// Pre-allocated geometry arrays
let posArr: Float32Array;
let norArr: Float32Array;
let colArr: Float32Array;

// ── Simplex-style noise (1D) ──────────────────────────────────────────────────

function hash1(n: number): number {
  const x = Math.sin(n) * 43758.5453123;
  return x - Math.floor(x);
}

function smoothNoise(x: number): number {
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f);
  return hash1(i) * (1 - u) + hash1(i + 1) * u;
}

// ── Colour helpers ────────────────────────────────────────────────────────────

// Warm terracotta at silence → hot amber at high amplitude
function ampToColor(amp: number): [number, number, number] {
  // Dark clay (#0d0806) → bright amber (#e06820)
  const r = 0.051 + amp * (0.878 - 0.051);
  const g = 0.031 + amp * (0.408 - 0.031);
  const b = 0.024 + amp * (0.125 - 0.024);
  return [r, g, b];
}

// ── Build tube geometry from history buffer ───────────────────────────────────

function buildRingVertices(
  ringIdx: number,   // position in [0, HISTORY) in render order (0=oldest, HISTORY-1=newest)
  cx: number, cy: number, cz: number,  // ring centre
  tx: number, ty: number, tz: number,  // unit tangent
  radius: number,
  amp: number
): void {
  // Compute an arbitrary vector perpendicular to tangent for the N (normal) direction
  // We always keep "up" preference unless tangent is near-vertical
  const absY = Math.abs(ty);
  let ux: number, uy: number, uz: number;
  if (absY < 0.95) {
    // cross(tangent, worldUp) = perp in horizontal plane
    const len = Math.sqrt(tx * tx + tz * tz) || 1;
    ux = -tz / len;
    uy = 0;
    uz =  tx / len;
  } else {
    // tangent near-vertical: use world X as reference
    const dot = tx;
    ux = 1 - dot * tx; uy = -dot * ty; uz = -dot * tz;
    const len = Math.sqrt(ux * ux + uy * uy + uz * uz) || 1;
    ux /= len; uy /= len; uz /= len;
  }
  // Binormal = tangent × normal
  const bx = ty * uz - tz * uy;
  const by = tz * ux - tx * uz;
  const bz = tx * uy - ty * ux;

  const [r, g, b] = ampToColor(amp);
  const baseVert = ringIdx * RADIAL;

  for (let j = 0; j < RADIAL; j++) {
    const phi = (j / RADIAL) * Math.PI * 2;
    const cp = Math.cos(phi);
    const sp = Math.sin(phi);
    const nx = cp * ux + sp * bx;
    const ny = cp * uy + sp * by;
    const nz = cp * uz + sp * bz;

    const vi = (baseVert + j) * 3;
    posArr[vi    ] = cx + radius * nx;
    posArr[vi + 1] = cy + radius * ny;
    posArr[vi + 2] = cz + radius * nz;
    norArr[vi    ] = nx;
    norArr[vi + 1] = ny;
    norArr[vi + 2] = nz;
    colArr[vi    ] = r;
    colArr[vi + 1] = g;
    colArr[vi + 2] = b;
  }
}

function updateGeometry(numCoils: number, scale: number): void {
  if (!tubeMesh) return;

  const count = historyFull ? HISTORY : historyHead;
  if (count < 2) return;

  // Compute ring centre positions along a helix perturbed by per-ring noise
  const centres: [number, number, number][] = [];
  for (let i = 0; i < count; i++) {
    const bufIdx = historyFull
      ? (historyHead + i) % HISTORY
      : i;
    const t = i / (count - 1);
    const theta = t * Math.PI * 2 * numCoils;
    const amp = ampHistory[bufIdx];
    const r = BASE_R + amp * scale;
    const nx = noiseOffsetX[bufIdx];
    const nz = noiseOffsetZ[bufIdx];
    centres.push([
      r * Math.cos(theta) + nx,
      HEIGHT * (t - 0.5),
      r * Math.sin(theta) + nz,
    ]);
  }

  // Build ring frames with tangents derived from adjacent centres
  for (let i = 0; i < count; i++) {
    const bufIdx = historyFull
      ? (historyHead + i) % HISTORY
      : i;
    const [cx, cy, cz] = centres[i];
    // Tangent from finite differences
    const [px, py, pz] = i > 0 ? centres[i - 1] : centres[0];
    const [nx_, ny_, nz_] = i < count - 1 ? centres[i + 1] : centres[count - 1];
    let tx = nx_ - px;
    let ty = ny_ - py;
    let tz = nz_ - pz;
    const tlen = Math.sqrt(tx * tx + ty * ty + tz * tz) || 1;
    tx /= tlen; ty /= tlen; tz /= tlen;

    const amp = ampHistory[bufIdx];
    const tubeRadius = TUBE_R * (0.4 + amp * 1.6);  // fatter when louder

    buildRingVertices(i, cx, cy, cz, tx, ty, tz, tubeRadius, amp);
  }

  const geo = tubeMesh.geometry as THREE.BufferGeometry;
  const posAttr = geo.attributes['position'] as THREE.BufferAttribute;
  const norAttr = geo.attributes['normal'] as THREE.BufferAttribute;
  const colAttr = geo.attributes['color'] as THREE.BufferAttribute;
  posAttr.needsUpdate = true;
  norAttr.needsUpdate = true;
  colAttr.needsUpdate = true;

  // Update draw range to only show filled history
  const triCount = (count - 1) * RADIAL * 2;
  geo.setDrawRange(0, triCount * 3);
  geo.computeBoundingSphere();
}

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
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x040208);  // near-black with warm tint

  camera = new THREE.PerspectiveCamera(
    50,
    window.innerWidth / window.innerHeight,
    0.1,
    100
  );
  camera.fov = fovForAspect(50, camera.aspect);
  camera.updateProjectionMatrix();
  camera.position.set(0, 0, 8);

  // ── Lighting: warm key + cool fill + ambient ──────────────────────────────
  keyLight = new THREE.DirectionalLight(0xffca70, 2.2);
  keyLight.position.set(4, 5, 3);
  scene.add(keyLight);

  const fillLight = new THREE.DirectionalLight(0x3060d0, 0.5);
  fillLight.position.set(-3, -2, -4);
  scene.add(fillLight);

  scene.add(new THREE.AmbientLight(0x0a0510, 0.6));

  // ── Tube mesh: pre-allocated BufferGeometry ───────────────────────────────
  posArr = new Float32Array(HISTORY * RADIAL * 3);
  norArr = new Float32Array(HISTORY * RADIAL * 3);
  colArr = new Float32Array(HISTORY * RADIAL * 3);

  // Build quad-strip index buffer: triangles connecting adjacent rings
  const idxArr = new Uint32Array((HISTORY - 1) * RADIAL * 6);
  let idx = 0;
  for (let ring = 0; ring < HISTORY - 1; ring++) {
    const a0 = ring * RADIAL;
    const a1 = (ring + 1) * RADIAL;
    for (let j = 0; j < RADIAL; j++) {
      const j1 = (j + 1) % RADIAL;
      idxArr[idx++] = a0 + j;
      idxArr[idx++] = a1 + j;
      idxArr[idx++] = a1 + j1;
      idxArr[idx++] = a0 + j;
      idxArr[idx++] = a1 + j1;
      idxArr[idx++] = a0 + j1;
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(posArr, 3));
  geo.setAttribute('normal',   new THREE.BufferAttribute(norArr, 3));
  geo.setAttribute('color',    new THREE.BufferAttribute(colArr, 3));
  geo.setIndex(new THREE.BufferAttribute(idxArr, 1));
  geo.setDrawRange(0, 0);

  tubeMaterial = new THREE.MeshStandardMaterial({
    vertexColors: true,
    metalness:  0.3,
    roughness:  0.6,
    side:       THREE.FrontSide,
  });

  tubeMesh = new THREE.Mesh(geo, tubeMaterial);
  scene.add(tubeMesh);

  // ── Post-processing ───────────────────────────────────────────────────────
  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));

  if (!isMobile) {
    const bloom = new UnrealBloomPass(
      new THREE.Vector2(window.innerWidth, window.innerHeight),
      0.35, 0.5, 0.75
    );
    composer.addPass(bloom);
  }

  composer.addPass(new OutputPass());
  initialized = true;
}

// ── Draw ──────────────────────────────────────────────────────────────────────

export function drawWorm(_p: unknown, dt: number): void {
  if (!initialized) setup();
  if (!renderer || !scene || !camera || !composer) return;

  const cfg   = store.config;
  const { amps, transients } = getBandAverages(7);

  const numCoils = 2 + Math.round(cfg.wormCoils * 6);       // 2–8 coils
  const scale    = cfg.wormScale * 1.0;                     // 0–1 → 0–1 displacement
  const polish   = cfg.wormPolish;                          // 0=shiny, 1=matte

  if (tubeMaterial) {
    tubeMaterial.roughness = 0.15 + polish * 0.75;
    tubeMaterial.metalness = 0.5  - polish * 0.35;
  }

  // ── Sample audio into ring buffer ───────────────────────────────────────
  const overallAmp = Math.min(1, amps.reduce((s: number, v: number) => s + v, 0) / 7);

  // Advance Perlin noise path with slight random walk (per-frame, not per-band)
  const speed = 0.004 * dt;
  noiseVX += (smoothNoise(noiseX * 0.3) - 0.5) * 0.03 * dt;
  noiseVZ += (smoothNoise(noiseZ * 0.3) - 0.5) * 0.03 * dt;
  noiseVX *= 0.995;
  noiseVZ *= 0.995;
  noiseX  += noiseVX * speed;
  noiseZ  += noiseVZ * speed;

  const writeIdx = historyHead % HISTORY;
  ampHistory[writeIdx]   = overallAmp;
  noiseOffsetX[writeIdx] = (smoothNoise(noiseX) - 0.5) * 0.6;
  noiseOffsetZ[writeIdx] = (smoothNoise(noiseZ + 7.3) - 0.5) * 0.6;
  historyHead++;
  if (historyHead >= HISTORY) historyFull = true;

  // ── Update tube geometry ────────────────────────────────────────────────
  updateGeometry(numCoils, scale);

  // ── Camera orbit ────────────────────────────────────────────────────────
  const orbitSpeed = 0.0003 * dt;
  camTheta += orbitSpeed;
  camPhi    = 0.25 + Math.sin(camTheta * 0.3) * 0.2;  // gentle elevation oscillation

  // Beat kick: brief FOV punch driven by bass transient
  if ((transients[0] ?? 1) > 1.5 && beatKick < 0.1) {
    beatKick = 0.08;
  }
  beatKick *= Math.pow(0.92, dt);

  camFov = 50 + beatKick * 120;
  if (camera) {
    camera.fov = fovForAspect(camFov, camera.aspect);
    camera.updateProjectionMatrix();

    const dist = 7.5 - overallAmp * 0.8;
    camera.position.set(
      dist * Math.sin(camTheta) * Math.cos(camPhi),
      dist * Math.sin(camPhi),
      dist * Math.cos(camTheta) * Math.cos(camPhi)
    );
    camera.lookAt(0, 0, 0);
  }

  // ── Animate key light to follow audio (warm pulse) ──────────────────────
  if (keyLight) {
    keyLight.intensity = 2.0 + overallAmp * 1.2 + beatKick * 3;
  }

  composer.render();
}

// ── Reset (resize) ────────────────────────────────────────────────────────────

export function resetWorm(): void {
  if (!initialized) return;
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer?.setSize(w, h);
  if (camera) {
    camera.aspect = w / h;
    camera.fov = fovForAspect(camFov, camera.aspect);
    camera.updateProjectionMatrix();
  }
  composer?.setSize(w, h);
}

// ── Dispose ───────────────────────────────────────────────────────────────────

export function disposeWorm(): void {
  if (!initialized) return;
  tubeMesh?.geometry.dispose();
  tubeMaterial?.dispose();
  composer?.dispose();
  renderer?.dispose();
  threeCanvas?.remove();
  threeCanvas  = null;
  renderer     = null;
  scene        = null;
  camera       = null;
  composer     = null;
  tubeMesh     = null;
  tubeMaterial = null;
  keyLight     = null;
  initialized  = false;
  historyHead  = 0;
  historyFull  = false;
  noiseX = 0; noiseZ = 0; noiseVX = 0.4; noiseVZ = 0.3;
}
