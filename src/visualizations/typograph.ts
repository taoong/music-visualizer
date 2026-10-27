/**
 * Typograph — 3D Extruded Typography Relief Wall
 *
 * 7 rows of capital letters arranged in a grid; each row is assigned to one
 * frequency band (sub-bass at bottom, brilliance at top). Letters extrude
 * toward the camera proportional to their band's amplitude — treated as a
 * continuous CHOP signal, not a beat-triggered event. The depth of each row
 * tells you how loud that frequency band is at every moment.
 *
 * Warm ivory MeshStandardMaterial under a 2-point studio rig (warm amber key,
 * cool steel fill). No rainbow palette, no emissive glow, no radial rings.
 * Camera sits at a slight off-axis angle so the extrusion depth is visible;
 * it yaws slowly and receives a brief kick on each beat.
 *
 * Inspired by Ryoji Ikeda "data.tron [FRAGMENT]" (2008, YCAM Yamaguchi,
 * https://www.ryojiikeda.com/project/datatron/) — data rendered as a physical
 * typographic field in space. Also Lawrence Weiner's "Language + the materials
 * referred to" series where text becomes three-dimensional sculptural object.
 */
import * as THREE from 'three';
import { FontLoader } from 'three/addons/loaders/FontLoader.js';
import { type FontData, type Font } from 'three/addons/loaders/FontLoader.js';
import { TextGeometry } from 'three/addons/geometries/TextGeometry.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { store } from '../state/store';
import { getBandAverages } from './helpers';
import { audioEngine } from '../audio/engine';
import { isMobile } from '../utils/constants';
import fontData from 'three/examples/fonts/helvetiker_bold.typeface.json';

// ── Constants ─────────────────────────────────────────────────────────────────

const ROWS = 7;
const CHAR_SET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const LETTER_SIZE   = 0.72;   // font size
const EXTRUDE_DEPTH = 0.40;   // fixed letter depth
const CELL_W        = 1.30;   // horizontal cell spacing
const CELL_H        = 1.50;   // vertical cell spacing
const MAX_RELIEF    = 4.0;    // max pop-out distance at amplitude = 1
const LERP_RATE     = 0.12;   // CHOP-style easing per normalised frame
const CHAR_SWAP_SEC = 3.5;    // seconds between random character shuffles

// ── Module state ──────────────────────────────────────────────────────────────

let initialized = false;
let threeCanvas: HTMLCanvasElement | null = null;
let renderer: THREE.WebGLRenderer | null = null;
let scene: THREE.Scene | null = null;
let camera: THREE.PerspectiveCamera | null = null;
let composer: EffectComposer | null = null;

// Shared material — same for all letters
let letterMaterial: THREE.MeshStandardMaterial | null = null;

// Parsed font — cached after first parse (JSON parse is non-trivial)
let cachedFont: Font | null = null;

function getFont(): Font {
  if (!cachedFont) {
    cachedFont = new FontLoader().parse(fontData as unknown as FontData);
  }
  return cachedFont;
}

// Geometry cache keyed by character
const geoCache = new Map<string, THREE.BufferGeometry>();

// Per-cell state
interface LetterCell {
  mesh:       THREE.Mesh;
  bandIndex:  number;   // which of the 7 freq bands this cell belongs to
  currentZ:   number;   // smoothed Z offset (CHOP easing)
  swapTimer:  number;   // countdown to next character swap (seconds)
  char:       string;   // current displayed character
}

let cells: LetterCell[] = [];

// Camera state
let cameraYaw         = 0.0;  // current camera yaw angle (radians)
let cameraYawVel      = 0.0;  // current yaw velocity (for beat kick)
const CAM_DISTANCE    = 14.0;
const CAM_PITCH       = -0.18; // radians — slightly above the grid looking down
const CAM_YAW_SPEED   = 0.0015; // base orbit speed (radians/normalised frame)
const CAM_KICK_DECAY  = 0.90;  // decay per frame for kick velocity

// Beat detection
let lastBeatIndex = -1;

// ── Helpers ───────────────────────────────────────────────────────────────────

function randChar(): string {
  return CHAR_SET[Math.floor(Math.random() * CHAR_SET.length)];
}

function getOrBuildGeo(char: string, font: Font): THREE.BufferGeometry {
  const existing = geoCache.get(char);
  if (existing) return existing;

  const geo = new TextGeometry(char, {
    font,
    size:         LETTER_SIZE,
    depth:        EXTRUDE_DEPTH,
    curveSegments: isMobile ? 3 : 5,
    bevelEnabled: true,
    bevelThickness: 0.035,
    bevelSize:    0.025,
    bevelSegments: 2,
  });
  geo.computeBoundingBox();
  geo.center();
  geoCache.set(char, geo);
  return geo;
}

function buildCells(font: Font, nCols: number): void {
  if (!scene || !letterMaterial) return;

  // Remove old cells
  for (const cell of cells) {
    scene.remove(cell.mesh);
    // Geometry is shared via cache — don't dispose here
  }
  cells = [];

  const gridW = (nCols - 1) * CELL_W;
  const gridH = (ROWS  - 1) * CELL_H;

  for (let row = 0; row < ROWS; row++) {
    const bandIndex = row; // row 0 = sub-bass, row 6 = brilliance
    const y = row * CELL_H - gridH * 0.5;

    for (let col = 0; col < nCols; col++) {
      const x = col * CELL_W - gridW * 0.5;
      const char = randChar();
      const geo = getOrBuildGeo(char, font);

      const mesh = new THREE.Mesh(geo, letterMaterial);
      mesh.position.set(x, y, 0);
      scene.add(mesh);

      cells.push({
        mesh,
        bandIndex,
        currentZ: 0,
        swapTimer: Math.random() * CHAR_SWAP_SEC,
        char,
      });
    }
  }
}

// ── Setup ─────────────────────────────────────────────────────────────────────

function setup(): void {
  initialized = true;

  const w = window.innerWidth;
  const h = window.innerHeight;

  // Canvas overlay
  threeCanvas = document.createElement('canvas');
  threeCanvas.style.cssText =
    'position:fixed;top:0;left:0;width:100%;height:100%;z-index:10;pointer-events:none';
  document.body.appendChild(threeCanvas);

  // Renderer
  renderer = new THREE.WebGLRenderer({
    canvas: threeCanvas,
    antialias: !isMobile,
    alpha: true,
  });
  renderer.setPixelRatio(isMobile ? 1.0 : Math.min(window.devicePixelRatio, 2));
  renderer.setSize(w, h);
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  // Scene
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x050504);

  // Camera
  camera = new THREE.PerspectiveCamera(42, w / h, 0.1, 200);
  camera.position.set(0, 0, CAM_DISTANCE);

  // Lights
  // Warm amber key: above-left, from the front
  const keyLight = new THREE.DirectionalLight(0xffeedd, 2.8);
  keyLight.position.set(-3, 5, 8);
  scene.add(keyLight);

  // Cool steel fill: below-right, less intense
  const fillLight = new THREE.DirectionalLight(0xaaccff, 0.9);
  fillLight.position.set(4, -3, 5);
  scene.add(fillLight);

  // Very dim ambient so shadowed faces aren't fully black
  const ambientLight = new THREE.AmbientLight(0xffffff, 0.12);
  scene.add(ambientLight);

  // Material — warm ivory matte plaster
  letterMaterial = new THREE.MeshStandardMaterial({
    color: 0xf5f0e8,
    roughness: 0.75,
    metalness: 0.0,
  });

  // Build initial grid (font is parsed lazily and cached)
  const nCols = isMobile ? 5 : Math.round(store.config.typographColumns);
  buildCells(getFont(), nCols);

  // Post-processing: just tone-map for correctness, no bloom
  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  composer.addPass(new OutputPass());
}

// ── Draw (called by p5 draw loop at ~60fps) ───────────────────────────────────

export function drawTypograph(_p: unknown, dt: number): void {
  if (!initialized) setup();
  if (!renderer || !scene || !camera || !composer || !letterMaterial) return;

  const { amps, transients } = getBandAverages(7);
  const cfg = store.config;

  // ── Rebuild grid when Columns slider changes ──────────────────────────────
  const targetCols = isMobile ? 5 : Math.round(cfg.typographColumns);
  if (cells.length > 0) {
    // Detect column count change (cells per row = targetCols)
    const currentCols = cells.filter(c => c.bandIndex === 0).length;
    if (currentCols !== targetCols) {
      const loader2 = new FontLoader();
      const font2 = loader2.parse(fontData as unknown as FontData);
      buildCells(font2, targetCols);
    }
  }

  // ── Per-cell CHOP update ──────────────────────────────────────────────────
  const maxPop = cfg.typographRelief * MAX_RELIEF;   // 0–1 slider → 0–MAX_RELIEF
  const easeK  = 1.0 - Math.pow(1.0 - LERP_RATE, dt);

  for (const cell of cells) {
    const amp = amps[cell.bandIndex] ?? 0;

    // CHOP-style: target Z is amp * maxPop; ease toward it continuously
    const targetZ = amp * maxPop;
    cell.currentZ += (targetZ - cell.currentZ) * easeK;
    cell.mesh.position.z = cell.currentZ;

    // Material emissive warmth — subtle, driven by amplitude
    // (emissive is set on the shared material as average; per-object emissive
    // would require instancing or different meshes, but the avg looks good here)

    // Swap character timer
    cell.swapTimer -= (dt * 0.016667); // dt is normalised frames
    if (cell.swapTimer <= 0) {
      cell.swapTimer = CHAR_SWAP_SEC * (0.7 + Math.random() * 0.6);
      cell.char = randChar();
      const newGeo = getOrBuildGeo(cell.char, getFont());
      cell.mesh.geometry = newGeo;
      // position X/Y unchanged — geometry is already centered
    }
  }

  // ── Shared material emissive from overall loudness ────────────────────────
  const avgAmp = (amps.reduce((a, b) => a + b, 0)) / 7;
  const warmth = cfg.typographWarmth; // 0 = cool/white, 1 = warm/amber
  // Emissive: lerp between cool blue-white and warm amber based on warmth slider
  const emR = warmth * 0.55 * avgAmp;
  const emG = warmth * 0.25 * avgAmp;
  const emB = (1.0 - warmth) * 0.25 * avgAmp;
  if (letterMaterial) {
    letterMaterial.emissive.setRGB(emR, emG, emB);
  }

  // ── Beat detection — camera kick ─────────────────────────────────────────
  const { state } = store;
  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adj = pos - state.beatOffset;
    const beatIndex = adj >= 0 ? Math.floor(adj / state.beatIntervalSec) : -1;
    if (beatIndex >= 0 && beatIndex !== lastBeatIndex) {
      lastBeatIndex = beatIndex;
      // Quick yaw kick proportional to bass transient
      const rawT = Math.max(transients[0] ?? 1.0, transients[1] ?? 1.0);
      const kick = Math.max(0, rawT - 1.0) * 0.025;
      cameraYawVel += kick * (Math.random() > 0.5 ? 1 : -1);
    }
  }

  // ── Camera slow orbit ─────────────────────────────────────────────────────
  cameraYaw += (CAM_YAW_SPEED + cameraYawVel) * dt;
  cameraYawVel *= Math.pow(CAM_KICK_DECAY, dt);

  // Clamp yaw within ±35° so we always see letters face-on enough to read them
  const maxYaw = 0.35;
  cameraYaw = Math.max(-maxYaw, Math.min(maxYaw, cameraYaw));
  // Reverse direction when hitting clamp
  if (Math.abs(cameraYaw) >= maxYaw - 0.01) {
    cameraYawVel *= -1;
  }

  // Camera sits at (sinYaw * dist, pitchOffset, cosYaw * dist)
  const cx = Math.sin(cameraYaw) * CAM_DISTANCE;
  const cz = Math.cos(cameraYaw) * CAM_DISTANCE;
  const cy = Math.sin(CAM_PITCH) * CAM_DISTANCE;
  camera.position.set(cx, cy, cz);
  camera.lookAt(0, 0, 0);

  composer.render();
}

// ── Reset (called on resize) ──────────────────────────────────────────────────

export function resetTypograph(): void {
  if (!initialized) return;
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer?.setSize(w, h);
  composer?.setSize(w, h);
  if (camera) {
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
}

// ── Dispose (called on viz switch) ───────────────────────────────────────────

export function disposeTypograph(): void {
  if (!initialized) return;

  for (const cell of cells) {
    scene?.remove(cell.mesh);
    // Geometry shared via geoCache — don't dispose individual mesh geometries
  }
  cells = [];

  // Dispose all cached geometries
  for (const geo of geoCache.values()) geo.dispose();
  geoCache.clear();

  letterMaterial?.dispose();
  composer?.dispose();
  renderer?.dispose();
  threeCanvas?.remove();

  threeCanvas = null;
  renderer = null;
  scene = null;
  camera = null;
  composer = null;
  letterMaterial = null;
  initialized = false;
}
