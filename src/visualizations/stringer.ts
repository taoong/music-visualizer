/**
 * Stringer — Three.js WebGL overlay visualization
 *
 * A field of luminous vertical strings fills a dark architectural void; each
 * string is assigned to one of 7 frequency bands and vibrates as a standing
 * wave whose amplitude and harmonic order respond continuously to that band's
 * energy. The camera weaves through the field at human height on a slow
 * sinusoidal path, making the strings part of an interior space rather than
 * a flat pattern.
 *
 * Inspired by Paul Friedlander's chromastrobic spinning-string sculptures
 * (1983–ongoing, https://paulfriedlander.com/Light_Sculpture.html) — in which
 * a single rope spun at up to 600 rpm under rapidly colour-cycling light
 * becomes a luminous three-dimensional form whose shape encodes frequency and
 * amplitude. Here every string is its own light-sculpture responding to a
 * different part of the spectrum.
 *
 * Material: custom ShaderMaterial with per-vertex emissive driven by wave
 * amplitude. Single draw call (merged BufferGeometry). Warm white-to-silver
 * monochrome palette — no rainbow. One subtle bloom pass.
 *
 * Sliders
 *   Strings   — structural: string count (20–200 desktop / 10–60 mobile)
 *   Resonance — vibration amplitude sensitivity
 *   Glow      — bloom strength + emissive brightness
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { store } from '../state/store';
import { getBandAverages, fovForAspect } from './helpers';
import { isMobile } from '../utils/constants';

// ── Module state ──────────────────────────────────────────────────────────────

let initialized = false;
let threeCanvas: HTMLCanvasElement | null = null;
let renderer: THREE.WebGLRenderer | null = null;
let scene: THREE.Scene | null = null;
let camera: THREE.PerspectiveCamera | null = null;
let composer: EffectComposer | null = null;
let bloomPass: UnrealBloomPass | null = null;
let stringMesh: THREE.Mesh | null = null;
let stringMat: THREE.ShaderMaterial | null = null;
let vizModeUnsub: (() => void) | null = null;

let time = 0;
let camTheta = 0;  // horizontal wander angle
let camPhi = 0;    // vertical bob
let lastStringCount = 0;

// ── Uniforms ──────────────────────────────────────────────────────────────────

const uTime:      THREE.IUniform<number>   = { value: 0 };
const uBands:     THREE.IUniform<number[]> = { value: new Array(7).fill(0) };
const uResonance: THREE.IUniform<number>   = { value: 0.5 };
const uGlow:      THREE.IUniform<number>   = { value: 0.5 };
const uBeat:      THREE.IUniform<number>   = { value: 0 };

// ── Shaders ───────────────────────────────────────────────────────────────────

const VERTEX = /* glsl */`
  // Per-vertex attributes baked into the merged geometry
  attribute float aBand;      // which frequency band (0–6)
  attribute float aT;         // position along the string (0=bottom, 1=top)
  attribute float aPhase;     // per-string random phase offset

  uniform float uTime;
  uniform float uBands[7];
  uniform float uResonance;
  uniform float uGlow;
  uniform float uBeat;

  varying float vBrightness;

  void main() {
    // Sample amplitude for this string's band with smooth clamping
    int b = int(aBand);
    float amp = uBands[b];

    // Standing wave: higher bands use more harmonics → finer oscillation
    float harmonics = aBand + 2.0;                    // 2 to 8 half-wavelengths
    float speed     = 1.0 + aBand * 0.35;             // higher bands oscillate faster
    float wave      = sin(aT * harmonics * 3.14159 + uTime * speed + aPhase);

    // Displacement in XZ plane, rotated by phase so adjacent strings spread out
    float dispAmt = wave * amp * uResonance * 0.35;
    float dx = dispAmt * cos(aPhase);
    float dz = dispAmt * sin(aPhase);

    vec3 pos = position + vec3(dx, 0.0, dz);

    // Brightness: base emissive + amplitude envelope + beat flash
    float envelope = abs(wave) * amp;
    vBrightness = 0.15 + envelope * uGlow * 2.0 + uBeat * 0.5;

    gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
  }
`;

const FRAGMENT = /* glsl */`
  varying float vBrightness;

  void main() {
    // Near-monochrome warm white: slightly warm at peak, cool silver at rest
    float b = clamp(vBrightness, 0.0, 1.0);
    vec3 warmWhite = vec3(1.0, 0.97, 0.90);
    vec3 coolSilver = vec3(0.55, 0.58, 0.65);
    vec3 col = mix(coolSilver, warmWhite, b);
    gl_FragColor = vec4(col * b, b);
  }
`;

// ── Geometry builder ──────────────────────────────────────────────────────────

/**
 * Build a single merged BufferGeometry containing N vertical strings.
 * Each string is a thin rectangular strip (2 vertices wide × S+1 tall),
 * oriented to face the camera by rotating per-string around Y.
 * All strings share one draw call.
 */
function buildStringGeometry(count: number): THREE.BufferGeometry {
  const segsV = isMobile ? 16 : 28;    // vertical segments per string
  const halfW = isMobile ? 0.018 : 0.012; // half-width of the strip

  // Layout: strings scattered in a grid with jitter
  const gridSide = Math.ceil(Math.sqrt(count));
  const spacing  = isMobile ? 2.8 : 2.4;
  const spread   = gridSide * spacing * 0.5;

  // Pre-assign positions + per-string metadata
  const positions: number[]  = [];
  const aBandArr:  number[]  = [];
  const aTArr:     number[]  = [];
  const aPhaseArr: number[]  = [];
  const indices:   number[]  = [];

  const STRING_HEIGHT = 8.0;  // world-space height

  let rng = 1.0;
  const rand = () => { rng = (rng * 1664525 + 1013904223) & 0xffffffff; return (rng >>> 0) / 0xffffffff; };

  for (let si = 0; si < count; si++) {
    const band    = si % 7;
    const phase   = rand() * Math.PI * 2;

    // Scatter strings in XZ with grid + jitter
    const col = si % gridSide;
    const row = Math.floor(si / gridSide);
    const sx  = (col / (gridSide - 1) - 0.5) * spread * 2 + (rand() - 0.5) * spacing * 0.6;
    const sz  = (row / (gridSide - 1) - 0.5) * spread * 2 + (rand() - 0.5) * spacing * 0.6;

    // Build strip vertices: two columns (left/right) × (segsV+1) rows
    const baseIdx = positions.length / 3;

    for (let vi = 0; vi <= segsV; vi++) {
      const t   = vi / segsV;           // 0 (bottom) → 1 (top)
      const y   = t * STRING_HEIGHT - STRING_HEIGHT * 0.15; // slightly below camera

      // Left column
      positions.push(sx - halfW, y, sz);
      aBandArr.push(band);
      aTArr.push(t);
      aPhaseArr.push(phase);

      // Right column
      positions.push(sx + halfW, y, sz);
      aBandArr.push(band);
      aTArr.push(t);
      aPhaseArr.push(phase + 0.01); // tiny offset so the two columns can diverge slightly
    }

    // Triangulate the strip
    for (let vi = 0; vi < segsV; vi++) {
      const v0 = baseIdx + vi * 2;
      const v1 = v0 + 1;
      const v2 = v0 + 2;
      const v3 = v0 + 3;
      indices.push(v0, v1, v2,  v1, v3, v2);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('aBand',    new THREE.Float32BufferAttribute(aBandArr,  1));
  geo.setAttribute('aT',       new THREE.Float32BufferAttribute(aTArr,     1));
  geo.setAttribute('aPhase',   new THREE.Float32BufferAttribute(aPhaseArr, 1));
  geo.setIndex(indices);
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
  const dpr = isMobile ? Math.min(window.devicePixelRatio, 1.5) : Math.min(window.devicePixelRatio, 2);

  renderer = new THREE.WebGLRenderer({ canvas: threeCanvas, antialias: !isMobile, alpha: true });
  renderer.setPixelRatio(dpr);
  renderer.setSize(w, h);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.2;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x040406);
  scene.fog = new THREE.FogExp2(0x040406, 0.045);

  camera = new THREE.PerspectiveCamera(fovForAspect(72, w / h), w / h, 0.1, 120);
  camera.position.set(0, 2.8, 0);

  // Build string geometry with current slider value
  rebuildStrings();

  // Composer
  const renderPass = new RenderPass(scene, camera);
  bloomPass = new UnrealBloomPass(new THREE.Vector2(w, h), 0.9, 0.3, 0.2);
  const outputPass = new OutputPass();

  composer = new EffectComposer(renderer);
  composer.addPass(renderPass);
  composer.addPass(bloomPass);
  composer.addPass(outputPass);

  // Re-build geometry when viz mode changes away then back (reset)
  vizModeUnsub = store.on('vizModeChange', () => {
    if (store.state.vizMode !== 'stringer') return;
    rebuildStrings();
  });

  initialized = true;
}

function rebuildStrings(): void {
  if (!scene) return;

  const rawCount = store.config.stringerStrings;
  const count = isMobile
    ? Math.round(10 + rawCount * 50)   // 10–60
    : Math.round(20 + rawCount * 180); // 20–200

  if (count === lastStringCount && stringMesh) return;
  lastStringCount = count;

  // Dispose previous
  stringMesh?.geometry.dispose();
  if (stringMesh) { scene.remove(stringMesh); stringMesh = null; }

  const geo = buildStringGeometry(count);

  if (!stringMat) {
    stringMat = new THREE.ShaderMaterial({
      uniforms: { uTime, uBands, uResonance, uGlow, uBeat },
      vertexShader:   VERTEX,
      fragmentShader: FRAGMENT,
      transparent: true,
      depthWrite:  false,
      blending:    THREE.AdditiveBlending,
      side:        THREE.DoubleSide,
    });
  }

  stringMesh = new THREE.Mesh(geo, stringMat);
  scene.add(stringMesh);
}

// ── Draw ──────────────────────────────────────────────────────────────────────

export function drawStringer(_p: unknown, dt: number): void {
  if (!initialized) setup();

  const { amps, transients } = getBandAverages(7);
  const cfg = store.config;

  // Smooth band amps into uniforms
  for (let i = 0; i < 7; i++) {
    uBands.value[i] = amps[i] ?? 0;
  }

  // Beat detection: largest transient across all bands
  const maxTransient = Math.max(...transients);
  const beatKick = Math.max(0, maxTransient - 1.2);
  uBeat.value += (beatKick * 0.8 - uBeat.value) * 0.18 * dt;
  uBeat.value = Math.max(0, uBeat.value);

  // Config uniforms
  uResonance.value = cfg.stringerResonance;
  uGlow.value      = cfg.stringerGlow;

  // Bloom threshold adapts to glow setting
  if (bloomPass) {
    bloomPass.strength  = 0.4 + cfg.stringerGlow * 1.4;
    bloomPass.radius    = 0.25 + cfg.stringerGlow * 0.35;
    bloomPass.threshold = Math.max(0.05, 0.35 - cfg.stringerGlow * 0.3);
  }

  // Rebuild if string count changed (structural slider)
  const newCount = isMobile
    ? Math.round(10 + cfg.stringerStrings * 50)
    : Math.round(20 + cfg.stringerStrings * 180);
  if (newCount !== lastStringCount) rebuildStrings();

  time += 0.016 * dt;
  uTime.value = time;

  // Camera: sinusoidal weave through the string field
  // Overall amplitude and master amplitude drive the wander radius
  const masterAmp = (amps.reduce((s, v) => s + v, 0) / 7) || 0;
  const wander = 3.5 + masterAmp * 3.0;

  camTheta += 0.0006 * dt;
  camPhi   += 0.00039 * dt;

  if (camera) {
    camera.position.x = Math.sin(camTheta * 1.0)  * wander + Math.sin(camTheta * 2.3 + 0.7) * wander * 0.35;
    camera.position.z = Math.cos(camTheta * 0.83) * wander + Math.cos(camTheta * 1.7 + 1.1) * wander * 0.40;
    camera.position.y = 2.5 + Math.sin(camPhi) * 0.9 + masterAmp * 0.4;

    // Gaze toward the field's center — the lookAt target used to be offset
    // in roughly the same radial direction as the camera's own orbital
    // position, so it pointed past the edge of the scattered strings
    // (radius ~11) instead of through them, leaving the field out of view
    // for the entire orbit.
    camera.lookAt(0, 2.8 + masterAmp * 0.3, 0);
  }

  composer?.render();
}

// ── Reset (window resize) ─────────────────────────────────────────────────────

export function resetStringer(): void {
  if (!initialized) return;
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer?.setSize(w, h);
  if (camera) {
    camera.aspect = w / h;
    camera.fov    = fovForAspect(72, camera.aspect);
    camera.updateProjectionMatrix();
  }
  bloomPass?.setSize(w, h);
  composer?.setSize(w, h);
}

// ── Dispose ───────────────────────────────────────────────────────────────────

export function disposeStringer(): void {
  if (!initialized) return;
  vizModeUnsub?.();
  vizModeUnsub = null;
  stringMesh?.geometry.dispose();
  stringMat?.dispose();
  composer?.dispose();
  renderer?.dispose();
  threeCanvas?.remove();
  threeCanvas  = null;
  renderer     = null;
  scene        = null;
  camera       = null;
  composer     = null;
  bloomPass    = null;
  stringMesh   = null;
  stringMat    = null;
  initialized  = false;
  lastStringCount = 0;
  time         = 0;
  camTheta     = 0;
  camPhi       = 0;
}
