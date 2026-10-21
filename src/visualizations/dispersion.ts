/**
 * Dispersion: 7 concentric rings of rotating glass prism columns
 *
 * Inspired by UVA (United Visual Artists) "Column" (2013) — a kinetic light
 * installation with rotating glass prisms that diffract light into shifting
 * colour fields. https://uva.co.uk/works/column
 *
 * Each concentric ring maps to one audio frequency band and rotates
 * continuously at amplitude-driven speed. Alternating CW/CCW direction per
 * ring creates dynamic interference patterns between inner and outer rings.
 * Camera orbits the outside of the barrel slowly. Iridescent physical glass
 * material shimmers as prisms turn.
 *
 * VJ principle: every audio band is treated as a continuous CHOP signal.
 * Angular velocity eases toward its amplitude target every frame; a beat
 * transient adds a decaying kick on top — there is no state reset.
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { store } from '../state/store';
import { getBandAverages } from './helpers';
import { isMobile } from '../utils/constants';

// ── Module-scoped state ───────────────────────────────────────────────────────

let initialized = false;
let threeCanvas: HTMLCanvasElement | null = null;
let renderer: THREE.WebGLRenderer | null = null;
let scene: THREE.Scene | null = null;
let camera: THREE.PerspectiveCamera | null = null;
let composer: EffectComposer | null = null;
let ringMaterial: THREE.MeshPhysicalMaterial | null = null;
let prismGeometry: THREE.CylinderGeometry | null = null;
let vizModeUnsub: (() => void) | null = null;

// Per-ring state (rebuilt when Rings slider changes)
const ringGroups: THREE.Group[] = [];
const ringVelocities: number[] = []; // current angular velocity rad/frame
let currentRingCount = 0;

// Camera orbit
let camAngle = 0;

// ── Ring layout constants ─────────────────────────────────────────────────────

// Alternating CW / CCW (viewed from above: +1 = CW about Y, -1 = CCW)
const RING_DIRS = [1, -1, 1, -1, 1, -1, 1] as const;
// Radii (world units) for rings 0–6
const RING_RADII = [2.5, 4.0, 5.5, 7.0, 8.5, 10.0, 11.5] as const;
// Prism count per ring — more prisms at larger radius to keep consistent gap
const RING_COUNTS = [6, 10, 14, 18, 22, 26, 30] as const;
const RING_COUNTS_MOBILE = [4, 6, 8, 10, 14, 16, 20] as const;
const MAX_RINGS = 7;

// ── Scene / ring builders ─────────────────────────────────────────────────────

function buildRings(n: number): void {
  if (!scene || !prismGeometry || !ringMaterial) return;

  // Dispose existing rings
  for (const g of ringGroups) {
    scene.remove(g);
    g.traverse((child) => {
      if (child instanceof THREE.Mesh) child.geometry.dispose();
    });
  }
  ringGroups.length = 0;
  ringVelocities.length = 0;

  const counts = isMobile ? RING_COUNTS_MOBILE : RING_COUNTS;

  for (let i = 0; i < n; i++) {
    const group = new THREE.Group();
    const radius = RING_RADII[i];
    const nPrisms = counts[i];
    for (let j = 0; j < nPrisms; j++) {
      const angle = (j / nPrisms) * Math.PI * 2;
      const mesh = new THREE.Mesh(prismGeometry, ringMaterial);
      mesh.position.set(Math.cos(angle) * radius, 0, Math.sin(angle) * radius);
      // Face prism outward so flat faces are tangent to the ring
      mesh.rotation.y = -angle + Math.PI * 0.5;
      group.add(mesh);
    }
    scene.add(group);
    ringGroups.push(group);
    ringVelocities.push(0);
  }

  currentRingCount = n;
}

function setup(): void {
  threeCanvas = document.createElement('canvas');
  threeCanvas.style.cssText =
    'position:fixed;top:0;left:0;width:100%;height:100%;z-index:10;pointer-events:none;display:block';
  document.body.appendChild(threeCanvas);

  renderer = new THREE.WebGLRenderer({
    canvas: threeCanvas,
    antialias: !isMobile,
    alpha: true,
  });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, isMobile ? 1 : 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  scene = new THREE.Scene();
  scene.background = null; // transparent — p5 canvas shows through

  const aspect = window.innerWidth / window.innerHeight;
  camera = new THREE.PerspectiveCamera(55, aspect, 0.1, 200);
  camera.position.set(RING_RADII[MAX_RINGS - 1] + 8, 4, 0);
  camera.lookAt(0, 1.5, 0);

  // Warm tungsten SpotLight from above
  const spot = new THREE.SpotLight(0xfff4d0, 120, 60, Math.PI / 5, 0.3, 1.5);
  spot.position.set(0, 18, 0);
  spot.target.position.set(0, 0, 0);
  scene.add(spot);
  scene.add(spot.target);

  // Cool fill DirectionalLight from below-behind
  const fill = new THREE.DirectionalLight(0xb0c8ff, 2.5);
  fill.position.set(-6, -4, -10);
  scene.add(fill);

  // Very dim ambient to avoid total blackness in shadows
  scene.add(new THREE.AmbientLight(0x0a0a12, 1.0));

  // Octagonal prism — slightly tapered (top smaller than base)
  prismGeometry = new THREE.CylinderGeometry(0.38, 0.50, 6.0, 8);

  // MeshPhysicalMaterial — iridescent glass look
  ringMaterial = new THREE.MeshPhysicalMaterial({
    color: 0xd0e8ff,
    metalness: 0.0,
    roughness: 0.08,
    transparent: true,
    opacity: 0.82,
    side: THREE.DoubleSide,
    iridescence: 0.7,
    iridescenceIOR: 1.9,
    iridescenceThicknessRange: [80, 500],
    envMapIntensity: 1.2,
  });

  const nRings = Math.round(store.config.dispersionRings ?? 7);
  buildRings(Math.max(2, Math.min(MAX_RINGS, nRings)));

  // EffectComposer: subtle bloom on glass edges (desktop only)
  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  if (!isMobile) {
    const res = new THREE.Vector2(window.innerWidth, window.innerHeight);
    const bloom = new UnrealBloomPass(res, 0.25, 0.4, 0.85);
    composer.addPass(bloom);
  }
  composer.addPass(new OutputPass());

  vizModeUnsub = store.on('vizModeChange', (data) => {
    if (!threeCanvas) return;
    threeCanvas.style.display = data === 'dispersion' ? 'block' : 'none';
  });

  initialized = true;
}

// ── Draw ──────────────────────────────────────────────────────────────────────

export function drawDispersion(_p: unknown, dt: number): void {
  if (!initialized) setup();
  if (!renderer || !scene || !camera || !composer || !ringMaterial) return;

  const { amps, transients } = getBandAverages(7);

  // Read sliders
  const spin    = store.config.dispersionSpin    ?? 0.5; // 0–1: audio sensitivity
  const clarity = store.config.dispersionClarity ?? 0.6; // 0–1: frosted → clear

  // Structural: rebuild rings if the Rings slider changed
  const targetRings = Math.max(2, Math.min(MAX_RINGS, Math.round(store.config.dispersionRings ?? 7)));
  if (targetRings !== currentRingCount) {
    buildRings(targetRings);
  }

  // Update material properties from Clarity slider (no needsUpdate needed for these)
  ringMaterial.roughness   = 0.02 + (1.0 - clarity) * 0.88;
  ringMaterial.opacity     = 0.35 + clarity * 0.55;
  ringMaterial.iridescence = 0.3  + clarity * 0.7;

  // Camera slow orbit around the ring structure
  const orbitRadius = (RING_RADII[Math.min(currentRingCount - 1, MAX_RINGS - 1)] ?? RING_RADII[MAX_RINGS - 1]) + 8;
  camAngle += 0.004 * dt;
  camera.position.set(
    Math.cos(camAngle) * orbitRadius,
    3.5 + Math.sin(camAngle * 0.3) * 1.0, // gentle altitude oscillation
    Math.sin(camAngle) * orbitRadius,
  );
  camera.lookAt(0, 1.5, 0);

  // Per-ring rotation update — CHOP-style continuous signal
  const spinMax = 0.04 * dt; // max rad/frame at amplitude=1, spin=1
  for (let i = 0; i < currentRingCount; i++) {
    const amp       = amps[i]       ?? 0;
    const transient = transients[i] ?? 1;
    const dir       = RING_DIRS[i]  ?? 1;

    // Target velocity: amplitude × sensitivity × direction
    const targetVel = amp * spin * spinMax * dir;

    // Ease current velocity toward target (continuous, frame-rate independent)
    const easeRate = 1.0 - Math.pow(0.06, dt / 60);
    ringVelocities[i] = (ringVelocities[i] ?? 0) + (targetVel - (ringVelocities[i] ?? 0)) * easeRate;

    // Transient kick: excess above 1.0 = beat impulse, decays into the ease
    const kick = Math.max(0, transient - 1.0) * 0.012 * spin * dir;
    ringVelocities[i] += kick;

    if (ringGroups[i]) {
      ringGroups[i].rotation.y += ringVelocities[i];
    }
  }

  composer.render();
}

// ── Reset (resize) ────────────────────────────────────────────────────────────

export function resetDispersion(): void {
  if (!initialized) return;
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer?.setSize(w, h);
  composer?.setSize(w, h);
  if (camera) {
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
}

// ── Dispose ───────────────────────────────────────────────────────────────────

export function disposeDispersion(): void {
  if (!initialized) return;

  vizModeUnsub?.();
  vizModeUnsub = null;

  // Dispose ring groups
  for (const g of ringGroups) {
    scene?.remove(g);
    g.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        // prismGeometry is shared; don't dispose per-mesh
      }
    });
  }
  ringGroups.length = 0;
  ringVelocities.length = 0;

  prismGeometry?.dispose();
  ringMaterial?.dispose();
  composer?.dispose();
  renderer?.dispose();
  threeCanvas?.remove();

  threeCanvas = null;
  renderer = null;
  scene = null;
  camera = null;
  composer = null;
  ringMaterial = null;
  prismGeometry = null;
  currentRingCount = 0;
  initialized = false;
}
