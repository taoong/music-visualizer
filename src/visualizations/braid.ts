/**
 * Braid — 3D helical fiber strands, Three.js WebGL overlay
 * Inspired by Sheila Hicks "Escalade Beyond Chromatic Lands"
 * (2016–17, 57th Venice Biennale, Arsenale Corderie)
 * https://www.nasjonalmuseet.no/en/collection/object/NMK.LAAN.2020.0016
 */
import * as THREE from 'three';
import { store } from '../state/store';
import { getBandAverages } from './helpers';
import { audioEngine } from '../audio/engine';
import { isMobile } from '../utils/constants';

// ── Shaders ───────────────────────────────────────────────────────────────────

const VERT = /* glsl */`
  uniform float uTwistRate;
  uniform float uHelixRadius;
  uniform float uPhaseOffset;
  uniform float uAmp;
  uniform float uBaseTubeRadius;
  uniform float uAmplitudeScale;

  varying vec3 vWorldPos;
  varying vec3 vWorldNormal;

  void main() {
    // position.y ∈ [-1, 1], position.x/z = unit circle cross-section
    float t = (position.y + 1.0) * 0.5;
    float angle = t * uTwistRate * 6.28318 + uPhaseOffset;
    float ca = cos(angle); float sa = sin(angle);
    // Tangent of helix (derivative wrt normalised height t → divide by 2)
    vec3 tang = normalize(vec3(
      -uHelixRadius * sa * uTwistRate * 6.28318 * 0.5,
      1.0,
       uHelixRadius * ca * uTwistRate * 6.28318 * 0.5
    ));
    vec3 worldUp = vec3(0.0, 1.0, 0.0);
    vec3 bn = normalize(cross(tang, worldUp)); // binormal
    vec3 nm = normalize(cross(bn, tang));      // normal to tang

    vec3 helixCenter = vec3(uHelixRadius * ca, position.y, uHelixRadius * sa);
    float tubeRad = uBaseTubeRadius * (1.0 + uAmp * uAmplitudeScale);
    vec3 localPos    = helixCenter + position.x * tubeRad * bn + position.z * tubeRad * nm;
    vec3 localNormal = normalize(position.x * bn + position.z * nm);

    vec4 worldPos4 = modelMatrix * vec4(localPos, 1.0);
    vWorldPos    = worldPos4.xyz;
    vWorldNormal = normalize(mat3(modelMatrix) * localNormal);

    gl_Position = projectionMatrix * viewMatrix * worldPos4;
  }
`;

const FRAG = /* glsl */`
  uniform vec3  uColor;
  uniform vec3  uKeyDir;
  uniform vec3  uKeyColor;
  uniform float uKeyIntensity;
  uniform vec3  uFillDir;
  uniform vec3  uFillColor;
  uniform vec3  uAmbient;
  uniform float uAmp;
  uniform float uRoughness;

  varying vec3 vWorldPos;
  varying vec3 vWorldNormal;

  void main() {
    vec3 N = normalize(vWorldNormal);
    vec3 V = normalize(cameraPosition - vWorldPos);

    float diffK = max(dot(N, uKeyDir), 0.0);
    vec3  H     = normalize(uKeyDir + V);
    float gloss = pow(2.0, (1.0 - uRoughness) * 6.0 + 2.0);
    float specK = pow(max(dot(N, H), 0.0), gloss) * (1.0 - uRoughness) * 0.45;

    float diffF = max(dot(N, uFillDir), 0.0) * 0.45;

    vec3 col = uColor * (uAmbient + diffK * uKeyColor * uKeyIntensity + diffF * uFillColor)
             + uKeyColor * specK * uKeyIntensity
             + uColor * uAmp * 0.12;

    gl_FragColor = vec4(col, 1.0);
  }
`;

// ── Palette — warm natural fibers, not rainbow ────────────────────────────────

const STRAND_COLORS = [
  new THREE.Color(0.80, 0.60, 0.35), // warm linen
  new THREE.Color(0.70, 0.28, 0.12), // terracotta
  new THREE.Color(0.82, 0.70, 0.28), // golden ochre
  new THREE.Color(0.22, 0.32, 0.55), // indigo
  new THREE.Color(0.40, 0.40, 0.40), // warm grey
  new THREE.Color(0.50, 0.58, 0.38), // sage
  new THREE.Color(0.62, 0.22, 0.28), // muted crimson
];

// ── Shared lighting uniforms (updated once per frame) ────────────────────────

const uKeyDir   = { value: new THREE.Vector3(0.45, 0.78, 0.44).normalize() };
const uKeyColor = { value: new THREE.Color(1.0, 0.85, 0.52) };
const uKeyIntensity: THREE.IUniform<number> = { value: 2.6 };
const uFillDir  = { value: new THREE.Vector3(-0.6, 0.3, -0.5).normalize() };
const uFillColor = { value: new THREE.Color(0.55, 0.65, 0.80) };
const uAmbient  = { value: new THREE.Color(0.12, 0.08, 0.04) };

// ── Module state ──────────────────────────────────────────────────────────────

interface StrandEntry {
  mesh: THREE.Mesh;
  geo: THREE.BufferGeometry;
  mat: THREE.ShaderMaterial;
  uAmp: THREE.IUniform<number>;
  uTwistRate: THREE.IUniform<number>;
  uAmplitudeScale: THREE.IUniform<number>;
}

let threeCanvas: HTMLCanvasElement | null = null;
let renderer: THREE.WebGLRenderer | null = null;
let scene: THREE.Scene | null = null;
let camera: THREE.PerspectiveCamera | null = null;
let vizModeUnsub: (() => void) | null = null;
let initialized = false;

let strands: StrandEntry[] = [];
let currentStrandCount = 0;

let cameraTheta = 0;
let lastBeatIndex = -1;
let beatFlash = 0;

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildStrands(count: number): void {
  if (!scene) return;
  disposeStrands();

  const helixRadius  = 0.42;
  const baseTubeRad  = isMobile ? 0.11 : 0.10;
  const tubularSegs  = isMobile ? 60 : 120;
  const radialSegs   = isMobile ? 5  : 8;

  for (let k = 0; k < count; k++) {
    const phaseOffset = (k / count) * Math.PI * 2;

    const uAmp: THREE.IUniform<number>           = { value: 0.0 };
    const uTwistRate: THREE.IUniform<number>     = { value: 2.5 };
    const uAmplitudeScale: THREE.IUniform<number> = { value: 0.6 };

    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uTwistRate,
        uHelixRadius:    { value: helixRadius },
        uPhaseOffset:    { value: phaseOffset },
        uAmp,
        uBaseTubeRadius: { value: baseTubeRad },
        uAmplitudeScale,
        uColor:          { value: STRAND_COLORS[k % STRAND_COLORS.length].clone() },
        uKeyDir,
        uKeyColor,
        uKeyIntensity,
        uFillDir,
        uFillColor,
        uAmbient,
        uRoughness:      { value: 0.68 },
      },
      vertexShader:   VERT,
      fragmentShader: FRAG,
      side: THREE.FrontSide,
    });

    // CylinderGeometry(r, r, height, radSeg, hSeg, openEnded)
    // height = 2 so position.y ∈ [-1, 1] — matches shader assumption
    const geo = new THREE.CylinderGeometry(1, 1, 2, radialSegs, tubularSegs, true);
    const mesh = new THREE.Mesh(geo, mat);
    scene.add(mesh);

    strands.push({ mesh, geo, mat, uAmp, uTwistRate, uAmplitudeScale });
  }

  currentStrandCount = count;
}

function disposeStrands(): void {
  for (const s of strands) {
    scene?.remove(s.mesh);
    s.geo.dispose();
    s.mat.dispose();
  }
  strands = [];
  currentStrandCount = 0;
}

// ── Setup ─────────────────────────────────────────────────────────────────────

function setup(): void {
  threeCanvas = document.createElement('canvas');
  threeCanvas.style.cssText =
    'position:fixed;top:0;left:0;width:100%;height:100%;z-index:10;pointer-events:none;display:block';
  document.body.appendChild(threeCanvas);

  renderer = new THREE.WebGLRenderer({
    canvas: threeCanvas,
    antialias: !isMobile,
    alpha: false,
  });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, isMobile ? 1.0 : 2.0));
  renderer.toneMapping       = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  renderer.outputColorSpace  = THREE.SRGBColorSpace;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x080604);
  scene.fog        = new THREE.FogExp2(0x080604, 0.09);

  camera = new THREE.PerspectiveCamera(52, window.innerWidth / window.innerHeight, 0.05, 60);

  vizModeUnsub = store.on('vizModeChange', () => {
    const w = window.innerWidth, h = window.innerHeight;
    renderer?.setSize(w, h);
    if (camera) { camera.aspect = w / h; camera.updateProjectionMatrix(); }
  });

  initialized = true;
}

// ── Public API ────────────────────────────────────────────────────────────────

export function drawBraid(_p: unknown, dt: number): void {
  if (!initialized) setup();
  if (!renderer || !scene || !camera) return;

  const { config, state } = store;
  const { amps } = getBandAverages(7);

  // Rebuild strands when count changes
  const desiredCount = Math.max(3, Math.min(7, Math.round(3 + config.braidStrands * 4)));
  if (desiredCount !== currentStrandCount) {
    buildStrands(desiredCount);
  }

  // Per-frame uniform updates
  const ampScale = config.braidTension * 0.8;
  const twist    = config.braidTwist * 6.5 + 1.0; // 1 – 7.5 turns
  for (let k = 0; k < strands.length; k++) {
    const s = strands[k];
    s.uAmp.value           = amps[k % 7] * 0.6;
    s.uTwistRate.value     = twist;
    s.uAmplitudeScale.value = ampScale;
  }

  // Beat detection
  if (state.beatIntervalSec > 0 && state.isPlaying) {
    const pos      = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    const beatIdx  = adjusted >= 0 ? Math.floor(adjusted / state.beatIntervalSec) : -1;
    if (beatIdx > lastBeatIndex) {
      lastBeatIndex = beatIdx;
      beatFlash = 1.0;
    }
  }

  // Decay beat flash
  const flashDecay = Math.pow(0.85, dt);
  beatFlash *= flashDecay;
  uKeyIntensity.value = 2.6 + beatFlash * 1.8;

  // Camera orbit
  const orbitSpeed = config.braidOrbit * 0.003 * dt;
  cameraTheta += orbitSpeed;

  const camR   = 4.2;
  const camH   = 0.5 + Math.sin(cameraTheta * 0.23) * 0.35;
  const tiltBob = beatFlash * 0.015 * Math.sin(cameraTheta * 29);

  camera.position.set(
    camR * Math.sin(cameraTheta),
    camH + tiltBob,
    camR * Math.cos(cameraTheta),
  );
  camera.lookAt(0, 0, 0);

  renderer.render(scene, camera);
}

export function resetBraid(): void {
  if (!initialized) return;
  const w = window.innerWidth, h = window.innerHeight;
  renderer?.setSize(w, h);
  if (camera) { camera.aspect = w / h; camera.updateProjectionMatrix(); }
  lastBeatIndex = -1;
  beatFlash     = 0;
}

export function disposeBraid(): void {
  if (!initialized) return;
  vizModeUnsub?.();
  vizModeUnsub = null;
  disposeStrands();
  renderer?.dispose();
  threeCanvas?.remove();
  threeCanvas = null;
  renderer    = null;
  scene       = null;
  camera      = null;
  cameraTheta   = 0;
  lastBeatIndex = -1;
  beatFlash     = 0;
  initialized   = false;
}
