/**
 * Cloister — Three.js WebGL overlay visualization
 * Tall quartzite stone pillars on a dark polished floor; a single warm
 * sidelight rakes the colonnade; 7 frequency bands drive column heights;
 * camera orbits at human height looking into the forest of stone.
 *
 * Inspired by Peter Zumthor's Therme Vals thermal baths (1996,
 * https://www.zumthor.com/therme-vals) and the stone-block architecture of
 * his Kolumba Museum (Cologne, 2007).
 */
import * as THREE from 'three';
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { isMobile } from '../utils/constants';

// ── Constants ─────────────────────────────────────────────────────────────────

const BAND_COUNT   = 7;
const MAX_ROWS     = isMobile ? 3 : 4;
const COL_SPACING  = 2.0;   // X gap between columns
const ROW_SPACING  = 2.2;   // Z gap between rows
const COL_W        = 0.65;  // column footprint width/depth
const BASE_H       = 0.4;   // minimum column height
const MAX_H        = 10.0;  // maximum column height
const ORBIT_RADIUS = 14.0;
const CAM_BASE_Y   = 2.5;
const CAM_LOOK_Y   = 4.0;
const BASE_ORBIT   = 0.0003;  // radians per dt unit at orbit=0.5
const FOV          = 52;

// ── Module state ──────────────────────────────────────────────────────────────

let initialized    = false;
let threeCanvas    : HTMLCanvasElement | null = null;
let renderer       : THREE.WebGLRenderer | null = null;
let scene          : THREE.Scene | null = null;
let camera         : THREE.PerspectiveCamera | null = null;
let vizModeUnsub   : (() => void) | null = null;

// Scene objects
let floorMesh      : THREE.Mesh | null = null;
let floorMat       : THREE.MeshStandardMaterial | null = null;
let dirLight       : THREE.DirectionalLight | null = null;
let fillLight      : THREE.HemisphereLight | null = null;

interface Pillar {
  mesh:    THREE.Mesh;
  mat:     THREE.MeshStandardMaterial;
  bandIdx: number;
  row:     number;
  smoothH: number;
}
let pillars: Pillar[] = [];
const pillarGeo: THREE.BoxGeometry[] = [];

// Camera animation
let camAngle    = Math.PI * 0.35;  // start slightly off-axis for drama
let camY        = CAM_BASE_Y;
let targetCamY  = CAM_BASE_Y;
let lastBeatIndex = -1;
let beatPulse   = 0;                 // 0→1, drives orbit-speed burst

// Smoothed audio for camera motion
let smoothAmp   = 0;

// ── Setup ─────────────────────────────────────────────────────────────────────

function setup(): void {
  // Overlay canvas
  threeCanvas = document.createElement('canvas');
  threeCanvas.style.cssText =
    'position:fixed;top:0;left:0;width:100%;height:100%;z-index:10;pointer-events:none;display:block';
  document.body.appendChild(threeCanvas);

  // Renderer
  renderer = new THREE.WebGLRenderer({
    canvas: threeCanvas,
    antialias: !isMobile,
    alpha: false,
  });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, isMobile ? 1.0 : 1.5));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;

  // Shadow mapping only on desktop — GPU cost is significant
  if (!isMobile) {
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  }

  // Scene
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x080806);
  scene.fog = new THREE.Fog(0x080806, 22, 50);

  // Camera
  camera = new THREE.PerspectiveCamera(FOV, window.innerWidth / window.innerHeight, 0.1, 100);
  camera.position.set(
    Math.cos(camAngle) * ORBIT_RADIUS,
    CAM_BASE_Y,
    Math.sin(camAngle) * ORBIT_RADIUS,
  );
  camera.lookAt(0, CAM_LOOK_Y, 0);

  // ── Lighting ─────────────────────────────────────────────────────────────

  // Warm directional key light — rakes across the colonnade from upper-left
  dirLight = new THREE.DirectionalLight(0xffcc88, 2.2);
  dirLight.position.set(-10, 18, -6);
  dirLight.target.position.set(0, 0, 0);
  if (!isMobile) {
    dirLight.castShadow = true;
    dirLight.shadow.mapSize.width  = 1024;
    dirLight.shadow.mapSize.height = 1024;
    dirLight.shadow.camera.near    = 1;
    dirLight.shadow.camera.far     = 60;
    dirLight.shadow.camera.left    = -18;
    dirLight.shadow.camera.right   = 18;
    dirLight.shadow.camera.top     = 18;
    dirLight.shadow.camera.bottom  = -18;
    dirLight.shadow.bias           = -0.002;
  }
  scene.add(dirLight);
  scene.add(dirLight.target);

  // Cool hemisphere fill — sky is deep indigo, ground is near-black
  fillLight = new THREE.HemisphereLight(0x2244aa, 0x0d0b08, 0.4);
  scene.add(fillLight);

  // ── Floor ────────────────────────────────────────────────────────────────

  const floorGeo = new THREE.PlaneGeometry(80, 80, 1, 1);
  floorMat = new THREE.MeshStandardMaterial({
    color:     new THREE.Color(0x0d0c0b),
    roughness: 0.08,
    metalness: 0.55,
    envMapIntensity: 0.6,
  });
  floorMesh = new THREE.Mesh(floorGeo, floorMat);
  floorMesh.rotation.x = -Math.PI / 2;
  floorMesh.position.y = 0;
  if (!isMobile) floorMesh.receiveShadow = true;
  scene.add(floorMesh);

  // ── Pillars ───────────────────────────────────────────────────────────────

  // Unit box: height=1 centred at y=0.  We'll scale.y per frame and offset y.
  const unitGeo = new THREE.BoxGeometry(COL_W, 1.0, COL_W, 1, 1, 1);
  pillarGeo.push(unitGeo);

  pillars = [];
  const halfBands = (BAND_COUNT - 1) / 2;  // 3

  for (let row = 0; row < MAX_ROWS; row++) {
    const z = (row - (MAX_ROWS - 1) / 2) * ROW_SPACING;

    for (let col = 0; col < BAND_COUNT; col++) {
      const x = (col - halfBands) * COL_SPACING;

      // Stone material — warm cream limestone, no per-band rainbow
      // Subtle emissive that heats up with amplitude (amber warm glow from within)
      const mat = new THREE.MeshStandardMaterial({
        color:     new THREE.Color(0xc2ae98),
        roughness: 0.88,
        metalness: 0.04,
        emissive:  new THREE.Color(0x201408),
        emissiveIntensity: 0.0,
      });

      const mesh = new THREE.Mesh(unitGeo, mat);
      mesh.position.set(x, BASE_H / 2, z);
      mesh.scale.set(1, BASE_H, 1);

      if (!isMobile) {
        mesh.castShadow    = true;
        mesh.receiveShadow = true;
      }

      scene.add(mesh);
      pillars.push({ mesh, mat, bandIdx: col, row, smoothH: BASE_H });
    }
  }

  // Subscribe: hide overlay when leaving this viz
  vizModeUnsub = store.on('vizModeChange', (mode) => {
    if (!threeCanvas) return;
    threeCanvas.style.display = mode === 'cloister' ? 'block' : 'none';
  });

  initialized = true;
}

// ── Draw ──────────────────────────────────────────────────────────────────────

export function drawCloister(_p: unknown, dt: number): void {
  if (!initialized) setup();
  if (!renderer || !scene || !camera) return;

  const { amps }  = getBandAverages(BAND_COUNT);
  const { state } = store;
  const cfg        = store.config;

  // ── Beat detection ────────────────────────────────────────────────────────

  if (state.beatIntervalSec > 0 && state.isPlaying) {
    const pos    = audioEngine.getPlaybackPosition();
    const adj    = pos - state.beatOffset;
    const beatIdx = adj >= 0 ? Math.floor(adj / state.beatIntervalSec) : -1;
    if (beatIdx > lastBeatIndex) {
      lastBeatIndex = beatIdx;
      // Camera dips down slightly then rises — a sense of gravity
      targetCamY  = CAM_BASE_Y - 0.8 + Math.random() * 0.4;
      beatPulse   = 1.0;
    }
  }

  // Settle camera Y back to base
  targetCamY += (CAM_BASE_Y - targetCamY) * 0.015 * dt;
  camY       += (targetCamY - camY) * 0.06 * dt;
  beatPulse  *= Math.pow(0.88, dt);

  // ── Camera orbit ─────────────────────────────────────────────────────────

  // orbitSlider 0..1 → speed multiplier 0.3..3.0
  const orbitSlider = cfg.cloisterOrbit;
  const orbitSpeed  = BASE_ORBIT * (0.3 + orbitSlider * 2.7) * (1.0 + beatPulse * 1.5);
  camAngle += orbitSpeed * dt;

  camera.position.set(
    Math.cos(camAngle) * ORBIT_RADIUS,
    camY,
    Math.sin(camAngle) * ORBIT_RADIUS,
  );
  camera.lookAt(0, CAM_LOOK_Y, 0);

  // ── Pillar height and visibility ──────────────────────────────────────────

  // Formation slider: 0..1 → rows visible 1..MAX_ROWS
  const rowCount = Math.max(1, Math.ceil(cfg.cloisterFormation * MAX_ROWS));
  const heightSlider = cfg.cloisterHeight;

  let totalAmp = 0;
  for (const amp of amps) totalAmp += amp;
  smoothAmp += ((totalAmp / BAND_COUNT) - smoothAmp) * 0.1 * dt;

  for (const pillar of pillars) {
    // Show/hide based on formation
    const visible = pillar.row < rowCount;
    if (pillar.mesh.visible !== visible) pillar.mesh.visible = visible;
    if (!visible) continue;

    // Height driven by band amplitude
    const amp       = amps[pillar.bandIdx] ?? 0;
    const targetH   = BASE_H + amp * MAX_H * (0.3 + heightSlider * 0.7);
    const lerpSpeed = amp > pillar.smoothH / MAX_H ? 0.2 : 0.08;  // fast attack, slow release
    pillar.smoothH += (targetH - pillar.smoothH) * lerpSpeed * dt;

    pillar.mesh.scale.y    = pillar.smoothH;
    pillar.mesh.position.y = pillar.smoothH / 2;

    // Subtle emissive warmth: warm amber glow scales with amplitude
    pillar.mat.emissiveIntensity = amp * 0.18 + smoothAmp * 0.06;
  }

  // ── Light animation ───────────────────────────────────────────────────────

  // Key light subtly breathes with overall loudness
  if (dirLight) {
    dirLight.intensity = 2.2 + smoothAmp * 0.8;
  }

  renderer.render(scene, camera);
}

// ── Reset ─────────────────────────────────────────────────────────────────────

export function resetCloister(): void {
  if (!initialized) return;
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer?.setSize(w, h);
  if (camera) {
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
}

// ── Dispose ───────────────────────────────────────────────────────────────────

export function disposeCloister(): void {
  if (!initialized) return;

  vizModeUnsub?.();
  vizModeUnsub = null;

  // Pillars
  for (const p of pillars) {
    p.mat.dispose();
  }
  pillars = [];

  for (const g of pillarGeo) g.dispose();
  pillarGeo.length = 0;

  // Floor
  floorMesh?.geometry.dispose();
  floorMat?.dispose();

  // Scene lights
  scene?.clear();

  renderer?.dispose();
  threeCanvas?.remove();

  threeCanvas = null;
  renderer    = null;
  scene       = null;
  camera      = null;
  floorMesh   = null;
  floorMat    = null;
  dirLight    = null;
  fillLight   = null;

  // Reset camera state
  camAngle      = Math.PI * 0.35;
  camY          = CAM_BASE_Y;
  targetCamY    = CAM_BASE_Y;
  lastBeatIndex = -1;
  beatPulse     = 0;
  smoothAmp     = 0;

  initialized = false;
}
