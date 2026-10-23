/**
 * Spire — Three.js WebGL overlay visualization.
 *
 * A field of sharp stone spires rises from a dark ground plane. A single raking
 * directional light casts dramatic shadow bars between them. Camera orbits the
 * perimeter at mid-height, looking inward and slightly upward — slow enough that
 * the shadow geometry reads as architectural landscape, not spinning toy.
 *
 * Audio drives spire heights continuously (CHOP-style per-frame lerp) across 7
 * column zones mapped left→right to sub-bass→brilliance. Beat adds a brief
 * upward camera jolt + light surge that decays — a kick to the flowing system,
 * not a state snap.
 *
 * Inspired by Maya Lin "Wave Field" (1995, University of Michigan storm-water
 * retention pond, https://www.mayalin.com/) — a landscape of 100 earth mounds
 * that recall ocean waves at rest — and by the way raking sidelight in VJ/TD
 * instanced-geometry patches turns height data into shadow-theatre.
 *
 * Sliders:
 *   Formation — grid density 4–12 spires per side (structural; rebuilds mesh)
 *   Height    — amplitude sensitivity: modest sway → sky-reaching spires
 *   Warmth    — 0 = cold moonlit obsidian / blue-white key light
 *               1 = warm sundown sandstone / amber key light
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass }     from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass }     from 'three/addons/postprocessing/OutputPass.js';
import { store }          from '../state/store';
import { audioEngine }    from '../audio/engine';
import { getBandAverages, fovForAspect } from './helpers';
import { isMobile }       from '../utils/constants';

// ── Constants ─────────────────────────────────────────────────────────────────

const SPACING    = 1.6;   // centre-to-centre distance between spires
const CONE_R     = 0.28;  // base radius of each cone
const CONE_SEGS  = isMobile ? 5 : 7;  // number of sides (5=pentagon, 7=heptagon)
const BASE_H     = 0.05;  // minimum height so spire is always visible
const CAM_RADIUS = 11.5;  // orbit radius around field centre
const CAM_FOV    = 62;
const ORBIT_RPM  = 0.022; // full orbit in ~45 seconds (radians per norm-dt)

// 7 band zone centres in normalised field X (−1 → +1, maps to column index)
const ZONE_X: number[] = [-0.857, -0.571, -0.286, 0.0, 0.286, 0.571, 0.857];
const SIGMA_SQ = 0.065; // Gaussian sigma² for zone weight falloff (~⅓ field width)

// Warmth parameter interpolation targets
//   [stone hex, key light hex, ambient hex, key intensity, ambient intensity]
const COLD = {
  stone:   new THREE.Color(0x18202e),
  ground:  new THREE.Color(0x10161f),
  key:     new THREE.Color(0xb8d4ff),  // cool moonlight
  amb:     new THREE.Color(0x0d1525),
  keyInt:  2.0,
  ambInt:  0.5,
  bg:      new THREE.Color(0x07080f),
};
const WARM = {
  stone:   new THREE.Color(0x3a2410),
  ground:  new THREE.Color(0x281808),
  key:     new THREE.Color(0xffa040),  // amber sundown
  amb:     new THREE.Color(0x1a1008),
  keyInt:  2.8,
  ambInt:  0.6,
  bg:      new THREE.Color(0x0c0804),
};

// ── Module state ──────────────────────────────────────────────────────────────

let initialized   = false;
let threeCanvas   : HTMLCanvasElement | null = null;
let renderer      : THREE.WebGLRenderer | null = null;
let scene         : THREE.Scene | null = null;
let camera        : THREE.PerspectiveCamera | null = null;
let composer      : EffectComposer | null = null;
let vizModeUnsub  : (() => void) | null = null;

let instancedMesh : THREE.InstancedMesh | null = null;
let spireMat      : THREE.MeshStandardMaterial | null = null;
let groundMesh    : THREE.Mesh | null = null;
let groundMat     : THREE.MeshStandardMaterial | null = null;
let dirLight      : THREE.DirectionalLight | null = null;
let ambLight      : THREE.AmbientLight | null = null;

let lastFormationN = 0;

// Per-instance current heights (smoothed) — lerped toward audio targets
let currentHeights: Float32Array = new Float32Array(0);

// Beat / camera dynamics
let orbitAngle   = 0;          // current orbit angle (radians)
let camYBase     = 3.0;        // base camera height
let camYJolt     = 0;          // additive jolt that decays each frame
let lightSurge   = 0;          // additive key-light intensity surge
let lastBeatIdx  = -1;

const dummy = new THREE.Object3D();
const _col  = new THREE.Color();

// ── Helpers ───────────────────────────────────────────────────────────────────

function lerpColor(a: { r: number; g: number; b: number }, b: { r: number; g: number; b: number }, t: number): THREE.Color {
  return new THREE.Color(
    a.r + (b.r - a.r) * t,
    a.g + (b.g - a.g) * t,
    a.b + (b.b - a.b) * t,
  );
}

function currentN(): number {
  // spireFormation 0–1 → 4–12 per side
  return Math.max(4, Math.min(isMobile ? 8 : 12, Math.round(store.config.spireFormation * 8 + 4)));
}

function buildField(N: number): void {
  if (!scene || !spireMat) return;

  if (instancedMesh) {
    instancedMesh.geometry.dispose();
    scene.remove(instancedMesh);
    instancedMesh = null;
  }

  const count = N * N;
  const geo   = new THREE.ConeGeometry(CONE_R, 1.0, CONE_SEGS, 1);
  instancedMesh = new THREE.InstancedMesh(geo, spireMat, count);
  instancedMesh.castShadow    = !isMobile;
  instancedMesh.receiveShadow = !isMobile;
  scene.add(instancedMesh);
  lastFormationN = N;

  currentHeights = new Float32Array(count).fill(BASE_H);

  // Initial placement at base height
  const offset = ((N - 1) * SPACING) / 2;
  for (let iz = 0; iz < N; iz++) {
    for (let ix = 0; ix < N; ix++) {
      const idx = iz * N + ix;
      dummy.position.set(ix * SPACING - offset, BASE_H * 0.5, iz * SPACING - offset);
      dummy.scale.set(1, BASE_H, 1);
      dummy.updateMatrix();
      instancedMesh.setMatrixAt(idx, dummy.matrix);
    }
  }
  instancedMesh.instanceMatrix.needsUpdate = true;
}

// ── Setup ─────────────────────────────────────────────────────────────────────

function setup(): void {
  threeCanvas = document.createElement('canvas');
  threeCanvas.style.cssText =
    'position:fixed;top:0;left:0;width:100%;height:100%;z-index:10;pointer-events:none;display:block';
  document.body.appendChild(threeCanvas);

  const w = window.innerWidth;
  const h = window.innerHeight;

  renderer = new THREE.WebGLRenderer({ canvas: threeCanvas, antialias: !isMobile, alpha: true });
  renderer.setSize(w, h);
  renderer.setPixelRatio(isMobile ? 1.0 : Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = !isMobile;
  renderer.shadowMap.type    = THREE.PCFSoftShadowMap;
  renderer.toneMapping       = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.2;

  scene = new THREE.Scene();
  scene.background = COLD.bg.clone();
  scene.fog = new THREE.Fog(COLD.bg, 10, 38);

  camera = new THREE.PerspectiveCamera(fovForAspect(CAM_FOV, w / h), w / h, 0.1, 60);

  // Directional key light — rakes across the field from high oblique angle
  dirLight = new THREE.DirectionalLight(COLD.key, COLD.keyInt);
  dirLight.position.set(12, 18, 4);
  if (!isMobile) {
    dirLight.castShadow = true;
    dirLight.shadow.mapSize.set(1024, 1024);
    const sc = dirLight.shadow.camera as THREE.OrthographicCamera;
    sc.near = 1; sc.far = 50;
    sc.left = -20; sc.right = 20; sc.top = 20; sc.bottom = -20;
    dirLight.shadow.bias = -0.001;
  }
  scene.add(dirLight);

  // Ambient fill — very dim complementary hue
  ambLight = new THREE.AmbientLight(COLD.amb, COLD.ambInt);
  scene.add(ambLight);

  // Stone material — uniform dark, no per-band coloring
  spireMat = new THREE.MeshStandardMaterial({
    color:      COLD.stone,
    roughness:  0.92,
    metalness:  0.05,
  });

  // Ground plane
  groundMat = new THREE.MeshStandardMaterial({
    color:     COLD.ground,
    roughness: 0.98,
    metalness: 0,
  });
  const groundGeo = new THREE.PlaneGeometry(80, 80);
  groundMesh = new THREE.Mesh(groundGeo, groundMat);
  groundMesh.rotation.x = -Math.PI / 2;
  groundMesh.receiveShadow = !isMobile;
  scene.add(groundMesh);

  // EffectComposer — subtle spire-tip bloom on desktop only
  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  if (!isMobile) {
    const bloom = new UnrealBloomPass(
      new THREE.Vector2(w, h),
      0.35,  // strength
      0.50,  // radius
      0.88,  // threshold — only very bright highlights (tips catching light)
    );
    composer.addPass(bloom);
  }
  composer.addPass(new OutputPass());

  buildField(currentN());

  vizModeUnsub = store.on('vizModeChange', (data) => {
    if (!threeCanvas) return;
    threeCanvas.style.display = data === 'spire' ? 'block' : 'none';
  });

  initialized = true;
}

// ── Draw (called by p5 draw loop at ~60fps) ───────────────────────────────────

export function drawSpire(_p: unknown, dt: number): void {
  if (!initialized) setup();
  if (!scene || !camera || !composer || !renderer || !instancedMesh || !dirLight || !ambLight) return;

  const { amps } = getBandAverages(7);

  // ── Formation: rebuild if N changed ──────────────────────────────────────
  const N = currentN();
  if (N !== lastFormationN) buildField(N);

  // ── Warmth: blend materials / lighting ───────────────────────────────────
  const warmth = store.config.spireWarmth;
  _col.copy(lerpColor(COLD.stone, WARM.stone, warmth));
  spireMat!.color.copy(_col);

  _col.copy(lerpColor(COLD.ground, WARM.ground, warmth));
  groundMat!.color.copy(_col);

  dirLight.color.copy(lerpColor(COLD.key, WARM.key, warmth));
  dirLight.intensity = (COLD.keyInt + (WARM.keyInt - COLD.keyInt) * warmth) + lightSurge;

  ambLight.color.copy(lerpColor(COLD.amb, WARM.amb, warmth));
  ambLight.intensity = COLD.ambInt + (WARM.ambInt - COLD.ambInt) * warmth;

  _col.copy(lerpColor(COLD.bg, WARM.bg, warmth));
  scene.background = _col.clone();
  (scene.fog as THREE.Fog).color.copy(_col);

  // ── Beat detection ────────────────────────────────────────────────────────
  const state = store.state;
  if (state.beatIntervalSec > 0 && state.isPlaying) {
    const pos  = audioEngine.getPlaybackPosition();
    const adj  = pos - state.beatOffset;
    const idx  = adj >= 0 ? Math.floor(adj / state.beatIntervalSec) : -1;
    if (idx > lastBeatIdx) {
      lastBeatIdx = idx;
      camYJolt   = 1.8;  // upward camera jolt
      lightSurge = 0.9;  // brief light brightness surge
    }
  }

  // Decay beat dynamics each frame
  camYJolt   *= Math.pow(0.92, dt);
  lightSurge *= Math.pow(0.88, dt);

  // ── Camera orbit ──────────────────────────────────────────────────────────
  const masterAmp = amps.reduce((s, a) => s + a, 0) / 7;
  orbitAngle += ORBIT_RPM * dt;

  // Height oscillates gently so we see both ground shadows and spire tips
  const camY = camYBase + 1.8 * Math.sin(orbitAngle * 0.31) + camYJolt;
  const camX = Math.cos(orbitAngle) * CAM_RADIUS;
  const camZ = Math.sin(orbitAngle) * CAM_RADIUS;
  camera.position.set(camX, camY, camZ);

  // Look toward field centre, tilted slightly toward upper-middle of field
  const lookY = 1.5 + masterAmp * 1.5;
  camera.lookAt(0, lookY, 0);

  // ── Audio-reactive spire heights ──────────────────────────────────────────
  const heightScale = store.config.spireHeight;  // 0–1 slider
  const maxH        = 2.0 + heightScale * 7.0;   // 2m → 9m max

  const offset = ((N - 1) * SPACING) / 2;

  for (let iz = 0; iz < N; iz++) {
    for (let ix = 0; ix < N; ix++) {
      const idx = iz * N + ix;

      // Compute normalised x position in field (−1 → +1)
      const nx = (ix * SPACING - offset) / ((N - 1) * SPACING * 0.5 + 0.001);

      // Sum Gaussian contribution from each of the 7 band zones
      let targetH = BASE_H;
      for (let b = 0; b < 7; b++) {
        const dx   = nx - ZONE_X[b];
        const w    = Math.exp(-(dx * dx) / SIGMA_SQ);
        targetH   += w * (amps[b] ?? 0) * maxH;
      }
      targetH = Math.max(BASE_H, targetH);

      // CHOP-style continuous easing — lerp toward audio target
      const speed    = 0.18 * dt;
      currentHeights[idx] = currentHeights[idx] + (targetH - currentHeights[idx]) * Math.min(1, speed);

      const h = currentHeights[idx];
      dummy.position.set(ix * SPACING - offset, h * 0.5, iz * SPACING - offset);
      dummy.scale.set(1, h, 1);
      dummy.updateMatrix();
      instancedMesh.setMatrixAt(idx, dummy.matrix);
    }
  }
  instancedMesh.instanceMatrix.needsUpdate = true;

  composer.render();
}

// ── Reset (window resize) ─────────────────────────────────────────────────────

export function resetSpire(): void {
  if (!initialized) return;
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer?.setSize(w, h);
  if (camera) {
    camera.aspect = w / h;
    camera.fov    = fovForAspect(CAM_FOV, camera.aspect);
    camera.updateProjectionMatrix();
  }
  composer?.setSize(w, h);
}

// ── Dispose ───────────────────────────────────────────────────────────────────

export function disposeSpire(): void {
  if (!initialized) return;
  vizModeUnsub?.();
  vizModeUnsub = null;
  instancedMesh?.geometry.dispose();
  spireMat?.dispose();
  groundMesh?.geometry.dispose();
  groundMat?.dispose();
  composer?.dispose();
  renderer?.dispose();
  threeCanvas?.remove();
  threeCanvas    = null;
  renderer       = null;
  scene          = null;
  camera         = null;
  composer       = null;
  instancedMesh  = null;
  spireMat       = null;
  groundMesh     = null;
  groundMat      = null;
  dirLight       = null;
  ambLight       = null;
  currentHeights = new Float32Array(0);
  lastFormationN = 0;
  camYJolt       = 0;
  lightSurge     = 0;
  lastBeatIdx    = -1;
  initialized    = false;
}
