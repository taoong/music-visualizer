/**
 * Kinetic — Calder mobile sculpture
 * Inspired by Alexander Calder "Red Mobile" (1956) and "Snow Flurry" (1948, MoMA).
 * https://www.moma.org/artists/795
 *
 * Horizontal arms hang at staggered heights, each driven by one frequency band.
 * Spring-damper pendulum tilts each arm; the whole assembly slowly rotates like a
 * real mobile turning in a gentle breeze. Restrained palette: vermillion, cadmium
 * yellow, cobalt blue, near-black, off-white — exactly Calder's vocabulary.
 * Warm gallery key light + cool fill. No bloom, no neon, no rainbow.
 */
import * as THREE from 'three';
import { store } from '../state/store';
import { getBandAverages } from './helpers';
import { audioEngine } from '../audio/engine';
import { isMobile } from '../utils/constants';

// ── Module state ──────────────────────────────────────────────────────────────

let threeCanvas: HTMLCanvasElement | null = null;
let renderer: THREE.WebGLRenderer | null = null;
let scene: THREE.Scene | null = null;
let camera: THREE.PerspectiveCamera | null = null;
let rootGroup: THREE.Group | null = null;
let vizModeUnsub: (() => void) | null = null;
let initialized = false;
let time = 0;
let lastBeatIndex = -1;
let beatImpulse = 0;
let cameraTheta = 0;

// Per-arm pendulum state
interface Arm {
  group: THREE.Group;
  tilt: number;
  tiltV: number;
  band: number;
  phase: number;
}

const MAX_ARMS = 7;
const allArms: Arm[] = [];

// All geometries/materials created at setup — disposed in disposeKinetic
const _geos: THREE.BufferGeometry[] = [];
const _mats: THREE.Material[] = [];

// Calder primary palette — exactly as he used them across his career
const CALDER_COLORS = [
  0xcc2200, // vermillion red
  0xf5c000, // cadmium yellow
  0x1a3a8a, // cobalt blue
  0x1a1a18, // carbon black
  0xeee8dc, // flake white
  0xd45000, // burnt orange
  0x2d6a2a, // leaf green
];

// ── Setup ─────────────────────────────────────────────────────────────────────

function setup(): void {
  threeCanvas = document.createElement('canvas');
  threeCanvas.style.cssText =
    'position:fixed;top:0;left:0;width:100%;height:100%;z-index:10;pointer-events:none;display:block';
  document.body.appendChild(threeCanvas);

  renderer = new THREE.WebGLRenderer({
    canvas: threeCanvas,
    antialias: !isMobile,
    alpha: false,
  });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, isMobile ? 1.0 : 1.5));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0c0b0a); // near-black warm gray
  scene.fog = new THREE.Fog(0x0c0b0a, 14, 30);

  camera = new THREE.PerspectiveCamera(
    50,
    window.innerWidth / window.innerHeight,
    0.1,
    50,
  );
  camera.position.set(0, 0.4, 7);
  camera.lookAt(0, 0, 0);

  // Gallery lighting — warm key from upper-right, cool dim fill from lower-left
  const keyLight = new THREE.DirectionalLight(0xfff4e0, 4.5);
  keyLight.position.set(4, 7, 4);
  scene.add(keyLight);

  const fillLight = new THREE.DirectionalLight(0xd0e8ff, 0.7);
  fillLight.position.set(-5, -3, -4);
  scene.add(fillLight);

  const rimLight = new THREE.DirectionalLight(0xffffff, 0.4);
  rimLight.position.set(0, -5, -6);
  scene.add(rimLight);

  scene.add(new THREE.AmbientLight(0x110e08, 2.0));

  // ── Geometry (shared across all arms) ────────────────────────────────────────
  // Rod: thin box extending along X (2.6 wide, 0.04 tall/deep)
  const rodGeo = new THREE.BoxGeometry(2.6, 0.04, 0.04);
  _geos.push(rodGeo);

  // Wire: thin vertical box connecting rod end to hanging form
  const wireGeo = new THREE.BoxGeometry(0.012, 0.32, 0.012);
  _geos.push(wireGeo);

  // Form: flat disc (cylinder axis=Y, circular face up/down)
  // Desktop: 32 segments; Mobile: 16 for perf
  const formSeg = isMobile ? 16 : 32;
  const formGeo = new THREE.CylinderGeometry(0.22, 0.22, 0.055, formSeg);
  _geos.push(formGeo);

  // Top wire: thin vertical line from ceiling attachment point
  const topWireGeo = new THREE.BoxGeometry(0.01, 0.7, 0.01);
  _geos.push(topWireGeo);

  // Shared dark-wire material (rod + connecting wires)
  const wireMat = new THREE.MeshStandardMaterial({
    color: 0x1c1a16,
    roughness: 0.88,
    metalness: 0.1,
  });
  _mats.push(wireMat);

  // ── Build mobile root group ───────────────────────────────────────────────────
  rootGroup = new THREE.Group();
  scene.add(rootGroup);

  // Ceiling wire attachment visible at top
  const topWire = new THREE.Mesh(topWireGeo, wireMat);
  topWire.position.set(0, 2.4, 0);
  rootGroup.add(topWire);

  // ARM HALF-LENGTH: rod extends ±1.3 along local X
  const HALF_ARM = 1.3;
  const ARM_VERTICAL_SPAN = 3.8; // total vertical spread of all arms

  for (let i = 0; i < MAX_ARMS; i++) {
    const band = Math.floor((i * 7) / MAX_ARMS);
    const color = CALDER_COLORS[i % CALDER_COLORS.length];

    const armGroup = new THREE.Group();

    // Stagger arms vertically and rotate around Y so they point different directions
    const baseY = 1.8 - i * (ARM_VERTICAL_SPAN / (MAX_ARMS - 1));
    armGroup.position.set(0, baseY, 0);
    // Each arm points in a unique horizontal direction; small phase offset avoids perfect overlap
    armGroup.rotation.y = (i / MAX_ARMS) * Math.PI * 2 + 0.37;

    // Rod mesh
    const rod = new THREE.Mesh(rodGeo, wireMat);
    armGroup.add(rod);

    // Per-arm disc material (one color per arm, same for both discs)
    const discMat = new THREE.MeshStandardMaterial({
      color,
      roughness: 0.93,
      metalness: 0.0,
    });
    _mats.push(discMat);

    // Two hanging discs + wires, one at each rod end
    for (const side of [-1, 1] as const) {
      const endX = side * HALF_ARM;

      // Connecting wire
      const wire = new THREE.Mesh(wireGeo, wireMat);
      wire.position.set(endX, -0.16, 0); // midpoint between rod (y=0) and disc (y=-0.32)
      armGroup.add(wire);

      // Hanging disc
      const disc = new THREE.Mesh(formGeo, discMat);
      disc.position.set(endX, -0.36, 0);
      armGroup.add(disc);
    }

    rootGroup.add(armGroup);

    allArms.push({
      group: armGroup,
      tilt: 0,
      tiltV: 0,
      band,
      phase: i * (Math.PI * 2) / MAX_ARMS,
    });
  }

  vizModeUnsub = store.on('vizModeChange', (data) => {
    if (!threeCanvas) return;
    threeCanvas.style.display = data === 'kinetic' ? 'block' : 'none';
  });

  initialized = true;
}

// ── Draw ──────────────────────────────────────────────────────────────────────

export function drawKinetic(_p: unknown, dt: number): void {
  if (!initialized) setup();

  time += dt * 0.016;

  const { amps, transients } = getBandAverages(7);
  const armCount = Math.round(
    2 + (store.config.kineticArms ?? 0.5) * 5, // slider 0–1 → 2–7
  );
  const sway = store.config.kineticSway ?? 1.0;
  const orbitSpeed = store.config.kineticOrbit ?? 0.5;

  // Show/hide arms based on slider (no geometry rebuild needed)
  for (let i = 0; i < MAX_ARMS; i++) {
    allArms[i].group.visible = i < armCount;
  }

  // Beat detection
  const { state } = store;
  if (state.beatIntervalSec > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    const beatIdx = adjusted >= 0 ? Math.floor(adjusted / state.beatIntervalSec) : -1;
    if (beatIdx > lastBeatIndex) {
      lastBeatIndex = beatIdx;
      beatImpulse = 1.0;
    }
  }
  beatImpulse *= Math.pow(0.87, dt);

  // Update each arm's pendulum
  for (let i = 0; i < armCount; i++) {
    const arm = allArms[i];
    const amp = amps[arm.band] ?? 0;
    const trans = Math.max(0, (transients[arm.band] ?? 1) - 1);

    // Target tilt: audio amplitude pulls the arm off-center
    const targetTilt = amp * sway * 0.38;

    // Spring-damper physics (spring toward target, damping, beat kick)
    const springK = 0.07;
    arm.tiltV += (targetTilt - arm.tilt) * springK;
    // Beat fire: alternating push direction per arm creates visual variety
    arm.tiltV += beatImpulse * 0.09 * (i % 2 === 0 ? 1 : -1) * sway;
    // Transient punch
    arm.tiltV += trans * 0.04 * Math.cos(time * 1.5 + arm.phase);
    // Damping
    arm.tiltV *= Math.pow(0.90, dt);
    arm.tilt += arm.tiltV * dt;

    // Idle gentle sway even at silence — mobile "breathing" in air
    const idleSway = 0.018 * Math.sin(time * 0.28 + arm.phase);

    // Apply: Z rotation tilts the arm (one end dips, other rises)
    arm.group.rotation.z = arm.tilt + idleSway;
  }

  // Rotate whole mobile slowly — suspended from a single point, like the real thing
  if (rootGroup) {
    rootGroup.rotation.y += 0.00085 * dt * (orbitSpeed + 0.2);
  }

  // Camera drifts slowly around the mobile, very slight height oscillation
  cameraTheta += 0.00028 * dt * (orbitSpeed + 0.1);
  if (camera) {
    const radius = 7.0;
    const camY = 0.4 + Math.sin(time * 0.06) * 0.25;
    camera.position.set(
      Math.sin(cameraTheta) * radius,
      camY,
      Math.cos(cameraTheta) * radius,
    );
    camera.lookAt(0, 0.3, 0); // aim slightly above origin so we see the full mobile
  }

  renderer?.render(scene!, camera!);
}

// ── Reset (resize) ────────────────────────────────────────────────────────────

export function resetKinetic(): void {
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

export function disposeKinetic(): void {
  if (!initialized) return;
  vizModeUnsub?.();
  vizModeUnsub = null;
  for (const geo of _geos) geo.dispose();
  for (const mat of _mats) mat.dispose();
  _geos.length = 0;
  _mats.length = 0;
  allArms.length = 0;
  renderer?.dispose();
  threeCanvas?.remove();
  threeCanvas = null;
  renderer = null;
  scene = null;
  camera = null;
  rootGroup = null;
  time = 0;
  lastBeatIndex = -1;
  beatImpulse = 0;
  cameraTheta = 0;
  initialized = false;
}
