/**
 * Torus Knot — Three.js first-person fly-through of a mathematical knot tunnel
 *
 * Inspired by Carlo Séquin's mathematical torus-knot sculptures shown at the
 * Bridges Conference on Mathematics and Arts (2015–2024,
 * https://people.eecs.berkeley.edu/~sequin/SCULPTS/KNOTS/index.html) — physical
 * bronze and steel knotted surfaces that make topology tangible as space you
 * inhabit, not just a diagram you observe.
 *
 * The camera rides the centreline of a (p,q) torus-knot tube on an infinite
 * loop. Seven frequency bands drive radial corrugations (star-shaped
 * cross-section deformation) along successive arc sections of the tunnel, so
 * the walls breathe with the music: bass swells the rear end, brilliance
 * undulates the far horizon. A warm amber key light floats slightly ahead and a
 * cool steel fill trails behind — no rainbow palette, no neon glow, no radial
 * symmetry. Just a physical space where topology and sound become the same thing.
 *
 * Sliders:
 *   Form   — torus-knot topology: (2,3) trefoil → (2,5) → (3,5) → (3,7)
 *   Bore   — tube cross-section radius (narrow corridor → spacious vault)
 *   Speed  — camera flight speed
 */

import * as THREE from 'three';
import { store } from '../state/store';
import { getBandAverages } from './helpers';
import { audioEngine } from '../audio/engine';
import { isMobile } from '../utils/constants';

// ── Module state ──────────────────────────────────────────────────────────────

let initialized   = false;
let threeCanvas:  HTMLCanvasElement | null = null;
let renderer:     THREE.WebGLRenderer | null = null;
let scene:        THREE.Scene | null = null;
let camera:       THREE.PerspectiveCamera | null = null;
let vizModeUnsub: (() => void) | null = null;

let tubeMesh: THREE.Mesh | null = null;
let tubeGeo:  THREE.BufferGeometry | null = null;
let tubeMat:  THREE.ShaderMaterial | null = null;

// Current geometry params — used to detect slider-driven rebuild
let currentP    = 2;
let currentQ    = 3;
let currentBore = 0.5;

const TORUS_RADIUS = 10;

// Camera path state
let camT      = 0;   // 0..1 position along knot path
let fovKick   = 0;   // beat-triggered FOV punch
let lastBeatIndex = -1;

// Smoothed camera up vector for roll-free Frenet transport
const smoothUp = new THREE.Vector3(0, 1, 0);

// Reusable vectors (avoid per-frame allocation)
const _v0 = new THREE.Vector3();
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();

// ── Uniform objects (mutated in place, Three.js reads by reference) ──────────

const uBands:     THREE.IUniform<number[]>       = { value: new Array(7).fill(0) };
const uLightAPos: THREE.IUniform<THREE.Vector3>  = { value: new THREE.Vector3() };
const uLightBPos: THREE.IUniform<THREE.Vector3>  = { value: new THREE.Vector3() };
const uLightACol: THREE.IUniform<THREE.Color>    = { value: new THREE.Color(0xffbb55) };
const uLightBCol: THREE.IUniform<THREE.Color>    = { value: new THREE.Color(0x7799cc) };
const uCamPos:    THREE.IUniform<THREE.Vector3>  = { value: new THREE.Vector3() };
const uBoreMod:   THREE.IUniform<number>         = { value: 0.8 };

const WARM_BASE = new THREE.Color(0xffbb55);
const COOL_BASE = new THREE.Color(0x7799cc);

// ── Shader sources ────────────────────────────────────────────────────────────

const VERTEX_SHADER = /* glsl */`
  uniform float uBands[7];
  uniform float uBoreMod;

  varying vec3  vWorldPos;
  varying vec3  vWorldNormal;
  varying float vBandAmp;
  varying vec2  vUv;

  void main() {
    vUv = uv;

    // Map arc position (uv.x = 0..1 along tube) to smoothed band amplitude
    float arcPos = uv.x * 7.0;
    int   b0     = int(floor(arcPos));
    int   b1     = min(b0 + 1, 6);
    float blend  = fract(arcPos);
    float ba     = mix(uBands[b0], uBands[b1], blend);
    vBandAmp     = ba;

    // Star-shaped corrugation: 6 radial lobes around tube cross-section
    // uv.y goes 0..1 around the tube — one full circumference
    float bump = sin(uv.y * 3.14159 * 12.0); // 6 bumps per circumference
    float disp = ba * uBoreMod * bump * 1.8;

    vec3 displaced = position + normal * disp;

    vWorldPos    = (modelMatrix    * vec4(displaced,  1.0)).xyz;
    vWorldNormal = normalize(normalMatrix * normal);

    gl_Position  = projectionMatrix * modelViewMatrix * vec4(displaced, 1.0);
  }
`;

const FRAGMENT_SHADER = /* glsl */`
  uniform vec3  uCamPos;
  uniform vec3  uLightAPos;
  uniform vec3  uLightBPos;
  uniform vec3  uLightACol;
  uniform vec3  uLightBCol;

  varying vec3  vWorldPos;
  varying vec3  vWorldNormal;
  varying float vBandAmp;
  varying vec2  vUv;

  vec3 phong(vec3 N, vec3 fragPos, vec3 lPos, vec3 lCol, vec3 viewPos) {
    vec3  L    = normalize(lPos - fragPos);
    float dist = length(lPos - fragPos);
    float att  = 1.0 / (1.0 + 0.04 * dist + 0.0018 * dist * dist);
    float diff = max(dot(N, L), 0.0);
    vec3  V    = normalize(viewPos - fragPos);
    vec3  R    = reflect(-L, N);
    float spec = pow(max(dot(R, V), 0.0), 28.0) * 0.30;
    return att * lCol * (diff + spec);
  }

  void main() {
    // For THREE.BackSide, negate normal to face inward toward the camera
    vec3 N = normalize(-vWorldNormal);

    // Subtle procedural micro-texture using UV hash
    float grain = fract(sin(dot(vUv, vec2(127.1, 311.7))) * 43758.5453) * 0.03;

    // Dark basalt: shifts slightly warmer at loud band peaks
    vec3 base = mix(
      vec3(0.065, 0.065, 0.072) + grain,
      vec3(0.18,  0.15,  0.10),
      vBandAmp * 0.55
    );

    // Ambient fill (very dark)
    vec3 color = base * 0.09;

    // Key light (warm, ahead)  +  fill light (cool, behind)
    color += base * phong(N, vWorldPos, uLightAPos, uLightACol, uCamPos);
    color += base * phong(N, vWorldPos, uLightBPos, uLightBCol, uCamPos);

    gl_FragColor = vec4(color, 1.0);
  }
`;

// ── Torus-knot path helpers ───────────────────────────────────────────────────

function knotPoint(t: number, p: number, q: number, r: number, out: THREE.Vector3): THREE.Vector3 {
  const u  = t * Math.PI * 2 * p;
  const qp = (q / p) * u;
  const cs = Math.cos(qp);
  return out.set(
    r * (2 + cs) * 0.5 * Math.cos(u),
    r * (2 + cs) * 0.5 * Math.sin(u),
    r * Math.sin(qp) * 0.5,
  );
}

function formToPQ(form: number): [number, number] {
  if (form < 0.25) return [2, 3];
  if (form < 0.50) return [2, 5];
  if (form < 0.75) return [3, 5];
  return [3, 7];
}

// ── Geometry builder ──────────────────────────────────────────────────────────

function buildGeometry(p: number, q: number, bore: number): THREE.TorusKnotGeometry {
  const tube   = 1.2 + bore * 2.8;                  // 1.2 → 4.0
  const tSeg   = isMobile ? 120 : 240;
  const rSeg   = isMobile ?  16 :  32;
  return new THREE.TorusKnotGeometry(TORUS_RADIUS, tube, tSeg, rSeg, p, q);
}

// ── Setup ─────────────────────────────────────────────────────────────────────

function setup(): void {
  threeCanvas = document.createElement('canvas');
  threeCanvas.style.cssText =
    'position:fixed;top:0;left:0;width:100%;height:100%;z-index:10;pointer-events:none;display:block';
  document.body.appendChild(threeCanvas);

  renderer = new THREE.WebGLRenderer({ canvas: threeCanvas, antialias: !isMobile, alpha: false });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, isMobile ? 1.0 : 1.5));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping       = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x010103);

  camera = new THREE.PerspectiveCamera(90, window.innerWidth / window.innerHeight, 0.1, 200);

  const form           = store.config.torusKnotForm ?? 0.0;
  const bore           = store.config.torusKnotBore ?? 0.5;
  const [p, q]         = formToPQ(form);
  currentP = p; currentQ = q; currentBore = bore;

  tubeGeo = buildGeometry(p, q, bore);
  tubeMat = new THREE.ShaderMaterial({
    vertexShader:   VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    side:           THREE.BackSide,
    uniforms: {
      uBands:     uBands,
      uCamPos:    uCamPos,
      uLightAPos: uLightAPos,
      uLightBPos: uLightBPos,
      uLightACol: uLightACol,
      uLightBCol: uLightBCol,
      uBoreMod:   uBoreMod,
    },
  });
  tubeMesh = new THREE.Mesh(tubeGeo, tubeMat);
  scene.add(tubeMesh);

  vizModeUnsub = store.on('vizModeChange', () => { /* nothing to rebuild on switch */ });

  initialized = true;
}

// ── Geometry rebuild when form/bore sliders move ──────────────────────────────

function rebuildIfNeeded(p: number, q: number, bore: number): void {
  const boreChanged = Math.abs(bore - currentBore) > 0.015;
  if (p === currentP && q === currentQ && !boreChanged) return;

  const old = tubeGeo;
  tubeGeo   = buildGeometry(p, q, bore);
  if (tubeMesh) tubeMesh.geometry = tubeGeo;
  old?.dispose();

  currentP = p; currentQ = q; currentBore = bore;
}

// ── Draw ──────────────────────────────────────────────────────────────────────

export function drawTorusKnot(_p: unknown, dt: number): void {
  if (!initialized) setup();
  if (!renderer || !scene || !camera || !tubeMesh) return;

  const cfg   = store.config;
  const form  = cfg.torusKnotForm  ?? 0.0;
  const bore  = cfg.torusKnotBore  ?? 0.5;
  const speed = cfg.torusKnotSpeed ?? 0.5;

  const [pQ, qQ] = formToPQ(form);
  rebuildIfNeeded(pQ, qQ, bore);

  // Audio
  const { amps } = getBandAverages(7);
  const bassAmp  = amps[1] ?? 0;
  const hiAmp    = (((amps[4] ?? 0) + (amps[5] ?? 0) + (amps[6] ?? 0)) / 3);

  for (let i = 0; i < 7; i++) uBands.value[i] = amps[i] ?? 0;

  // Bore-driven displacement: narrower bore → more pronounced wall deformation
  uBoreMod.value = 0.4 + (1 - bore) * 1.4;

  // Beat detection
  const { state } = store;
  if (state.beatIntervalSec > 0 && state.isPlaying) {
    const pos     = audioEngine.getPlaybackPosition();
    const adj     = pos - state.beatOffset;
    const beatIdx = adj >= 0 ? Math.floor(adj / state.beatIntervalSec) : -1;
    if (beatIdx > lastBeatIndex) {
      lastBeatIndex = beatIdx;
      fovKick       = 1.0;
      uLightACol.value.setRGB(1.0, 0.88, 0.52);  // brief warm flare
    }
  }

  // Decay
  const decay = Math.pow(0.87, dt);
  fovKick    *= decay;
  uLightACol.value.lerp(WARM_BASE, 0.06 * dt);

  // Advance camera along path
  const vel = 0.00025 + speed * 0.0012;
  camT       = (camT + vel * dt) % 1.0;

  // Evaluate torus-knot Frenet frame
  const eps  = 0.008;
  const tPrev = (camT - eps + 1.0) % 1.0;
  const tNext = (camT + eps)       % 1.0;
  const tFar  = (camT + eps * 3)   % 1.0;

  knotPoint(camT,  currentP, currentQ, TORUS_RADIUS, _v0);  // camera pos
  knotPoint(tNext, currentP, currentQ, TORUS_RADIUS, _v1);  // look-at pos
  knotPoint(tPrev, currentP, currentQ, TORUS_RADIUS, _v2);  // prev pos (for tangent)
  knotPoint(tFar,  currentP, currentQ, TORUS_RADIUS, _v3);  // far pos (for curvature)

  const tangent  = new THREE.Vector3().subVectors(_v1, _v2).normalize();
  const tangent2 = new THREE.Vector3().subVectors(_v3, _v1).normalize();
  const curv     = new THREE.Vector3().subVectors(tangent2, tangent).normalize();
  const binormal = new THREE.Vector3().crossVectors(tangent, curv).normalize();

  // Smooth camera up with lerp to avoid flipping on low-curvature sections
  const useUp = binormal.lengthSq() > 0.01 ? binormal : new THREE.Vector3(0, 1, 0);
  smoothUp.lerp(useUp, 0.04 * dt).normalize();

  camera.position.copy(_v0);
  camera.up.copy(smoothUp);
  camera.lookAt(_v1);

  // FOV: base 90° + kick on beat + slight swell with bass
  camera.fov = 90 + fovKick * 18 + bassAmp * 6;
  camera.updateProjectionMatrix();

  // Light positions: warm ahead, cool behind on knot path
  const aheadT  = (camT + 0.06) % 1.0;
  const behindT = (camT - 0.06 + 1.0) % 1.0;
  knotPoint(aheadT,  currentP, currentQ, TORUS_RADIUS, uLightAPos.value);
  knotPoint(behindT, currentP, currentQ, TORUS_RADIUS, uLightBPos.value);
  uCamPos.value.copy(_v0);

  // Cool fill: brightens with high-frequency energy
  uLightBCol.value.copy(COOL_BASE).multiplyScalar(0.4 + hiAmp * 1.6);

  renderer.render(scene, camera);
}

// ── Reset (window resize) ─────────────────────────────────────────────────────

export function resetTorusKnot(): void {
  if (!initialized) return;
  const w = window.innerWidth, h = window.innerHeight;
  renderer?.setSize(w, h);
  if (camera) { camera.aspect = w / h; camera.updateProjectionMatrix(); }
}

// ── Dispose ───────────────────────────────────────────────────────────────────

export function disposeTorusKnot(): void {
  if (!initialized) return;
  vizModeUnsub?.();
  vizModeUnsub = null;
  tubeGeo?.dispose();
  tubeMat?.dispose();
  renderer?.dispose();
  threeCanvas?.remove();
  threeCanvas = null; renderer = null; scene = null; camera = null;
  tubeMesh = null; tubeGeo = null; tubeMat = null;
  camT = 0; fovKick = 0; lastBeatIndex = -1;
  currentP = 2; currentQ = 3; currentBore = 0.5;
  smoothUp.set(0, 1, 0);
  initialized = false;
}
