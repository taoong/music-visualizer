/**
 * Scanfield — Rutt/Etra analog video synthesizer tribute
 *
 * N horizontal scan lines span the field in 3D. Each vertex on a line is
 * Z-displaced by the audio spectrum amplitude at that horizontal position,
 * folding the flat raster into a 3D audio-relief landscape — the same
 * principle as Steve Rutt & Bill Etra's hardware scan processor (1971–73).
 *
 * Inspired by: Rutt/Etra Scan Processor (EAI, New York)
 * https://www.eai.org/titles/rutt-etra-scan-processor
 * Used by Nam June Paik, Steina & Woody Vasulka, and subsequent generations
 * of video synthesis artists.
 *
 * Palette: cold blue-white → phosphor green → warm amber (P1/P3/P31 phosphors).
 * Camera: oblique handheld drift over the scan field, FOV punch on beat.
 * No rainbow per-band hues; no concentric ring pulses; no centre bursts.
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

let initialized = false;
let threeCanvas: HTMLCanvasElement | null = null;
let renderer: THREE.WebGLRenderer | null = null;
let scene: THREE.Scene | null = null;
let camera: THREE.PerspectiveCamera | null = null;
let composer: EffectComposer | null = null;
let scanMesh: THREE.LineSegments | null = null;
let scanMat: THREE.ShaderMaterial | null = null;
let vizModeUnsub: (() => void) | null = null;

let time = 0;
let lastBeatIndex = -1;
let beatFovKick = 0;
const BASE_FOV = isMobile ? 62 : 52;

// Geometry constants — fixed at setup time
const MAX_ROWS = isMobile ? 40 : 80;
const COLS     = isMobile ? 96 : 192;

// Uniforms mutated every frame
const uBands:      THREE.IUniform<number[]> = { value: new Array(7).fill(0) };
const uTime:       THREE.IUniform<number>   = { value: 0 };
const uDepth:      THREE.IUniform<number>   = { value: 0.6 };
const uWarmth:     THREE.IUniform<number>   = { value: 0.4 };
const uGlow:       THREE.IUniform<number>   = { value: 0.5 };
const uMaxRowFrac: THREE.IUniform<number>   = { value: 1.0 };
const uBeatFlash:  THREE.IUniform<number>   = { value: 0 };

// ── GLSL ──────────────────────────────────────────────────────────────────────

const VERTEX_SHADER = /* glsl */`
  attribute float aBandT;    // 0..1 horizontal position → band selector
  attribute float aRowNorm;  // 0..1 vertical row position

  uniform float uBands[7];
  uniform float uTime;
  uniform float uDepth;
  uniform float uMaxRowFrac;

  varying float vBandAmp;

  float sampleBands(float t) {
    float fi = t * 6.0;
    int i0 = clamp(int(floor(fi)), 0, 6);
    int i1 = clamp(i0 + 1, 0, 6);
    return mix(uBands[i0], uBands[i1], fract(fi));
  }

  void main() {
    // Rows beyond the Lines slider are clipped away
    if (aRowNorm > uMaxRowFrac + 0.001) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      vBandAmp = 0.0;
      return;
    }

    float bandAmp = sampleBands(aBandT);

    // Per-row shimmer: each row oscillates with a unique phase
    float shimmer = sin(aRowNorm * 53.7 + uTime * 2.1) * 0.025;
    float z = (bandAmp + shimmer) * uDepth * 16.0;

    vBandAmp = bandAmp;

    gl_Position = projectionMatrix * modelViewMatrix * vec4(position.x, position.y, z, 1.0);
  }
`;

const FRAGMENT_SHADER = /* glsl */`
  uniform float uWarmth;
  uniform float uGlow;
  uniform float uBeatFlash;

  varying float vBandAmp;

  void main() {
    // Three phosphor palette extremes
    vec3 coldBlue      = vec3(0.22, 0.58, 1.00);  // P7 (blue-white CRT)
    vec3 phosphorGreen = vec3(0.10, 1.00, 0.42);  // P31 (classic green)
    vec3 phosphorAmber = vec3(1.00, 0.64, 0.06);  // P3  (amber)

    vec3 color;
    if (uWarmth < 0.5) {
      color = mix(coldBlue, phosphorGreen, uWarmth * 2.0);
    } else {
      color = mix(phosphorGreen, phosphorAmber, (uWarmth - 0.5) * 2.0);
    }

    float bright = 0.10 + vBandAmp * (0.5 + uGlow * 0.5) + uBeatFlash * 0.20;
    float alpha  = clamp(bright * 1.4, 0.0, 1.0);
    gl_FragColor = vec4(color * bright, alpha);
  }
`;

// ── Geometry builder ──────────────────────────────────────────────────────────

function buildGeometry(): THREE.BufferGeometry {
  const W = 52.0;
  const H = 22.0;

  const nVerts = MAX_ROWS * COLS;
  const positions = new Float32Array(nVerts * 3);
  const aBandT    = new Float32Array(nVerts);
  const aRowNorm  = new Float32Array(nVerts);
  const indices: number[] = [];

  for (let r = 0; r < MAX_ROWS; r++) {
    const rowNorm = r / (MAX_ROWS - 1);
    const y = -H / 2 + rowNorm * H;
    for (let c = 0; c < COLS; c++) {
      const bandT = c / (COLS - 1);
      const x = -W / 2 + bandT * W;
      const vi = r * COLS + c;
      positions[vi * 3    ] = x;
      positions[vi * 3 + 1] = y;
      positions[vi * 3 + 2] = 0;
      aBandT[vi]   = bandT;
      aRowNorm[vi] = rowNorm;
      if (c < COLS - 1) {
        indices.push(vi, vi + 1);
      }
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('aBandT',   new THREE.BufferAttribute(aBandT,   1));
  geo.setAttribute('aRowNorm', new THREE.BufferAttribute(aRowNorm, 1));
  geo.setIndex(indices);
  return geo;
}

// ── Setup ─────────────────────────────────────────────────────────────────────

function setup(): void {
  threeCanvas = document.createElement('canvas');
  threeCanvas.style.cssText =
    'position:fixed;top:0;left:0;width:100%;height:100%;z-index:10;pointer-events:none;display:block';
  document.body.appendChild(threeCanvas);

  renderer = new THREE.WebGLRenderer({ canvas: threeCanvas, antialias: !isMobile, alpha: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, isMobile ? 1 : 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);

  camera = new THREE.PerspectiveCamera(BASE_FOV, window.innerWidth / window.innerHeight, 0.1, 300);
  camera.position.set(0, 14, 32);
  camera.lookAt(0, 1, -2);

  const geo = buildGeometry();
  scanMat = new THREE.ShaderMaterial({
    vertexShader:   VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    uniforms: {
      uBands:      uBands,
      uTime:       uTime,
      uDepth:      uDepth,
      uWarmth:     uWarmth,
      uGlow:       uGlow,
      uMaxRowFrac: uMaxRowFrac,
      uBeatFlash:  uBeatFlash,
    },
    transparent: true,
    depthWrite:  false,
  });
  scanMesh = new THREE.LineSegments(geo, scanMat);
  scene.add(scanMesh);

  const res = new THREE.Vector2(window.innerWidth, window.innerHeight);
  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene!, camera));
  const bloom = new UnrealBloomPass(res, 0.9, 0.6, 0.05);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  vizModeUnsub = store.on('vizModeChange', (data) => {
    if (!threeCanvas) return;
    threeCanvas.style.display = (data === 'scanfield') ? 'block' : 'none';
  });

  initialized = true;
}

// ── Draw ──────────────────────────────────────────────────────────────────────

export function drawScanfield(_p: unknown, dt: number): void {
  if (!initialized) setup();

  time += dt * 0.016;

  const { amps } = getBandAverages(7);
  const overall = amps.reduce((s, v) => s + v, 0) / 7;

  uBands.value = amps.slice();
  uTime.value  = time;

  const cfg = store.config;
  uDepth.value  = cfg.scanfieldDepth;
  uWarmth.value = cfg.scanfieldWarmth;
  uGlow.value   = cfg.scanfieldGlow;

  // Lines slider 0..1 → fraction of MAX_ROWS to render
  uMaxRowFrac.value = 0.25 + cfg.scanfieldLines * 0.75;

  // Beat detection
  const { state } = store;
  if (state.beatIntervalSec > 0 && state.isPlaying) {
    const pos     = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    const beatIdx  = adjusted >= 0 ? Math.floor(adjusted / state.beatIntervalSec) : -1;
    if (beatIdx > lastBeatIndex) {
      lastBeatIndex = beatIdx;
      beatFovKick   = 1.0;
    }
  }

  beatFovKick *= Math.pow(0.88, dt);
  uBeatFlash.value = beatFovKick;

  // Camera: slow handheld drift, with FOV punch on beat
  if (camera) {
    const swayX = Math.sin(time * 0.13) * 3.2;
    const swayY = Math.sin(time * 0.087 + 1.1) * 1.4;
    camera.position.set(swayX, 14 + swayY, 32 - overall * 3.5);
    camera.lookAt(0, 1, -2);
    camera.fov = BASE_FOV - beatFovKick * 7;
    camera.updateProjectionMatrix();
  }

  // Update bloom strength with glow slider + overall audio
  if (composer) {
    const bloomPass = composer.passes[1] as InstanceType<typeof UnrealBloomPass>;
    if (bloomPass) bloomPass.strength = 0.5 + cfg.scanfieldGlow * 0.8 + overall * 0.6;
    composer.render();
  }
}

// ── Reset ─────────────────────────────────────────────────────────────────────

export function resetScanfield(): void {
  if (!initialized) return;
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer?.setSize(w, h);
  if (camera) { camera.aspect = w / h; camera.updateProjectionMatrix(); }
  composer?.setSize(w, h);
}

// ── Dispose ───────────────────────────────────────────────────────────────────

export function disposeScanfield(): void {
  if (!initialized) return;
  vizModeUnsub?.();
  vizModeUnsub = null;
  scanMesh?.geometry.dispose();
  scanMat?.dispose();
  composer?.dispose();
  renderer?.dispose();
  threeCanvas?.remove();
  threeCanvas    = null;
  renderer       = null;
  scene          = null;
  camera         = null;
  composer       = null;
  scanMesh       = null;
  scanMat        = null;
  time           = 0;
  lastBeatIndex  = -1;
  beatFovKick    = 0;
  initialized    = false;
}
