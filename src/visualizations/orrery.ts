/**
 * Orrery — Three.js WebGL overlay visualization.
 *
 * A mechanical armillary sphere: 2–7 inclined metallic rings with orbiting
 * node spheres driven by audio frequency bands. Warm brass-to-verdigris
 * palette under key–fill directional lighting. No rainbow, no additive neon
 * glow — physical material and real light only.
 *
 * Inspired by Conrad Shawcross "Slow Arc Inside a Cube" (2009, AXA Art
 * Collection, https://conradshawcross.com/works/slow-arc-inside-a-cube-iv/)
 * and the historical armillary sphere instrument tradition (George Adams,
 * c. 1760, Science Museum London,
 * https://collection.sciencemuseumgroup.org.uk/objects/co41527).
 *
 * Sliders: Rings (2–7 orbital planes — structural), Patina (0=bright brass
 * → 1=aged verdigris — material character), Tempo (orbital speed).
 */
import * as THREE from 'three';
import { store } from '../state/store';
import { getBandAverages } from './helpers';
import { audioEngine } from '../audio/engine';
import { isMobile } from '../utils/constants';

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_RINGS   = 7;
const RING_RADIUS = 2.4;
const TUBE_RADIUS = isMobile ? 0.042 : 0.058;
const NODE_RADIUS = isMobile ? 0.13 : 0.17;
const CAM_DIST    = 7.2;
const CAM_FOV     = 52;

// Golden-angle distribution — each ring i gets a unique (x, y) tilt so they
// fan out visually like the circles of an armillary sphere
const GOLDEN_ANGLE = 2.399963;   // ≈ 2π / φ²
const RING_TILTS = Array.from({ length: MAX_RINGS }, (_, i) => ({
  x: (i * GOLDEN_ANGLE) % Math.PI,
  y: (i / MAX_RINGS) * Math.PI,
}));

// Patina colour stops: bright brass → weathered copper → aged verdigris
const BRASS_COL    = new THREE.Color(0.88, 0.68, 0.22);
const COPPER_COL   = new THREE.Color(0.72, 0.43, 0.22);
const VERDIGRIS_COL = new THREE.Color(0.26, 0.57, 0.43);

// ── Module state ──────────────────────────────────────────────────────────────

let initialized = false;
let threeCanvas: HTMLCanvasElement | null = null;
let renderer: THREE.WebGLRenderer | null = null;
let scene: THREE.Scene | null = null;
let camera: THREE.PerspectiveCamera | null = null;
let vizModeUnsub: (() => void) | null = null;

let torusGeo: THREE.TorusGeometry | null = null;
let nodeGeo: THREE.SphereGeometry | null = null;

const ringGroups: THREE.Group[] = [];
const ringMeshes: THREE.Mesh[] = [];
const nodeMeshes: THREE.Mesh[] = [];
const ringMats: THREE.MeshStandardMaterial[] = [];
const nodeMats: THREE.MeshStandardMaterial[] = [];
const nodePhase: number[] = new Array(MAX_RINGS).fill(0);

let centralMesh: THREE.Mesh | null = null;
let centralMat: THREE.MeshStandardMaterial | null = null;
let centralGeo: THREE.SphereGeometry | null = null;

let keyLight: THREE.DirectionalLight | null = null;
let rimLight: THREE.DirectionalLight | null = null;
let fillLight: THREE.AmbientLight | null = null;

let time = 0;
let camTheta = 0;
let lastBeatIdx = -1;
let beatPulse = 0;

// Pre-allocated colour for patina calculations
const _col   = new THREE.Color();
const _nCol  = new THREE.Color();

// ── Helpers ───────────────────────────────────────────────────────────────────

function patinaColor(t: number): THREE.Color {
  if (t < 0.5) {
    return _col.lerpColors(BRASS_COL, COPPER_COL, t * 2.0);
  }
  return _col.lerpColors(COPPER_COL, VERDIGRIS_COL, (t - 0.5) * 2.0);
}

function patinaRoughness(t: number): number { return 0.20 + t * 0.62; }
function patinaMetalness(t: number): number { return 1.00 - t * 0.55; }

function currentRingCount(): number {
  // 0–1 → 2–7
  return Math.max(2, Math.min(MAX_RINGS, Math.round(store.config.orreryRings * 5.0 + 2.0)));
}

// ── Setup ─────────────────────────────────────────────────────────────────────

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
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.35;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x070810);
  scene.fog = new THREE.FogExp2(0x070810, 0.042);

  camera = new THREE.PerspectiveCamera(CAM_FOV, w / h, 0.2, 60);

  // Warm key light — upper right front
  keyLight = new THREE.DirectionalLight(0xffe0a0, 3.2);
  keyLight.position.set(5.0, 7.0, 3.0);
  scene.add(keyLight);

  // Cool rim light — opposite side, lower
  rimLight = new THREE.DirectionalLight(0x304070, 1.0);
  rimLight.position.set(-4.0, -2.0, -5.0);
  scene.add(rimLight);

  // Ambient fill — very dim, keeps deep shadows from going fully black
  fillLight = new THREE.AmbientLight(0x1a2035, 1.5);
  scene.add(fillLight);

  // ── Shared geometry ───────────────────────────────────────────────────────
  const tubeSegs = isMobile ?  8 : 16;
  const ringSegs = isMobile ? 48 : 96;
  const nodeSegs = isMobile ? 10 : 18;

  torusGeo  = new THREE.TorusGeometry(RING_RADIUS, TUBE_RADIUS, tubeSegs, ringSegs);
  nodeGeo   = new THREE.SphereGeometry(NODE_RADIUS, nodeSegs, nodeSegs);
  centralGeo = new THREE.SphereGeometry(NODE_RADIUS * 1.8, nodeSegs, nodeSegs);

  // ── Per-ring objects ──────────────────────────────────────────────────────
  const N = currentRingCount();
  for (let i = 0; i < MAX_RINGS; i++) {
    const rMat = new THREE.MeshStandardMaterial({
      color:     new THREE.Color(0.88, 0.68, 0.22),
      metalness: 1.0,
      roughness: 0.25,
    });
    const nMat = new THREE.MeshStandardMaterial({
      color:            new THREE.Color(0.95, 0.78, 0.30),
      metalness:        1.0,
      roughness:        0.15,
      emissive:         new THREE.Color(0.2, 0.12, 0.0),
      emissiveIntensity: 0.4,
    });
    ringMats.push(rMat);
    nodeMats.push(nMat);

    const group = new THREE.Group();
    group.rotation.x = RING_TILTS[i].x;
    group.rotation.y = RING_TILTS[i].y;

    const ring = new THREE.Mesh(torusGeo, rMat);
    group.add(ring);
    ringMeshes.push(ring);

    const node = new THREE.Mesh(nodeGeo, nMat);
    node.position.set(RING_RADIUS, 0, 0);
    group.add(node);
    nodeMeshes.push(node);

    group.visible = i < N;
    scene.add(group);
    ringGroups.push(group);
  }

  // ── Central sphere ("sun") ────────────────────────────────────────────────
  centralMat = new THREE.MeshStandardMaterial({
    color:            new THREE.Color(0.95, 0.82, 0.35),
    metalness:        0.95,
    roughness:        0.08,
    emissive:         new THREE.Color(0.5, 0.28, 0.0),
    emissiveIntensity: 0.5,
  });
  centralMesh = new THREE.Mesh(centralGeo, centralMat);
  scene.add(centralMesh);

  vizModeUnsub = store.on('vizModeChange', () => { disposeOrrery(); });
  initialized  = true;
}

// ── Draw ──────────────────────────────────────────────────────────────────────

export function drawOrrery(_p: unknown, dt: number): void {
  if (!initialized) setup();
  if (!renderer || !scene || !camera || !keyLight) return;

  const { amps } = getBandAverages(MAX_RINGS);
  const cfg   = store.config;
  const state = store.state;

  time += 0.016 * dt;

  // ── Beat detection ────────────────────────────────────────────────────────
  if (state.beatIntervalSec > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adj = pos - state.beatOffset;
    const idx = adj >= 0 ? Math.floor(adj / state.beatIntervalSec) : -1;
    if (idx > lastBeatIdx) {
      lastBeatIdx = idx;
      beatPulse   = 1.0;
    }
  }
  beatPulse *= Math.pow(0.76, dt);

  // ── Structural: Rings slider ──────────────────────────────────────────────
  const N = currentRingCount();
  for (let i = 0; i < MAX_RINGS; i++) {
    ringGroups[i].visible = i < N;
  }

  // ── Material: Patina slider ───────────────────────────────────────────────
  const pat   = cfg.orreryPatina;
  const col   = patinaColor(pat);
  const rough = patinaRoughness(pat);
  const metal = patinaMetalness(pat);

  for (let i = 0; i < MAX_RINGS; i++) {
    if (!ringGroups[i].visible) continue;
    const amp = amps[i];

    ringMats[i].color.copy(col);
    ringMats[i].roughness = rough;
    ringMats[i].metalness = metal;

    // Node is slightly brighter; emissive in its own palette colour
    _nCol.setRGB(
      Math.min(1.0, col.r * 1.18),
      Math.min(1.0, col.g * 1.18),
      Math.min(1.0, col.b * 1.18),
    );
    nodeMats[i].color.copy(_nCol);
    nodeMats[i].roughness = Math.max(0.05, rough - 0.10);
    nodeMats[i].metalness = Math.min(1.0,  metal + 0.04);
    // Emissive glow tracks material colour + amplitude
    nodeMats[i].emissive.setRGB(
      col.r * amp * 0.55,
      col.g * amp * 0.35,
      col.b * amp * 0.25,
    );
    nodeMats[i].emissiveIntensity = 1.0;
  }

  // Central sphere breathes with overall amplitude
  if (centralMat) {
    let sumAmp = 0;
    for (let i = 0; i < N; i++) sumAmp += amps[i];
    const avgAmp = sumAmp / N;
    centralMat.emissiveIntensity = 0.5 + avgAmp * 0.9 + beatPulse * 0.6;

    // Patina also shifts central sphere toward material colour slightly
    centralMat.color.setRGB(
      0.95 - pat * 0.30,
      0.82 - pat * 0.28,
      0.35 + pat * 0.05,
    );
  }

  // ── Orbital positions ─────────────────────────────────────────────────────
  const baseSpeed = 0.20 + cfg.orreryTempo * 1.5;
  for (let i = 0; i < MAX_RINGS; i++) {
    if (!ringGroups[i].visible) continue;
    const amp = amps[i];
    // Each ring's orbital speed is audio-driven; all get a beat surge
    const speed = baseSpeed * (0.3 + amp * 1.8 + beatPulse * 1.0);
    nodePhase[i] += 0.016 * dt * speed;
    nodeMeshes[i].position.set(
      Math.cos(nodePhase[i]) * RING_RADIUS,
      Math.sin(nodePhase[i]) * RING_RADIUS,
      0,
    );
  }

  // ── Key light driven by average amplitude ────────────────────────────────
  let sumAmp = 0;
  for (let i = 0; i < N; i++) sumAmp += amps[i];
  const avgAmp = sumAmp / N;
  keyLight.intensity = 2.8 + avgAmp * 1.8 + beatPulse * 2.5;

  // ── Camera orbit ──────────────────────────────────────────────────────────
  // Slow azimuthal orbit; latitude gently oscillates
  camTheta += 0.0022 * dt;
  const camPhi = Math.PI * 0.30 + Math.sin(time * 0.20) * 0.28;
  camera.position.set(
    Math.sin(camTheta) * Math.sin(camPhi) * CAM_DIST,
    Math.cos(camPhi)   * CAM_DIST,
    Math.cos(camTheta) * Math.sin(camPhi) * CAM_DIST,
  );
  camera.lookAt(0, 0, 0);

  renderer.render(scene, camera);
}

// ── Reset (resize) ────────────────────────────────────────────────────────────

export function resetOrrery(): void {
  if (!initialized) return;
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer?.setSize(w, h);
  if (camera) { camera.aspect = w / h; camera.updateProjectionMatrix(); }
}

// ── Dispose ───────────────────────────────────────────────────────────────────

export function disposeOrrery(): void {
  if (!initialized) return;

  vizModeUnsub?.();
  vizModeUnsub = null;

  torusGeo?.dispose();
  torusGeo = null;
  nodeGeo?.dispose();
  nodeGeo = null;
  centralGeo?.dispose();
  centralGeo = null;
  centralMat?.dispose();
  centralMat = null;

  for (let i = 0; i < ringMats.length; i++) {
    ringMats[i].dispose();
    nodeMats[i].dispose();
  }

  ringGroups.length = 0;
  ringMeshes.length = 0;
  nodeMeshes.length = 0;
  ringMats.length   = 0;
  nodeMats.length   = 0;
  nodePhase.fill(0);

  renderer?.dispose();
  threeCanvas?.remove();

  threeCanvas  = null;
  renderer     = null;
  scene        = null;
  camera       = null;
  centralMesh  = null;
  keyLight     = null;
  rimLight     = null;
  fillLight    = null;
  time         = 0;
  camTheta     = 0;
  lastBeatIdx  = -1;
  beatPulse    = 0;
  initialized  = false;
}
