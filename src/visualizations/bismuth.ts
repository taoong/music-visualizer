/**
 * Bismuth — audio-reactive stepped crystal terrain with thin-film iridescence.
 *
 * Chebyshev-distance zoning maps 7 frequency bands to concentric square
 * "terrace rings" on a horizontal heightmap; band amplitude drives terrace
 * height continuously (CHOP-style lerp). The vertex shader displaces the grid
 * in Y using sharp band-index steps (not smooth interpolation) so each ring
 * is a flat plateau. The fragment shader derives surface normals from dFdx/dFdy
 * of world position, detects step edges from discontinuous band-fraction
 * derivatives, and computes optical thin-film interference for the bismuth-
 * crystal rainbow oxidation that sweeps across the surface as the camera orbits.
 *
 * Inspired by bismuth crystal photography (Alchemist-hp / Wikimedia Commons)
 * and Tokujin Yoshioka "Crystallize" (Swarovski Crystal Palace, Design Miami
 * 2011, https://www.tokujin.com/work/crystallize).
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { store } from '../state/store';
import { getBandAverages } from './helpers';
import { isMobile } from '../utils/constants';
import { audioEngine } from '../audio/engine';

// ── Module state ───────────────────────────────────────────────────────────────

let initialized = false;
let threeCanvas:  HTMLCanvasElement  | null = null;
let renderer:     THREE.WebGLRenderer | null = null;
let scene:        THREE.Scene         | null = null;
let camera:       THREE.PerspectiveCamera | null = null;
let composer:     EffectComposer      | null = null;
let terrainMesh:  THREE.Mesh          | null = null;
let terrainMat:   THREE.ShaderMaterial | null = null;
let vizModeUnsub: (() => void)        | null = null;

let time         = 0;
let cameraTheta  = Math.PI * 0.25;  // start at an angled position
let lastBeatIndex = -1;
let kickAmp       = 0;

// ── Shared uniforms ────────────────────────────────────────────────────────────

const uTime:      THREE.IUniform<number>        = { value: 0 };
const uBands:     THREE.IUniform<number[]>      = { value: new Array(7).fill(0) };
const uKick:      THREE.IUniform<number>        = { value: 0 };
const uRelief:    THREE.IUniform<number>        = { value: 1 };
const uOxidation: THREE.IUniform<number>        = { value: 0.6 };
const uScale:     THREE.IUniform<number>        = { value: 1 };
const uLightDir:  THREE.IUniform<THREE.Vector3> = {
  value: new THREE.Vector3(0.55, 0.78, 0.3).normalize(),
};
const uCamPos:    THREE.IUniform<THREE.Vector3> = { value: new THREE.Vector3() };

// ── Vertex shader ──────────────────────────────────────────────────────────────

const VERTEX_SHADER = /* glsl */`
  uniform float uTime;
  uniform float uBands[7];
  uniform float uKick;
  uniform float uRelief;
  uniform float uScale;

  const float HALF  = 50.0;
  const float MAX_H = 15.0;

  varying float vHeight;
  varying float vCheb;
  varying float vBandFrac;
  varying vec3  vWorldPos;

  void main() {
    // Chebyshev (L∞) distance from center → concentric square rings
    float nx = abs(position.x) / HALF;
    float nz = abs(position.z) / HALF;
    float cheb = max(nx, nz);           // 0 at centre, 1 at edge

    // Add gentle time-varying wobble to ring edges (organic crystal look)
    float wobble = sin(position.x * 0.4 + uTime * 0.6) *
                   cos(position.z * 0.4 - uTime * 0.5) * 0.025;
    float chebW = clamp(cheb + wobble, 0.0, 1.0);

    // Sharp band index — floor gives discrete plateaus
    float scaled  = chebW * uScale * 7.0;
    float bandIdxF = mod(floor(scaled), 7.0);
    int   bandIdx  = int(bandIdxF);

    float bandAmp = uBands[bandIdx];
    // Each band contributes a base oxidation height even at silence
    float baseH = bandIdxF * 0.07;        // 0–0.42 stagger per ring
    float height = (baseH + bandAmp) * uRelief * MAX_H;
    // Beat kick: strongest at centre, fades out
    height += uKick * MAX_H * 0.55 * (1.0 - cheb * cheb);

    vHeight   = height;
    vCheb     = chebW;
    vBandFrac = fract(scaled);            // position within current ring

    vec4 worldPos4 = modelMatrix * vec4(position.x, height, position.z, 1.0);
    vWorldPos = worldPos4.xyz;

    gl_Position = projectionMatrix * viewMatrix * worldPos4;
  }
`;

// ── Fragment shader ────────────────────────────────────────────────────────────

const FRAGMENT_SHADER = /* glsl */`
  uniform float uOxidation;
  uniform vec3  uLightDir;
  uniform vec3  uCamPos;

  varying float vHeight;
  varying float vCheb;
  varying float vBandFrac;
  varying vec3  vWorldPos;

  // Physically-based thin-film interference colour for bismuth Bi₂O₃ surface.
  // thickness in micrometres, cosTheta = angle of incidence.
  // Returns interference weighting in [0,1]^3 (RGB).
  vec3 thinFilm(float cosTheta, float thickness) {
    // Film IOR ≈ 2.0 (bismuth(III) oxide Bi₂O₃)
    const float n = 2.0;
    const float TAU = 6.283185;

    // Optical path difference (round trip through film)
    float d = 2.0 * n * thickness * cosTheta;

    // Constructive/destructive interference for R, G, B wavelengths (μm)
    float phiR = TAU * d / 0.630;
    float phiG = TAU * d / 0.540;
    float phiB = TAU * d / 0.450;

    return 0.5 + 0.5 * vec3(cos(phiR), cos(phiG), cos(phiB));
  }

  void main() {
    // ── Surface normal from world-position screen-space derivatives ──────────
    vec3 dPdX = dFdx(vWorldPos);
    vec3 dPdZ = dFdy(vWorldPos);
    vec3 normal = normalize(cross(dPdX, dPdZ));
    if (normal.y < 0.0) normal = -normal;   // ensure upward-facing

    // ── Step-edge detection via band-fraction discontinuity ──────────────────
    // vBandFrac jumps near 0→1 at every ring boundary.
    // The derivative spikes there, flagging an edge fragment.
    float dfx = abs(dFdx(vBandFrac));
    float dfy = abs(dFdy(vBandFrac));
    // Also detect actual height difference between adjacent fragments
    float dHx = abs(dFdx(vHeight));
    float dHy = abs(dFdy(vHeight));
    float edgeFactor = clamp((dfx + dfy) * 3.0 + (dHx + dHy) * 0.15, 0.0, 1.0);

    // ── Lighting (warm amber key + cool ambient) ──────────────────────────────
    vec3  L       = normalize(uLightDir);
    float diffuse = max(0.0, dot(normal, L));
    float ambient = 0.08;

    vec3 viewDir  = normalize(uCamPos - vWorldPos);
    vec3 H        = normalize(L + viewDir);
    float spec    = pow(max(0.0, dot(normal, H)), 56.0);

    // ── Thin-film iridescence ─────────────────────────────────────────────────
    float cosView = abs(dot(normal, viewDir));
    // Film thickness: base stagger per ring + audio-driven height contribution
    // Bands 0-6 each have a shifted base so they carry distinct colours at rest.
    float bandShift = mod(vCheb * 7.0, 1.0) * 7.0 * 0.065;  // 0–0.455 μm
    float thickness = 0.22 + bandShift + (vHeight / 15.0) * 0.35;
    vec3 irid = thinFilm(cosView, thickness);

    // On flat step tops the iridescence is angle-dependent (shifts with orbit).
    // On step edges it is always present, creating the classic bismuth rainbow.
    float iridMix = mix(cosView * 0.35, 1.0, edgeFactor) * uOxidation;

    // ── Final colour ──────────────────────────────────────────────────────────
    // Dark steel-grey base (bismuth metal is very lustrous, near-black)
    vec3 baseColor = vec3(0.18, 0.20, 0.24);
    vec3 color     = baseColor * (ambient + 0.82 * diffuse);

    // Specular: warm amber light on metallic surface
    color += vec3(1.0, 0.82, 0.60) * spec * 0.70;

    // Iridescent overlay — multiply to boost rainbow on metallic surface
    color = mix(color, color * irid * 2.4, iridMix);

    // Clamp; output HDR for bloom pass
    gl_FragColor = vec4(clamp(color, 0.0, 3.0), 1.0);
  }
`;

// ── Geometry builder (manual XZ grid, like neon.ts) ───────────────────────────

function buildTerrain(segments: number): THREE.BufferGeometry {
  const SIZE  = 100;
  const verts = segments + 1;
  const positions = new Float32Array(verts * verts * 3);
  const indices: number[] = [];

  for (let iz = 0; iz < verts; iz++) {
    for (let ix = 0; ix < verts; ix++) {
      const idx = iz * verts + ix;
      positions[idx * 3]     = (ix / segments) * SIZE - SIZE / 2;
      positions[idx * 3 + 1] = 0;
      positions[idx * 3 + 2] = (iz / segments) * SIZE - SIZE / 2;
    }
  }

  for (let iz = 0; iz < segments; iz++) {
    for (let ix = 0; ix < segments; ix++) {
      const a = iz * verts + ix;
      const b = a + 1;
      const c = a + verts;
      const d = c + 1;
      indices.push(a, b, c, b, d, c);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setIndex(indices);
  return geo;
}

// ── Setup ──────────────────────────────────────────────────────────────────────

function setup(): void {
  threeCanvas = document.createElement('canvas');
  threeCanvas.style.cssText =
    'position:fixed;top:0;left:0;width:100%;height:100%;z-index:10;pointer-events:none;display:block';
  document.body.appendChild(threeCanvas);

  const dpr = Math.min(window.devicePixelRatio, isMobile ? 1 : 2);
  renderer = new THREE.WebGLRenderer({ canvas: threeCanvas, antialias: !isMobile, alpha: false });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(dpr);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.4;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  scene  = new THREE.Scene();
  scene.background = new THREE.Color(0x060608);
  scene.fog = new THREE.FogExp2(0x060608, 0.012);

  // Camera orbits at ~32° elevation, radius 85
  camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 400);
  camera.position.set(
    Math.sin(cameraTheta) * 85,
    32,
    Math.cos(cameraTheta) * 85,
  );
  camera.lookAt(0, 3, 0);

  // Single warm-amber directional key light
  const keyLight = new THREE.DirectionalLight(0xffd090, 2.6);
  keyLight.position.set(0.55, 0.78, 0.3);
  scene.add(keyLight);

  // Cool-blue ambient fill (simulates sky scatter)
  scene.add(new THREE.AmbientLight(0x1a2240, 0.6));

  // Build terrain geometry (high-res for crisp step edges)
  const segments = isMobile ? 80 : 200;
  const geo = buildTerrain(segments);

  terrainMat = new THREE.ShaderMaterial({
    vertexShader:   VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    uniforms: {
      uTime,
      uBands,
      uKick,
      uRelief,
      uOxidation,
      uScale,
      uLightDir,
      uCamPos,
    },
    side: THREE.DoubleSide,
  });

  terrainMesh = new THREE.Mesh(geo, terrainMat);
  scene.add(terrainMesh);

  // EffectComposer: RenderPass → subtle bloom → OutputPass
  const res = new THREE.Vector2(window.innerWidth, window.innerHeight);
  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(res, isMobile ? 0.4 : 0.6, 0.6, 0.55);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  // Hide canvas when switching away
  vizModeUnsub = store.on('vizModeChange', (data) => {
    if (!threeCanvas) return;
    threeCanvas.style.display = data === 'bismuth' ? 'block' : 'none';
  });

  initialized = true;
}

// ── Draw ───────────────────────────────────────────────────────────────────────

export function drawBismuth(_p: unknown, dt: number): void {
  if (!initialized) setup();

  time += dt * 0.016;

  const { amps } = getBandAverages(7);

  // ── Continuous CHOP-style uniform updates ──────────────────────────────────
  uBands.value = amps.slice();
  uTime.value  = time;

  // ── Beat detection + kick impulse ─────────────────────────────────────────
  const { state } = store;
  if (state.beatIntervalSec > 0 && state.isPlaying) {
    const pos      = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    const beatIdx  = adjusted >= 0 ? Math.floor(adjusted / state.beatIntervalSec) : -1;
    if (beatIdx > lastBeatIndex) {
      lastBeatIndex = beatIdx;
      kickAmp = 1.0;
    }
  }
  // Exponential decay (not beat-snap)
  kickAmp *= Math.pow(0.88, dt);
  uKick.value = kickAmp;

  // ── Slider-driven uniforms ─────────────────────────────────────────────────
  // bismuthScale  0→1 → uScale 0.5→2.5 (structural ring frequency)
  uScale.value     = 0.5 + store.config.bismuthScale * 2.0;
  // bismuthRelief 0→1 → uRelief 0.1→1.0
  uRelief.value    = 0.1 + store.config.bismuthRelief * 0.9;
  // bismuthOxidation direct
  uOxidation.value = store.config.bismuthOxidation;

  // ── Camera orbit (slow, continuous) ───────────────────────────────────────
  if (camera) {
    // 90-second full orbit; bass amplitude nudges speed slightly
    const orbitSpeed = 0.00065 * (1.0 + (amps[0] ?? 0) * 0.4);
    cameraTheta += orbitSpeed * dt;

    // Slight elevation oscillation keyed to low-mid
    const baseElev   = 30;
    const elevDelta  = (amps[2] ?? 0) * 6;
    const elevation  = baseElev + elevDelta + kickAmp * 4;
    const radius     = 82 + (amps[1] ?? 0) * 5;

    camera.position.set(
      Math.sin(cameraTheta) * radius,
      elevation,
      Math.cos(cameraTheta) * radius,
    );
    camera.lookAt(0, 3, 0);
    uCamPos.value.copy(camera.position);
  }

  if (composer) composer.render();
}

// ── Reset (window resize) ─────────────────────────────────────────────────────

export function resetBismuth(): void {
  if (!initialized) return;
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer?.setSize(w, h);
  if (camera) { camera.aspect = w / h; camera.updateProjectionMatrix(); }
  composer?.setSize(w, h);
}

// ── Dispose ───────────────────────────────────────────────────────────────────

export function disposeBismuth(): void {
  if (!initialized) return;
  vizModeUnsub?.();
  vizModeUnsub = null;
  terrainMesh?.geometry.dispose();
  terrainMat?.dispose();
  composer?.dispose();
  renderer?.dispose();
  threeCanvas?.remove();
  threeCanvas = null; renderer = null; scene = null; camera = null;
  composer = null; terrainMesh = null; terrainMat = null;
  time = 0; cameraTheta = Math.PI * 0.25; lastBeatIndex = -1; kickAmp = 0;
  initialized = false;
}
