/**
 * Gossamer — Translucent soap-film membrane planes in 3D space
 *
 * A cluster of large gossamer planes float in a dark void, each shimmering
 * with thin-film iridescence (the rainbow effect of soap bubbles).  7 planes
 * map to the 7 frequency bands and billow with their band's amplitude.
 * A warm point light drifts through the scene.  No additive neon glow —
 * just physical translucency and fresnel iridescence.
 *
 * Inspired by Tomas Saraceno "On Air" (Palais de Tokyo, Paris, 2018) —
 * biopolymer web modules stretched in the dark gallery space, visible only
 * through the ambient light catching their gossamer geometry.
 * https://tomassaraceno.com/projects/on-air/
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

// ── Module state ──────────────────────────────────────────────────────────────

let initialized   = false;
let threeCanvas   : HTMLCanvasElement | null = null;
let renderer      : THREE.WebGLRenderer | null = null;
let scene         : THREE.Scene | null = null;
let camera        : THREE.PerspectiveCamera | null = null;
let composer      : EffectComposer | null = null;
let bloomPass     : UnrealBloomPass | null = null;
let vizModeUnsub  : (() => void) | null = null;

// Per-plane state (up to MAX_PLANES)
const MAX_PLANES  = 21;
const planeMeshes : THREE.Mesh[] = [];
const planeMats   : THREE.ShaderMaterial[] = [];
const planeGeoms  : THREE.BufferGeometry[] = [];

// Each plane's "home" orientation and audio band
const planePositions : THREE.Vector3[] = [];
const planeQuats     : THREE.Quaternion[] = [];
const planeBandIdx   : number[] = [];

// Beat state
let lastBeatIndex = -1;
let beatFlash     = 0.0;  // 1.0 on beat, decays to 0

// Timing / camera
let animTime   = 0.0;
let cameraTheta = 0.0;
let cameraPhi   = 0.3;

// How many planes are currently active (rebuilt when gossamerCount changes)
let activeCount = 0;
let cachedCount = -1;

// ── Shaders ───────────────────────────────────────────────────────────────────

const VERTEX = /* glsl */`
  uniform float uTime;
  uniform float uBandAmp;
  uniform float uFlutter;
  varying vec3 vNormal;
  varying vec3 vViewPos;
  varying vec2 vUv;

  void main() {
    vUv = uv;

    // Sinusoidal billowing displacement along the local normal
    float waveA = sin(uv.x * 4.189 + uTime * 1.3) *
                  sin(uv.y * 3.927 + uTime * 1.1);
    float waveB = sin(uv.x * 8.378 + uTime * 2.7) *
                  sin(uv.y * 7.854 + uTime * 2.3) * 0.3;
    float disp  = (waveA + waveB) * uBandAmp * uFlutter * 0.45;

    vec3 displaced = position + normal * disp;

    vec4 viewPos = modelViewMatrix * vec4(displaced, 1.0);
    vViewPos = viewPos.xyz;
    vNormal  = normalize(normalMatrix * normal);

    gl_Position = projectionMatrix * viewPos;
  }
`;

const FRAGMENT = /* glsl */`
  uniform float uIridescence;
  uniform float uBandAmp;
  uniform float uBeatFlash;
  varying vec3 vNormal;
  varying vec3 vViewPos;
  varying vec2 vUv;

  void main() {
    vec3 viewDir = normalize(-vViewPos);
    float NdotV  = abs(dot(vNormal, viewDir));
    float fresnel = 1.0 - NdotV;  // 1 at grazing angle, 0 head-on

    // Thin-film interference: phase driven by viewing angle
    // Produces the classic soap-bubble rainbow sequence
    float phase = fresnel * 6.283 * 2.5;
    vec3 iridColor = vec3(
      0.5 + 0.5 * cos(phase + 0.0),
      0.5 + 0.5 * cos(phase + 2.094),   // +120°
      0.5 + 0.5 * cos(phase + 4.189)    // +240°
    );

    // Base: cold milk-glass white
    vec3 baseColor = vec3(0.88, 0.93, 1.0);

    // Mix: iridescence shows up most at grazing angles
    vec3 color = mix(baseColor, iridColor, fresnel * uIridescence);

    // Amplitude brightens the membrane
    color += uBandAmp * 0.12 + uBeatFlash * 0.25;

    // Alpha: grazing edges opaque, centre nearly transparent
    float alpha = 0.04 + fresnel * 0.28 + uBandAmp * 0.07 + uBeatFlash * 0.08;
    alpha = clamp(alpha, 0.0, 0.75);

    gl_FragColor = vec4(color, alpha);
  }
`;

// Uniform templates — each plane shares one uBandAmp per material instance
const uTime       : THREE.IUniform<number> = { value: 0.0 };
const uFlutter    : THREE.IUniform<number> = { value: 0.5 };
const uIridescence: THREE.IUniform<number> = { value: 0.65 };
const uBeatFlash  : THREE.IUniform<number> = { value: 0.0 };

// ── Fibonacci sphere distribution ─────────────────────────────────────────────

function fibonacciSphere(n: number, i: number): THREE.Vector3 {
  const golden = Math.PI * (3.0 - Math.sqrt(5.0));
  const y      = 1.0 - (i / (n - 1)) * 2.0;
  const radius = Math.sqrt(1.0 - y * y);
  const theta  = golden * i;
  return new THREE.Vector3(radius * Math.cos(theta), y, radius * Math.sin(theta));
}

// ── Build planes ──────────────────────────────────────────────────────────────

function buildPlanes(count: number): void {
  // Dispose any existing planes
  for (let i = 0; i < planeMeshes.length; i++) {
    scene?.remove(planeMeshes[i]);
    planeGeoms[i]?.dispose();
    planeMats[i]?.dispose();
  }
  planeMeshes.length = 0;
  planeMats.length   = 0;
  planeGeoms.length  = 0;
  planePositions.length = 0;
  planeQuats.length  = 0;
  planeBandIdx.length = 0;

  const segs  = isMobile ? 6 : 10;
  const dist  = 2.2;  // distance from origin for each plane centre

  for (let i = 0; i < count; i++) {
    const pos = fibonacciSphere(count, i).multiplyScalar(dist);
    planePositions.push(pos.clone());

    // Orient the plane to face the origin (inward normal)
    const q = new THREE.Quaternion();
    q.setFromUnitVectors(new THREE.Vector3(0, 0, 1), pos.clone().normalize().negate());
    planeQuats.push(q.clone());

    const bandIdx = i % 7;
    planeBandIdx.push(bandIdx);

    const geom = new THREE.PlaneGeometry(2.8, 2.8, segs, segs);
    planeGeoms.push(geom);

    // Each plane gets its own uBandAmp uniform (different value per plane)
    const mat = new THREE.ShaderMaterial({
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      uniforms: {
        uTime:        uTime,
        uBandAmp:     { value: 0.0 },
        uFlutter:     uFlutter,
        uIridescence: uIridescence,
        uBeatFlash:   uBeatFlash,
      },
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    planeMats.push(mat);

    const mesh = new THREE.Mesh(geom, mat);
    mesh.position.copy(pos);
    mesh.quaternion.copy(q);
    scene?.add(mesh);
    planeMeshes.push(mesh);
  }

  activeCount = count;
}

// ── Setup ─────────────────────────────────────────────────────────────────────

function setup(): void {
  threeCanvas = document.createElement('canvas');
  threeCanvas.style.cssText =
    'position:fixed;top:0;left:0;width:100%;height:100%;z-index:10;pointer-events:none;display:block';
  document.body.appendChild(threeCanvas);

  const w  = window.innerWidth;
  const h  = window.innerHeight;
  const pr = isMobile ? Math.min(window.devicePixelRatio, 1.0) : Math.min(window.devicePixelRatio, 1.5);

  renderer = new THREE.WebGLRenderer({ canvas: threeCanvas, antialias: !isMobile, alpha: false });
  renderer.setSize(w, h);
  renderer.setPixelRatio(pr);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.2;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x020308);

  camera = new THREE.PerspectiveCamera(55, w / h, 0.1, 60);
  camera.position.set(0, 1.8, 7.5);
  camera.lookAt(0, 0, 0);

  // Warm ambient fill + two subtle distant point lights (key + rim)
  const ambient = new THREE.AmbientLight(0xc8d8f0, 0.25);
  scene.add(ambient);

  const keyLight = new THREE.DirectionalLight(0xfff0d8, 1.2);
  keyLight.position.set(-3, 5, 4);
  scene.add(keyLight);

  const rimLight = new THREE.DirectionalLight(0x90b8f8, 0.6);
  rimLight.position.set(4, -2, -5);
  scene.add(rimLight);

  // Post-processing: very subtle bloom (edges of membranes glow softly)
  if (!isMobile) {
    composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    bloomPass = new UnrealBloomPass(new THREE.Vector2(w, h), 0.35, 0.5, 0.82);
    composer.addPass(bloomPass);
    composer.addPass(new OutputPass());
  }

  vizModeUnsub = store.on('vizModeChange', () => {
    // Nothing needed on viz switch — dispose handles cleanup
  });

  const count = countFromSlider(store.config.gossamerCount);
  buildPlanes(count);
  cachedCount = count;

  initialized = true;
}

// ── Slider → plane count ──────────────────────────────────────────────────────

function countFromSlider(v: number): number {
  const raw = Math.round(4 + v * 17);  // 0→4, 1→21
  return isMobile ? Math.min(raw, 7) : Math.min(raw, MAX_PLANES);
}

// ── Draw ──────────────────────────────────────────────────────────────────────

export function drawGossamer(_p: unknown, dt: number): void {
  if (!initialized) setup();
  if (!renderer || !scene || !camera) return;

  animTime    += dt * 0.016;
  uTime.value += dt * 0.016;

  // ── Config uniforms ──
  uFlutter.value     = store.config.gossamerFlutter;
  uIridescence.value = store.config.gossamerIridescence;

  // ── Rebuild planes if density slider changed ──
  const newCount = countFromSlider(store.config.gossamerCount);
  if (newCount !== cachedCount) {
    buildPlanes(newCount);
    cachedCount = newCount;
  }

  // ── Audio data ──
  const { amps: bands, transients } = getBandAverages(7);
  const overallAmp = bands.reduce((s, b) => s + b, 0) / 7;

  // ── Beat detection ──
  const state = store.state;
  if (state.beatIntervalSec > 0 && state.isPlaying) {
    const pos      = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    const beatIdx  = adjusted >= 0 ? Math.floor(adjusted / state.beatIntervalSec) : -1;
    if (beatIdx > lastBeatIndex) {
      lastBeatIndex = beatIdx;
      beatFlash     = 1.0;
    }
  }
  beatFlash      *= Math.pow(0.92, dt);  // decay
  uBeatFlash.value = beatFlash;

  // Transient: brief extra flash on strong kick
  const maxTransient = Math.max(...transients);
  if (maxTransient > 1.8) beatFlash = Math.max(beatFlash, 0.3);

  // ── Update per-plane band amplitudes ──
  for (let i = 0; i < activeCount; i++) {
    const bandAmp = bands[planeBandIdx[i]] ?? 0;
    (planeMats[i].uniforms['uBandAmp'] as THREE.IUniform<number>).value = bandAmp;
  }

  // ── Camera orbit ──
  cameraTheta += dt * 0.0028;
  // gentle elevation breathing
  cameraPhi = 0.28 + Math.sin(animTime * 0.17) * 0.14;
  // amplitude gently breathes the camera distance in/out
  const camR = 7.0 + overallAmp * 0.8 + Math.sin(animTime * 0.09) * 0.4;

  camera.position.set(
    camR * Math.sin(cameraPhi) * Math.cos(cameraTheta),
    camR * Math.cos(cameraPhi),
    camR * Math.sin(cameraPhi) * Math.sin(cameraTheta),
  );
  camera.lookAt(0, 0, 0);

  // ── Render ──
  if (composer && !isMobile) {
    composer.render();
  } else {
    renderer.render(scene, camera);
  }
}

// ── Reset ─────────────────────────────────────────────────────────────────────

export function resetGossamer(): void {
  if (!initialized) return;
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer?.setSize(w, h);
  if (camera) { camera.aspect = w / h; camera.updateProjectionMatrix(); }
  composer?.setSize(w, h);
  bloomPass?.setSize(w, h);
}

// ── Dispose ───────────────────────────────────────────────────────────────────

export function disposeGossamer(): void {
  if (!initialized) return;
  vizModeUnsub?.();
  vizModeUnsub = null;

  for (let i = 0; i < planeMeshes.length; i++) {
    scene?.remove(planeMeshes[i]);
    planeGeoms[i]?.dispose();
    planeMats[i]?.dispose();
  }
  planeMeshes.length   = 0;
  planeMats.length     = 0;
  planeGeoms.length    = 0;
  planePositions.length = 0;
  planeQuats.length    = 0;
  planeBandIdx.length  = 0;

  composer?.dispose();
  renderer?.dispose();
  threeCanvas?.remove();

  threeCanvas = null; renderer = null; scene = null;
  camera = null; composer = null; bloomPass = null;
  initialized = false;
  cachedCount = -1;
  beatFlash   = 0;
  animTime    = 0;
  cameraTheta = 0;
  lastBeatIndex = -1;
  uTime.value = 0;
}
