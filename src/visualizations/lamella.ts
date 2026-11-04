/**
 * Lamella — Three.js WebGL overlay visualization
 * A grid of vertical glass panels (louvres) whose tilt angle responds to audio.
 * Each column zone maps to a frequency band: bass tilts left columns, brilliance
 * tilts right. Beat fires a "stadium wave" that sweeps across the entire grid.
 * Warm tungsten SpotLight + cool steel fill + white rim backlight reveal the
 * glass transmission and iridescence as panels rotate.
 *
 * Inspired by Tokujin Yoshioka "Tornado" (Salone del Mobile, 2007) — a tornado
 * of thousands of translucent fibres — and UVA "Volume" (V&A Museum, 2006).
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

// ── Sizing constants (mobile-guarded) ────────────────────────────────────────

const MAX_COLS = isMobile ? 8  : 20;
const MAX_ROWS = isMobile ? 5  : 12;

// World-space grid extent
const GRID_W  = 22;    // horizontal width
const GRID_H  = 12;    // vertical height
const FOV     = 48;    // base vertical FOV

// ── Module state ──────────────────────────────────────────────────────────────

let threeCanvas : HTMLCanvasElement       | null = null;
let renderer    : THREE.WebGLRenderer     | null = null;
let scene       : THREE.Scene             | null = null;
let camera      : THREE.PerspectiveCamera | null = null;
let composer    : EffectComposer          | null = null;
let iMesh       : THREE.InstancedMesh     | null = null;
let panelMat    : THREE.MeshPhysicalMaterial | null = null;
let keyLight    : THREE.SpotLight         | null = null;
let vizUnsub    : (() => void)            | null = null;
let initialized = false;

let camT          = 0;        // time parameter for camera sway
let lastBeatIndex = -1;
let wavePhase     = 999;      // > 1 = inactive
let beatKick      = 0;        // 0–1, decays each frame
let lastBuiltCols = 0;
let lastBuiltRows = 0;

// Per-column tilt (radians) and smoothed band amplitudes
let colTilts    = new Float32Array(MAX_COLS);
const smoothBands = new Float32Array(7);

// Three.js helper for building instance matrices without allocations
const dummy = new THREE.Object3D();

// ── Grid helpers ──────────────────────────────────────────────────────────────

function getGridDims(): { cols: number; rows: number } {
  const d    = store.config.lamellaDensity;             // 0–1
  const minC = isMobile ? 3 : 5;
  const cols = Math.round(minC + d * (MAX_COLS - minC));
  const rows = Math.max(2, Math.round(cols * (isMobile ? 0.5 : 0.55)));
  return { cols, rows: Math.min(rows, MAX_ROWS) };
}

function panelSpacing(cols: number, rows: number): {
  sx: number; sy: number; pw: number; ph: number;
} {
  const sx = GRID_W / cols;
  const sy = GRID_H / rows;
  return { sx, sy, pw: sx * 0.96, ph: sy * 0.94 };
}

// ── Build / rebuild instanced mesh ───────────────────────────────────────────

function buildMesh(cols: number, rows: number): void {
  if (iMesh) {
    iMesh.geometry.dispose();
    scene?.remove(iMesh);
    iMesh = null;
  }

  const { sx, sy, pw, ph } = panelSpacing(cols, rows);
  const thickness = pw * 0.025;      // very thin panel

  const geo = new THREE.BoxGeometry(pw, ph, thickness);
  const count = cols * rows;

  iMesh = new THREE.InstancedMesh(geo, panelMat!, count);
  iMesh.frustumCulled = false;

  const ox = -(cols - 1) * sx * 0.5;
  const oy = -(rows - 1) * sy * 0.5;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      dummy.position.set(ox + c * sx, oy + r * sy, 0);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.setScalar(1);
      dummy.updateMatrix();
      iMesh.setMatrixAt(r * cols + c, dummy.matrix);
    }
  }
  iMesh.instanceMatrix.needsUpdate = true;

  scene?.add(iMesh);

  colTilts    = new Float32Array(cols);
  lastBuiltCols = cols;
  lastBuiltRows = rows;
}

// ── Setup ─────────────────────────────────────────────────────────────────────

function setup(): void {
  threeCanvas = document.createElement('canvas');
  threeCanvas.style.cssText =
    'position:fixed;top:0;left:0;width:100%;height:100%;z-index:10;pointer-events:none;display:block';
  document.body.appendChild(threeCanvas);

  renderer = new THREE.WebGLRenderer({
    canvas: threeCanvas,
    antialias: !isMobile,
    alpha: true,
  });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, isMobile ? 1 : 2));
  renderer.toneMapping    = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x04050a);
  scene.fog = new THREE.FogExp2(0x04050a, 0.028);

  const aspect = window.innerWidth / window.innerHeight;
  camera = new THREE.PerspectiveCamera(fovForAspect(FOV, aspect), aspect, 0.1, 100);

  // ── Lighting ──
  // Ambient: very dark so lights define the form
  scene.add(new THREE.AmbientLight(0x101822, 1.0));

  // Warm tungsten SpotLight from upper-front-left
  keyLight = new THREE.SpotLight(0xffd580, isMobile ? 4 : 7);
  keyLight.position.set(-6, 14, 10);
  keyLight.angle   = Math.PI / 3.8;
  keyLight.penumbra = 0.45;
  keyLight.target.position.set(0, 0, 0);
  scene.add(keyLight);
  scene.add(keyLight.target);

  // Cool steel fill from upper-right
  const fillLight = new THREE.DirectionalLight(0x8099cc, 0.9);
  fillLight.position.set(8, 6, 4);
  scene.add(fillLight);

  // White rim backlight — illuminates glass edges when panels tilt
  const rimLight = new THREE.DirectionalLight(0xddeeff, isMobile ? 0.7 : 1.1);
  rimLight.position.set(0, -2, -12);
  scene.add(rimLight);

  // ── Material: physical glass with iridescence ──
  panelMat = new THREE.MeshPhysicalMaterial({
    color               : new THREE.Color(0xfff9f4),
    metalness           : 0.0,
    roughness           : 0.06,
    transmission        : 0.30,
    thickness           : 0.08,
    ior                 : 1.52,
    iridescence         : 0.0,         // updated each frame from slider
    iridescenceIOR      : 1.48,
    iridescenceThicknessRange: [80, 420],
    side                : THREE.DoubleSide,
    transparent         : true,
  });

  // Build initial instanced mesh
  const { cols, rows } = getGridDims();
  buildMesh(cols, rows);

  // Initial camera position
  updateCamera(0);

  // ── Post-processing ──
  const size = new THREE.Vector2(window.innerWidth, window.innerHeight);
  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera!));
  if (!isMobile) {
    // Subtle bloom — catches specular glints and rim-lit glass edges
    composer.addPass(new UnrealBloomPass(size, 0.35, 0.5, 0.65));
  }
  composer.addPass(new OutputPass());

  vizUnsub = store.on('vizModeChange', (data) => {
    if (threeCanvas) threeCanvas.style.display = data === 'lamella' ? 'block' : 'none';
  });

  initialized = true;
}

// ── Camera ────────────────────────────────────────────────────────────────────

function updateCamera(t: number): void {
  if (!camera) return;
  // Slow sinusoidal sway left-right + gentle elevation oscillation
  const camX = Math.sin(t * 0.28) * 3.5;
  const camY = 2.5 + Math.sin(t * 0.17) * 1.5;
  const camZ = 15.5 + Math.cos(t * 0.22) * 2.0;
  camera.position.set(camX, camY, camZ);
  camera.lookAt(0, 0.5, 0);
}

// ── Draw ──────────────────────────────────────────────────────────────────────

export function drawLamella(_p: unknown, dt: number): void {
  if (!initialized) setup();

  const cfg  = store.config;
  const { state } = store;
  const { amps } = getBandAverages(7);

  // Rebuild grid when density slider changes grid dimensions
  const { cols, rows } = getGridDims();
  if (cols !== lastBuiltCols || rows !== lastBuiltRows) {
    buildMesh(cols, rows);
  }

  // Smooth audio bands — CHOP-style continuous signal
  for (let b = 0; b < 7; b++) {
    smoothBands[b] += ((amps[b] ?? 0) - smoothBands[b]) * 0.18 * dt;
  }

  // ── Beat detection ──
  if (state.beatIntervalSec > 0 && state.isPlaying) {
    const pos      = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    const beatIdx  = adjusted >= 0 ? Math.floor(adjusted / state.beatIntervalSec) : -1;
    if (beatIdx > lastBeatIndex) {
      lastBeatIndex = beatIdx;
      beatKick  = 1.0;
      wavePhase = 0.0;   // kick wave from the left
    }
  }

  // Decay beat kick
  beatKick *= Math.pow(0.84, dt);
  if (beatKick < 0.004) beatKick = 0;

  // Advance stadium wave across full grid width (~24 frames)
  wavePhase += dt * 0.045;

  // ── Update iridescence from slider (continuous CHOP-style) ──
  if (panelMat) {
    panelMat.iridescence = cfg.lamellaIridescence;
  }

  // ── Key-light intensity breathes with overall amplitude ──
  if (keyLight) {
    const avg = smoothBands.reduce((s, v) => s + v, 0) / 7;
    const base = isMobile ? 4 : 7;
    keyLight.intensity = base + avg * 2.5;
  }

  // ── Tilt each column of panels based on audio ──
  if (iMesh) {
    const { sx, sy } = panelSpacing(cols, rows);
    const ox = -(cols - 1) * sx * 0.5;
    const oy = -(rows - 1) * sy * 0.5;
    const maxTilt = THREE.MathUtils.degToRad(12 + cfg.lamellaTilt * 60);

    for (let c = 0; c < cols; c++) {
      // Gaussian blend of 7 band amplitudes for this column's x-fraction
      const colFrac = cols > 1 ? c / (cols - 1) : 0.5;
      let targetTilt = 0;
      for (let b = 0; b < 7; b++) {
        const bandCenter = b / 6;
        const diff = colFrac - bandCenter;
        const w = Math.exp(-diff * diff * 18);
        targetTilt += smoothBands[b] * w;
      }
      targetTilt = Math.min(targetTilt, 1.0) * maxTilt;

      // Stadium-wave kick: a pulse that travels left → right across the grid
      const waveCol = wavePhase * cols;
      const waveDist = Math.abs(c - waveCol);
      const waveKick = Math.max(0, 1 - waveDist * 0.7) * beatKick * maxTilt * 0.55;

      // Continuous ease toward target + decaying beat kick
      const target = targetTilt + waveKick;
      colTilts[c] += (target - colTilts[c]) * 0.14 * dt;

      // Update all panel instances in this column
      for (let r = 0; r < rows; r++) {
        dummy.position.set(ox + c * sx, oy + r * sy, 0);
        dummy.rotation.set(0, colTilts[c], 0);
        dummy.scale.setScalar(1);
        dummy.updateMatrix();
        iMesh.setMatrixAt(r * cols + c, dummy.matrix);
      }
    }
    iMesh.instanceMatrix.needsUpdate = true;
  }

  // ── Advance and apply camera sway ──
  camT += dt * 0.014;
  updateCamera(camT);

  composer?.render();
}

// ── Reset (resize handler) ────────────────────────────────────────────────────

export function resetLamella(): void {
  if (!initialized) return;
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer?.setSize(w, h);
  if (camera) {
    camera.aspect = w / h;
    camera.fov    = fovForAspect(FOV, camera.aspect);
    camera.updateProjectionMatrix();
  }
  composer?.setSize(w, h);
}

// ── Dispose ───────────────────────────────────────────────────────────────────

export function disposeLamella(): void {
  if (!initialized) return;
  vizUnsub?.();
  vizUnsub = null;

  if (iMesh) {
    iMesh.geometry.dispose();
    scene?.remove(iMesh);
    iMesh = null;
  }
  panelMat?.dispose();
  panelMat = null;

  composer?.dispose();
  renderer?.dispose();
  threeCanvas?.remove();

  threeCanvas = null;
  renderer    = null;
  scene       = null;
  camera      = null;
  composer    = null;
  keyLight    = null;

  camT          = 0;
  lastBeatIndex = -1;
  wavePhase     = 999;
  beatKick      = 0;
  lastBuiltCols = 0;
  lastBuiltRows = 0;
  colTilts      = new Float32Array(MAX_COLS);
  smoothBands.fill(0);

  initialized = false;
}
