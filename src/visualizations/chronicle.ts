/**
 * Chronicle — 3D scrolling audio sediment landscape
 * Each frame of the spectrum is deposited as a row of geometry that
 * scrolls back through Z, building a physical 3D record of the music.
 * Flat-shaded terracotta geometry under warm directional light —
 * no rainbow palette, no emissive glow.
 * Inspired by Quayola "Partitura 002" (2011, https://quayola.com/partitura/)
 * and real-time VJ terrain synthesis in TouchDesigner.
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { store } from '../state/store';
import { getBandAverages } from './helpers';
import { isMobile } from '../utils/constants';
import { audioEngine } from '../audio/engine';

// ── Constants ─────────────────────────────────────────────────────────────────

const BAND_COUNT = 7;
const INTERP = 4;                          // interpolated cols between bands
const COLS = (BAND_COUNT - 1) * INTERP + 1; // 25 vertex columns

// Row limits driven by history slider (0-1 → MIN_ROWS–MAX_ROWS)
const MIN_ROWS = 16;
const MAX_ROWS = isMobile ? 40 : 96;

// World-space sizing
const GRID_WIDTH = 12.0;                   // total X extent
const COL_STEP   = GRID_WIDTH / (COLS - 1);
const ROW_STEP   = 0.32;                   // Z spacing between history frames
const MAX_HEIGHT = isMobile ? 4.5 : 6.0;  // maximum bar height at amplitude=1

// Camera orbit
const CAM_RADIUS = 18.0;

// ── Module state ──────────────────────────────────────────────────────────────

let initialized    = false;
let threeCanvas:    HTMLCanvasElement | null = null;
let renderer:       THREE.WebGLRenderer | null = null;
let scene:          THREE.Scene | null = null;
let camera:         THREE.PerspectiveCamera | null = null;
let composer:       EffectComposer | null = null;
let surfaceMesh:    THREE.Mesh | null = null;
let surfaceMat:     THREE.MeshStandardMaterial | null = null;
let keyLight:       THREE.DirectionalLight | null = null;
let vizModeUnsub:   (() => void) | null = null;

// Geometry buffers (re-allocated when row count changes)
let posAttr:        THREE.BufferAttribute | null = null;
let normAttr:       THREE.BufferAttribute | null = null;
let rawPositions:   Float32Array | null = null;
let rawNormals:     Float32Array | null = null;

// Ring buffer: MAX_ROWS × BAND_COUNT amplitude values
let ringBuffer:     Float32Array = new Float32Array(MAX_ROWS * BAND_COUNT);
let ringHead        = 0;           // next slot to write
let currentRows     = MIN_ROWS;    // how many rows are currently in the geometry

// Per-band eased heights for smooth continuous motion (TD-style CHOP easing)
const easedAmps:    Float32Array = new Float32Array(BAND_COUNT);
const targetAmps:   Float32Array = new Float32Array(BAND_COUNT);

// Camera state
let camTheta     = 0;              // azimuth (radians)
let camPhi       = 0.38;           // elevation angle (radians from horizontal)
let camPhiTarget = 0.38;
let beatPulse    = 0;              // decay value that spikes camera jerk on beat
let lastBeatIdx  = -1;

// ── Geometry helpers ──────────────────────────────────────────────────────────

function interpolateAmps(amps: Float32Array, colIdx: number): number {
  const t   = colIdx / (COLS - 1) * (BAND_COUNT - 1);
  const b0  = Math.min(Math.floor(t), BAND_COUNT - 2);
  const b1  = b0 + 1;
  const frac = t - b0;
  return amps[b0] * (1 - frac) + amps[b1] * frac;
}

function buildGeometry(rows: number): THREE.BufferGeometry {
  const vCount  = COLS * rows;
  const idxCount = (COLS - 1) * (rows - 1) * 6;

  rawPositions = new Float32Array(vCount * 3);
  rawNormals   = new Float32Array(vCount * 3);
  const idxBuf = new Uint32Array(idxCount);

  // Initial flat positions — y will be updated per frame
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < COLS; c++) {
      const vi = (r * COLS + c) * 3;
      rawPositions[vi]     = -GRID_WIDTH / 2 + c * COL_STEP;
      rawPositions[vi + 1] = 0;
      rawPositions[vi + 2] = -r * ROW_STEP;
    }
  }

  // Triangle indices (quads split into 2 tris)
  let ii = 0;
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < COLS - 1; c++) {
      const a = r * COLS + c;
      const b = a + 1;
      const d = a + COLS;
      const e = d + 1;
      idxBuf[ii++] = a; idxBuf[ii++] = d; idxBuf[ii++] = b;
      idxBuf[ii++] = b; idxBuf[ii++] = d; idxBuf[ii++] = e;
    }
  }

  const geo = new THREE.BufferGeometry();
  posAttr  = new THREE.BufferAttribute(rawPositions, 3);
  normAttr = new THREE.BufferAttribute(rawNormals, 3);
  posAttr.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('position', posAttr);
  geo.setAttribute('normal', normAttr);
  geo.setIndex(new THREE.BufferAttribute(idxBuf, 1));
  return geo;
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
  renderer.setPixelRatio(isMobile ? 1.0 : Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x080b16);
  scene.fog = new THREE.Fog(0x080b16, 18, 45);

  // Camera
  camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 120);

  // Lights — warm key + cool fill, no rainbow
  keyLight = new THREE.DirectionalLight(0xffe8c8, 2.4);
  keyLight.position.set(6, 10, 4);
  scene.add(keyLight);

  const fillLight = new THREE.DirectionalLight(0x3a5080, 0.9);
  fillLight.position.set(-8, 4, -6);
  scene.add(fillLight);

  const ambLight = new THREE.AmbientLight(0x12161e, 1.0);
  scene.add(ambLight);

  // Surface material — warm terracotta, flat-shaded, physical
  surfaceMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(0xb8703a),
    roughness: 0.88,
    metalness: 0.0,
    flatShading: true,
    side: THREE.DoubleSide,
  });

  // Build initial geometry
  currentRows = MIN_ROWS;
  const geo = buildGeometry(currentRows);
  surfaceMesh = new THREE.Mesh(geo, surfaceMat);
  scene.add(surfaceMesh);

  // Post-processing — minimal, just tone-mapping output
  const renderPass  = new RenderPass(scene, camera);
  const outputPass  = new OutputPass();
  composer = new EffectComposer(renderer);
  composer.addPass(renderPass);
  composer.addPass(outputPass);
  composer.setSize(window.innerWidth, window.innerHeight);

  vizModeUnsub = store.on('vizModeChange', (mode) => {
    if (threeCanvas) threeCanvas.style.display = mode === 'chronicle' ? 'block' : 'none';
  });

  initialized = true;
}

// ── Draw ──────────────────────────────────────────────────────────────────────

export function drawChronicle(_p: unknown, dt: number): void {
  if (!initialized) setup();
  if (!renderer || !scene || !camera || !composer || !surfaceMesh) return;

  const cfg = store.config;
  const { amps, transients } = getBandAverages(BAND_COUNT);

  // ── Desired row count from slider ──────────────────────────────────────────
  const desiredRows = Math.round(MIN_ROWS + cfg.chronicleDepth * (MAX_ROWS - MIN_ROWS));
  if (desiredRows !== currentRows) {
    surfaceMesh.geometry.dispose();
    currentRows = desiredRows;
    const newGeo = buildGeometry(currentRows);
    surfaceMesh.geometry = newGeo;
    ringBuffer.fill(0);
    ringHead = 0;
  }

  // ── Push new amplitude row into ring buffer ───────────────────────────────
  for (let b = 0; b < BAND_COUNT; b++) {
    easedAmps[b] += (amps[b] - easedAmps[b]) * Math.min(1, 0.35 * dt);
    ringBuffer[ringHead * BAND_COUNT + b] = easedAmps[b];
  }
  ringHead = (ringHead + 1) % MAX_ROWS;

  // ── Beat detection — continuous kick, not snap ─────────────────────────────
  const { state } = store;
  if (state.beatIntervalSec > 0 && state.isPlaying) {
    const pos     = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    const beatIdx  = adjusted >= 0 ? Math.floor(adjusted / state.beatIntervalSec) : -1;
    if (beatIdx > lastBeatIdx) {
      lastBeatIdx = beatIdx;
      beatPulse   = 1.0;
    }
  }
  beatPulse *= Math.pow(0.88, dt);

  // ── Camera orbit ──────────────────────────────────────────────────────────
  const orbitSlider = cfg.chronicleOrbit;           // 0-1
  const orbitSpeed  = 0.0004 + orbitSlider * 0.0018;
  camTheta         += orbitSpeed * dt + beatPulse * 0.012 * dt;

  // Elevation: orbit slider also lifts camera (0=low dramatic→1=higher overview)
  camPhiTarget = 0.22 + orbitSlider * 0.32;
  camPhi      += (camPhiTarget - camPhi) * Math.min(1, 0.05 * dt);

  // Grid centre in Z
  const gridCentreZ = -currentRows * ROW_STEP * 0.5;
  const lookTarget  = new THREE.Vector3(0, 1.2, gridCentreZ);

  const cx = CAM_RADIUS * Math.sin(camTheta) * Math.cos(camPhi);
  const cy = CAM_RADIUS * Math.sin(camPhi) + beatPulse * 1.2;
  const cz = CAM_RADIUS * Math.cos(camTheta) * Math.cos(camPhi) + gridCentreZ;
  camera.position.set(cx, cy, cz);
  camera.lookAt(lookTarget);

  // ── Surface color — subtle warmth shift with dominant band ──────────────
  if (surfaceMat) {
    let maxAmp = 0;
    let domBand = 0;
    for (let b = 0; b < BAND_COUNT; b++) {
      if ((amps[b] ?? 0) > maxAmp) { maxAmp = amps[b] ?? 0; domBand = b; }
    }
    const hueShift = domBand / (BAND_COUNT - 1);
    // warm ochre at bass → cooler sand at treble — restrained palette
    surfaceMat.color.setHSL(0.07 - hueShift * 0.03, 0.62, 0.44);
  }

  // ── Height scale from slider ──────────────────────────────────────────────
  const heightScale = 0.3 + cfg.chronicleHeight * 0.9;

  // ── Update geometry positions ─────────────────────────────────────────────
  if (rawPositions && posAttr) {
    for (let r = 0; r < currentRows; r++) {
      const bufRow = (ringHead - 1 - r + MAX_ROWS) % MAX_ROWS;
      for (let b = 0; b < BAND_COUNT; b++) {
        targetAmps[b] = ringBuffer[bufRow * BAND_COUNT + b];
      }
      for (let c = 0; c < COLS; c++) {
        const vi = (r * COLS + c) * 3;
        const amp = interpolateAmps(targetAmps, c);
        rawPositions[vi + 1] = amp * MAX_HEIGHT * heightScale;
        rawPositions[vi + 2] = -r * ROW_STEP;
      }
    }
    posAttr.needsUpdate = true;
    surfaceMesh.geometry.computeVertexNormals();
  }

  // ── Key light tracking for warmth animation ───────────────────────────────
  if (keyLight) {
    let transientMax = 1.0;
    for (let b = 0; b < BAND_COUNT; b++) {
      if ((transients[b] ?? 1.0) > transientMax) transientMax = transients[b] ?? 1.0;
    }
    keyLight.intensity = 2.4 + (transientMax - 1) * 0.8 + beatPulse * 1.2;
  }

  composer.render();
}

// ── Reset (canvas resize) ─────────────────────────────────────────────────────

export function resetChronicle(): void {
  if (!initialized) return;
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer?.setSize(w, h);
  if (camera) {
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  composer?.setSize(w, h);
}

// ── Dispose ───────────────────────────────────────────────────────────────────

export function disposeChronicle(): void {
  if (!initialized) return;
  vizModeUnsub?.();
  vizModeUnsub = null;
  surfaceMesh?.geometry.dispose();
  surfaceMat?.dispose();
  composer?.dispose();
  renderer?.dispose();
  threeCanvas?.remove();

  threeCanvas = null; renderer = null; scene = null; camera = null;
  composer = null; surfaceMesh = null; surfaceMat = null; keyLight = null;
  posAttr = null; normAttr = null; rawPositions = null; rawNormals = null;
  ringBuffer = new Float32Array(MAX_ROWS * BAND_COUNT);
  ringHead = 0; currentRows = MIN_ROWS;
  easedAmps.fill(0); targetAmps.fill(0);
  camTheta = 0; beatPulse = 0; lastBeatIdx = -1;
  initialized = false;
}
