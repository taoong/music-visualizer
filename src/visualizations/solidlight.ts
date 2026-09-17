/**
 * Solid Light — Three.js volumetric light cone installation
 *
 * Inspired by Anthony McCall's "Solid Light" exhibition at Tate Modern (2024),
 * where massive cones of projected light cut through a misty darkened gallery.
 * Visitors walk inside the beams, seeing their own shadow in the haze.
 *
 * Here: 2–6 particle-cloud cones hang from a virtual ceiling, each driven by
 * one frequency band. Near-monochrome warm/cool palette (no rainbow). Additive
 * particle blending creates soft volumetric scattering. Camera drifts slowly
 * through the installation space at eye level.
 */

import * as THREE from 'three';
import { store } from '../state/store';
import { getBandAverages } from './helpers';
import { audioEngine } from '../audio/engine';
import { isMobile } from '../utils/constants';

// ── Module state ──────────────────────────────────────────────────────────────

let initialized = false;
let threeCanvas: HTMLCanvasElement | null = null;
let renderer: THREE.WebGLRenderer | null = null;
let scene: THREE.Scene | null = null;
let camera: THREE.PerspectiveCamera | null = null;
let vizModeUnsub: (() => void) | null = null;

// Per-beam state
interface Beam {
  points: THREE.Points;
  mat: THREE.ShaderMaterial;
  bandIndex: number;
  coneAngle: number;    // current animated cone half-angle
  brightness: number;   // current smoothed brightness
}

let beams: Beam[] = [];
let activeBeamCount = 0;

// Animation state
let time = 0;
let cameraTheta = 0;
let cameraPhiOffset = 0;
let lastBeatIndex = -1;
let beatFlash = 0;

// ── Irregular beam positions (apex world position — not a perfect ring) ────────

const BEAM_APEXES: [number, number, number][] = [
  [-2.2, 5.0,  0.5],
  [ 2.8, 5.0,  1.0],
  [ 0.3, 5.0, -3.2],
  [-1.8, 5.0,  3.8],
  [ 4.0, 5.0, -1.8],
  [-3.6, 5.0, -1.2],
];

// Slightly off-vertical orientations — each beam tilts a few degrees
const BEAM_TILTS: [number, number][] = [
  [0.0,  0.0],
  [0.04, 0.02],
  [-0.03, 0.05],
  [0.02, -0.04],
  [-0.05, 0.03],
  [0.03, -0.02],
];

// Warm/cool near-monochrome palette — no rainbow
const BEAM_COLORS: [number, number, number][] = [
  [1.00, 0.96, 0.88], // warm incandescent (3200 K)
  [0.88, 0.94, 1.00], // daylight blue (7000 K)
  [0.98, 0.98, 1.00], // neutral studio white
  [1.00, 0.91, 0.80], // deep warm amber-white
  [0.90, 0.96, 1.00], // ice blue-white
  [1.00, 0.98, 0.95], // soft warm white
];

// ── GLSL shaders ──────────────────────────────────────────────────────────────

const VERT = /* glsl */`
  attribute float aT;       // normalized height (0=apex, 1=base)
  attribute float aAngle;   // azimuthal angle around beam axis
  attribute float aRadius;  // radial fraction within cone cross-section [0, 1]

  uniform float uConeAngle; // cone half-angle in radians
  uniform float uHeight;    // cone length in world units
  uniform float uHaze;      // controls particle size

  void main() {
    // Cone coordinate: apex at local origin, beam extends along -Y
    float r = aT * tan(uConeAngle) * aRadius;
    float lx = r * cos(aAngle);
    float ly = -aT * uHeight;
    float lz = r * sin(aAngle);

    vec4 mvPos = modelViewMatrix * vec4(lx, ly, lz, 1.0);
    gl_Position = projectionMatrix * mvPos;

    // Screen-space size: larger near camera, denser near apex (aT small)
    float depth = max(-mvPos.z, 0.5);
    float apexBoost = 1.0 + (1.0 - aT) * 0.8; // brighter/larger near source
    gl_PointSize = clamp(uHaze * 60.0 * apexBoost / depth, 0.5, 24.0);
  }
`;

const FRAG = /* glsl */`
  uniform float uAlpha;
  uniform vec3  uColor;
  uniform float uBeatFlash;

  void main() {
    vec2 uv = gl_PointCoord - 0.5;
    float r2 = dot(uv, uv) * 4.0;
    if (r2 > 1.0) discard;
    float a = (1.0 - r2) * (1.0 - r2) * uAlpha * (1.0 + uBeatFlash * 0.6);
    vec3 col = mix(uColor, vec3(1.0), uBeatFlash * 0.25);
    gl_FragColor = vec4(col, a);
  }
`;

// ── Geometry builder ──────────────────────────────────────────────────────────

function buildBeamGeometry(count: number): THREE.BufferGeometry {
  const aT      = new Float32Array(count);
  const aAngle  = new Float32Array(count);
  const aRadius = new Float32Array(count);
  // All particles have the same nominal position; vertex shader computes real pos
  const positions = new Float32Array(count * 3); // zeros

  for (let i = 0; i < count; i++) {
    aT[i]      = Math.random();
    aAngle[i]  = Math.random() * Math.PI * 2;
    // Uniform distribution inside a disk: r = sqrt(uniform)
    aRadius[i] = Math.sqrt(Math.random());
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('aT',       new THREE.BufferAttribute(aT, 1));
  geo.setAttribute('aAngle',   new THREE.BufferAttribute(aAngle, 1));
  geo.setAttribute('aRadius',  new THREE.BufferAttribute(aRadius, 1));
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
    antialias: false,
    alpha: false,
  });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, isMobile ? 1 : 1.5));

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);

  const aspect = window.innerWidth / window.innerHeight;
  camera = new THREE.PerspectiveCamera(65, aspect, 0.1, 100);
  camera.position.set(7, 1.5, 0);
  camera.lookAt(0, 2.0, 0);

  // Soft ambient fill — very dim, so particles read as the light source
  scene.add(new THREE.AmbientLight(0x050507, 1.0));

  // Pre-allocate all 6 beams (only activeBeamCount are rendered)
  const particlesPerBeam = isMobile ? 500 : 2000;
  beams = [];

  for (let i = 0; i < 6; i++) {
    const [cx, cy, cz] = BEAM_APEXES[i];
    const [tx, tz] = BEAM_TILTS[i];
    const [r, g, b] = BEAM_COLORS[i];

    const uniforms = {
      uConeAngle: { value: 0.28 },
      uHeight:    { value: 8.0 },
      uHaze:      { value: 0.6 },
      uAlpha:     { value: 0.0 },
      uColor:     { value: new THREE.Color(r, g, b) },
      uBeatFlash: { value: 0.0 },
    };

    const mat = new THREE.ShaderMaterial({
      vertexShader:   VERT,
      fragmentShader: FRAG,
      uniforms,
      transparent: true,
      depthWrite:  false,
      depthTest:   true,
      blending:    THREE.AdditiveBlending,
    });

    const geo = buildBeamGeometry(particlesPerBeam);
    const points = new THREE.Points(geo, mat);
    points.frustumCulled = false; // vertex shader places particles — no CPU bounding sphere

    // Position apex and apply slight tilt
    points.position.set(cx, cy, cz);
    points.rotation.x = tx;
    points.rotation.z = tz;

    scene.add(points);
    beams.push({ points, mat, bandIndex: i % 7, coneAngle: 0.28, brightness: 0 });
  }

  vizModeUnsub = store.on('vizModeChange', (data) => {
    if (!threeCanvas) return;
    threeCanvas.style.display = data === 'solidlight' ? 'block' : 'none';
  });

  initialized = true;
}

// ── Draw ──────────────────────────────────────────────────────────────────────

export function drawSolidLight(_p: unknown, dt: number): void {
  if (!initialized) setup();

  time += dt * 0.016;

  const { amps } = getBandAverages(7);
  const { config, state } = store;

  // Map solidlightBeams slider (0–1) to beam count (2–6; mobile capped at 3)
  const maxBeams = isMobile ? 3 : 6;
  const beamT = config.solidlightBeams;
  const targetCount = Math.round(2 + beamT * (maxBeams - 2));
  if (targetCount !== activeBeamCount) {
    activeBeamCount = targetCount;
    beams.forEach((b, i) => {
      b.points.visible = i < activeBeamCount;
    });
  }

  // Haze slider → particle size multiplier
  const haze = 0.3 + config.solidlightHaze * 1.4;

  // Beat detection
  if (state.beatIntervalSec > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    const beatIdx = adjusted >= 0 ? Math.floor(adjusted / state.beatIntervalSec) : -1;
    if (beatIdx > lastBeatIndex) {
      lastBeatIndex = beatIdx;
      beatFlash = 1.0;
    }
  }
  beatFlash *= Math.pow(0.85, dt);

  // Update each active beam
  for (let i = 0; i < 6; i++) {
    const beam = beams[i];
    if (i >= activeBeamCount) {
      beam.mat.uniforms['uAlpha'].value = 0;
      continue;
    }

    const bandAmp = amps[beam.bandIndex] ?? 0;

    // Smooth cone angle with audio
    const targetAngle = 0.22 + bandAmp * 0.28;
    beam.coneAngle += (targetAngle - beam.coneAngle) * Math.min(0.08 * dt, 0.4);

    // Smooth brightness
    const targetBrightness = 0.04 + bandAmp * 0.28;
    beam.brightness += (targetBrightness - beam.brightness) * Math.min(0.12 * dt, 0.5);

    // Apply uniforms
    beam.mat.uniforms['uConeAngle'].value = beam.coneAngle;
    beam.mat.uniforms['uHaze'].value      = haze;
    beam.mat.uniforms['uAlpha'].value     = beam.brightness;
    beam.mat.uniforms['uBeatFlash'].value = beatFlash;
  }

  // Camera drift: slow orbit at eye level, slight vertical drift
  const driftSpeed = 0.00008 + config.solidlightDrift * 0.0005;
  cameraTheta += dt * driftSpeed * Math.PI;
  cameraPhiOffset = Math.sin(time * 0.11) * 0.35;

  const orbitR = 7.5;
  const camX = Math.sin(cameraTheta) * orbitR;
  const camZ = Math.cos(cameraTheta) * orbitR;
  const camY = 1.5 + Math.sin(cameraTheta * 0.27 + 1.0) * 0.6 + cameraPhiOffset;

  if (camera) {
    camera.position.set(camX, camY, camZ);
    // Look slightly upward toward the beam apexes
    camera.lookAt(0, 2.5, 0);
    // On beat: slight camera flinch (subtle recoil)
    if (beatFlash > 0.5) {
      const flinch = (beatFlash - 0.5) * 0.04;
      camera.position.y += flinch;
    }
  }

  renderer?.render(scene!, camera!);
}

// ── Reset (resize) ─────────────────────────────────────────────────────────────

export function resetSolidLight(): void {
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

export function disposeSolidLight(): void {
  if (!initialized) return;
  vizModeUnsub?.();
  vizModeUnsub = null;

  for (const beam of beams) {
    beam.points.geometry.dispose();
    beam.mat.dispose();
  }
  beams = [];

  renderer?.dispose();
  threeCanvas?.remove();
  threeCanvas = null;
  renderer = null;
  scene = null;
  camera = null;

  time = 0;
  cameraTheta = 0;
  cameraPhiOffset = 0;
  lastBeatIndex = -1;
  beatFlash = 0;
  activeBeamCount = 0;
  initialized = false;
}
