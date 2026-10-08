/**
 * Drift — audio-reactive torus with ping-pong feedback texture
 *
 * A torus in perspective whose surface carries a self-modifying feedback texture:
 * each frame the previous frame's render is sampled with a slight UV scroll (decay × shift),
 * and 7 frequency bands inject warm→cool light at distinct latitudes on the torus surface.
 * The accumulated texture also drives radial vertex displacement, making the torus breathe.
 * Restrained two-tone palette: warm amber (bass) to cool blue-white (treble) — no rainbow.
 * Camera slowly orbits the torus, revealing its 3D topology.
 *
 * Inspired by the feedback video synthesis of Steina & Woody Vasulka ("Violin Power", 1970–78)
 * and the temporal data-materialization of Ryoji Ikeda's "dataplex" installation (2006,
 * https://www.ryojiikeda.com/project/dataplex/), combined with the TD/vvvv feedback-loop
 * technique used by live VJs to build up accumulating, self-referential visual textures.
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { isMobile } from '../utils/constants';

// ── Module state ──────────────────────────────────────────────────────────────

let initialized = false;
let threeCanvas: HTMLCanvasElement | null = null;
let renderer: THREE.WebGLRenderer | null = null;

// Main torus scene
let scene: THREE.Scene | null = null;
let camera: THREE.PerspectiveCamera | null = null;
let composer: EffectComposer | null = null;
let torusMesh: THREE.Mesh | null = null;
let torusMat: THREE.ShaderMaterial | null = null;
let torusGeo: THREE.BufferGeometry | null = null;

// Feedback ping-pong
let fbScene: THREE.Scene | null = null;
let fbCamera: THREE.OrthographicCamera | null = null;
let fbQuad: THREE.Mesh | null = null;
let fbMat: THREE.ShaderMaterial | null = null;
let fboA: THREE.WebGLRenderTarget | null = null;
let fboB: THREE.WebGLRenderTarget | null = null;

let vizModeUnsub: (() => void) | null = null;

let time = 0;
let scrollV = 0;
let cameraTheta = 0;
let lastBeatIndex = -1;
let beatPulse = 0;

// ── Uniforms (mutated in place each frame) ────────────────────────────────────

const uBands:    THREE.IUniform<number[]>             = { value: new Array(7).fill(0) };
const uScrollV:  THREE.IUniform<number>               = { value: 0 };
const uBeatPulse:THREE.IUniform<number>               = { value: 0 };
const uDecay:    THREE.IUniform<number>               = { value: 0.97 };
const uR:        THREE.IUniform<number>               = { value: 2.0 };
const uTube:     THREE.IUniform<number>               = { value: 0.6 };
const uWarp:     THREE.IUniform<number>               = { value: 0.3 };
const uPrevTex:  THREE.IUniform<THREE.Texture | null> = { value: null };
const uFeedback: THREE.IUniform<THREE.Texture | null> = { value: null };

// ── GLSL ──────────────────────────────────────────────────────────────────────

// Feedback pass: decay + UV scroll + audio injection into ping-pong FBO
const FEEDBACK_VERT = /* glsl */`
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FEEDBACK_FRAG = /* glsl */`
  uniform sampler2D uPrevTex;
  uniform float     uBands[7];
  uniform float     uScrollV;
  uniform float     uDecay;
  uniform float     uBeatPulse;
  varying vec2 vUv;

  // Two-tone palette: warm amber for bass, cool blue-white for treble
  vec3 bandColor(int b) {
    float t = float(b) / 6.0;
    // amber (1.0, 0.55, 0.10) → cool blue-white (0.55, 0.82, 1.0)
    return mix(vec3(1.0, 0.55, 0.10), vec3(0.55, 0.82, 1.0), t * t);
  }

  void main() {
    // UV scroll: shift along V (major ring direction) each frame
    // Creates the illusion of bands orbiting the torus
    vec2 scrolledUv = vec2(vUv.x, mod(vUv.y - uScrollV, 1.0));

    // Decay previous frame
    vec3 prev = texture2D(uPrevTex, scrolledUv).rgb * uDecay;

    // Inject 7 frequency bands as thin horizontal stripes in UV space
    // uv.x = u-param (0→1 around tube cross-section)
    // Bands distributed evenly across u axis
    vec3 inject = vec3(0.0);
    for (int b = 0; b < 7; b++) {
      float bandU = (float(b) + 0.5) / 7.0;
      float dist  = abs(vUv.x - bandU);
      // Gaussian stripe; sigma controls width
      float stripe = exp(-dist * dist * 3500.0) * uBands[b] * 0.35;
      inject += bandColor(b) * stripe;
    }

    // Beat: warm white flash injected uniformly across the surface
    inject += vec3(1.0, 0.88, 0.65) * uBeatPulse * 0.05;

    gl_FragColor = vec4(clamp(prev + inject, 0.0, 1.3), 1.0);
  }
`;

// Torus: compute 3D position from UV params, displace by feedback, draw emissive
const TORUS_VERT = /* glsl */`
  uniform sampler2D uFeedback;
  uniform float     uR;
  uniform float     uTube;
  uniform float     uWarp;

  varying vec2  vUv;
  varying float vDisplace;

  void main() {
    vUv = uv;

    // uv.x = u-param (cross-section), uv.y = v-param (major ring)
    float uAngle = uv.x * 6.28318530718;
    float vAngle = uv.y * 6.28318530718;

    // Sample feedback texture for radial displacement
    float displace = texture2D(uFeedback, uv).r;
    vDisplace = displace;

    float r = uTube + displace * uWarp;

    // Torus parametric equations
    float cosU = cos(uAngle);
    float sinU = sin(uAngle);
    float cosV = cos(vAngle);
    float sinV = sin(vAngle);

    vec3 tPos;
    tPos.x = (uR + r * cosU) * cosV;
    tPos.y =  r * sinU;
    tPos.z = (uR + r * cosU) * sinV;

    gl_Position = projectionMatrix * modelViewMatrix * vec4(tPos, 1.0);
  }
`;

const TORUS_FRAG = /* glsl */`
  uniform sampler2D uFeedback;
  varying vec2  vUv;
  varying float vDisplace;

  void main() {
    vec3 col = texture2D(uFeedback, vUv).rgb;
    // Gamma-style lift for emissive feel — avoid pure black
    col = pow(max(col, vec3(0.0)), vec3(0.8));
    gl_FragColor = vec4(col, 1.0);
  }
`;

// ── Geometry ──────────────────────────────────────────────────────────────────

function buildTorusGeo(tubSeg: number, radSeg: number): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  const uvArr:   number[] = [];
  const posArr:  number[] = []; // dummy positions (computed in vertex shader from uv)
  const idxArr:  number[] = [];

  for (let tv = 0; tv <= tubSeg; tv++) {
    for (let ru = 0; ru <= radSeg; ru++) {
      const u = ru / radSeg; // 0→1 around tube cross-section
      const v = tv / tubSeg; // 0→1 around major ring
      uvArr.push(u, v);
      posArr.push(0, 0, 0); // placeholder — overridden in vertex shader
    }
  }

  for (let tv = 0; tv < tubSeg; tv++) {
    for (let ru = 0; ru < radSeg; ru++) {
      const a = tv * (radSeg + 1) + ru;
      const b = a + 1;
      const c = a + (radSeg + 1);
      const d = c + 1;
      idxArr.push(a, c, b);
      idxArr.push(b, c, d);
    }
  }

  geo.setIndex(idxArr);
  geo.setAttribute('position', new THREE.Float32BufferAttribute(posArr, 3));
  geo.setAttribute('uv',       new THREE.Float32BufferAttribute(uvArr, 2));
  return geo;
}

// ── Setup ─────────────────────────────────────────────────────────────────────

function setup(): void {
  threeCanvas = document.createElement('canvas');
  threeCanvas.style.cssText =
    'position:fixed;top:0;left:0;width:100%;height:100%;z-index:10;pointer-events:none;display:block';
  document.body.appendChild(threeCanvas);

  const w = window.innerWidth;
  const h = window.innerHeight;
  const dpr = isMobile ? 1.0 : Math.min(window.devicePixelRatio, 2);

  renderer = new THREE.WebGLRenderer({ canvas: threeCanvas, antialias: !isMobile, alpha: true });
  renderer.setSize(w, h);
  renderer.setPixelRatio(dpr);
  renderer.autoClear = false;

  // Feedback FBO resolution — lower on mobile to stay within budget
  const fboW = isMobile ? 256 : 512;
  const fboH = isMobile ? 256 : 512;

  const fboOpts: THREE.RenderTargetOptions = {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    format: THREE.RGBAFormat,
    type: THREE.HalfFloatType,
  };
  fboA = new THREE.WebGLRenderTarget(fboW, fboH, fboOpts);
  fboB = fboA.clone();

  // ── Feedback scene (fullscreen orthographic quad) ─────────────────────────
  fbScene  = new THREE.Scene();
  fbCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  fbMat = new THREE.ShaderMaterial({
    vertexShader:   FEEDBACK_VERT,
    fragmentShader: FEEDBACK_FRAG,
    uniforms: {
      uPrevTex:  uPrevTex,
      uBands:    uBands,
      uScrollV:  uScrollV,
      uDecay:    uDecay,
      uBeatPulse:uBeatPulse,
    },
    depthTest:  false,
    depthWrite: false,
  });

  uPrevTex.value = fboA.texture;
  fbQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), fbMat);
  fbScene.add(fbQuad);

  // ── Main torus scene ──────────────────────────────────────────────────────
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x060606);

  camera = new THREE.PerspectiveCamera(52, w / h, 0.1, 100);
  cameraTheta = 0;
  positionCamera();

  const tubSeg = isMobile ? 64  : 128;
  const radSeg = isMobile ? 32  : 64;

  torusGeo = buildTorusGeo(tubSeg, radSeg);

  torusMat = new THREE.ShaderMaterial({
    vertexShader:   TORUS_VERT,
    fragmentShader: TORUS_FRAG,
    uniforms: {
      uFeedback: uFeedback,
      uR:        uR,
      uTube:     uTube,
      uWarp:     uWarp,
    },
    side: THREE.DoubleSide,
  });

  uFeedback.value = fboA.texture;
  torusMesh = new THREE.Mesh(torusGeo, torusMat);
  scene.add(torusMesh);

  // Subtle bloom — accent the glow without over-saturating
  const bloomStrength = isMobile ? 0.3 : 0.45;
  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(w, h), bloomStrength, 0.7, 0.15);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  // Hide canvas when another viz is active
  vizModeUnsub = store.on('vizModeChange', (data) => {
    if (threeCanvas) threeCanvas.style.display = data === 'drift' ? 'block' : 'none';
  });

  // Initialise tube radius from current config
  syncFormSlider();

  initialized = true;
}

function positionCamera(): void {
  if (!camera) return;
  const elevation = 0.42; // fixed ~24° above horizontal
  const orbitR    = 7.0;
  camera.position.set(
    orbitR * Math.cos(cameraTheta) * Math.cos(elevation),
    orbitR * Math.sin(elevation),
    orbitR * Math.sin(cameraTheta) * Math.cos(elevation),
  );
  camera.lookAt(0, 0, 0);
}

function syncFormSlider(): void {
  // Form: 0 = thin ribbon (tube=0.20), 1 = fat donut (tube=1.10)
  uTube.value = 0.20 + store.config.driftForm * 0.90;
}

// ── Draw ──────────────────────────────────────────────────────────────────────

export function drawDrift(_p: unknown, dt: number): void {
  if (!initialized) setup();
  if (!renderer || !scene || !camera || !composer || !fbScene || !fbCamera || !fboA || !fboB) return;

  time += dt * 0.016;

  const { amps } = getBandAverages(7);
  const avgAmp = amps.reduce((a, b) => a + b, 0) / 7;

  // ── Uniforms ──────────────────────────────────────────────────────────────
  uBands.value = amps.slice();

  // UV scroll: base drift + audio-reactive boost (continuous, not beat-snap)
  const scrollSpeed = (0.0004 + avgAmp * 0.0018) * dt;
  scrollV = (scrollV + scrollSpeed) % 1.0;
  uScrollV.value = scrollV;

  // Decay: 0 → fast fade (0.88), 1 → very persistent (0.99)
  uDecay.value = 0.75 + store.config.driftDecay * 0.15;

  // Warp: vertex displacement driven by feedback brightness
  uWarp.value = store.config.driftWarp * 0.55;

  // Form: tube radius (structural, drives geometry shape via vertex shader)
  syncFormSlider();

  // Beat detection — continuous ease of beatPulse, beat adds a transient kick
  const { state } = store;
  if (state.beatIntervalSec > 0 && state.isPlaying) {
    const pos     = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    const beatIdx  = adjusted >= 0 ? Math.floor(adjusted / state.beatIntervalSec) : -1;
    if (beatIdx > lastBeatIndex) {
      lastBeatIndex = beatIdx;
      beatPulse = 1.0;
    }
  }
  // Exponential decay — beat kick impulse fades smoothly
  beatPulse *= Math.pow(0.87, dt);
  uBeatPulse.value = beatPulse;

  // Camera: gentle continuous orbit (no beat-snap cuts)
  cameraTheta += dt * 0.00055;
  positionCamera();

  // ── Feedback pass → write into fboB, reading fboA ─────────────────────────
  uPrevTex.value = fboA.texture;
  renderer.setRenderTarget(fboB);
  renderer.clear();
  renderer.render(fbScene, fbCamera);
  renderer.setRenderTarget(null);

  // Swap — fboA now holds the freshly computed feedback frame
  const tmp = fboA;
  fboA = fboB;
  fboB = tmp;
  uFeedback.value = fboA.texture;

  // ── Main torus render ─────────────────────────────────────────────────────
  renderer.clear();
  composer.render();
}

// ── Reset (resize) ────────────────────────────────────────────────────────────

export function resetDrift(): void {
  if (!initialized) return;
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer?.setSize(w, h);
  if (camera) { camera.aspect = w / h; camera.updateProjectionMatrix(); }
  composer?.setSize(w, h);
}

// ── Dispose ───────────────────────────────────────────────────────────────────

export function disposeDrift(): void {
  if (!initialized) return;
  vizModeUnsub?.();
  vizModeUnsub = null;

  torusGeo?.dispose();
  torusMat?.dispose();
  (fbQuad?.geometry as THREE.BufferGeometry | undefined)?.dispose();
  fbMat?.dispose();
  fboA?.dispose();
  fboB?.dispose();
  composer?.dispose();
  renderer?.dispose();
  threeCanvas?.remove();

  threeCanvas = null;
  renderer    = null;
  scene       = null;
  camera      = null;
  composer    = null;
  torusMesh   = null;
  torusMat    = null;
  torusGeo    = null;
  fbScene     = null;
  fbCamera    = null;
  fbQuad      = null;
  fbMat       = null;
  fboA        = null;
  fboB        = null;

  time          = 0;
  scrollV       = 0;
  cameraTheta   = 0;
  lastBeatIndex = -1;
  beatPulse     = 0;

  initialized = false;
}
