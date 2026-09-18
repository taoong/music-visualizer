/**
 * Crystal Universe — Three.js WebGL overlay visualization
 *
 * Inspired by teamLab "Crystal Universe" (2015–ongoing, teamLab Borderless, Tokyo):
 * 60,000 suspended LEDs that respond to visitor touch and create an infinite light world.
 * https://www.teamlab.art/w/crystaluniverse/
 *
 * Thousands of luminous light particles drift in a cylindrical 3D volume;
 * a first-person camera slowly flies through them. Audio bands drive particle
 * brightness; beats fire a forward surge. Palette: warm amber (sub-bass) →
 * pure white → cool blue-white (brilliance). No radial symmetry, no center rings,
 * no per-band rainbow — just light, depth, and drifting space.
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
let pointsMesh: THREE.Points | null = null;
let pointsMat: THREE.ShaderMaterial | null = null;
let vizModeUnsub: (() => void) | null = null;
let initialized = false;

let time = 0;
let lastBeatIndex = -1;

// Camera smooth state
let camX = 0;
let camY = 0;
let camZ = 50;
let camAngleT = 0;     // angle parameter for the spiral/straight path
let beatImpulse = 0;   // forward impulse magnitude

// ── Particle counts ───────────────────────────────────────────────────────────

const PARTICLE_COUNT = isMobile ? 1400 : 4000;
const FIELD_RADIUS   = 28;   // radial extent of the cylinder
const FIELD_DEPTH    = 100;  // Z extent of the particle field

// ── Uniforms ──────────────────────────────────────────────────────────────────

const uTime:      THREE.IUniform<number>   = { value: 0 };
const uBands:     THREE.IUniform<number[]> = { value: new Array(7).fill(0) };
const uBeatFlash: THREE.IUniform<number>   = { value: 0 };
const uGlow:      THREE.IUniform<number>   = { value: 0.55 };
const uFlow:      THREE.IUniform<number>   = { value: 0.4 };
const uCamZ:      THREE.IUniform<number>   = { value: 50 };

// ── Shaders ───────────────────────────────────────────────────────────────────

const VERTEX_SHADER = /* glsl */`
  uniform float uTime;
  uniform float uBands[7];
  uniform float uBeatFlash;
  uniform float uGlow;
  uniform float uFlow;
  uniform float uCamZ;

  attribute float aBandIdx;  // 0–6, which freq band owns this particle
  attribute float aPhase;    // random phase [0, 2π]
  attribute float aLayer;    // random layering weight [0, 1]

  varying float vBrightness;
  varying float vBandIdx;
  varying float vDepthFade;

  void main() {
    float band = uBands[int(aBandIdx)];

    // Slow organic drift using multi-frequency oscillation
    float speed = uFlow * 0.35 + 0.08;
    float px = position.x
      + sin(uTime * speed        + aPhase)            * 3.5 * uFlow
      + sin(uTime * speed * 0.6 + aPhase * 1.3) * 0.8 * uFlow;
    float py = position.y
      + cos(uTime * speed * 0.8  + aPhase * 0.7)      * 2.8 * uFlow
      + cos(uTime * speed * 0.4  + aPhase * 1.9) * 0.6 * uFlow;

    // Cyclic Z: wrap particles into the visible window ahead of the camera.
    // Modulo arithmetic keeps them uniformly distributed relative to uCamZ.
    float rawZ = position.z + sin(uTime * speed * 0.3 + aPhase * 1.1) * 1.5 * uFlow;
    float relZ = rawZ - uCamZ;
    // Remap relZ into [-FIELD_DEPTH/2, FIELD_DEPTH/2]
    float fd = ${FIELD_DEPTH.toFixed(1)};
    relZ = relZ - fd * floor((relZ + fd * 0.5) / fd);
    float pz = uCamZ + relZ;

    vec4 mvPos = modelViewMatrix * vec4(px, py, pz, 1.0);
    gl_Position = projectionMatrix * mvPos;

    // Depth-based fade: bright up close, dim in the distance
    float depth = clamp(-mvPos.z, 0.5, 100.0);
    vDepthFade = clamp(1.0 - depth / 80.0, 0.05, 1.0);

    // Perspective-correct point size
    float baseSize = (1.8 + uGlow * 6.0) * (200.0 / depth);
    float audioBoost = 0.3 + band * 1.4 + uBeatFlash * 0.6;
    gl_PointSize = baseSize * audioBoost * (0.6 + aLayer * 0.8);

    vBrightness = (0.12 + band * 0.88 + uBeatFlash * 0.15) * vDepthFade;
    vBandIdx    = aBandIdx;
  }
`;

const FRAGMENT_SHADER = /* glsl */`
  uniform float uBeatFlash;

  varying float vBrightness;
  varying float vBandIdx;
  varying float vDepthFade;

  void main() {
    // Soft bokeh dot: bright core + wider halo
    vec2 uv = gl_PointCoord - 0.5;
    float r  = length(uv) * 2.0;
    float core = exp(-r * r * 5.5);
    float halo = exp(-r * r * 1.2) * 0.22;
    float alpha = (core + halo) * vBrightness;
    if (alpha < 0.004) discard;

    // Warm-to-cool palette: amber (sub-bass) → white (mid) → blue-white (brilliance)
    // Deliberately not a per-band rainbow — two accent hues around white.
    float t = vBandIdx / 6.0;
    vec3 warmAmber  = vec3(1.00, 0.80, 0.46);
    vec3 pureWhite  = vec3(1.00, 0.97, 0.95);
    vec3 coolBlue   = vec3(0.60, 0.80, 1.00);

    vec3 col;
    if (t < 0.5) {
      col = mix(warmAmber, pureWhite, t * 2.0);
    } else {
      col = mix(pureWhite, coolBlue, (t - 0.5) * 2.0);
    }
    // Beat flash brightens toward white
    col = mix(col, vec3(1.0), uBeatFlash * 0.25);

    gl_FragColor = vec4(col, alpha);
  }
`;

// ── Geometry ──────────────────────────────────────────────────────────────────

function buildGeometry(): THREE.BufferGeometry {
  const geo       = new THREE.BufferGeometry();
  const positions  = new Float32Array(PARTICLE_COUNT * 3);
  const bandIdxs   = new Float32Array(PARTICLE_COUNT);
  const phases     = new Float32Array(PARTICLE_COUNT);
  const layers     = new Float32Array(PARTICLE_COUNT);

  for (let i = 0; i < PARTICLE_COUNT; i++) {
    // Uniform-density cylindrical distribution (sqrt for uniform area)
    const theta = Math.random() * Math.PI * 2;
    const r     = Math.sqrt(Math.random()) * FIELD_RADIUS;
    positions[i * 3 + 0] = Math.cos(theta) * r;
    positions[i * 3 + 1] = Math.sin(theta) * r;
    positions[i * 3 + 2] = (Math.random() - 0.5) * FIELD_DEPTH;

    // Band assignment: radial rings — sub-bass at centre, brilliance at edge
    bandIdxs[i] = Math.floor((r / FIELD_RADIUS) * 6.9999);
    phases[i]   = Math.random() * Math.PI * 2;
    layers[i]   = Math.random();
  }

  geo.setAttribute('position',  new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('aBandIdx',  new THREE.BufferAttribute(bandIdxs,  1));
  geo.setAttribute('aPhase',    new THREE.BufferAttribute(phases,    1));
  geo.setAttribute('aLayer',    new THREE.BufferAttribute(layers,    1));
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
    alpha: true,
    powerPreference: isMobile ? 'low-power' : 'high-performance',
  });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, isMobile ? 1 : 1.5));
  // Pure black background — no scene fog to maintain crisp depth-fade from shader
  renderer.setClearColor(0x000000, 1);

  scene  = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(72, window.innerWidth / window.innerHeight, 0.5, 200);
  camera.position.set(0, 0, camZ);
  camera.lookAt(0, 0, 0);

  pointsMat = new THREE.ShaderMaterial({
    uniforms: { uTime, uBands, uBeatFlash, uGlow, uFlow, uCamZ },
    vertexShader:   VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    transparent:    true,
    depthWrite:     false,
    blending:       THREE.AdditiveBlending,
  });

  pointsMesh = new THREE.Points(buildGeometry(), pointsMat);
  scene.add(pointsMesh);

  vizModeUnsub = store.on('vizModeChange', (data) => {
    if (!threeCanvas) return;
    threeCanvas.style.display = data === 'crystaluniverse' ? 'block' : 'none';
  });

  initialized = true;
}

// ── Export: reset (resize) ────────────────────────────────────────────────────

export function resetCrystalUniverse(): void {
  if (!initialized) return;
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer?.setSize(w, h);
  if (camera) { camera.aspect = w / h; camera.updateProjectionMatrix(); }
}

// ── Export: draw ──────────────────────────────────────────────────────────────

export function drawCrystalUniverse(_p: unknown, dt: number): void {
  if (!initialized) setup();

  time += dt * 0.016;

  const { amps }         = getBandAverages(7);
  const { config, state } = store;
  const flow    = config.crystaluniverseFlow;
  const glowVal = config.crystaluniverseGlow;
  const drift   = config.crystaluniverseDrift;

  // Beat detection (same pattern as neon.ts)
  if (state.beatIntervalSec > 0 && state.isPlaying) {
    const pos      = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    const beatIdx  = adjusted >= 0 ? Math.floor(adjusted / state.beatIntervalSec) : -1;
    if (beatIdx > lastBeatIndex) {
      lastBeatIndex = beatIdx;
      beatImpulse   = 1.0;
      uBeatFlash.value = 1.0;
    }
  }

  // Decay impulse and flash
  beatImpulse          *= Math.pow(0.88, dt);
  uBeatFlash.value      = Math.max(0, uBeatFlash.value * Math.pow(0.82, dt));

  // Master amplitude for speed modulation
  const masterAmp = amps.reduce((a, b) => a + b, 0) / 7;

  // Camera forward travel — speed proportional to audio + beat impulse
  const baseSpeed = flow * 0.25 + 0.04;
  camZ -= dt * (baseSpeed + masterAmp * 0.35 + beatImpulse * 1.8);

  // Wrap camera Z so the particle field always cycles
  if (camZ < -FIELD_DEPTH / 2) camZ += FIELD_DEPTH;

  // Lateral drift path: 0=straight tunnel, 1=wide spiral sweep
  camAngleT += dt * 0.0008 * (flow * 1.5 + 0.3);
  const sweepRadius = drift * FIELD_RADIUS * 0.5;
  const targetX = Math.sin(camAngleT)          * sweepRadius;
  const targetY = Math.cos(camAngleT * 0.71)   * sweepRadius * 0.55;

  camX += (targetX - camX) * 0.025;
  camY += (targetY - camY) * 0.020;

  // Update uniforms
  uTime.value    = time;
  uBands.value   = amps;
  uFlow.value    = flow;
  uGlow.value    = glowVal;
  uCamZ.value    = camZ;

  if (camera) {
    camera.position.set(camX, camY, camZ);
    // Look slightly ahead and inward — creates the "flying into the light" feel
    camera.lookAt(camX * 0.3, camY * 0.3, camZ - 25);
  }

  renderer?.render(scene!, camera!);
}

// ── Export: dispose ───────────────────────────────────────────────────────────

export function disposeCrystalUniverse(): void {
  if (!initialized) return;
  vizModeUnsub?.();
  vizModeUnsub = null;
  pointsMesh?.geometry.dispose();
  pointsMat?.dispose();
  renderer?.dispose();
  threeCanvas?.remove();
  threeCanvas = null;
  renderer    = null;
  scene       = null;
  camera      = null;
  pointsMesh  = null;
  pointsMat   = null;
  initialized = false;
  time          = 0;
  lastBeatIndex = -1;
  beatImpulse   = 0;
  camX = 0; camY = 0; camZ = 50; camAngleT = 0;
}
