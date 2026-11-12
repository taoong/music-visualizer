/**
 * Harmonic — 3-D Lissajous particle cloud
 *
 * ~6 000 particles are distributed along a continuously-evolving 3-D parametric
 * curve  x(t)=Ax·sin(nx·t+φx)  y(t)=Ay·sin(ny·t+φy)  z(t)=Az·sin(nz·t+φz).
 * Everything except uniform uploads runs on the GPU: the vertex shader positions
 * each particle from its static aT attribute and the current uniform values, so
 * there are zero per-frame Float32Array allocations.
 *
 * Inspired by John Whitney Sr. "Catalog" (1961) and "Matrix III" (1972) —
 * the first use of analog differential-equation computers to generate real-time
 * harmonic-motion graphics — and Jerobeam Fenderson's 3-D oscilloscope music.
 * https://en.wikipedia.org/wiki/John_Whitney_(animator)
 * https://oscilloscopemusic.com/
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { store } from '../state/store';
import { getBandAverages } from './helpers';
import { audioEngine } from '../audio/engine';
import { isMobile } from '../utils/constants';

// ── Module state ─────────────────────────────────────────────────────────────

let initialized = false;
let threeCanvas: HTMLCanvasElement | null = null;
let renderer: THREE.WebGLRenderer | null = null;
let scene: THREE.Scene | null = null;
let camera: THREE.PerspectiveCamera | null = null;
let composer: EffectComposer | null = null;
let points: THREE.Points | null = null;
let mat: THREE.ShaderMaterial | null = null;
let vizModeUnsub: (() => void) | null = null;

// Animation state — all scalars, no heap allocations per frame
let time = 0;
let cameraTheta = 0;
let cameraPhi = 0.4;    // gentle upward tilt
let phaseX = 0, phaseY = 0, phaseZ = 0;
let phaseVelX = 0, phaseVelY = 0, phaseVelZ = 0; // beat-kick velocities
let currentNx = 1.0, currentNy = 2.0, currentNz = 3.0;
let lastBeatIndex = -1;

// ── Uniform objects (pre-allocated, reused every frame) ──────────────────────

const uTime:      THREE.IUniform<number>        = { value: 0 };
const uBands:     THREE.IUniform<number[]>      = { value: new Array(7).fill(0) };
const uPhaseX:    THREE.IUniform<number>        = { value: 0 };
const uPhaseY:    THREE.IUniform<number>        = { value: 0 };
const uPhaseZ:    THREE.IUniform<number>        = { value: 0 };
const uNx:        THREE.IUniform<number>        = { value: 1.0 };
const uNy:        THREE.IUniform<number>        = { value: 2.0 };
const uNz:        THREE.IUniform<number>        = { value: 3.0 };
const uGlow:      THREE.IUniform<number>        = { value: 0.5 };
const uAlpha:     THREE.IUniform<number>        = { value: 0.09 };
const uWarmth:    THREE.IUniform<number>        = { value: 0.5 };
const uBeatFlash: THREE.IUniform<number>        = { value: 0 };
const uColorWarm: THREE.IUniform<THREE.Color>   = { value: new THREE.Color(1.0, 0.82, 0.55) };
const uColorCool: THREE.IUniform<THREE.Color>   = { value: new THREE.Color(0.70, 0.88, 1.00) };

// ── Shaders ───────────────────────────────────────────────────────────────────

const VERT = /* glsl */`
  attribute float aT;      // curve parameter [0, 1] — static, never changed
  attribute float aNoise;  // per-particle random [0, 1] — drives turbulence

  uniform float uTime;
  uniform float uBands[7]; // [sub, bass, lowMid, mid, upperMid, presence, brilliance]
  uniform float uPhaseX;
  uniform float uPhaseY;
  uniform float uPhaseZ;
  uniform float uNx;       // X frequency ratio (continuous float)
  uniform float uNy;       // Y frequency ratio
  uniform float uNz;       // Z frequency ratio
  uniform float uGlow;     // controls point size

  void main() {
    float t = aT * 6.28318530718;

    // Per-axis amplitudes driven by low freq bands
    float Ax = 0.45 + uBands[0] * 0.55;
    float Ay = 0.45 + uBands[1] * 0.55;
    float Az = 0.45 + uBands[2] * 0.55;

    float x = Ax * sin(uNx * t + uPhaseX);
    float y = Ay * sin(uNy * t + uPhaseY);
    float z = Az * sin(uNz * t + uPhaseZ);

    // Turbulence from brilliance band — particles scatter off-curve
    float turb = uBands[6] * 0.14;
    float seed = aNoise * 6.28318;
    x += turb * sin(seed * 2.3 + uTime * 0.9);
    y += turb * cos(seed * 3.7 + uTime * 1.1);
    z += turb * sin(seed * 5.1 + uTime * 0.7);

    vec4 mvPos = modelViewMatrix * vec4(x, y, z, 1.0);
    gl_Position = projectionMatrix * mvPos;

    // Screen-space size: larger close to camera, scales with Glow slider
    float depth = max(-mvPos.z, 0.4);
    gl_PointSize = clamp(uGlow * 100.0 / depth, 1.0, 28.0);
  }
`;

const FRAG = /* glsl */`
  uniform vec3  uColorWarm;
  uniform vec3  uColorCool;
  uniform float uAlpha;
  uniform float uWarmth;    // 0=cool steel-blue, 1=warm tungsten-amber
  uniform float uBeatFlash;

  void main() {
    vec2 uv = gl_PointCoord - 0.5;
    float r2 = dot(uv, uv) * 4.0;
    if (r2 > 1.0) discard;

    float a = (1.0 - r2) * (1.0 - r2) * uAlpha;
    vec3 col = mix(uColorCool, uColorWarm, uWarmth);
    // Beat flash bleaches toward white
    col = mix(col, vec3(1.0), uBeatFlash * 0.55);
    gl_FragColor = vec4(col, a);
  }
`;

// ── Geometry builder ─────────────────────────────────────────────────────────

function buildParticleGeo(count: number): THREE.BufferGeometry {
  const aT     = new Float32Array(count);
  const aNoise = new Float32Array(count);
  const pos    = new Float32Array(count * 3); // zeros — vertex shader overwrites

  for (let i = 0; i < count; i++) {
    aT[i]     = i / count;
    aNoise[i] = Math.random();
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aT',       new THREE.BufferAttribute(aT, 1));
  geo.setAttribute('aNoise',   new THREE.BufferAttribute(aNoise, 1));
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
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x010108); // very dark blue-black

  const aspect = window.innerWidth / window.innerHeight;
  camera = new THREE.PerspectiveCamera(55, aspect, 0.1, 50);
  camera.position.set(0, 1.2, 3.5);
  camera.lookAt(0, 0, 0);

  // Particle material — additive blending for luminous density buildup
  mat = new THREE.ShaderMaterial({
    vertexShader:   VERT,
    fragmentShader: FRAG,
    uniforms: {
      uTime, uBands, uPhaseX, uPhaseY, uPhaseZ,
      uNx, uNy, uNz, uGlow, uAlpha, uWarmth, uBeatFlash,
      uColorWarm, uColorCool,
    },
    transparent: true,
    depthWrite:  false,
    depthTest:   false,
    blending:    THREE.AdditiveBlending,
  });

  const count = isMobile ? 2500 : 7000;
  points = new THREE.Points(buildParticleGeo(count), mat);
  points.frustumCulled = false;
  scene.add(points);

  // EffectComposer: gentle UnrealBloom for the additive glow halo
  const w = window.innerWidth;
  const h = window.innerHeight;
  const renderPass  = new RenderPass(scene, camera);
  const bloomStrength = isMobile ? 1.2 : 1.6;
  const bloomPass   = new UnrealBloomPass(
    new THREE.Vector2(w, h), bloomStrength, 0.5, 0.0
  );
  const outputPass  = new OutputPass();

  composer = new EffectComposer(renderer);
  composer.addPass(renderPass);
  composer.addPass(bloomPass);
  composer.addPass(outputPass);

  vizModeUnsub = store.on('vizModeChange', (mode) => {
    if (!threeCanvas) return;
    threeCanvas.style.display = mode === 'harmonic' ? 'block' : 'none';
  });

  initialized = true;
}

// ── Draw ──────────────────────────────────────────────────────────────────────

export function drawHarmonic(_p: unknown, dt: number): void {
  if (!initialized) setup();

  time += dt * 0.016;

  const { amps } = getBandAverages(7);
  const { config, state } = store;

  // ── Beat detection ────────────────────────────────────────────────────────
  if (state.beatIntervalSec > 0 && state.isPlaying) {
    const pos     = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    const beatIdx  = adjusted >= 0 ? Math.floor(adjusted / state.beatIntervalSec) : -1;
    if (beatIdx > lastBeatIndex) {
      lastBeatIndex = beatIdx;
      // Kick all three phase velocities — CHOP-style impulse that decays
      phaseVelX += 1.4 + Math.random() * 0.6;
      phaseVelY += 1.1 + Math.random() * 0.5;
      phaseVelZ += 1.6 + Math.random() * 0.4;
      uBeatFlash.value = 1.0;
    }
  }

  // Decay beat flash and phase velocities
  const decay = Math.pow(0.88, dt);
  uBeatFlash.value *= Math.pow(0.82, dt);
  phaseVelX *= decay;
  phaseVelY *= decay;
  phaseVelZ *= decay;

  // ── Phase accumulation (bands[3,4,5] drive drift speed) ───────────────────
  const speedScale = 0.004 + config.harmonicSpeed * 0.025;
  phaseX += dt * speedScale * (0.5 + amps[3] * 1.8 + phaseVelX * 0.1);
  phaseY += dt * speedScale * (0.4 + amps[4] * 1.4 + phaseVelY * 0.1);
  phaseZ += dt * speedScale * (0.6 + amps[5] * 1.6 + phaseVelZ * 0.1);

  // ── Frequency ratios (harmonicRatio slider) ────────────────────────────────
  // Interpolate between three topologically distinct preset families:
  //   0.0 → (1, 2, 3)  — compact figure-eight knot
  //   0.5 → (2, 3, 5)  — open trefoil-ish
  //   1.0 → (3, 5, 7)  — complex star knot
  const r = config.harmonicRatio;
  let targetNx: number, targetNy: number, targetNz: number;
  if (r < 0.5) {
    const f = r * 2;
    targetNx = 1.0 + f * 1.0;
    targetNy = 2.0 + f * 1.0;
    targetNz = 3.0 + f * 2.0;
  } else {
    const f = (r - 0.5) * 2;
    targetNx = 2.0 + f * 1.0;
    targetNy = 3.0 + f * 2.0;
    targetNz = 5.0 + f * 2.0;
  }
  // Smooth easing toward target ratios
  const nEase = Math.min(0.06 * dt, 0.3);
  currentNx += (targetNx - currentNx) * nEase;
  currentNy += (targetNy - currentNy) * nEase;
  currentNz += (targetNz - currentNz) * nEase;

  // ── Warmth: driven by bass/brilliance balance ──────────────────────────────
  const targetWarmth = 0.2 + amps[1] * 0.8 - amps[6] * 0.4;
  uWarmth.value += (Math.max(0, Math.min(1, targetWarmth)) - uWarmth.value) * 0.08;

  // ── Glow / alpha ───────────────────────────────────────────────────────────
  // Overall amplitude drives alpha; Glow slider scales point size
  const overallAmp = amps.reduce((s, a) => s + a, 0) / 7;
  uGlow.value  = 0.3 + config.harmonicGlow * 1.4;
  uAlpha.value = 0.07 + overallAmp * 0.08;

  // ── Upload uniforms ────────────────────────────────────────────────────────
  uTime.value   = time;
  uPhaseX.value = phaseX;
  uPhaseY.value = phaseY;
  uPhaseZ.value = phaseZ;
  uNx.value     = currentNx;
  uNy.value     = currentNy;
  uNz.value     = currentNz;
  for (let i = 0; i < 7; i++) uBands.value[i] = amps[i] ?? 0;

  // ── Camera orbit (slow sinusoidal path around origin) ─────────────────────
  const orbitSpeed = 0.00008 + config.harmonicSpeed * 0.0004;
  cameraTheta += dt * orbitSpeed * Math.PI;
  cameraPhi    = 0.35 + Math.sin(time * 0.07) * 0.18;

  const orbitR = 3.2;
  const camX   = Math.cos(cameraTheta) * orbitR * Math.cos(cameraPhi);
  const camY   = Math.sin(cameraPhi) * orbitR;
  const camZ   = Math.sin(cameraTheta) * orbitR * Math.cos(cameraPhi);

  if (camera) {
    camera.position.set(camX, camY, camZ);
    camera.lookAt(0, 0, 0);
  }

  composer?.render();
}

// ── Reset (window resize) ─────────────────────────────────────────────────────

export function resetHarmonic(): void {
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

export function disposeHarmonic(): void {
  if (!initialized) return;

  vizModeUnsub?.();
  vizModeUnsub = null;

  points?.geometry.dispose();
  mat?.dispose();
  composer?.dispose();
  renderer?.dispose();
  threeCanvas?.remove();

  threeCanvas = null;
  renderer = null;
  scene = null;
  camera = null;
  composer = null;
  points = null;
  mat = null;

  time = 0;
  cameraTheta = 0;
  cameraPhi = 0.4;
  phaseX = 0; phaseY = 0; phaseZ = 0;
  phaseVelX = 0; phaseVelY = 0; phaseVelZ = 0;
  currentNx = 1.0; currentNy = 2.0; currentNz = 3.0;
  lastBeatIndex = -1;
  uBeatFlash.value = 0;
  uWarmth.value = 0.5;

  initialized = false;
}
