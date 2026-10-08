/**
 * Dome — Geodesic Dome Interior
 *
 * Camera floats inside a luminous icosahedral sphere; 7 azimuthal zones of
 * triangular faces each respond to a different frequency band, warming and
 * cooling with the music.  Structural edge lines trace the geodesic lattice.
 * Restrained warm-amber → cool-sapphire palette controlled by a single slider.
 * No neon-additive overlay — just genuine face emissive driven by audio.
 *
 * Inspired by Olafur Eliasson "The Sky" (2022) — geodesic dome interior
 * flooded with spectrally-separated coloured light panels — and by
 * R. Buckminster Fuller's Biosphere (Montréal, 1967) geodesic architecture.
 * https://olafureliasson.net/  /  https://www.biosphere.ca/
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

let initialized  = false;
let threeCanvas  : HTMLCanvasElement | null = null;
let renderer     : THREE.WebGLRenderer | null = null;
let scene        : THREE.Scene | null = null;
let camera       : THREE.PerspectiveCamera | null = null;
let composer     : EffectComposer | null = null;
let domeMesh     : THREE.Mesh | null = null;
let domeMat      : THREE.ShaderMaterial | null = null;
let domeGeo      : THREE.BufferGeometry | null = null;
let edgeMesh     : THREE.LineSegments | null = null;
let edgeGeo      : THREE.BufferGeometry | null = null;
let vizModeUnsub : (() => void) | null = null;

let time         = 0;
let lastBeatIdx  = -1;
let beatFlash    = 0.0;
let cameraTheta  = 0.0;
let cameraPhi    = Math.PI * 0.38;  // elevation from top
let builtDetail  = -1;

// ── Uniforms ──────────────────────────────────────────────────────────────────

const uBands    : THREE.IUniform<number[]> = { value: new Array(7).fill(0) };
const uBeatFlash: THREE.IUniform<number>   = { value: 0.0 };
const uPalette  : THREE.IUniform<number>   = { value: 0.0 };
const uGlow     : THREE.IUniform<number>   = { value: 1.0 };

// ── Shaders ───────────────────────────────────────────────────────────────────

const VERT = /* glsl */`
  attribute float aBand;
  varying float vBand;
  varying vec3  vNormal;
  void main() {
    vBand   = aBand;
    vNormal = normalize(normalMatrix * normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FRAG = /* glsl */`
  uniform float uBands[7];
  uniform float uPalette;
  uniform float uGlow;
  uniform float uBeatFlash;
  varying float vBand;
  varying vec3  vNormal;

  // Warm-amber (left) to cool-sapphire (right) palette — 7 steps
  vec3 bandColor(int i) {
    vec3 w, c;
    if      (i == 0) { w = vec3(1.00,0.38,0.04); c = vec3(0.06,0.12,0.82); }
    else if (i == 1) { w = vec3(1.00,0.62,0.08); c = vec3(0.10,0.26,0.98); }
    else if (i == 2) { w = vec3(0.98,0.84,0.22); c = vec3(0.18,0.52,1.00); }
    else if (i == 3) { w = vec3(0.94,0.96,0.90); c = vec3(0.72,0.86,1.00); }
    else if (i == 4) { w = vec3(0.62,0.88,0.98); c = vec3(0.88,0.94,1.00); }
    else if (i == 5) { w = vec3(0.28,0.56,1.00); c = vec3(0.76,0.60,0.96); }
    else             { w = vec3(0.14,0.28,0.90); c = vec3(0.50,0.12,0.80); }
    return mix(w, c, uPalette);
  }

  float getBand(int i) {
    if (i == 0) return uBands[0];
    if (i == 1) return uBands[1];
    if (i == 2) return uBands[2];
    if (i == 3) return uBands[3];
    if (i == 4) return uBands[4];
    if (i == 5) return uBands[5];
    return uBands[6];
  }

  void main() {
    int   idx  = int(vBand);
    float amp  = getBand(idx);
    vec3  col  = bandColor(idx);

    // minimal structure ambient
    float ambient  = 0.035;
    // audio-driven emissive
    float emissive = amp * uGlow * 0.32;
    // beat flash: warm white surge across entire dome
    float flash    = uBeatFlash * 0.18;
    // subtle normal shading for face depth (virtual top-left key light)
    vec3  ld       = normalize(vec3(0.4, 1.0, 0.6));
    float diffuse  = max(0.0, dot(vNormal, ld)) * 0.10;

    float bright = ambient + emissive + flash + diffuse;
    // On beat, flash toward warm white
    vec3  flashCol = mix(col, vec3(1.0, 0.96, 0.88), flash * 1.2);
    gl_FragColor = vec4(flashCol * bright, 1.0);
  }
`;

// ── Geometry helpers ──────────────────────────────────────────────────────────

function densityToDetail(d: number): number {
  if (d < 0.34) return 1;
  if (d < 0.67) return isMobile ? 1 : 2;
  return isMobile ? 1 : 3;
}

function buildDomeGeometry(detail: number): THREE.BufferGeometry {
  const sphere = new THREE.IcosahedronGeometry(10, detail);
  const geo    = sphere.toNonIndexed();
  sphere.dispose();

  // Flip normals inward so interior faces are lit
  const norms = geo.getAttribute('normal') as THREE.BufferAttribute;
  for (let i = 0; i < norms.count; i++) {
    norms.setXYZ(i, -norms.getX(i), -norms.getY(i), -norms.getZ(i));
  }
  norms.needsUpdate = true;

  // Per-face band assignment: azimuthal angle of centroid → band 0-6
  const pos       = geo.getAttribute('position') as THREE.BufferAttribute;
  const faceCount = pos.count / 3;
  const aBand     = new Float32Array(pos.count);
  for (let f = 0; f < faceCount; f++) {
    const vi = f * 3;
    const cx = (pos.getX(vi) + pos.getX(vi + 1) + pos.getX(vi + 2)) / 3;
    const cz = (pos.getZ(vi) + pos.getZ(vi + 1) + pos.getZ(vi + 2)) / 3;
    const az = (Math.atan2(cx, cz) + Math.PI) / (2 * Math.PI); // 0..1
    const b  = Math.floor(az * 7) % 7;
    aBand[vi] = b; aBand[vi + 1] = b; aBand[vi + 2] = b;
  }
  geo.setAttribute('aBand', new THREE.BufferAttribute(aBand, 1));
  return geo;
}

// ── Scene setup ───────────────────────────────────────────────────────────────

function setup(): void {
  threeCanvas = document.createElement('canvas');
  threeCanvas.style.cssText =
    'position:fixed;top:0;left:0;width:100%;height:100%;z-index:10;pointer-events:none;display:block';
  document.body.appendChild(threeCanvas);

  renderer = new THREE.WebGLRenderer({ canvas: threeCanvas, antialias: !isMobile, alpha: false });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, isMobile ? 1 : 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x010101);

  camera = new THREE.PerspectiveCamera(80, window.innerWidth / window.innerHeight, 0.1, 100);
  camera.position.set(0, 0, 0);

  const detail = densityToDetail(store.config.domeDensity);
  builtDetail  = detail;
  domeGeo      = buildDomeGeometry(detail);

  domeMat = new THREE.ShaderMaterial({
    vertexShader:   VERT,
    fragmentShader: FRAG,
    uniforms: { uBands, uBeatFlash, uPalette, uGlow },
    side: THREE.BackSide,
  });

  domeMesh = new THREE.Mesh(domeGeo, domeMat);
  scene.add(domeMesh);

  // Thin structural edges — barely visible, pure geometry reference
  edgeGeo  = new THREE.EdgesGeometry(domeGeo);
  edgeMesh = new THREE.LineSegments(
    edgeGeo,
    new THREE.LineBasicMaterial({ color: 0x1c1c1c })
  );
  scene.add(edgeMesh);

  // Post-processing chain
  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  if (!isMobile) {
    const res = new THREE.Vector2(window.innerWidth, window.innerHeight);
    composer.addPass(new UnrealBloomPass(res, 0.25, 0.45, 0.5));
  }
  composer.addPass(new OutputPass());

  vizModeUnsub = store.on('vizModeChange', (data) => {
    if (threeCanvas) threeCanvas.style.display = data === 'dome' ? 'block' : 'none';
  });

  initialized = true;
}

// ── Geometry rebuild (structural slider) ──────────────────────────────────────

function rebuildGeometry(detail: number): void {
  if (!domeMesh || !edgeMesh) return;
  domeGeo?.dispose();
  edgeGeo?.dispose();
  domeGeo        = buildDomeGeometry(detail);
  edgeGeo        = new THREE.EdgesGeometry(domeGeo);
  domeMesh.geometry = domeGeo;
  edgeMesh.geometry = edgeGeo;
  builtDetail    = detail;
}

// ── Draw ──────────────────────────────────────────────────────────────────────

export function drawDome(_p: unknown, dt: number): void {
  if (!initialized) setup();
  if (!renderer || !scene || !camera || !composer) return;

  time += dt;

  // ── Audio ──────────────────────────────────────────────────────────────────
  const { amps, transients } = getBandAverages(7);
  const appState  = store.state;
  const overallAmp = amps.reduce((s, a) => s + a, 0) / 7;

  // Beat detection
  if (appState.beatIntervalSec > 0 && appState.isPlaying) {
    const pos     = audioEngine.getPlaybackPosition();
    const adj     = pos - appState.beatOffset;
    const beatIdx = adj >= 0 ? Math.floor(adj / appState.beatIntervalSec) : -1;
    if (beatIdx > lastBeatIdx) {
      lastBeatIdx = beatIdx;
      beatFlash   = 1.0;
    }
  }
  // Transient accent
  const maxTrans = Math.max(...transients);
  if (maxTrans > 1.8) beatFlash = Math.max(beatFlash, 0.35);
  beatFlash *= Math.pow(0.88, dt);

  // ── Config ─────────────────────────────────────────────────────────────────
  const density    = store.config.domeDensity;
  const paletteVal = store.config.domePalette;
  const glowVal    = store.config.domeGlow;

  // Structural rebuild if density changed
  const targetDetail = densityToDetail(density);
  if (targetDetail !== builtDetail) rebuildGeometry(targetDetail);

  // Update uniforms
  uBands.value     = amps;
  uBeatFlash.value = beatFlash;
  uPalette.value   = paletteVal;
  uGlow.value      = 0.25 + glowVal * 1.75;

  // Bloom strength follows glow slider
  if (!isMobile && composer.passes.length >= 3) {
    const bp = composer.passes[1] as InstanceType<typeof UnrealBloomPass>;
    if (bp) bp.strength = 0.15 + glowVal * 0.8;
  }

  // ── Camera ─────────────────────────────────────────────────────────────────
  // Slow azimuthal orbit inside the dome; elevation breathes with bass
  const orbitRate = 0.006 + overallAmp * 0.003;
  cameraTheta += orbitRate * dt;

  // Elevation oscillates gently; bass pulls view slightly downward
  const bassAmp  = amps[1] ?? 0;
  cameraPhi = Math.PI * 0.36 + Math.sin(time * 0.003) * 0.22 + bassAmp * 0.12;

  const sinPhi = Math.sin(cameraPhi);
  const cosPhi = Math.cos(cameraPhi);
  const lx = Math.sin(cameraTheta) * sinPhi;
  const ly = cosPhi;
  const lz = Math.cos(cameraTheta) * sinPhi;

  // Subtle beat shake perpendicular to look direction
  const shake = beatFlash * 0.12;
  camera.position.set(
    shake * Math.cos(cameraTheta),
    shake * 0.3,
    shake * -Math.sin(cameraTheta)
  );
  camera.lookAt(lx * 9, ly * 9, lz * 9);

  // Slight FOV pulse on beat for a sense of impact
  camera.fov = 80 + beatFlash * 8;
  camera.updateProjectionMatrix();

  // ── Render ─────────────────────────────────────────────────────────────────
  composer.render();
}

// ── Reset ─────────────────────────────────────────────────────────────────────

export function resetDome(): void {
  if (!initialized) return;
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer?.setSize(w, h);
  if (camera) { camera.aspect = w / h; camera.updateProjectionMatrix(); }
  composer?.setSize(w, h);
}

// ── Dispose ───────────────────────────────────────────────────────────────────

export function disposeDome(): void {
  if (!initialized) return;
  vizModeUnsub?.();
  vizModeUnsub = null;
  domeGeo?.dispose();
  edgeGeo?.dispose();
  domeMat?.dispose();
  if (edgeMesh?.material instanceof THREE.Material) edgeMesh.material.dispose();
  composer?.dispose();
  renderer?.dispose();
  threeCanvas?.remove();
  threeCanvas   = null; renderer  = null; scene     = null;
  camera        = null; composer  = null;
  domeMesh      = null; edgeMesh  = null;
  domeGeo       = null; edgeGeo   = null; domeMat = null;
  time = 0; lastBeatIdx = -1; beatFlash = 0;
  cameraTheta = 0; cameraPhi = Math.PI * 0.38; builtDetail = -1;
  initialized = false;
}
