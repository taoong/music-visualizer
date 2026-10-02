/**
 * Tomography — 3D SDF cross-section scanner
 *
 * A stack of parallel XY planes each renders a ShaderMaterial that evaluates
 * a 3D signed-distance field at that plane's depth, drawing glowing contour
 * lines wherever the surface crosses the scan plane. Additive blending stacks
 * the slices into a luminous wire-cage portrait of the underlying 3D shape.
 *
 * The SDF blends three topologies controlled by the Shape slider:
 *   0 → single sphere
 *   0.5 → ring torus
 *   1.0 → figure-8 (two fused spheres)
 * Each topology responds differently to the 7 audio bands.
 *
 * Camera orbits the stack continuously; beats fire brief angular impulses.
 * EffectComposer: subtle UnrealBloomPass (desktop) + chromatic aberration.
 *
 * Inspired by Ryoji Ikeda "the transfinite" (2011, Park Ave Armory) and
 * Memo Akten's computational data-sculpture works; VJ/Notch scan-line aesthetic.
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { store } from '../state/store';
import { getBandAverages } from './helpers';
import { isMobile } from '../utils/constants';

// ── Module state ──────────────────────────────────────────────────────────────

let threeCanvas: HTMLCanvasElement | null = null;
let renderer: THREE.WebGLRenderer | null = null;
let scene: THREE.Scene | null = null;
let camera: THREE.PerspectiveCamera | null = null;
let composer: EffectComposer | null = null;

let sliceMeshes: THREE.Mesh[] = [];
let sliceMaterials: THREE.ShaderMaterial[] = [];
let sharedGeo: THREE.PlaneGeometry | null = null;
let aberrationPass: ShaderPass | null = null;
let bloomPass: UnrealBloomPass | null = null;

let initialized = false;
let orbitAngle = 0.0;
let orbitVel = 0.0;
let lastDensityKey = -1;

// ── Shared uniforms (mutated in place each frame) ──────────────────────────────

const uTime: THREE.IUniform<number>           = { value: 0.0 };
const uTransient: THREE.IUniform<number>      = { value: 0.0 };
const uMorphMix: THREE.IUniform<number>       = { value: 0.3 };
const uGlow: THREE.IUniform<number>           = { value: 0.07 };
const uColor: THREE.IUniform<THREE.Vector3>   = { value: new THREE.Vector3(0.35, 0.75, 1.0) };
const uBands: THREE.IUniform<number[]>        = { value: [0, 0, 0, 0, 0, 0, 0] };
const uSliceWeight: THREE.IUniform<number>    = { value: 0.8 };

// ── Shaders ───────────────────────────────────────────────────────────────────

const VERT = /* glsl */`
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FRAG = /* glsl */`
  uniform float uBands[7];
  uniform float uTime;
  uniform float uSliceZ;
  uniform float uMorphMix;
  uniform vec3  uColor;
  uniform float uGlow;
  uniform float uTransient;
  uniform float uSliceWeight;

  varying vec2 vUv;

  // ── SDF primitives ────────────────────────────────────────────────────────

  float sdSphere(vec3 p, float r) {
    return length(p) - r;
  }

  float sdTorus(vec3 p, vec2 t) {
    // Ring in XZ plane (axis = Y)
    vec2 q = vec2(length(p.xz) - t.x, p.y);
    return length(q) - t.y;
  }

  float opSmoothUnion(float a, float b, float k) {
    float h = clamp(0.5 + 0.5*(b - a)/k, 0.0, 1.0);
    return mix(b, a, h) - k * h * (1.0 - h);
  }

  // ── Audio-reactive 3D SDF ─────────────────────────────────────────────────

  float evalSDF(vec3 p) {
    // Sub-bass drives sphere radius
    float sR = 1.3 + uBands[0] * 0.9;

    // Bass drives torus major radius, low-mid drives tube radius
    float tR = 1.1 + uBands[1] * 0.45;
    float tr = 0.32 + uBands[2] * 0.28;

    float dSphere = sdSphere(p, sR);
    float dTorus  = sdTorus(p, vec2(tR, tr));

    // Figure-8: two spheres displaced along Y, smooth-unioned
    float r2  = sR * 0.68;
    float off = r2 * 0.72;
    float da  = sdSphere(p + vec3(0.0, off, 0.0), r2);
    float db  = sdSphere(p - vec3(0.0, off, 0.0), r2);
    float dFig8 = opSmoothUnion(da, db, 0.22);

    // Morph: 0=sphere → 0.5=torus → 1.0=figure-8
    float bToTorus   = clamp(uMorphMix * 2.0, 0.0, 1.0);
    float bToFig8    = clamp(uMorphMix * 2.0 - 1.0, 0.0, 1.0);
    float d = mix(dSphere, dTorus, bToTorus);
    d = mix(d, dFig8, bToFig8);

    // Mid (band 3): morph also nudged continuously by audio
    float audioBias = uBands[3] * 0.4;
    float dExtraTorus = sdTorus(p, vec2(tR * 0.8, tr * 0.7));
    d = mix(d, dExtraTorus, audioBias * (1.0 - uMorphMix));

    // Upper-mid: standing-wave corrugations on the surface
    float corrugate = sin(d * 20.0 + uTime * 0.4) * uBands[4] * 0.055;
    d += corrugate;

    // Presence: turbulence (cheap FBM-style)
    float n = sin(p.x * 2.9 + uTime * 0.8)
            * cos(p.y * 3.3 - uTime * 0.6)
            * sin(p.z * 2.5 + uTime * 0.45);
    d += n * uBands[5] * 0.09;

    // Brilliance: fine-scale wrinkles
    float fine = cos(p.x * 13.0 - uTime * 1.1) * sin(p.z * 11.0 + uTime * 0.9);
    d += fine * uBands[6] * 0.035;

    return d;
  }

  void main() {
    // Map UV to world-space XY (plane extends ±2.75 units)
    vec2 xy = (vUv - 0.5) * 5.5;
    vec3 p  = vec3(xy, uSliceZ);

    float d = evalSDF(p);

    // Contour glow: exponential falloff from zero-crossing
    float gw      = max(0.015, uGlow);
    float contour = exp(-abs(d) / gw);

    // Subtle fill inside the surface
    float fill = smoothstep(0.0, -0.6, d) * 0.10;

    // Transient flash brightens the contour
    float flash = uTransient * contour * 0.55;

    float bright = (contour + fill + flash) * uSliceWeight;
    gl_FragColor = vec4(uColor * bright, bright);
  }
`;

const ABERR_VERT = /* glsl */`
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const ABERR_FRAG = /* glsl */`
  uniform sampler2D tDiffuse;
  uniform float uStrength;
  varying vec2 vUv;
  void main() {
    vec2 dir    = (vUv - 0.5);
    float dist  = length(dir);
    vec2 offset = normalize(dir + vec2(0.001)) * dist * uStrength;
    float r = texture2D(tDiffuse, vUv + offset).r;
    float g = texture2D(tDiffuse, vUv).g;
    float b = texture2D(tDiffuse, vUv - offset).b;
    gl_FragColor = vec4(r, g, b, 1.0);
  }
`;

// ── Geometry management ───────────────────────────────────────────────────────

const PLANE_SIZE   = 5.5;
const STACK_EXTENT = 2.75;

function buildSlices(count: number): void {
  for (const m of sliceMeshes) scene?.remove(m);
  for (const mat of sliceMaterials) mat.dispose();
  sharedGeo?.dispose();
  sliceMeshes     = [];
  sliceMaterials  = [];

  sharedGeo = new THREE.PlaneGeometry(PLANE_SIZE, PLANE_SIZE);

  // Normalise per-slice brightness so total accumulation stays consistent
  const weight = Math.min(1.0, 3.0 / Math.sqrt(count));
  uSliceWeight.value = weight;

  for (let i = 0; i < count; i++) {
    const t      = count === 1 ? 0.5 : i / (count - 1);
    const sliceZ = -STACK_EXTENT + t * 2.0 * STACK_EXTENT;

    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uBands:       uBands,
        uTime:        uTime,
        uSliceZ:      { value: sliceZ },
        uMorphMix:    uMorphMix,
        uColor:       uColor,
        uGlow:        uGlow,
        uTransient:   uTransient,
        uSliceWeight: uSliceWeight,
      },
      vertexShader:   VERT,
      fragmentShader: FRAG,
      transparent:    true,
      blending:       THREE.AdditiveBlending,
      depthWrite:     false,
      side:           THREE.DoubleSide,
    });
    sliceMaterials.push(mat);

    const mesh = new THREE.Mesh(sharedGeo, mat);
    mesh.position.z = sliceZ;
    scene!.add(mesh);
    sliceMeshes.push(mesh);
  }

  lastDensityKey = count;
}

// ── Setup ─────────────────────────────────────────────────────────────────────

function setup(): void {
  threeCanvas             = document.createElement('canvas');
  threeCanvas.style.cssText =
    'position:fixed;top:0;left:0;width:100%;height:100%;z-index:10;pointer-events:none;display:block';
  document.body.appendChild(threeCanvas);

  const pr = Math.min(window.devicePixelRatio, isMobile ? 1.0 : 1.5);
  renderer = new THREE.WebGLRenderer({
    canvas: threeCanvas,
    antialias: false,
    alpha: true,
  });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(pr);
  renderer.setClearColor(0x000000, 0);

  scene  = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(
    48,
    window.innerWidth / window.innerHeight,
    0.1,
    60,
  );

  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));

  if (!isMobile) {
    bloomPass = new UnrealBloomPass(
      new THREE.Vector2(window.innerWidth, window.innerHeight),
      0.45,
      0.5,
      0.65,
    );
    composer.addPass(bloomPass);
  }

  aberrationPass = new ShaderPass({
    uniforms: {
      tDiffuse:  { value: null as THREE.Texture | null },
      uStrength: { value: 0.004 },
    },
    vertexShader:   ABERR_VERT,
    fragmentShader: ABERR_FRAG,
  });
  composer.addPass(aberrationPass);

  const initCount = isMobile ? 8 : 12;
  buildSlices(initCount);
  initialized = true;
}

// ── Palette helper ────────────────────────────────────────────────────────────

function applyPalette(t: number): void {
  // 0 = cold blue-white (CT scan), 0.5 = phosphor green (vintage CRT), 1 = warm amber
  const c = uColor.value;
  if (t <= 0.5) {
    const s = t * 2.0;
    c.set(
      0.35 + (0.08 - 0.35) * s,
      0.75 + (1.0  - 0.75) * s,
      1.0  + (0.25 - 1.0)  * s,
    );
  } else {
    const s = (t - 0.5) * 2.0;
    c.set(
      0.08 + (1.0  - 0.08) * s,
      1.0  + (0.58 - 1.0)  * s,
      0.25 + (0.04 - 0.25) * s,
    );
  }
}

// ── Draw ──────────────────────────────────────────────────────────────────────

export function drawTomography(_p: unknown, dt: number): void {
  if (!initialized) setup();

  const { amps, transients } = getBandAverages(7);
  const cfg = store.config;

  // Audio uniforms
  uBands.value = amps as number[];
  uTime.value += 0.016 * dt;

  const rawT = Math.max(transients[0] ?? 1, transients[1] ?? 1, transients[2] ?? 1) - 1.0;
  uTransient.value += (Math.max(0, rawT) * 1.3 - uTransient.value) * 0.2;

  // Slider-driven uniforms
  uMorphMix.value = cfg.tomographyShape;
  uGlow.value     = 0.018 + cfg.tomographyGlow * 0.18;

  applyPalette(cfg.tomographyPalette);

  // Rebuild slices if density changed
  const rawCount  = Math.round(3 + cfg.tomographyDensity * 17); // 3–20
  const count     = isMobile ? Math.min(rawCount, 12) : rawCount;
  if (count !== lastDensityKey) {
    buildSlices(count);
  }

  // Camera orbit: continuous slow drift, beat fires angular impulse
  orbitVel    *= 0.94;
  orbitAngle  += 0.0022 * dt + orbitVel;

  if (rawT > 0.45) {
    orbitVel += 0.018 * Math.min(rawT, 2.0);
  }

  const orbitDist = 8.0;
  const orbitY    = 1.8;
  if (camera) {
    camera.position.set(
      Math.sin(orbitAngle) * orbitDist,
      orbitY,
      Math.cos(orbitAngle) * orbitDist,
    );
    camera.lookAt(0, 0, 0);
  }

  if (composer) composer.render();
}

// ── Reset ─────────────────────────────────────────────────────────────────────

export function resetTomography(): void {
  if (!initialized) return;
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer?.setSize(w, h);
  if (camera) { camera.aspect = w / h; camera.updateProjectionMatrix(); }
  composer?.setSize(w, h);
  bloomPass?.setSize(w, h);
}

// ── Dispose ───────────────────────────────────────────────────────────────────

export function disposeTomography(): void {
  if (!initialized) return;
  for (const m of sliceMeshes) scene?.remove(m);
  for (const mat of sliceMaterials) mat.dispose();
  sharedGeo?.dispose();
  sliceMeshes     = [];
  sliceMaterials  = [];
  sharedGeo       = null;
  composer?.dispose();
  renderer?.dispose();
  threeCanvas?.remove();
  threeCanvas  = null;
  renderer     = null;
  scene        = null;
  camera       = null;
  composer     = null;
  aberrationPass = null;
  bloomPass    = null;
  initialized  = false;
}
