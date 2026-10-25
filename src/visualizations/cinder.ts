/**
 * Cinder — 3D IFS fractal flame point cloud
 *
 * Seven affine maps (one per frequency band) drive a 3D chaos-game IFS attractor.
 * Selection probability for each map is proportional to its band's smoothed amplitude,
 * so bass-heavy music pulls points into the low structural maps while treble activates
 * the fine branching maps at the tips. The resulting point cloud is a 3D attractor
 * whose shape changes continuously with the music — without a single hue-per-band
 * rainbow, beat-snap, or concentric ring pulse.
 *
 * A Chaos slider blends sinusoidal nonlinearity (V_sin) onto the affine maps:
 *   Chaos=0 → pure affine IFS (geometric, faceted forms)
 *   Chaos=1 → fully sinusoidally-warped (organic, flame-like tendrils)
 *
 * A Warmth slider shifts the whole palette:
 *   Warmth=0 → cool electric-blue / phosphor white
 *   Warmth=1 → deep amber / emberglow
 *
 * The Density slider (structural) controls ring-buffer size and IFS iterations per frame,
 * scaling from a sparse sparse ember trail to a dense volumetric cloud.
 *
 * Architecture:
 *   - CPU IFS chaos game (M iterations/frame, TypedArray)
 *   - Ring-buffer of N 3D points with per-point hue and normalized index
 *   - THREE.Points with custom ShaderMaterial (billboard gaussian sprite)
 *   - Age computed from ring-head uniform in vertex shader → no per-frame age upload
 *   - AdditiveBlending for glow accumulation
 *   - Subtle UnrealBloomPass (desktop only)
 *   - Slow elliptical camera orbit, beat-triggered velocity kick
 *
 * Inspired by Scott Draves "Electric Sheep" IFS fractal flames (2000–present,
 * https://electricsheep.org) and the 3D flame work in Apophysis/JWildfire —
 * specifically the emergent visual language that arises when FFT band amplitudes
 * are used as IFS transform selection weights.
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { store } from '../state/store';
import { getBandAverages, fovForAspect } from './helpers';
import { audioEngine } from '../audio/engine';
import { isMobile } from '../utils/constants';

// ── IFS transform definitions ─────────────────────────────────────────────────
// 7 contracting affine maps, one per frequency band.
// Each map: [a,b,c, d,e,f, g,h,i, tx,ty,tz]
// Applied as: p' = M*p + t  where M is 3x3, t is translation
// All maps satisfy spectral radius < 1 so the attractor is bounded.
// The coefficients are tuned to create a layered vertical form reminiscent of
// a fractal flame — wide at base (bass maps), delicate at tips (treble maps).

const TRANSFORMS: Float32Array[] = [
  // T0 sub-bass: broad contracting stem along Y axis
  new Float32Array([  0.50, 0.00, 0.00,   0.00, 0.40, 0.00,   0.00, 0.00, 0.50,   0.00, -0.50, 0.00 ]),
  // T1 bass: rotated 45° in XY, moderate contraction, left lean
  new Float32Array([  0.42,-0.42, 0.00,   0.36, 0.36, 0.00,   0.00, 0.00, 0.45,  -0.45,  0.30, 0.10 ]),
  // T2 low-mid: rotated -45°, right lean
  new Float32Array([  0.42, 0.42, 0.00,  -0.36, 0.36, 0.00,   0.00, 0.00, 0.45,   0.45,  0.30,-0.10 ]),
  // T3 mid: forward tilt into Z, center
  new Float32Array([  0.35, 0.00, 0.10,   0.00, 0.35, 0.10,  -0.10,-0.10, 0.35,   0.00,  0.65, 0.00 ]),
  // T4 upper-mid: spiral in XZ, smaller
  new Float32Array([  0.22,-0.10, 0.20,   0.10, 0.22, 0.10,  -0.20,-0.10, 0.22,  -0.20,  0.75, 0.20 ]),
  // T5 presence: counter-spiral, smaller
  new Float32Array([  0.22, 0.10,-0.20,  -0.10, 0.22, 0.10,   0.20,-0.10, 0.22,   0.20,  0.75,-0.20 ]),
  // T6 brilliance: tiny contraction at very top, dispersed
  new Float32Array([  0.15, 0.10, 0.05,  -0.10, 0.15, 0.05,  -0.05,-0.05, 0.15,   0.00,  0.90, 0.00 ]),
];

// Color coordinate per transform (0.0–1.0) — used to derive the point hue
// T0=0.05 (deep amber), T1=0.15, T2=0.20, T3=0.35, T4=0.55, T5=0.70, T6=0.90 (cool)
const TRANSFORM_COLORS = new Float32Array([0.05, 0.15, 0.20, 0.35, 0.55, 0.70, 0.90]);

// ── Module state ──────────────────────────────────────────────────────────────

let initialized    = false;
let threeCanvas:   HTMLCanvasElement | null = null;
let renderer:      THREE.WebGLRenderer | null = null;
let scene:         THREE.Scene | null = null;
let camera:        THREE.PerspectiveCamera | null = null;
let composer:      EffectComposer | null = null;
let pointsMesh:    THREE.Points | null = null;
let pointsMat:     THREE.ShaderMaterial | null = null;
let posAttr:       THREE.BufferAttribute | null = null;
let hueAttr:       THREE.BufferAttribute | null = null;
let vizModeUnsub:  (() => void) | null = null;

// Ring buffer (CPU side)
let N            = 0;          // current ring buffer capacity (driven by density slider)
let ringHead     = 0;          // next write position
let cpuPos:      Float32Array | null = null;  // [x,y,z] * N
let cpuHue:      Float32Array | null = null;  // [h] * N

// IFS state
let px = 0, py = 0, pz = 0, ph = 0.5; // current chaos game point + color

// Camera orbit state
let camTheta     = 0;
let camVel       = 0;          // velocity kick on beat
let camPhi       = 0.45;       // elevation (radians above equator)

// Beat tracking
let lastBeatIdx  = -1;

// Uniform objects
const uRingHead: THREE.IUniform<number> = { value: 0.0 };
const uWarmth:   THREE.IUniform<number> = { value: 0.5 };
const uGlow:     THREE.IUniform<number> = { value: 0.6 };

// ── GLSL ──────────────────────────────────────────────────────────────────────

const VERT = /* glsl */`
  attribute float aHue;
  attribute float aIndex;

  uniform float uRingHead;
  uniform float uGlow;

  varying float vAlpha;
  varying float vHue;

  void main() {
    // Age: 0 = newest (just written), 1 = oldest (about to be overwritten)
    float age = mod(aIndex - uRingHead + 1.0, 1.0);

    // Non-linear fade: new points burn bright, old ones fade fast
    vAlpha = pow(1.0 - age, 1.6) * uGlow;
    vHue   = aHue;

    vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
    gl_Position  = projectionMatrix * mvPos;

    // Perspective-correct point size
    float perspScale = 200.0 / max(-mvPos.z, 0.1);
    gl_PointSize = clamp(perspScale * 1.8, 1.0, 8.0);
  }
`;

const FRAG = /* glsl */`
  varying float vAlpha;
  varying float vHue;

  uniform float uWarmth;

  // H ∈ [0,1], S=0.85, V=1 → RGB
  vec3 hsv2rgb(float h, float s, float v) {
    vec4 K = vec4(1.0, 2.0/3.0, 1.0/3.0, 3.0);
    vec3 p = abs(fract(vec3(h) + K.xyz) * 6.0 - K.www);
    return v * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), s);
  }

  void main() {
    // Soft gaussian disk — discard corners so point is circular
    float d = length(gl_PointCoord - vec2(0.5));
    if (d > 0.5) discard;
    float brightness = exp(-4.5 * d * d); // gaussian falloff

    // Map hue: warmth=0 → cool (0.55–0.75 blue range)
    //          warmth=1 → warm (0.0–0.15 amber-red range)
    float hShift  = mix(0.58, 0.03, uWarmth);
    float hRange  = mix(0.16, 0.12, uWarmth);
    float finalH  = hShift + vHue * hRange;

    // Saturation: lower near tips (more white), higher at base
    float sat = mix(0.5, 0.9, vHue);

    vec3 col = hsv2rgb(finalH, sat, 1.0);
    gl_FragColor = vec4(col * brightness * vAlpha, brightness * vAlpha);
  }
`;

// ── Helpers ───────────────────────────────────────────────────────────────────

function pointsForDensity(d: number): number {
  // density 0–1 → ring buffer size
  const base = isMobile ? 18000 : 80000;
  const top  = isMobile ? 60000 : 250000;
  return Math.round(base + (top - base) * d);
}

function iterPerFrame(d: number): number {
  const base = isMobile ? 1200 : 5000;
  const top  = isMobile ? 4000 : 18000;
  return Math.round(base + (top - base) * d);
}

function rebuildBuffers(n: number): void {
  N = n;
  ringHead = 0;
  cpuPos = new Float32Array(N * 3);
  cpuHue = new Float32Array(N);

  if (!scene || !pointsMesh || !pointsMat) return;

  // Rebuild geometry attributes
  const geo = pointsMesh.geometry;
  posAttr = new THREE.BufferAttribute(cpuPos, 3);
  posAttr.setUsage(THREE.DynamicDrawUsage);

  hueAttr = new THREE.BufferAttribute(cpuHue, 1);
  hueAttr.setUsage(THREE.DynamicDrawUsage);

  const idxArr = new Float32Array(N);
  for (let i = 0; i < N; i++) idxArr[i] = i / N;
  const idxAttr = new THREE.BufferAttribute(idxArr, 1);

  geo.setAttribute('position', posAttr);
  geo.setAttribute('aHue', hueAttr);
  geo.setAttribute('aIndex', idxAttr);

  geo.setDrawRange(0, N);
}

// ── IFS step ──────────────────────────────────────────────────────────────────

function ifsStep(
  weights: Float32Array,
  chaos: number,
  mix: number
): void {
  // Select transform by weighted random
  const r = Math.random();
  let acc = 0;
  let t = 6;
  for (let k = 0; k < 7; k++) {
    acc += weights[k];
    if (r < acc) { t = k; break; }
  }

  const M = TRANSFORMS[t];
  // Affine part: p' = M * p + translation
  const ax = M[0]*px + M[1]*py + M[2]*pz + M[9];
  const ay = M[3]*px + M[4]*py + M[5]*pz + M[10];
  const az = M[6]*px + M[7]*py + M[8]*pz + M[11];

  if (chaos > 0) {
    // Sinusoidal variation: V_sin(ax, ay, az) = (sin(ax), sin(ay), sin(az))
    const sx = Math.sin(ax), sy = Math.sin(ay), sz = Math.sin(az);
    px = ax * (1 - chaos) + sx * chaos;
    py = ay * (1 - chaos) + sy * chaos;
    pz = az * (1 - chaos) + sz * chaos;
  } else {
    px = ax; py = ay; pz = az;
  }

  // Blend color coordinate
  ph = ph * 0.5 + TRANSFORM_COLORS[t] * 0.5;

  // Store in ring buffer
  const i = ringHead;
  if (cpuPos && cpuHue) {
    cpuPos[i*3]   = px * mix;
    cpuPos[i*3+1] = py * mix;
    cpuPos[i*3+2] = pz * mix;
    cpuHue[i]     = ph;
  }
  ringHead = (ringHead + 1) % N;
}

// ── Setup ─────────────────────────────────────────────────────────────────────

function setup(): void {
  threeCanvas = document.createElement('canvas');
  threeCanvas.style.cssText =
    'position:fixed;top:0;left:0;width:100%;height:100%;z-index:10;pointer-events:none;display:block';
  document.body.appendChild(threeCanvas);

  renderer = new THREE.WebGLRenderer({ canvas: threeCanvas, antialias: false, alpha: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, isMobile ? 1.0 : 1.5));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  scene  = new THREE.Scene();
  const aspect = window.innerWidth / window.innerHeight;
  camera = new THREE.PerspectiveCamera(fovForAspect(60, aspect), aspect, 0.01, 200);
  camera.position.set(0, 0.5, 4.5);
  camera.lookAt(0, 0.3, 0);

  // Points geometry (will be populated in rebuildBuffers)
  const geo = new THREE.BufferGeometry();
  pointsMat = new THREE.ShaderMaterial({
    vertexShader:   VERT,
    fragmentShader: FRAG,
    uniforms: {
      uRingHead: uRingHead,
      uWarmth:   uWarmth,
      uGlow:     uGlow,
    },
    blending:    THREE.AdditiveBlending,
    depthWrite:  false,
    transparent: true,
  });

  pointsMesh = new THREE.Points(geo, pointsMat);
  scene.add(pointsMesh);

  // Build initial buffers from current density slider
  const density = store.config.cinderDensity;
  rebuildBuffers(pointsForDensity(density));

  // Warm up IFS (discard first 300 iterations to avoid [0,0,0] cluster)
  const warmWeights = new Float32Array(7).fill(1/7);
  for (let i = 0; i < 300; i++) ifsStep(warmWeights, 0, 1);
  ringHead = 0; // reset ring head after warmup so warmup points don't show

  // Post-processing
  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  if (!isMobile) {
    const bloom = new UnrealBloomPass(
      new THREE.Vector2(window.innerWidth, window.innerHeight),
      0.4, 0.5, 0.7
    );
    composer.addPass(bloom);
  }
  composer.addPass(new OutputPass());

  vizModeUnsub = store.on('vizModeChange', (data) => {
    if (!threeCanvas) return;
    threeCanvas.style.display = (data === 'cinder') ? 'block' : 'none';
  });

  initialized = true;
}

// ── Draw ──────────────────────────────────────────────────────────────────────

export function drawCinder(_p: unknown, dt: number): void {
  if (!initialized) setup();
  if (!renderer || !scene || !camera || !composer || !pointsMesh || !cpuPos || !cpuHue) return;

  const { amps, transients } = getBandAverages(7);
  const centroid = store.audioState.smoothedCentroid ?? 0.5;
  const chaos    = store.config.cinderChaos;   // 0–1
  const density  = store.config.cinderDensity; // 0–1
  const warmth   = store.config.cinderWarmth;  // 0–1

  // Re-build ring buffer if density changed significantly
  const targetN = pointsForDensity(density);
  if (Math.abs(targetN - N) > 5000) {
    rebuildBuffers(targetN);
  }

  // Compute per-band weights (proportional to amplitude, normalized)
  const weights = new Float32Array(7);
  let wSum = 0;
  for (let k = 0; k < 7; k++) {
    const amp = amps[k] ?? 0;
    weights[k] = 0.05 + amp * 0.95; // base probability + audio drive
    wSum += weights[k];
  }
  for (let k = 0; k < 7; k++) weights[k] /= wSum;

  // IFS iterations this frame
  const M    = iterPerFrame(density);
  const mix  = 1.0;

  for (let i = 0; i < M; i++) ifsStep(weights, chaos, mix);

  // Update uniforms
  uRingHead.value = ringHead / N;
  uWarmth.value   = warmth;
  uGlow.value     = store.config.cinderGlow;

  // Upload only the slice we just wrote (wrap-around handled by needsUpdate)
  if (posAttr && hueAttr) {
    posAttr.needsUpdate = true;
    hueAttr.needsUpdate = true;
  }

  // Beat kick: boost camera orbit velocity
  const beatInterval = store.state.beatIntervalSec > 0 ? store.state.beatIntervalSec : 0.5;
  const playPos = audioEngine.getPlaybackPosition();
  const beatOffset = store.state.beatOffset;
  const beatIdx = Math.floor((playPos - beatOffset) / beatInterval);
  if (beatIdx !== lastBeatIdx && beatIdx > lastBeatIdx) {
    lastBeatIdx = beatIdx;
    const kick = Math.max(transients[0] ?? 1, transients[1] ?? 1) - 1.0;
    camVel += kick * 0.08;
  }

  // Orbit camera (continuous, slow)
  camVel *= 0.92;
  const baseSpeed = 0.0004 * dt;
  camTheta += baseSpeed + camVel * dt * 0.016;
  // Gentle figure-8-like elevation drift
  camPhi = 0.35 + Math.sin(camTheta * 0.13) * 0.25;

  const r = 4.5 - centroid * 0.5; // treble → slightly closer
  camera.position.set(
    Math.cos(camTheta) * r * Math.cos(camPhi),
    Math.sin(camPhi) * r + 0.3,
    Math.sin(camTheta) * r * Math.cos(camPhi)
  );
  camera.lookAt(0, 0.3, 0);

  composer.render();
}

// ── Reset ─────────────────────────────────────────────────────────────────────

export function resetCinder(): void {
  if (!initialized) return;
  const w = window.innerWidth, h = window.innerHeight;
  renderer?.setSize(w, h);
  if (camera) {
    camera.aspect = w / h;
    camera.fov    = fovForAspect(60, camera.aspect);
    camera.updateProjectionMatrix();
  }
  composer?.setSize(w, h);
}

// ── Dispose ───────────────────────────────────────────────────────────────────

export function disposeCinder(): void {
  if (!initialized) return;
  vizModeUnsub?.();
  vizModeUnsub = null;
  pointsMesh?.geometry.dispose();
  pointsMat?.dispose();
  composer?.dispose();
  renderer?.dispose();
  threeCanvas?.remove();
  threeCanvas = null;
  renderer    = null;
  scene       = null;
  camera      = null;
  composer    = null;
  pointsMesh  = null;
  pointsMat   = null;
  posAttr     = null;
  hueAttr     = null;
  cpuPos      = null;
  cpuHue      = null;
  initialized = false;
}
