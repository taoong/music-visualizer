/**
 * Reeds — Three.js WebGL overlay visualization
 *
 * N thin acrylic rods arranged in a golden-angle phyllotaxis field; 7 radial
 * frequency zones drive emissive brightness; vertex shader bends rod tips
 * proportional to each zone's audio amplitude — rods sway like reeds in wind.
 *
 * Vantage slider shifts the camera from inside-the-field eye-level (revealing
 * parallax depth among the rods) to overhead (revealing the sunflower
 * phyllotaxis geometry), creating two completely different visual compositions.
 *
 * Palette: near-monochrome warm amber/cream (no per-band rainbow). UnrealBloomPass
 * halos neighbouring rods when bands are loud, creating volumetric spillover.
 *
 * Inspired by UVA (United Visual Artists) "Momentum" (2016) — a large-scale
 * installation of individually-addressable vertical light rods that ripple and
 * pulse with sound — adapted as a real-time audio-reactive instrument in the
 * spirit of a TouchDesigner Instanced Geometry + CHOPs patch.
 * https://uva.co.uk/works/momentum
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

// ── Constants ─────────────────────────────────────────────────────────────────

const N_DESKTOP  = 380;
const N_MOBILE   = 180;
const GOLDEN_ANGLE = 2.3998632; // 137.507764°  in radians
const ROD_HEIGHT = isMobile ? 3.2 : 4.0;
const ROD_HALF   = ROD_HEIGHT / 2;
// Spacing between rods (phyllotaxis radius scale)
const SPACING    = isMobile ? 0.36 : 0.40;
// How much the rod tip bends per unit amplitude (vertex shader uniform max value)
const MAX_BEND   = 0.8;

// ── Module state ──────────────────────────────────────────────────────────────

let initialized   = false;
let threeCanvas   : HTMLCanvasElement   | null = null;
let renderer      : THREE.WebGLRenderer | null = null;
let scene         : THREE.Scene         | null = null;
let camera        : THREE.PerspectiveCamera | null = null;
let composer      : EffectComposer      | null = null;
let reedMesh      : THREE.InstancedMesh | null = null;
let reedMat       : THREE.ShaderMaterial| null = null;
let vizModeUnsub  : (() => void)        | null = null;

let time           = 0;
let cameraTheta    = 0;
let lastBeatIndex  = -1;
let beatRippleTime = -999; // seconds since last beat
let beatStrength   = 0.0;

// Uniforms — mutated in place each frame, Three.js reads by reference
const uBands       : THREE.IUniform<number[]> = { value: new Array(7).fill(0) };
const uTime        : THREE.IUniform<number>   = { value: 0 };
const uBeatRipple  : THREE.IUniform<number>   = { value: -999 }; // ring radius
const uBeatStrength: THREE.IUniform<number>   = { value: 0 };
const uBendScale   : THREE.IUniform<number>   = { value: MAX_BEND * 0.4 };
const uGlowScale   : THREE.IUniform<number>   = { value: 1.0 };
const uRodHalf     : THREE.IUniform<number>   = { value: ROD_HALF };
const uRodHeight   : THREE.IUniform<number>   = { value: ROD_HEIGHT };

// ── GLSL ──────────────────────────────────────────────────────────────────────

const VERT = /* glsl */`
  // Per-instance attributes (set at init, never updated)
  attribute float instancePhase;      // 0 – 2π random sway phase
  attribute float instanceBandIndex;  // 0.0 – 6.0 (float for smooth GLSL indexing)
  attribute float instanceRadius;     // distance from field centre (for beat ripple)

  uniform float uBands[7];
  uniform float uTime;
  uniform float uBeatRipple;   // current ring radius (negative = no ripple)
  uniform float uBeatStrength;
  uniform float uBendScale;    // 0–1, controlled by Flow slider
  uniform float uRodHalf;
  uniform float uRodHeight;

  varying float vBrightness;

  // Safe band lookup — avoids integer array index compiler issues on some GPUs
  float bandAt(int idx) {
    if (idx <= 0) return uBands[0];
    if (idx == 1) return uBands[1];
    if (idx == 2) return uBands[2];
    if (idx == 3) return uBands[3];
    if (idx == 4) return uBands[4];
    if (idx == 5) return uBands[5];
    return uBands[6];
  }

  void main() {
    int bandIdx = int(instanceBandIndex);
    float amp = bandAt(bandIdx);

    // Beat ripple: ring expands from centre; Gaussian envelope around ring edge
    float ripple = 0.0;
    if (uBeatRipple >= 0.0) {
      float diff = instanceRadius - uBeatRipple;
      ripple = uBeatStrength * exp(-diff * diff * 1.8);
    }

    // Emissive brightness for this rod
    float undulation = 0.06 * amp * sin(uTime * 0.9 + instancePhase);
    vBrightness = 0.04 + amp * 1.4 + undulation + ripple * 0.6;

    // Bend displacement: proportional to t² (base stays planted, tip sways)
    float t = clamp((position.y + uRodHalf) / uRodHeight, 0.0, 1.0);
    float sway = amp * uBendScale * t * t;
    vec3 displaced = position;
    displaced.x += sway * sin(uTime * 0.8 + instancePhase);
    displaced.z += sway * cos(uTime * 0.8 + instancePhase);

    // Apply instance transform (phyllotaxis position)
    vec4 worldPos = instanceMatrix * vec4(displaced, 1.0);
    gl_Position   = projectionMatrix * modelViewMatrix * worldPos;
  }
`;

const FRAG = /* glsl */`
  uniform float uGlowScale;
  varying float vBrightness;

  void main() {
    // Warm amber/cream: slight yellow-orange cast on bright, cooler at dark
    float b = clamp(vBrightness * uGlowScale, 0.0, 2.5);
    // HDR values (>1.0) will be picked up by UnrealBloomPass
    gl_FragColor = vec4(b * 1.00, b * 0.92, b * 0.78, 1.0);
  }
`;

// ── Setup ─────────────────────────────────────────────────────────────────────

function setup(): void {
  const N = isMobile ? N_MOBILE : N_DESKTOP;

  threeCanvas = document.createElement('canvas');
  threeCanvas.style.cssText =
    'position:fixed;top:0;left:0;width:100%;height:100%;z-index:10;pointer-events:none;display:block';
  document.body.appendChild(threeCanvas);

  renderer = new THREE.WebGLRenderer({
    canvas: threeCanvas,
    antialias: !isMobile,
    alpha: true,
  });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, isMobile ? 1 : 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  scene  = new THREE.Scene();
  scene.background = new THREE.Color(0x050505);

  const aspect = window.innerWidth / window.innerHeight;
  camera = new THREE.PerspectiveCamera(fovForAspect(60, aspect), aspect, 0.1, 200);

  // ── Reed geometry ────────────────────────────────────────────────────────
  // Thin hexagonal rod: tapered top, 8 height segments for smooth bending
  const geo = new THREE.CylinderGeometry(0.030, 0.048, ROD_HEIGHT, 6, 8);

  // Per-instance attributes (phyllotaxis placement, random phase)
  const phases      = new Float32Array(N);
  const bandIndices = new Float32Array(N);
  const radii       = new Float32Array(N);

  const totalRadius = Math.sqrt(N - 1) * SPACING;

  for (let k = 0; k < N; k++) {
    const r     = Math.sqrt(k) * SPACING;
    const normR = r / totalRadius;           // 0 at centre, 1 at rim
    phases[k]      = Math.random() * Math.PI * 2;
    bandIndices[k] = Math.min(6, Math.floor(normR * 7));
    radii[k]       = r;
  }

  geo.setAttribute('instancePhase',
    new THREE.InstancedBufferAttribute(phases, 1));
  geo.setAttribute('instanceBandIndex',
    new THREE.InstancedBufferAttribute(bandIndices, 1));
  geo.setAttribute('instanceRadius',
    new THREE.InstancedBufferAttribute(radii, 1));

  reedMat = new THREE.ShaderMaterial({
    vertexShader  : VERT,
    fragmentShader: FRAG,
    uniforms: {
      uBands       : uBands,
      uTime        : uTime,
      uBeatRipple  : uBeatRipple,
      uBeatStrength: uBeatStrength,
      uBendScale   : uBendScale,
      uGlowScale   : uGlowScale,
      uRodHalf     : uRodHalf,
      uRodHeight   : uRodHeight,
    },
  });

  reedMesh = new THREE.InstancedMesh(geo, reedMat, N);
  reedMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

  // Place instances at phyllotaxis positions; centre of rod at y = ROD_HALF
  const dummy = new THREE.Object3D();
  for (let k = 0; k < N; k++) {
    const angle = k * GOLDEN_ANGLE;
    const r     = Math.sqrt(k) * SPACING;
    dummy.position.set(r * Math.cos(angle), ROD_HALF, r * Math.sin(angle));
    dummy.rotation.set(0, 0, 0);
    dummy.updateMatrix();
    reedMesh.setMatrixAt(k, dummy.matrix);
  }
  reedMesh.instanceMatrix.needsUpdate = true;

  scene.add(reedMesh);

  // Subtle dark floor to anchor the installation in space
  const floorGeo = new THREE.CircleGeometry(totalRadius + 2, 64);
  const floorMat = new THREE.MeshBasicMaterial({ color: 0x080808 });
  const floor    = new THREE.Mesh(floorGeo, floorMat);
  floor.rotation.x = -Math.PI / 2;
  scene.add(floor);

  // ── Post-processing ──────────────────────────────────────────────────────
  const bloomStrength  = isMobile ? 1.0 : 1.5;
  const bloomRadius    = 0.65;
  const bloomThreshold = 0.28;

  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  composer.addPass(new UnrealBloomPass(
    new THREE.Vector2(window.innerWidth, window.innerHeight),
    bloomStrength, bloomRadius, bloomThreshold,
  ));
  composer.addPass(new OutputPass());

  // Hide canvas when switching away
  vizModeUnsub = store.on('vizModeChange', (data) => {
    if (threeCanvas) threeCanvas.style.display = data === 'reeds' ? 'block' : 'none';
  });

  initialized = true;
}

// ── Draw ──────────────────────────────────────────────────────────────────────

export function drawReeds(_p: unknown, dt: number): void {
  if (!initialized) setup();
  if (!renderer || !scene || !camera || !composer) return;

  const { amps, transients } = getBandAverages(7);

  // Beat detection
  const { state } = store;
  const beatIntervalSec = state.beatIntervalSec > 0 ? state.beatIntervalSec : 0.5;
  const playbackPos     = audioEngine.getPlaybackPosition();
  const currentBeat     = Math.floor(playbackPos / beatIntervalSec);
  if (currentBeat !== lastBeatIndex && currentBeat > lastBeatIndex) {
    lastBeatIndex   = currentBeat;
    beatRippleTime  = 0;
    beatStrength    = 0.85 + Math.max(...transients.map(t => Math.max(0, t - 1.0))) * 0.15;
  }

  // Advance time
  time += dt * 0.016;

  // Update beat ripple
  const RIPPLE_SPEED = 3.5; // units per second
  beatRippleTime   += dt * 0.016;
  beatStrength     *= Math.pow(0.96, dt);

  // Uniforms
  uBands.value    = amps;
  uTime.value     = time;
  uBeatRipple.value   = beatRippleTime >= 0 ? beatRippleTime * RIPPLE_SPEED : -1;
  uBeatStrength.value = beatStrength;
  uBendScale.value    = store.config.reedsFlow * MAX_BEND;
  uGlowScale.value    = 0.4 + store.config.reedsGlow * 1.6;

  // Camera: Vantage 0 = inside field at eye level, Vantage 1 = overhead
  const vantage = store.config.reedsVantage;
  const orbitSpeed = (0.05 + store.config.reedsFlow * 0.2) * dt;
  cameraTheta += orbitSpeed;

  // Lerp camera position between low and high vantage
  const lowY  = 1.8;  const lowR  = 7.5; const lowLookY  = 2.0;
  const highY = 16.0; const highR = 1.5; const highLookY = 0.5;
  const camY    = lowY  + (highY  - lowY)  * vantage;
  const camR    = lowR  + (highR  - lowR)  * vantage;
  const lookAtY = lowLookY + (highLookY - lowLookY) * vantage;

  camera.position.set(
    camR * Math.cos(cameraTheta),
    camY,
    camR * Math.sin(cameraTheta),
  );
  camera.lookAt(0, lookAtY, 0);

  // Adapt FOV: wide inside the field, narrower overhead
  const baseFov = 60 - vantage * 20; // 60° at ground, 40° overhead
  const aspect  = window.innerWidth / window.innerHeight;
  camera.fov  = fovForAspect(baseFov, aspect);
  camera.aspect = aspect;
  camera.updateProjectionMatrix();

  // Update UnrealBloomPass strength from Glow slider
  const bloomPass = composer.passes[1] as UnrealBloomPass;
  if (bloomPass && 'strength' in bloomPass) {
    bloomPass.strength = (isMobile ? 0.8 : 1.2) + store.config.reedsGlow * 1.0;
  }

  composer.render();
}

// ── Reset ─────────────────────────────────────────────────────────────────────

export function resetReeds(): void {
  if (!initialized) return;
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer?.setSize(w, h);
  if (camera) {
    camera.aspect = w / h;
    camera.fov    = fovForAspect(60, camera.aspect);
    camera.updateProjectionMatrix();
  }
  composer?.setSize(w, h);
}

// ── Dispose ───────────────────────────────────────────────────────────────────

export function disposeReeds(): void {
  if (!initialized) return;
  vizModeUnsub?.();
  vizModeUnsub = null;
  reedMesh?.geometry.dispose();
  reedMat?.dispose();
  composer?.dispose();
  renderer?.dispose();
  threeCanvas?.remove();
  threeCanvas = null; renderer = null; scene = null; camera = null;
  composer = null; reedMesh = null; reedMat = null;
  initialized = false;
  time = 0; cameraTheta = 0; lastBeatIndex = -1;
  beatRippleTime = -999; beatStrength = 0;
}
