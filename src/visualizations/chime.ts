/**
 * Chime — 3D crystal pendant array
 *
 * N hexagonal glass prisms hang from a horizontal metallic bar.
 * Each prism is assigned to a frequency band and swings like a pendulum
 * via spring-damper physics driven continuously by band amplitude —
 * no beat-snap, beats add a decaying angular kick that disturbs the
 * already-flowing motion. MeshPhysicalMaterial with glass transmission
 * and iridescence on desktop; simplified on mobile.
 *
 * Inspired by Es Devlin's crystal installation "Mirrormaze" (2018,
 * National Portrait Gallery London) and the TouchDesigner spring-physics
 * CHOP technique where audio signals feed continuously into physical
 * simulation rather than triggering discrete state changes.
 * https://www.esdevlin.com/work/mirrormaze
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
let vizModeUnsub: (() => void) | null = null;

// Bar rod across the top
let barMesh: THREE.Mesh | null = null;
let barMat: THREE.MeshStandardMaterial | null = null;
let barGeo: THREE.CylinderGeometry | null = null;

// Floor
let floorMesh: THREE.Mesh | null = null;
let floorMat: THREE.MeshStandardMaterial | null = null;

// Per-prism state
const MAX_PRISMS = 12;
const WIRE_LEN  = 1.3;   // length of thin wire above each crystal
const BAR_Y     = 0.0;   // y-position of the hanging bar
const PRISM_SEGS = isMobile ? 4 : 6; // hex prism on desktop, square on mobile
const PRISM_RADIUS = 0.13;

const prismPivots:   THREE.Group[]  = [];
const wireMeshes:    THREE.Mesh[]   = [];
const crystalMeshes: THREE.Mesh[]   = [];
const crystalMats:   (THREE.MeshPhysicalMaterial | THREE.MeshStandardMaterial)[] = [];
const wireGeos:      THREE.CylinderGeometry[] = [];
const crystalGeos:   THREE.CylinderGeometry[] = [];
const wireMats:      THREE.MeshStandardMaterial[] = [];

// Pendulum physics state per prism
const angles:   Float32Array = new Float32Array(MAX_PRISMS);
const angVels:  Float32Array = new Float32Array(MAX_PRISMS);

// Beat
let lastBeatIndex = -1;
let beatKick = 0.0;

// Camera
let cameraTheta = 0.0;
let cameraFov = 55.0;

// Time
let time = 0.0;

// Track last count to detect structural changes
let lastPrismCount = -1;

// Lights kept for per-frame update
let keyLight: THREE.SpotLight | null = null;
let keyLightTarget: THREE.Object3D | null = null;

// ── Prism length by index (bass=tall, treble=short) ───────────────────────────

function prismLength(index: number, count: number): number {
  const t = count <= 1 ? 0 : index / (count - 1);
  return 2.6 - t * 1.1; // 2.6 → 1.5
}

// ── Build / rebuild prism geometry for a given count ─────────────────────────

function repositionPrisms(count: number): void {
  const spacing = isMobile ? 0.85 : 0.92;
  const totalWidth = (count - 1) * spacing;
  const halfW = totalWidth * 0.5;

  for (let i = 0; i < MAX_PRISMS; i++) {
    const pivot = prismPivots[i];
    if (!pivot) continue;

    if (i < count) {
      pivot.visible = true;
      pivot.position.x = -halfW + i * spacing;
      pivot.position.y = BAR_Y;
      pivot.rotation.z = 0;

      // Update crystal geometry for new length
      const len = prismLength(i, count);
      const crystal = crystalMeshes[i];
      const wire    = wireMeshes[i];
      if (crystal && wire) {
        crystal.position.y = -(WIRE_LEN + len * 0.5);
        wire.position.y    = -WIRE_LEN * 0.5;
      }

      // Rebuild crystal geometry with correct length (dispose old)
      const oldGeo = crystalGeos[i];
      if (oldGeo) oldGeo.dispose();
      const newGeo = new THREE.CylinderGeometry(PRISM_RADIUS, PRISM_RADIUS, len, PRISM_SEGS, 1);
      crystalGeos[i] = newGeo;
      if (crystal) crystal.geometry = newGeo;
    } else {
      pivot.visible = false;
    }
  }

  // Update bar scale to match current prism span
  if (barMesh) {
    const newBarLen = totalWidth + 1.0;
    barMesh.scale.x = newBarLen;
  }

  angles.fill(0);
  angVels.fill(0);
}

// ── Setup ─────────────────────────────────────────────────────────────────────

function setup(): void {
  threeCanvas = document.createElement('canvas');
  threeCanvas.style.cssText =
    'position:fixed;top:0;left:0;width:100%;height:100%;z-index:10;pointer-events:none;display:block';
  document.body.appendChild(threeCanvas);

  renderer = new THREE.WebGLRenderer({ canvas: threeCanvas, antialias: !isMobile, alpha: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(isMobile ? 1.0 : Math.min(window.devicePixelRatio, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  if (!isMobile) renderer.shadowMap.enabled = true;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x030303);
  scene.fog = new THREE.FogExp2(0x030303, 0.055);

  camera = new THREE.PerspectiveCamera(cameraFov, window.innerWidth / window.innerHeight, 0.1, 80);
  camera.position.set(0, -1.5, 11);
  camera.lookAt(0, -3.0, 0);

  // ── Lights ───────────────────────────────────────────────────────────────

  // Warm tungsten key (SpotLight for focused beam through glass)
  keyLight = new THREE.SpotLight(0xffd080, isMobile ? 60 : 80, 35, Math.PI / 4.5, 0.25, 1.2);
  keyLight.position.set(4.5, 7, 3);
  keyLightTarget = new THREE.Object3D();
  keyLightTarget.position.set(0, -3, 0);
  scene.add(keyLightTarget);
  keyLight.target = keyLightTarget;
  if (!isMobile) {
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.set(512, 512);
    keyLight.shadow.camera.near = 1;
    keyLight.shadow.camera.far  = 40;
  }
  scene.add(keyLight);

  // Cool fill from left
  const fillLight = new THREE.DirectionalLight(0x8aacff, isMobile ? 1.2 : 2.0);
  fillLight.position.set(-6, 2, 1);
  scene.add(fillLight);

  // Subtle rim from behind
  const rimLight = new THREE.DirectionalLight(0xaaddff, 0.5);
  rimLight.position.set(0, 2, -6);
  scene.add(rimLight);

  // Very dim ambient
  scene.add(new THREE.AmbientLight(0x111111, isMobile ? 0.4 : 0.25));

  // ── Bar rod ───────────────────────────────────────────────────────────────

  barGeo = new THREE.CylinderGeometry(0.04, 0.04, 1.0, 8, 1); // scale.x set per count
  barMat = new THREE.MeshStandardMaterial({
    color: 0x999999,
    metalness: 0.9,
    roughness: 0.25,
  });
  barMesh = new THREE.Mesh(barGeo, barMat);
  barMesh.rotation.z = Math.PI * 0.5; // horizontal
  barMesh.position.y = BAR_Y;
  barMesh.receiveShadow = !isMobile;
  scene.add(barMesh);

  // End caps on bar (small spheres)
  const capGeo = new THREE.SphereGeometry(0.055, 8, 6);
  for (const sign of [-1, 1]) {
    const cap = new THREE.Mesh(capGeo, barMat);
    cap.position.set(sign * 6.0, BAR_Y, 0);
    scene.add(cap);
  }

  // ── Floor ─────────────────────────────────────────────────────────────────

  floorMat = new THREE.MeshStandardMaterial({
    color: 0x060606,
    metalness: 0.3,
    roughness: 0.75,
  });
  floorMesh = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), floorMat);
  floorMesh.rotation.x = -Math.PI / 2;
  floorMesh.position.y = -8.5;
  floorMesh.receiveShadow = !isMobile;
  scene.add(floorMesh);

  // ── Prisms ────────────────────────────────────────────────────────────────

  const sharedWireGeo = new THREE.CylinderGeometry(0.008, 0.008, WIRE_LEN, 4, 1);
  const sharedWireMat = new THREE.MeshStandardMaterial({
    color: 0x777777,
    metalness: 0.95,
    roughness: 0.05,
  });

  for (let i = 0; i < MAX_PRISMS; i++) {
    const pivot = new THREE.Group();
    pivot.position.set(0, BAR_Y, 0);
    pivot.visible = false;
    scene.add(pivot);
    prismPivots.push(pivot);

    // Thin wire
    const wireGeo = new THREE.CylinderGeometry(0.008, 0.008, WIRE_LEN, 4, 1);
    wireGeos.push(wireGeo);
    const wireMat = sharedWireMat.clone();
    wireMats.push(wireMat);
    const wire = new THREE.Mesh(wireGeo, wireMat);
    wire.position.y = -WIRE_LEN * 0.5;
    wire.castShadow = !isMobile;
    pivot.add(wire);
    wireMeshes.push(wire);

    // Crystal prism
    const len = 2.0;
    const crystalGeo = new THREE.CylinderGeometry(PRISM_RADIUS, PRISM_RADIUS, len, PRISM_SEGS, 1);
    crystalGeos.push(crystalGeo);

    let crystalMat: THREE.MeshPhysicalMaterial | THREE.MeshStandardMaterial;
    if (isMobile) {
      crystalMat = new THREE.MeshStandardMaterial({
        color: 0xd8ecf4,
        transparent: true,
        opacity: 0.55,
        roughness: 0.05,
        metalness: 0.0,
        side: THREE.DoubleSide,
      });
    } else {
      crystalMat = new THREE.MeshPhysicalMaterial({
        color: 0xeaf4f8,
        metalness: 0.0,
        roughness: 0.0,
        transmission: 0.9,
        thickness: 1.5,
        iridescence: 0.6,
        iridescenceIOR: 1.9,
        iridescenceThicknessRange: [100, 800] as [number, number],
        ior: 1.5,
        side: THREE.DoubleSide,
      });
    }
    crystalMats.push(crystalMat);

    const crystal = new THREE.Mesh(crystalGeo, crystalMat);
    crystal.position.y = -(WIRE_LEN + len * 0.5);
    crystal.castShadow = !isMobile;
    pivot.add(crystal);
    crystalMeshes.push(crystal);
  }

  sharedWireGeo.dispose(); // was only used as reference; actual geos are in wireGeos[]

  // ── Post-processing (desktop only) ───────────────────────────────────────

  if (!isMobile) {
    const res = new THREE.Vector2(window.innerWidth, window.innerHeight);
    composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    composer.addPass(new UnrealBloomPass(res, 0.3, 0.5, 0.2));
    composer.addPass(new OutputPass());
  }

  // ── Visibility toggle on viz switch ──────────────────────────────────────

  vizModeUnsub = store.on('vizModeChange', (data) => {
    if (!threeCanvas) return;
    threeCanvas.style.display = data === 'chime' ? 'block' : 'none';
  });

  initialized = true;
}

// ── Draw (called by p5 draw loop at ~60fps) ───────────────────────────────────

export function drawChime(_p: unknown, dt: number): void {
  if (!initialized) setup();
  if (!renderer || !scene || !camera) return;

  time += dt * 0.016;

  const { amps } = getBandAverages(7);
  const cfg = store.config;

  // Current prism count from slider (structural)
  const count = Math.max(3, Math.min(MAX_PRISMS, Math.round(3 + cfg.chimeCount * 9)));
  if (count !== lastPrismCount) {
    repositionPrisms(count);
    lastPrismCount = count;
  }

  const shimmer = cfg.chimeShimmer;
  const swingSens = 0.08 + cfg.chimeSwing * 0.52; // 0.08→0.60 radians at amp=1

  // ── Beat detection ─────────────────────────────────────────────────────

  const { state } = store;
  if (state.beatIntervalSec > 0 && state.isPlaying) {
    const pos      = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    const beatIdx  = adjusted >= 0 ? Math.floor(adjusted / state.beatIntervalSec) : -1;
    if (beatIdx > lastBeatIndex) {
      lastBeatIndex = beatIdx;
      beatKick = 1.0;
      // Add angular kick to each visible prism (alternating sign, staggered phase)
      for (let i = 0; i < count; i++) {
        const dir = (i % 2 === 0) ? 1.0 : -1.0;
        angVels[i] += 0.28 * dir * (0.7 + Math.random() * 0.3);
      }
    }
  }
  beatKick *= Math.pow(0.90, dt);

  // ── Pendulum physics per prism ─────────────────────────────────────────

  for (let i = 0; i < count; i++) {
    const pivot = prismPivots[i];
    if (!pivot || !pivot.visible) continue;

    const band      = amps[i % 7] ?? 0;
    const dir       = (i % 2 === 0) ? 1.0 : -1.0;
    const targetAng = band * swingSens * dir;

    // Spring-damper: continuous lerp toward target, never snap
    const stiffness = 0.055;
    const damping   = isMobile ? 0.90 : 0.87;
    angVels[i] += (targetAng - angles[i]) * stiffness;
    angVels[i] *= Math.pow(damping, dt);
    angles[i]  += angVels[i] * dt;

    pivot.rotation.z = angles[i];

    // Update iridescence on desktop materials
    if (!isMobile) {
      const mat = crystalMats[i] as THREE.MeshPhysicalMaterial;
      if (mat && 'iridescence' in mat) {
        mat.iridescence = shimmer * (0.4 + band * 0.6);
      }
    }
  }

  // ── Camera orbit ───────────────────────────────────────────────────────

  // Very slow continuous orbit
  cameraTheta += dt * 0.00028;
  // Gentle vertical sway
  const camH = -1.5 + Math.sin(time * 0.18) * 1.2;
  const camR = 10.5 + Math.sin(time * 0.11) * 0.5;
  if (camera) {
    camera.position.x = Math.sin(cameraTheta) * camR;
    camera.position.z = Math.cos(cameraTheta) * camR;
    camera.position.y = camH;
    camera.lookAt(0, -3.2, 0);

    // FOV breath: subtle FOV kick on beat
    const targetFov = 55 - beatKick * 4;
    cameraFov += (targetFov - cameraFov) * 0.08;
    camera.fov = cameraFov;
    camera.updateProjectionMatrix();
  }

  // ── Key light ─────────────────────────────────────────────────────────

  if (keyLight) {
    // Intensity breathes with overall amplitude
    const avgAmp = amps.reduce((a, b) => a + b, 0) / 7;
    const baseIntensity = isMobile ? 60 : 80;
    keyLight.intensity = baseIntensity + avgAmp * 40 + beatKick * 30;
  }

  // ── Bloom strength from shimmer slider ────────────────────────────────

  if (composer) {
    const bloomPass = composer.passes[1] as InstanceType<typeof UnrealBloomPass>;
    if (bloomPass) {
      bloomPass.strength = 0.1 + shimmer * 0.7;
    }
  }

  // ── Render ────────────────────────────────────────────────────────────

  if (composer) {
    composer.render();
  } else {
    renderer.render(scene, camera);
  }
}

// ── Reset (resize) ────────────────────────────────────────────────────────────

export function resetChime(): void {
  if (!initialized) return;
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer?.setSize(w, h);
  if (camera) { camera.aspect = w / h; camera.updateProjectionMatrix(); }
  composer?.setSize(w, h);
}

// ── Dispose ───────────────────────────────────────────────────────────────────

export function disposeChime(): void {
  if (!initialized) return;

  vizModeUnsub?.();
  vizModeUnsub = null;

  // Prism geometry + materials
  for (let i = 0; i < MAX_PRISMS; i++) {
    wireGeos[i]?.dispose();
    crystalGeos[i]?.dispose();
    wireMats[i]?.dispose();
    crystalMats[i]?.dispose();
  }
  wireGeos.length    = 0;
  crystalGeos.length = 0;
  wireMats.length    = 0;
  crystalMats.length = 0;
  wireMeshes.length  = 0;
  crystalMeshes.length = 0;
  prismPivots.length = 0;

  // Bar
  barGeo?.dispose();
  barMat?.dispose();

  // Floor
  floorMat?.dispose();

  // Post-processing
  composer?.dispose();

  // Renderer + canvas
  renderer?.dispose();
  threeCanvas?.remove();

  // Nullify
  threeCanvas = null;
  renderer    = null;
  scene       = null;
  camera      = null;
  composer    = null;
  barMesh     = null;
  barGeo      = null;
  barMat      = null;
  floorMesh   = null;
  floorMat    = null;
  keyLight    = null;
  keyLightTarget = null;

  // Reset per-frame state
  time          = 0;
  lastBeatIndex = -1;
  beatKick      = 0;
  cameraTheta   = 0;
  cameraFov     = 55;
  lastPrismCount = -1;
  angles.fill(0);
  angVels.fill(0);

  initialized = false;
}
