/**
 * Sculpture — Three.js WebGL overlay visualization
 * User image (or procedural gradient) mapped onto a 3D sphere with
 * audio-reactive vertex displacement. On each beat the camera smoothly
 * transitions to a new position around the sculpture, always looking at center.
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { getUserImageUrl } from './userImage';

// ── Constants ─────────────────────────────────────────────────────────────────

const SPHERE_RADIUS   = 20;
const SPHERE_SEGMENTS = 64;
const CAMERA_DIST     = 55;       // distance from center
const CAMERA_LERP     = 0.04;     // per-frame lerp speed (dt-normalized)
const DISPLACE_SCALE  = 6;        // max vertex displacement from audio
const PULSE_SCALE     = 3;        // bass pulse scale addition
const BASE_EMISSIVE   = 0.15;

// Pre-defined camera orbit positions (spherical: theta, phi) — avoids poles
const CAMERA_PRESETS: [number, number][] = [];
{
  const phiSteps  = [0.4, 0.6, 0.8, 1.0, 1.2, 1.4, 1.6, 1.8, 2.0, 2.2, 2.4, 2.7];
  const thetaSteps = [0, 0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 4.5, 5.0, 5.5];
  for (const phi of phiSteps) {
    for (const theta of thetaSteps) {
      CAMERA_PRESETS.push([theta, phi]);
    }
  }
}

// ── Module state ──────────────────────────────────────────────────────────────

let initialized    = false;
let threeCanvas    : HTMLCanvasElement | null = null;
let renderer       : THREE.WebGLRenderer | null = null;
let scene          : THREE.Scene | null = null;
let camera         : THREE.PerspectiveCamera | null = null;
let composer       : EffectComposer | null = null;
let vizModeUnsub   : (() => void) | null = null;
let imageUnsub     : (() => void) | null = null;

let sphereMesh     : THREE.Mesh | null = null;
let sphereMat      : THREE.MeshStandardMaterial | null = null;
let sphereGeo      : THREE.SphereGeometry | null = null;
let basePositions  : Float32Array | null = null;   // original vertex positions
let imageTexture   : THREE.Texture | null = null;

// Camera animation
let currentCamTheta = 1.0;
let currentCamPhi   = 1.2;
let targetCamTheta  = 1.0;
let targetCamPhi    = 1.2;
let lastBeatIndex   = -1;
let lastPresetIndex = -1;

// Audio smoothing
let smoothedBass  = 0;
let smoothedTotal = 0;

// ── Setup ─────────────────────────────────────────────────────────────────────

function setup(): void {
  // Overlay canvas
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
  scene.background = new THREE.Color(0x050510);

  // Camera
  camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 500);
  updateCameraPosition(1.0);  // instant

  // Lights
  scene.add(new THREE.AmbientLight(0x333344, 0.6));
  const keyLight = new THREE.PointLight(0xffffff, 1.8, 200);
  keyLight.position.set(30, 40, 30);
  scene.add(keyLight);
  const fillLight = new THREE.PointLight(0x4466ff, 0.8, 200);
  fillLight.position.set(-30, -10, -30);
  scene.add(fillLight);
  const rimLight = new THREE.PointLight(0xff4488, 0.6, 200);
  rimLight.position.set(0, -30, 40);
  scene.add(rimLight);

  // Sphere
  sphereGeo = new THREE.SphereGeometry(SPHERE_RADIUS, SPHERE_SEGMENTS, SPHERE_SEGMENTS);
  basePositions = new Float32Array(sphereGeo.attributes['position'].array);

  sphereMat = new THREE.MeshStandardMaterial({
    color: 0x8844ff,
    emissive: 0x221144,
    emissiveIntensity: BASE_EMISSIVE,
    metalness: 0.3,
    roughness: 0.4,
    side: THREE.DoubleSide,
  });

  sphereMesh = new THREE.Mesh(sphereGeo, sphereMat);
  scene.add(sphereMesh);

  // If image already loaded, apply it
  const existingUrl = getUserImageUrl();
  if (existingUrl) applyImage(existingUrl);

  // Post-processing
  const res = new THREE.Vector2(window.innerWidth, window.innerHeight);
  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  composer.addPass(new UnrealBloomPass(res, 0.8, 0.4, 0.2));
  composer.addPass(new OutputPass());

  // Hide canvas when switching away
  vizModeUnsub = store.on('vizModeChange', (data) => {
    if (!threeCanvas) return;
    threeCanvas.style.display = data === 'sculpture' ? 'block' : 'none';
  });

  // React to image load/remove
  imageUnsub = store.on('imageChange', (data) => {
    if (data) {
      const url = getUserImageUrl();
      if (url) applyImage(url);
    } else {
      clearImage();
    }
  });

  initialized = true;
}

// ── Image helpers ─────────────────────────────────────────────────────────────

function applyImage(url: string): void {
  new THREE.TextureLoader().load(url, (tex) => {
    tex.colorSpace = THREE.SRGBColorSpace;
    imageTexture?.dispose();
    imageTexture = tex;
    if (sphereMat) {
      sphereMat.map = tex;
      sphereMat.color.set(0xffffff);
      sphereMat.emissive.set(0x222222);
      sphereMat.needsUpdate = true;
    }
  });
}

function clearImage(): void {
  imageTexture?.dispose();
  imageTexture = null;
  if (sphereMat) {
    sphereMat.map = null;
    sphereMat.color.set(0x8844ff);
    sphereMat.emissive.set(0x221144);
    sphereMat.needsUpdate = true;
  }
}

// ── Camera helpers ────────────────────────────────────────────────────────────

function sphericalToCartesian(theta: number, phi: number, r: number): THREE.Vector3 {
  return new THREE.Vector3(
    r * Math.sin(phi) * Math.cos(theta),
    r * Math.cos(phi),
    r * Math.sin(phi) * Math.sin(theta),
  );
}

function updateCameraPosition(lerpFactor: number): void {
  if (!camera) return;

  // Lerp spherical coordinates
  currentCamTheta += (targetCamTheta - currentCamTheta) * lerpFactor;
  currentCamPhi   += (targetCamPhi - currentCamPhi) * lerpFactor;

  const pos = sphericalToCartesian(currentCamTheta, currentCamPhi, CAMERA_DIST);
  camera.position.copy(pos);
  camera.lookAt(0, 0, 0);
}

function pickNewCameraTarget(): void {
  // Pick a random preset, avoiding the previous one
  let idx: number;
  do {
    idx = Math.floor(Math.random() * CAMERA_PRESETS.length);
  } while (idx === lastPresetIndex && CAMERA_PRESETS.length > 1);
  lastPresetIndex = idx;

  const [theta, phi] = CAMERA_PRESETS[idx];
  targetCamTheta = theta;
  targetCamPhi   = phi;
}

// ── Vertex displacement ───────────────────────────────────────────────────────

function displaceVertices(amps: number[]): void {
  if (!sphereGeo || !basePositions) return;

  const posAttr = sphereGeo.attributes['position'] as THREE.BufferAttribute;
  const count   = posAttr.count;

  for (let i = 0; i < count; i++) {
    const bx = basePositions[i * 3];
    const by = basePositions[i * 3 + 1];
    const bz = basePositions[i * 3 + 2];

    // Normalize position to get direction
    const len = Math.sqrt(bx * bx + by * by + bz * bz);
    const nx = bx / len;
    const ny = by / len;
    const nz = bz / len;

    // Map vertex latitude to a frequency band (0-6)
    // phi: 0 at top, PI at bottom → band index
    const phi = Math.acos(Math.max(-1, Math.min(1, ny)));
    const bandIdx = Math.min(6, Math.floor((phi / Math.PI) * 7));
    const amp = amps[bandIdx] ?? 0;

    // Displacement outward along normal
    const displacement = amp * DISPLACE_SCALE * store.config.spikeScale;
    posAttr.setXYZ(
      i,
      bx + nx * displacement,
      by + ny * displacement,
      bz + nz * displacement,
    );
  }

  posAttr.needsUpdate = true;
  sphereGeo.computeVertexNormals();
}

// ── Draw ──────────────────────────────────────────────────────────────────────

export function drawSculpture(_p: unknown, dt: number): void {
  if (!initialized) setup();

  const { amps } = getBandAverages(7);
  const { state } = store;

  // Smooth audio values
  const bass  = (amps[0] + amps[1]) * 0.5;
  const total = amps.reduce((s, a) => s + a, 0) / 7;
  smoothedBass  += (bass - smoothedBass) * 0.15 * dt;
  smoothedTotal += (total - smoothedTotal) * 0.12 * dt;

  // Beat detection → camera transition
  if (state.beatIntervalSec > 0 && state.isPlaying) {
    const pos      = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    const beatIdx  = adjusted >= 0 ? Math.floor(adjusted / state.beatIntervalSec) : -1;
    if (beatIdx > lastBeatIndex) {
      lastBeatIndex = beatIdx;
      pickNewCameraTarget();
    }
  }

  // Update camera (smooth lerp)
  updateCameraPosition(CAMERA_LERP * dt);

  // Displace sphere vertices based on frequency bands
  displaceVertices(amps);

  // Pulse sphere scale with bass
  if (sphereMesh) {
    const scale = 1.0 + smoothedBass * PULSE_SCALE * 0.1;
    sphereMesh.scale.setScalar(scale);

    // Slow idle rotation
    sphereMesh.rotation.y += dt * 0.001 * store.config.rotationSpeed;
  }

  // Emissive intensity from amplitude
  if (sphereMat) {
    sphereMat.emissiveIntensity = BASE_EMISSIVE + smoothedTotal * 1.5;
  }

  // Bloom strength from intensity slider
  if (composer && composer.passes[1]) {
    (composer.passes[1] as UnrealBloomPass).strength = 0.8 * store.config.intensity;
  }

  composer?.render();
}

// ── Reset ─────────────────────────────────────────────────────────────────────

export function resetSculpture(): void {
  if (!initialized) return;
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer?.setSize(w, h);
  if (camera) { camera.aspect = w / h; camera.updateProjectionMatrix(); }
  composer?.setSize(w, h);
}

// ── Dispose ───────────────────────────────────────────────────────────────────

export function disposeSculpture(): void {
  if (!initialized) return;
  vizModeUnsub?.();
  imageUnsub?.();
  vizModeUnsub = null;
  imageUnsub   = null;

  sphereGeo?.dispose();
  sphereMat?.dispose();
  imageTexture?.dispose();

  composer?.dispose();
  renderer?.dispose();
  threeCanvas?.remove();

  threeCanvas = null; renderer = null; scene = null; camera = null;
  composer = null; sphereMesh = null; sphereMat = null; sphereGeo = null;
  basePositions = null; imageTexture = null;

  lastBeatIndex = -1; lastPresetIndex = -1;
  smoothedBass = 0; smoothedTotal = 0;
  currentCamTheta = 1.0; currentCamPhi = 1.2;
  targetCamTheta = 1.0; targetCamPhi = 1.2;
  initialized = false;
}
