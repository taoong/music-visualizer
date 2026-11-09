/**
 * Thermal — FLIR-style aerial heat scan
 * Inspired by Ryoji Ikeda "data.scan" (Ars Electronica 2010) and the use of
 * FLIR thermal imaging as an artistic surveillance medium.
 *
 * A dense terrain sits beneath an overhead camera; 7 Gaussian heat sources
 * (one per freq band) lift columns of the mesh toward the sensor. Fragment
 * shader applies the FLIR Iron palette (cold=black→deep blue→purple→red→
 * orange→yellow→white=hot) with optional isotherm contour lines and sensor
 * grain / CRT scanlines. Altitude slider structurally changes the camera
 * from low raking view to straight-down scan geometry.
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { isMobile } from '../utils/constants';

// ── Module state ──────────────────────────────────────────────────────────────

let threeCanvas: HTMLCanvasElement | null = null;
let renderer: THREE.WebGLRenderer | null = null;
let scene: THREE.Scene | null = null;
let camera: THREE.PerspectiveCamera | null = null;
let composer: EffectComposer | null = null;
let terrainMesh: THREE.Mesh | null = null;
let terrainMaterial: THREE.ShaderMaterial | null = null;
let terrainGeometry: THREE.BufferGeometry | null = null;
let vizModeUnsub: (() => void) | null = null;
let initialized = false;

let orbitAngle = 0.0;
let lastBeatIndex = -1;
let beatFlash = 0.0;

// Uniform objects — mutated per frame, Three.js reads by reference
const uTime:    THREE.IUniform<number>   = { value: 0.0 };
const uBands:   THREE.IUniform<number[]> = { value: new Array(7).fill(0) };
const uBeat:    THREE.IUniform<number>   = { value: 0.0 };
const uContour: THREE.IUniform<number>   = { value: 0.5 };
const uGain:    THREE.IUniform<number>   = { value: 0.5 };

// ── GLSL ──────────────────────────────────────────────────────────────────────

const vertexShader = /* glsl */`
  uniform float uTime;
  uniform float[7] uBands;
  uniform float uGain;

  varying float vTemp;

  float gaussian(float x, float mu, float sigma) {
    float d = (x - mu) / sigma;
    return exp(-0.5 * d * d);
  }

  void main() {
    vec3 pos = position;

    // 7 heat sources evenly spaced along X (-1..+1 plane coords)
    float heat = 0.0;
    for (int i = 0; i < 7; i++) {
      float mu = -1.0 + (float(i) + 0.5) * (2.0 / 7.0);
      float amp = uBands[i] * uGain * 2.0;
      // Gaussian footprint wider in Z to look like a thermal column
      float gx = gaussian(pos.x, mu, 0.14);
      float gz = gaussian(pos.z, 0.0, 0.55);
      heat += amp * gx * gz;
    }

    // Slow base drift using a simple 2-octave fbm approximation
    float nx = sin(pos.x * 3.1 + uTime * 0.3) * 0.5 + 0.5;
    float nz = sin(pos.z * 2.7 + uTime * 0.25) * 0.5 + 0.5;
    float base = nx * nz * 0.08;

    pos.y = heat + base;
    vTemp = clamp(heat + base * 0.5, 0.0, 1.0);

    gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
  }
`;

const fragmentShader = /* glsl */`
  uniform float uTime;
  uniform float uBeat;
  uniform float uContour;

  varying float vTemp;

  // FLIR Iron palette — evenly sampled from the standard look-up table
  vec3 ironPalette(float t) {
    t = clamp(t, 0.0, 1.0);
    // Key stops: black(0), dark blue(.15), purple(.30), red(.50),
    //            orange(.70), yellow(.85), white(1.0)
    vec3 c;
    if      (t < 0.15) { c = mix(vec3(0.0, 0.0, 0.0),   vec3(0.05, 0.0, 0.52),  t / 0.15); }
    else if (t < 0.30) { c = mix(vec3(0.05, 0.0, 0.52),  vec3(0.42, 0.0, 0.52),  (t - 0.15) / 0.15); }
    else if (t < 0.50) { c = mix(vec3(0.42, 0.0, 0.52),  vec3(0.80, 0.0, 0.0),   (t - 0.30) / 0.20); }
    else if (t < 0.70) { c = mix(vec3(0.80, 0.0, 0.0),   vec3(0.90, 0.45, 0.0),  (t - 0.50) / 0.20); }
    else if (t < 0.85) { c = mix(vec3(0.90, 0.45, 0.0),  vec3(0.98, 0.95, 0.0),  (t - 0.70) / 0.15); }
    else               { c = mix(vec3(0.98, 0.95, 0.0),  vec3(1.00, 1.00, 1.00), (t - 0.85) / 0.15); }
    return c;
  }

  // Hash for sensor grain
  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }

  void main() {
    float temp = vTemp;

    // Beat flash: raise apparent temperature across the frame
    temp = clamp(temp + uBeat * 0.18, 0.0, 1.0);

    vec3 col = ironPalette(temp);

    // Isotherm contour lines — bright bands at integer multiples
    if (uContour > 0.01) {
      float levels = mix(0.0, 12.0, uContour);
      float band   = fract(temp * levels);
      // Narrow the contour line and ramp up with the slider
      float line   = 1.0 - smoothstep(0.03, 0.09, abs(band - 0.5) * 2.0);
      col = mix(col, vec3(1.0), line * uContour * 0.65);
    }

    // CRT scanlines — every other pixel row is dimmed ~12 %
    float scan = mod(gl_FragCoord.y, 2.0) < 1.0 ? 0.88 : 1.0;
    col *= scan;

    // Sensor grain — 1–2 % noise
    float grain = (hash(gl_FragCoord.xy + uTime * 7.3) - 0.5) * 0.025;
    col = clamp(col + grain, 0.0, 1.0);

    gl_FragColor = vec4(col, 1.0);
  }
`;

// ── Setup ─────────────────────────────────────────────────────────────────────

function setup(): void {
  threeCanvas = document.createElement('canvas');
  threeCanvas.style.cssText =
    'position:fixed;top:0;left:0;width:100%;height:100%;z-index:10;pointer-events:none;display:block';
  document.body.appendChild(threeCanvas);

  renderer = new THREE.WebGLRenderer({ canvas: threeCanvas, antialias: false, alpha: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, isMobile ? 1.0 : 1.5));
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);

  const aspect = window.innerWidth / window.innerHeight;
  camera = new THREE.PerspectiveCamera(55, aspect, 0.1, 500);

  // Grid: 2×2 world units, subdivided
  const segs = isMobile ? 48 : 96;
  terrainGeometry = new THREE.PlaneGeometry(2.0, 2.0, segs, segs);
  terrainGeometry.rotateX(-Math.PI / 2);

  terrainMaterial = new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms: {
      uTime:    uTime,
      uBands:   uBands,
      uBeat:    uBeat,
      uContour: uContour,
      uGain:    uGain,
    },
    side: THREE.DoubleSide,
  });

  terrainMesh = new THREE.Mesh(terrainGeometry, terrainMaterial);
  scene.add(terrainMesh);

  // EffectComposer desktop only
  if (!isMobile) {
    composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    composer.addPass(new OutputPass());
  }

  vizModeUnsub = store.on('vizModeChange', (data) => {
    if (!threeCanvas) return;
    threeCanvas.style.display = data === 'thermal' ? 'block' : 'none';
  });

  _placeCamera(store.config.thermalAltitude ?? 0.3);
  initialized = true;
}

function _placeCamera(altT: number): void {
  if (!camera) return;
  // altT 0 → raking low-angle view; altT 1 → straight overhead scan
  const minAlt = 0.5;
  const maxAlt = 4.5;
  const y  = minAlt + altT * (maxAlt - minAlt);
  // Orbit radius shrinks as we go overhead (keeps terrain filling frame)
  const r  = (1.0 - altT * 0.9) * 1.4;
  const lx = Math.cos(orbitAngle) * r;
  const lz = Math.sin(orbitAngle) * r;
  camera.position.set(lx, y, lz);
  camera.lookAt(0, 0, 0);
  camera.fov = 55 - altT * 15; // narrow FOV as we go overhead
  camera.updateProjectionMatrix();
}

// ── Draw ──────────────────────────────────────────────────────────────────────

export function drawThermal(_p: unknown, dt: number): void {
  if (!initialized) setup();

  const { amps, transients } = getBandAverages(7);

  // Update band uniforms
  for (let i = 0; i < 7; i++) {
    uBands.value[i] = amps[i] ?? 0;
  }
  uTime.value += 0.016 * dt;

  // Beat detection
  const { state } = store;
  if (state.beatIntervalSec > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    const beatIdx = adjusted >= 0 ? Math.floor(adjusted / state.beatIntervalSec) : -1;
    if (beatIdx > lastBeatIndex) {
      lastBeatIndex = beatIdx;
      beatFlash = 1.0;
    }
  }
  // Kick on strong transient even without BPM
  const rawT = Math.max(transients[0] ?? 1, transients[1] ?? 1);
  if (rawT > 1.5) beatFlash = Math.max(beatFlash, (rawT - 1.0) * 0.4);

  beatFlash *= Math.pow(0.82, dt);
  uBeat.value = beatFlash;

  // Config uniforms
  uContour.value = store.config.thermalContour ?? 0.5;
  uGain.value    = store.config.thermalGain    ?? 0.5;

  // Slow camera orbit — continuous, no discrete jumps
  const altT = store.config.thermalAltitude ?? 0.3;
  orbitAngle += 0.0004 * dt * (1.0 - altT * 0.6); // slower orbit at high altitude
  _placeCamera(altT);

  if (composer) {
    composer.render();
  } else {
    renderer?.render(scene!, camera!);
  }
}

// ── Reset (window resize) ─────────────────────────────────────────────────────

export function resetThermal(): void {
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

export function disposeThermal(): void {
  if (!initialized) return;
  vizModeUnsub?.();
  vizModeUnsub = null;
  terrainGeometry?.dispose();
  terrainMaterial?.dispose();
  composer?.dispose();
  renderer?.dispose();
  threeCanvas?.remove();
  threeCanvas = null;
  renderer = null;
  scene = null;
  camera = null;
  composer = null;
  terrainMesh = null;
  terrainMaterial = null;
  terrainGeometry = null;
  orbitAngle = 0.0;
  lastBeatIndex = -1;
  beatFlash = 0.0;
  initialized = false;
}
