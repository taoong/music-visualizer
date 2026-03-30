/**
 * Neon Grid — Three.js WebGL overlay visualization
 * Synthwave-inspired terrain: audio-driven height displacement, glowing grid lines,
 * beat-triggered radial shockwave rings, bloom post-processing.
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { store } from '../state/store';
import { getBandAverages } from './helpers';
import { audioEngine } from '../audio/engine';

// ── Module state ──────────────────────────────────────────────────────────────

let initialized = false;
let threeCanvas: HTMLCanvasElement | null = null;
let renderer: THREE.WebGLRenderer | null = null;
let scene: THREE.Scene | null = null;
let camera: THREE.PerspectiveCamera | null = null;
let composer: EffectComposer | null = null;
let terrainMesh: THREE.Mesh | null = null;
let gridLines: THREE.LineSegments | null = null;
let terrainMat: THREE.ShaderMaterial | null = null;
let gridMat: THREE.ShaderMaterial | null = null;
let vizModeUnsub: (() => void) | null = null;

let time = 0;
let lastBeatIndex = -1;
let beatPulse = 0;
let beatRadius = 0;
let cameraTheta = 0;

// ── Uniforms (shared by terrain + grid materials) ─────────────────────────────

const uTime: THREE.IUniform<number> = { value: 0.0 };
const uBands: THREE.IUniform<number[]> = { value: new Array(7).fill(0) };
const uBeatPulse: THREE.IUniform<number> = { value: 0.0 };
const uBeatRadius: THREE.IUniform<number> = { value: 0.0 };
const uCentroid: THREE.IUniform<number> = { value: 0.5 };
const uIntensity: THREE.IUniform<number> = { value: 1.0 };

// ── Shared vertex shader ──────────────────────────────────────────────────────

const VERTEX_SHADER = /* glsl */`
  uniform float uTime;
  uniform float uBands[7];
  uniform float uBeatPulse;
  uniform float uBeatRadius;
  uniform float uIntensity;
  varying float vHeight;
  varying float vNormX;

  float sampleBands(float t) {
    float fi = t * 6.0;
    int i0 = int(floor(fi));
    int i1 = min(i0 + 1, 6);
    return mix(uBands[i0], uBands[i1], fract(fi));
  }

  void main() {
    float normX = (position.x + 150.0) / 300.0;
    float bandAmp = sampleBands(normX);

    float mainWave = bandAmp     * 18.0 * sin(position.z * 0.06 + uTime * 1.8);
    float subLand  = uBands[0]   *  8.0 * sin(position.z * 0.03 + position.x * 0.015 + uTime * 0.6);
    float ripple   = uBands[6]   *  3.0 * sin(position.x * 0.35 + position.z * 0.4 + uTime * 4.0);
    float dist     = length(vec2(position.x, position.z));
    float beatWave = uBeatPulse  * 12.0 * exp(-pow((dist - uBeatRadius) * 0.08, 2.0));

    float y = (mainWave + subLand + ripple + beatWave) * uIntensity;
    vHeight = y;
    vNormX  = normX;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position.x, y, position.z, 1.0);
  }
`;

// ── Terrain fragment shader ───────────────────────────────────────────────────

const TERRAIN_FRAGMENT_SHADER = /* glsl */`
  uniform float uCentroid;
  varying float vHeight;
  varying float vNormX;

  vec3 hsl2rgb(float h, float s, float l) {
    float c = (1.0 - abs(2.0 * l - 1.0)) * s;
    float x = c * (1.0 - abs(mod(h * 6.0, 2.0) - 1.0));
    float m = l - c * 0.5;
    vec3 rgb;
    if      (h < 1.0/6.0) rgb = vec3(c, x, 0.0);
    else if (h < 2.0/6.0) rgb = vec3(x, c, 0.0);
    else if (h < 3.0/6.0) rgb = vec3(0.0, c, x);
    else if (h < 4.0/6.0) rgb = vec3(0.0, x, c);
    else if (h < 5.0/6.0) rgb = vec3(x, 0.0, c);
    else                   rgb = vec3(c, 0.0, x);
    return rgb + m;
  }

  void main() {
    float h = clamp(vHeight / 20.0, 0.0, 1.0);
    // uCentroid shifts hue: 0.55 = cyan, 0.85 = magenta
    float hue = mix(0.55, 0.85, uCentroid) + h * 0.1;
    float lum = 0.25 + h * 0.45;
    vec3 col = hsl2rgb(hue, 1.0, lum);
    float alpha = 0.3 + h * 0.5;
    gl_FragColor = vec4(col, alpha);
  }
`;

// ── Grid fragment shader ──────────────────────────────────────────────────────

const GRID_FRAGMENT_SHADER = /* glsl */`
  uniform float uCentroid;
  varying float vHeight;
  varying float vNormX;

  vec3 hsl2rgb(float h, float s, float l) {
    float c = (1.0 - abs(2.0 * l - 1.0)) * s;
    float x = c * (1.0 - abs(mod(h * 6.0, 2.0) - 1.0));
    float m = l - c * 0.5;
    vec3 rgb;
    if      (h < 1.0/6.0) rgb = vec3(c, x, 0.0);
    else if (h < 2.0/6.0) rgb = vec3(x, c, 0.0);
    else if (h < 3.0/6.0) rgb = vec3(0.0, c, x);
    else if (h < 4.0/6.0) rgb = vec3(0.0, x, c);
    else if (h < 5.0/6.0) rgb = vec3(x, 0.0, c);
    else                   rgb = vec3(c, 0.0, x);
    return rgb + m;
  }

  void main() {
    // Slight hue variation along X for rainbow-grid effect
    float hue = mix(0.55, 0.85, uCentroid) + vNormX * 0.15;
    vec3 col = hsl2rgb(hue, 1.0, 0.65);
    gl_FragColor = vec4(col, 1.0);
  }
`;

// ── Geometry helpers ──────────────────────────────────────────────────────────

const GRID_SEGMENTS = 64; // 65 vertices per side
const GRID_SIZE = 300;    // X/Z ∈ [-150, 150]

function buildTerrainGeometry(): THREE.BufferGeometry {
  const verts = GRID_SEGMENTS + 1;
  const positions = new Float32Array(verts * verts * 3);
  const indices: number[] = [];

  for (let iz = 0; iz < verts; iz++) {
    for (let ix = 0; ix < verts; ix++) {
      const idx = iz * verts + ix;
      const x = (ix / GRID_SEGMENTS) * GRID_SIZE - GRID_SIZE / 2;
      const z = (iz / GRID_SEGMENTS) * GRID_SIZE - GRID_SIZE / 2;
      positions[idx * 3]     = x;
      positions[idx * 3 + 1] = 0;
      positions[idx * 3 + 2] = z;
    }
  }

  for (let iz = 0; iz < GRID_SEGMENTS; iz++) {
    for (let ix = 0; ix < GRID_SEGMENTS; ix++) {
      const a = iz * verts + ix;
      const b = a + 1;
      const c = a + verts;
      const d = c + 1;
      indices.push(a, b, c);
      indices.push(b, d, c);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setIndex(indices);
  return geo;
}

function buildGridGeometry(): THREE.BufferGeometry {
  const verts = GRID_SEGMENTS + 1;
  const positions: number[] = [];
  const lineIndices: number[] = [];
  let vertexIndex = 0;

  // Horizontal lines (along X axis, varying Z)
  for (let iz = 0; iz < verts; iz++) {
    const z = (iz / GRID_SEGMENTS) * GRID_SIZE - GRID_SIZE / 2;
    const lineStart = vertexIndex;
    for (let ix = 0; ix < verts; ix++) {
      const x = (ix / GRID_SEGMENTS) * GRID_SIZE - GRID_SIZE / 2;
      positions.push(x, 0, z);
      vertexIndex++;
    }
    for (let ix = 0; ix < GRID_SEGMENTS; ix++) {
      lineIndices.push(lineStart + ix, lineStart + ix + 1);
    }
  }

  // Vertical lines (along Z axis, varying X)
  for (let ix = 0; ix < verts; ix++) {
    const x = (ix / GRID_SEGMENTS) * GRID_SIZE - GRID_SIZE / 2;
    const lineStart = vertexIndex;
    for (let iz = 0; iz < verts; iz++) {
      const z = (iz / GRID_SEGMENTS) * GRID_SIZE - GRID_SIZE / 2;
      positions.push(x, 0, z);
      vertexIndex++;
    }
    for (let iz = 0; iz < GRID_SEGMENTS; iz++) {
      lineIndices.push(lineStart + iz, lineStart + iz + 1);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(lineIndices);
  return geo;
}

// ── Setup ─────────────────────────────────────────────────────────────────────

function setup(): void {
  // Overlay canvas (same CSS pattern as liquidmetal.ts)
  threeCanvas = document.createElement('canvas');
  threeCanvas.style.cssText =
    'position:fixed;top:0;left:0;width:100%;height:100%;z-index:10;pointer-events:none;display:block';
  document.body.appendChild(threeCanvas);

  // Renderer
  renderer = new THREE.WebGLRenderer({ canvas: threeCanvas, antialias: true, alpha: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  // Scene
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000008);
  scene.fog = new THREE.FogExp2(0x000008, 0.006);

  // Camera — low angle looking down the terrain
  camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 500);
  camera.position.set(0, 25, 80);
  camera.lookAt(0, 0, -30);

  // Ambient light
  scene.add(new THREE.AmbientLight(0x111133, 0.4));

  // Terrain mesh
  const terrainGeo = buildTerrainGeometry();
  terrainMat = new THREE.ShaderMaterial({
    vertexShader: VERTEX_SHADER,
    fragmentShader: TERRAIN_FRAGMENT_SHADER,
    uniforms: {
      uTime: uTime,
      uBands: uBands,
      uBeatPulse: uBeatPulse,
      uBeatRadius: uBeatRadius,
      uCentroid: uCentroid,
      uIntensity: uIntensity,
    },
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  terrainMesh = new THREE.Mesh(terrainGeo, terrainMat);
  scene.add(terrainMesh);

  // Grid line overlay
  const gridGeo = buildGridGeometry();
  gridMat = new THREE.ShaderMaterial({
    vertexShader: VERTEX_SHADER,
    fragmentShader: GRID_FRAGMENT_SHADER,
    uniforms: {
      uTime: uTime,
      uBands: uBands,
      uBeatPulse: uBeatPulse,
      uBeatRadius: uBeatRadius,
      uCentroid: uCentroid,
      uIntensity: uIntensity,
    },
    transparent: true,
  });
  gridLines = new THREE.LineSegments(gridGeo, gridMat);
  scene.add(gridLines);

  // Post-processing: RenderPass → UnrealBloomPass → OutputPass
  const res = new THREE.Vector2(window.innerWidth, window.innerHeight);
  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  composer.addPass(new UnrealBloomPass(res, 1.2, 0.5, 0.15));
  composer.addPass(new OutputPass());

  // Hide canvas when switching away from this viz
  vizModeUnsub = store.on('vizModeChange', (data) => {
    if (!threeCanvas) return;
    threeCanvas.style.display = data === 'neon' ? 'block' : 'none';
  });

  initialized = true;
}

// ── Draw (called by p5 draw loop at ~60fps) ───────────────────────────────────

export function drawNeon(_p: unknown, dt: number): void {
  if (!initialized) setup();

  time += dt * 0.016;

  const { amps } = getBandAverages(7);

  // Update band uniforms
  uBands.value = amps.slice();
  uCentroid.value = store.audioState.smoothedCentroid;
  uTime.value = time;

  // Beat detection
  const { state } = store;
  if (state.beatIntervalSec > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    const beatIdx = adjusted >= 0 ? Math.floor(adjusted / state.beatIntervalSec) : -1;
    if (beatIdx > lastBeatIndex) {
      lastBeatIndex = beatIdx;
      beatPulse = 1.0;
      beatRadius = 0;
    }
  }

  // Decay beat pulse and expand ring
  beatPulse *= Math.pow(0.92, dt);
  beatRadius += dt * 8;

  uBeatPulse.value = beatPulse;
  uBeatRadius.value = beatRadius;

  // Camera bob with bass
  if (camera) {
    camera.position.y = 25 + (amps[1] ?? 0) * 5 * Math.sin(time * 2);

    // Full orbit around terrain
    cameraTheta += dt * 0.0003 * store.config.rotationSpeed;
    const orbitRadius = 90;
    camera.position.x = Math.sin(cameraTheta) * orbitRadius;
    camera.position.z = Math.cos(cameraTheta) * orbitRadius;
    camera.lookAt(0, 0, 0);
  }

  // Intensity controls bloom strength + terrain displacement
  const intensity = store.config.intensity;
  uIntensity.value = 0.3 + intensity * 0.7;
  if (composer) {
    const bloomPass = composer.passes[1] as InstanceType<typeof UnrealBloomPass>;
    if (bloomPass) bloomPass.strength = 0.4 + intensity * 0.8;
  }

  if (composer) composer.render();
}

// ── Reset (called on window resize) ──────────────────────────────────────────

export function resetNeon(): void {
  if (!initialized) return;
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer?.setSize(w, h);
  if (camera) { camera.aspect = w / h; camera.updateProjectionMatrix(); }
  composer?.setSize(w, h);
}

// ── Dispose (called on page unload) ──────────────────────────────────────────

export function disposeNeon(): void {
  if (!initialized) return;
  vizModeUnsub?.();
  vizModeUnsub = null;
  terrainMesh?.geometry.dispose();
  gridLines?.geometry.dispose();
  terrainMat?.dispose();
  gridMat?.dispose();
  composer?.dispose();
  renderer?.dispose();
  threeCanvas?.remove();
  threeCanvas = null; renderer = null; scene = null; camera = null;
  composer = null; terrainMesh = null; gridLines = null;
  terrainMat = null; gridMat = null;
  time = 0; lastBeatIndex = -1; beatPulse = 0; beatRadius = 0; cameraTheta = 0;
  initialized = false;
}
