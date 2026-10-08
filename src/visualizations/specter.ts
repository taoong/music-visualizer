// Specter: audio-reactive spherical harmonic surface sculpture
// Inspired by Henry Segerman's mathematical 3D-printed sculptures (okstate.edu)
// and Linden Gledhill's cymatics macro photography — each of 7 frequency bands
// drives a distinct Cartesian real spherical harmonic mode (Y_1^0 through Y_4^4c),
// creating electron-orbital-like standing-wave deformations on a flat-shaded
// icosphere. Warm amber key + cool steel fill lighting. Camera orbits on an
// elliptical path; beats add a brief outward kick.

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { store } from '../state/store';
import { getBandAverages } from './helpers';
import { audioEngine } from '../audio/engine';
import { isMobile } from '../utils/constants';

// ── Module state ───────────────────────────────────────────────────────────────

let initialized = false;
let threeCanvas: HTMLCanvasElement | null = null;
let renderer: THREE.WebGLRenderer | null = null;
let scene: THREE.Scene | null = null;
let camera: THREE.PerspectiveCamera | null = null;
let composer: EffectComposer | null = null;
let vizModeUnsub: (() => void) | null = null;
let sphereMesh: THREE.Mesh | null = null;
let shaderMat: THREE.ShaderMaterial | null = null;
let bloomPass: UnrealBloomPass | null = null;

let time = 0;
let lastBeatIndex = -1;
let camAngle = 0;
let camHeightAngle = 0.3;
let beatKick = 0;

// ── Uniforms ──────────────────────────────────────────────────────────────────

const uBands: THREE.IUniform<number[]> = { value: new Array(7).fill(0) };
const uTime: THREE.IUniform<number> = { value: 0.0 };
const uDisplacement: THREE.IUniform<number> = { value: 0.4 };
const uComplexity: THREE.IUniform<number> = { value: 0.7 };
const uGlow: THREE.IUniform<number> = { value: 1.2 };
const uKeyLightPos: THREE.IUniform<THREE.Vector3> = { value: new THREE.Vector3(6, 4, 3) };
const uFillLightPos: THREE.IUniform<THREE.Vector3> = { value: new THREE.Vector3(-5, -2, -4) };

// ── Shaders ───────────────────────────────────────────────────────────────────

const VERT = /* glsl */ `
  uniform float uBands[7];
  uniform float uDisplacement;
  uniform float uComplexity;
  uniform float uTime;

  varying vec3 vWorldPos;
  varying float vDisplace;

  void main() {
    vec3 n = normalize(position); // unit-sphere vertex = surface normal direction

    // Cartesian real spherical harmonics (un-normalised, for visual effect)
    float sh0 = n.z;                                                              // Y_1^0  — dipole Z
    float sh1 = n.x;                                                              // Y_1^1c — dipole X
    float sh2 = 3.0 * n.z * n.z - 1.0;                                           // Y_2^0  — d_z2
    float sh3 = n.x * n.x - n.y * n.y;                                           // Y_2^2c — d_x2-y2
    float sh4 = n.z * (5.0 * n.z * n.z - 3.0);                                   // Y_3^0  — f_z3
    float sh5 = n.z * (n.x * n.x - n.y * n.y);                                   // Y_3^2c — f_xz2
    float sh6 = n.x*n.x*n.x*n.x - 6.0*n.x*n.x*n.y*n.y + n.y*n.y*n.y*n.y;      // Y_4^4c — g_x4

    // Complexity: higher-order modes fade in as slider increases
    float c = uComplexity * 7.0;
    float w0 = clamp(c - 0.0, 0.0, 1.0);
    float w1 = clamp(c - 1.0, 0.0, 1.0);
    float w2 = clamp(c - 2.0, 0.0, 1.0);
    float w3 = clamp(c - 3.0, 0.0, 1.0);
    float w4 = clamp(c - 4.0, 0.0, 1.0);
    float w5 = clamp(c - 5.0, 0.0, 1.0);
    float w6 = clamp(c - 6.0, 0.0, 1.0);

    float disp = uBands[0]*sh0*w0 + uBands[1]*sh1*w1 + uBands[2]*sh2*w2
               + uBands[3]*sh3*w3 + uBands[4]*sh4*w4 + uBands[5]*sh5*w5
               + uBands[6]*sh6*w6;

    // Subtle base breathing so the sphere never goes fully static at silence
    disp += 0.05 * sin(uTime * 0.55 + n.x * 1.9 + n.y * 1.3);

    vDisplace = disp;

    float r = 1.5 + disp * uDisplacement;
    vec3 displaced = n * r;
    vWorldPos = (modelMatrix * vec4(displaced, 1.0)).xyz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(displaced, 1.0);
  }
`;

const FRAG = /* glsl */ `
  uniform vec3 uKeyLightPos;
  uniform vec3 uFillLightPos;
  uniform float uGlow;

  varying vec3 vWorldPos;
  varying float vDisplace;

  void main() {
    // Flat face normal — computed from position derivatives (works in WebGL2)
    vec3 fdx = dFdx(vWorldPos);
    vec3 fdy = dFdy(vWorldPos);
    vec3 N = normalize(cross(fdx, fdy));

    // Flip if back-facing
    if (dot(N, cameraPosition - vWorldPos) < 0.0) N = -N;

    vec3 V = normalize(cameraPosition - vWorldPos);

    // Base material: dark charcoal
    vec3 baseColor = vec3(0.07, 0.08, 0.11);

    // Warm amber key light
    vec3 Lk = normalize(uKeyLightPos - vWorldPos);
    float diffK = max(dot(N, Lk), 0.0);
    float specK = pow(max(dot(reflect(-Lk, N), V), 0.0), 90.0);
    vec3 keyColor = vec3(1.0, 0.72, 0.28);

    // Cool steel-blue fill light
    vec3 Lf = normalize(uFillLightPos - vWorldPos);
    float diffF = max(dot(N, Lf), 0.0);
    vec3 fillColor = vec3(0.28, 0.45, 0.75);

    // Ambient
    vec3 ambient = baseColor * 0.12;

    // Diffuse
    vec3 diffuse = baseColor * (keyColor * diffK * 0.72 + fillColor * diffF * 0.28);

    // Specular (key only)
    vec3 specular = keyColor * specK * 0.5;

    // Emissive: positive displacement ridges glow warm amber for bloom pickup
    float emissiveMag = max(vDisplace, 0.0);
    vec3 emissive = keyColor * emissiveMag * uGlow * 0.35;

    vec3 color = ambient + diffuse + specular + emissive;
    gl_FragColor = vec4(color, 1.0);
  }
`;

// ── Setup ─────────────────────────────────────────────────────────────────────

function setup(): void {
  threeCanvas = document.createElement('canvas');
  threeCanvas.style.cssText =
    'position:fixed;top:0;left:0;width:100%;height:100%;z-index:10;pointer-events:none;display:block';
  document.body.appendChild(threeCanvas);

  renderer = new THREE.WebGLRenderer({ canvas: threeCanvas, antialias: !isMobile, alpha: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, isMobile ? 1 : 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  scene = new THREE.Scene();

  camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 100);
  camera.position.set(0, 0, 5);
  camera.lookAt(0, 0, 0);

  // Icosphere: detail=4 desktop (~5120 faces), detail=3 mobile (~1280 faces)
  const detail = isMobile ? 3 : 4;
  const geo = new THREE.IcosahedronGeometry(1.5, detail);

  shaderMat = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: {
      uBands,
      uTime,
      uDisplacement,
      uComplexity,
      uGlow,
      uKeyLightPos,
      uFillLightPos,
    },
    side: THREE.DoubleSide,
  });

  sphereMesh = new THREE.Mesh(geo, shaderMat);
  scene.add(sphereMesh);

  const res = new THREE.Vector2(window.innerWidth, window.innerHeight);
  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  bloomPass = new UnrealBloomPass(res, 1.2, 0.5, 0.2);
  composer.addPass(bloomPass);
  composer.addPass(new OutputPass());

  vizModeUnsub = store.on('vizModeChange', (data) => {
    if (!threeCanvas) return;
    threeCanvas.style.display = data === 'specter' ? 'block' : 'none';
  });

  initialized = true;
}

// ── Draw ──────────────────────────────────────────────────────────────────────

export function drawSpecter(_p: unknown, dt: number): void {
  if (!initialized) setup();

  time += dt * 0.016;

  const { amps } = getBandAverages(7);
  const avgAmp = amps.reduce((s, a) => s + a, 0) / 7;

  uBands.value = amps.slice();
  uTime.value = time;
  uDisplacement.value = store.config.specterDisplacement * 0.8;
  uComplexity.value = store.config.specterComplexity;

  // Beat detection
  const { state } = store;
  if (state.beatIntervalSec > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    const beatIdx = adjusted >= 0 ? Math.floor(adjusted / state.beatIntervalSec) : -1;
    if (beatIdx > lastBeatIndex) {
      lastBeatIndex = beatIdx;
      beatKick = 0.7;
    }
  }
  beatKick *= Math.pow(0.88, dt);

  // Lights slowly orbit the sphere
  const keyAngle = time * 0.17;
  uKeyLightPos.value.set(
    Math.cos(keyAngle) * 6 + Math.sin(keyAngle * 0.5) * 2,
    3.5 + Math.sin(time * 0.11) * 1.5,
    Math.sin(keyAngle) * 6,
  );
  uFillLightPos.value.set(
    -Math.cos(keyAngle + 2.6) * 5,
    -1.5 - Math.sin(time * 0.09) * 1.5,
    -Math.sin(keyAngle + 2.6) * 5,
  );

  // Bloom driven by glow slider + audio amplitude
  const glowConfig = store.config.specterGlow;
  uGlow.value = glowConfig;
  if (bloomPass) {
    bloomPass.strength = 0.25 + glowConfig * 0.55 + avgAmp * 0.7;
    bloomPass.threshold = 0.12;
    bloomPass.radius = 0.45;
  }

  // Camera: slow elliptical orbit + gentle height oscillation
  camAngle += dt * 0.00065;
  camHeightAngle += dt * 0.00042;
  const baseR = isMobile ? 5.8 : 4.8;
  const r = baseR + beatKick * 0.9;

  if (camera) {
    camera.position.set(
      Math.cos(camAngle) * r,
      Math.sin(camHeightAngle) * 1.3 + avgAmp * 0.4,
      Math.sin(camAngle) * r * 0.82, // slight ellipse on Z
    );
    camera.lookAt(0, 0, 0);
  }

  if (composer) composer.render();
}

// ── Reset (resize) ─────────────────────────────────────────────────────────────

export function resetSpecter(): void {
  if (!initialized) return;
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer?.setSize(w, h);
  if (camera) { camera.aspect = w / h; camera.updateProjectionMatrix(); }
  composer?.setSize(w, h);
}

// ── Dispose ────────────────────────────────────────────────────────────────────

export function disposeSpecter(): void {
  if (!initialized) return;
  vizModeUnsub?.();
  vizModeUnsub = null;
  sphereMesh?.geometry.dispose();
  shaderMat?.dispose();
  composer?.dispose();
  renderer?.dispose();
  threeCanvas?.remove();
  threeCanvas = null; renderer = null; scene = null; camera = null;
  composer = null; sphereMesh = null; shaderMat = null; bloomPass = null;
  time = 0; lastBeatIndex = -1; camAngle = 0; camHeightAngle = 0.3; beatKick = 0;
  initialized = false;
}
