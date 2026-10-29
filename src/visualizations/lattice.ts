/**
 * Lattice — audio-reactive 3D crystal lattice
 *
 * A simple-cubic array of metallic nodes connected by cylindrical bonds;
 * 7 frequency bands each drive a distinct displacement mode (radial expansion,
 * transverse waves on X/Z, axial twist, scale pulse, micro-noise) giving the
 * rigid lattice an organic, breathing quality. Camera slowly orbits the
 * structure; beats fire a decaying outward burst.  Restrained two-tone palette:
 * warm-amber key light against cool-steel fill — no rainbow.
 *
 * Inspired by George W. Hart's "72 Pencils" crystal lattice sculpture
 * (https://www.georgehart.com/sculpture/pencils.html) and the TouchDesigner
 * SOP-crystal-lattice aesthetic common in real-time VJ performance.
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
let threeCanvas: HTMLCanvasElement | null = null;
let renderer: THREE.WebGLRenderer | null = null;
let scene: THREE.Scene | null = null;
let camera: THREE.PerspectiveCamera | null = null;
let composer: EffectComposer | null = null;
let bloomPass: UnrealBloomPass | null = null;
let nodesMesh: THREE.InstancedMesh | null = null;
let bondsMesh: THREE.InstancedMesh | null = null;
let nodesGeo: THREE.SphereGeometry | null = null;
let bondsGeo: THREE.CylinderGeometry | null = null;
let nodesMat: THREE.MeshStandardMaterial | null = null;
let bondsMat: THREE.MeshStandardMaterial | null = null;
let vizModeUnsub: (() => void) | null = null;
let initialized = false;

// Lattice rebuild tracking
let builtN = -1;
let builtSpacing = -1;

// Per-node data (rest positions + current displaced positions)
let restPos    = new Float32Array(0); // nodeCount * 3
let dispPos    = new Float32Array(0); // nodeCount * 3
let nodeCount  = 0;
let bondPairs  = new Uint16Array(0);  // bondCount * 2
let bondCount  = 0;

// Animation state
let time       = 0;
let camAngle   = 0;
let beatKick   = 0;  // decaying impulse added on beat
let camKick    = 0;  // decaying camera radial offset on beat

// Pre-allocated scratch to avoid hot-path GC
const _m4   = new THREE.Matrix4();
const _posA = new THREE.Vector3();
const _posB = new THREE.Vector3();
const _mid  = new THREE.Vector3();
const _dir  = new THREE.Vector3();
const _up   = new THREE.Vector3(0, 1, 0);
const _rot  = new THREE.Quaternion();
const _sca  = new THREE.Vector3();
const _sca1 = new THREE.Vector3(1, 1, 1);

// ── Setup ─────────────────────────────────────────────────────────────────────
function setup(): void {
  threeCanvas = document.createElement('canvas');
  threeCanvas.style.cssText =
    'position:fixed;top:0;left:0;width:100%;height:100%;z-index:10;pointer-events:none;display:block';
  document.body.appendChild(threeCanvas);

  renderer = new THREE.WebGLRenderer({ canvas: threeCanvas, antialias: !isMobile, alpha: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, isMobile ? 1.0 : 2.0));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x020305);

  const aspect = window.innerWidth / window.innerHeight;
  camera = new THREE.PerspectiveCamera(fovForAspect(42, aspect), aspect, 0.01, 200);

  // Warm amber key + cool steel fill + dim ambient
  const key = new THREE.DirectionalLight(0xffd4a0, 3.0);
  key.position.set(3, 4, 2);
  scene.add(key);

  const fill = new THREE.DirectionalLight(0xa0c8e8, 0.8);
  fill.position.set(-3, -2, -3);
  scene.add(fill);

  scene.add(new THREE.AmbientLight(0x08090c, 1.0));

  // Reusable geometry — shared across all rebuilds
  nodesGeo = new THREE.SphereGeometry(0.12, isMobile ? 8 : 14, isMobile ? 6 : 10);
  nodesMat = new THREE.MeshStandardMaterial({
    color: 0xb0b8c8,
    metalness: 0.82,
    roughness: 0.22,
  });

  bondsGeo = new THREE.CylinderGeometry(0.028, 0.028, 1.0, isMobile ? 4 : 6, 1);
  bondsMat = new THREE.MeshStandardMaterial({
    color: 0x7a8896,
    metalness: 0.65,
    roughness: 0.38,
  });

  // Post-processing: bloom (desktop only) + output
  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  if (!isMobile) {
    bloomPass = new UnrealBloomPass(
      new THREE.Vector2(window.innerWidth, window.innerHeight),
      0.35, 0.4, 0.88,
    );
    composer.addPass(bloomPass);
  }
  composer.addPass(new OutputPass());

  vizModeUnsub = store.on('vizModeChange', (data) => {
    if (!threeCanvas) return;
    threeCanvas.style.display = data === 'lattice' ? 'block' : 'none';
  });

  initialized = true;
}

// ── Build / rebuild the lattice ───────────────────────────────────────────────
function buildLattice(n: number, spacing: number): void {
  // Remove old meshes from scene, dispose instances
  if (nodesMesh) { scene?.remove(nodesMesh); nodesMesh.dispose(); nodesMesh = null; }
  if (bondsMesh) { scene?.remove(bondsMesh); bondsMesh.dispose(); bondsMesh = null; }

  const half = (n - 1) * 0.5 * spacing;
  nodeCount = n * n * n;
  restPos   = new Float32Array(nodeCount * 3);
  dispPos   = new Float32Array(nodeCount * 3);

  for (let iz = 0; iz < n; iz++) {
    for (let iy = 0; iy < n; iy++) {
      for (let ix = 0; ix < n; ix++) {
        const i = iz * n * n + iy * n + ix;
        restPos[i * 3 + 0] = ix * spacing - half;
        restPos[i * 3 + 1] = iy * spacing - half;
        restPos[i * 3 + 2] = iz * spacing - half;
      }
    }
  }

  // Bonds: one from each node to its +X, +Y, +Z neighbour if in bounds
  const pairs: number[] = [];
  for (let iz = 0; iz < n; iz++) {
    for (let iy = 0; iy < n; iy++) {
      for (let ix = 0; ix < n; ix++) {
        const i = iz * n * n + iy * n + ix;
        if (ix + 1 < n) pairs.push(i, i + 1);
        if (iy + 1 < n) pairs.push(i, i + n);
        if (iz + 1 < n) pairs.push(i, i + n * n);
      }
    }
  }
  bondPairs = new Uint16Array(pairs);
  bondCount = pairs.length >> 1;

  nodesMesh = new THREE.InstancedMesh(nodesGeo!, nodesMat!, nodeCount);
  bondsMesh = new THREE.InstancedMesh(bondsGeo!, bondsMat!, bondCount);
  scene?.add(nodesMesh);
  scene?.add(bondsMesh);

  builtN       = n;
  builtSpacing = spacing;
}

// ── Draw ──────────────────────────────────────────────────────────────────────
export function drawLattice(_p: unknown, dt: number): void {
  if (!initialized) setup();
  if (!renderer || !scene || !camera || !composer) return;

  const { amps, transients } = getBandAverages(7);

  // ── Config read ────────────────────────────────────────────────────────────
  const rawScale   = store.config.latticeScale;      // 0-1
  const rawWave    = store.config.latticeWave;        // 0-1
  const rawGlow    = store.config.latticeGlow;        // 0-1

  const maxN = isMobile ? 4 : 5;
  const n       = Math.max(2, Math.min(maxN, 2 + Math.round(rawScale * (maxN - 2))));
  const spacing = 1.4 + rawScale * 0.8; // 1.4 – 2.2 (loose to tight structurally)
  const waveMul = rawWave * 0.8 + 0.05; // 0.05 – 0.85
  const glowStr = rawGlow;

  // Rebuild lattice if structural parameters changed
  if (n !== builtN || Math.abs(spacing - builtSpacing) > 0.05) {
    buildLattice(n, spacing);
  }
  if (!nodesMesh || !bondsMesh) return;

  // ── Beat detection ─────────────────────────────────────────────────────────
  const transient = Math.max(transients[0] ?? 1, transients[1] ?? 1);
  if (transient > 1.35) {
    beatKick = Math.min(1.0, beatKick + (transient - 1.35) * 0.9);
    camKick  = Math.min(0.6, camKick  + (transient - 1.35) * 0.5);
  }
  beatKick *= Math.pow(0.88, dt);
  camKick  *= Math.pow(0.92, dt);

  // ── Node displacement ──────────────────────────────────────────────────────
  const a0 = amps[0] ?? 0, a1 = amps[1] ?? 0, a2 = amps[2] ?? 0,
        a3 = amps[3] ?? 0, a4 = amps[4] ?? 0, a5 = amps[5] ?? 0,
        a6 = amps[6] ?? 0;

  time += 0.016 * dt;

  for (let i = 0; i < nodeCount; i++) {
    const rx = restPos[i * 3];
    const ry = restPos[i * 3 + 1];
    const rz = restPos[i * 3 + 2];

    // Band 0 (sub): radial expansion in XZ plane
    const radXZ = Math.sqrt(rx * rx + rz * rz) || 0.001;
    const dxSub = (rx / radXZ) * a0 * 0.6;
    const dzSub = (rz / radXZ) * a0 * 0.6;

    // Band 1 (bass): transverse Y-wave sweeping along X
    const dyBass = Math.sin(rx * 1.8 + time * 2.1) * a1 * 0.7;

    // Band 2 (lowMid): transverse Z-wave sweeping along Y
    const dzLow = Math.sin(ry * 1.6 + time * 1.7) * a2 * 0.55;

    // Band 3 (mid): axial twist — rotate XZ around Y proportional to Y height
    const twistRad = ry * a3 * 0.5;
    const cosT = Math.cos(twistRad), sinT = Math.sin(twistRad);
    const dxMid = rx * (cosT - 1) - rz * sinT;
    const dzMid = rx * sinT       + rz * (cosT - 1);

    // Band 4 (upperMid): transverse X-wave sweeping along Z
    const dxUpper = Math.sin(rz * 2.0 + time * 2.6) * a4 * 0.5;

    // Band 5 (presence): uniform scale pulse — all axes expand together
    const sc = a5 * 0.25;
    const dxSc = rx * sc, dySc = ry * sc, dzSc = rz * sc;

    // Band 6 (brilliance): micro-perturbation (cheap sinusoidal hash)
    const noiseX = Math.sin(rx * 7.1 + time * 3.2) * Math.cos(rz * 5.3 + time * 1.9) * a6 * 0.18;
    const noiseY = Math.sin(ry * 6.7 + time * 2.4) * Math.cos(rx * 8.1 + time * 2.7) * a6 * 0.18;
    const noiseZ = Math.sin(rz * 9.3 + time * 1.6) * Math.cos(ry * 4.9 + time * 3.1) * a6 * 0.18;

    // Beat kick: outward radial burst from center
    const dist3 = Math.sqrt(rx * rx + ry * ry + rz * rz) || 0.001;
    const kick  = beatKick * 0.45;

    dispPos[i * 3]     = rx + (dxSub + dxMid + dxUpper + dxSc + noiseX + rx / dist3 * kick) * waveMul;
    dispPos[i * 3 + 1] = ry + (dyBass + dySc + noiseY + ry / dist3 * kick) * waveMul;
    dispPos[i * 3 + 2] = rz + (dzSub + dzLow + dzMid + dzSc + noiseZ + rz / dist3 * kick) * waveMul;
  }

  // ── Update node matrices ───────────────────────────────────────────────────
  for (let i = 0; i < nodeCount; i++) {
    _posA.set(dispPos[i * 3], dispPos[i * 3 + 1], dispPos[i * 3 + 2]);
    _m4.compose(_posA, _rot, _sca1);
    nodesMesh.setMatrixAt(i, _m4);
  }
  nodesMesh.instanceMatrix.needsUpdate = true;

  // ── Update bond matrices ───────────────────────────────────────────────────
  for (let b = 0; b < bondCount; b++) {
    const ia = bondPairs[b * 2];
    const ib = bondPairs[b * 2 + 1];

    _posA.set(dispPos[ia * 3], dispPos[ia * 3 + 1], dispPos[ia * 3 + 2]);
    _posB.set(dispPos[ib * 3], dispPos[ib * 3 + 1], dispPos[ib * 3 + 2]);

    _mid.addVectors(_posA, _posB).multiplyScalar(0.5);
    _dir.subVectors(_posB, _posA);
    const len = _dir.length();
    _dir.multiplyScalar(1 / (len || 0.001));

    _rot.setFromUnitVectors(_up, _dir);
    _sca.set(1, len, 1);
    _m4.compose(_mid, _rot, _sca);
    bondsMesh.setMatrixAt(b, _m4);
  }
  bondsMesh.instanceMatrix.needsUpdate = true;

  // ── Emissive drive from glow slider ───────────────────────────────────────
  if (nodesMat) {
    const em = glowStr * 0.3 + Math.max(a0, a1) * glowStr * 0.2;
    nodesMat.emissive.setScalar(em * 0.4);
    nodesMat.emissiveIntensity = em;
  }

  // ── Bloom strength ────────────────────────────────────────────────────────
  if (bloomPass) bloomPass.strength = 0.1 + glowStr * 0.55 + beatKick * 0.25;

  // ── Camera orbit ──────────────────────────────────────────────────────────
  const baseRadius = (n - 1) * spacing * 0.78 + 3.5;
  const camRadius  = baseRadius + camKick * 0.8;
  camAngle += 0.003 * dt;

  const elevation = 0.42; // radians (~24°)
  camera.position.set(
    Math.sin(camAngle) * camRadius * Math.cos(elevation),
    Math.sin(elevation) * camRadius,
    Math.cos(camAngle) * camRadius * Math.cos(elevation),
  );
  camera.lookAt(0, 0, 0);

  composer.render();
}

// ── Reset (resize) ────────────────────────────────────────────────────────────
export function resetLattice(): void {
  if (!initialized) return;
  const w = window.innerWidth, h = window.innerHeight;
  renderer?.setSize(w, h);
  if (camera) {
    camera.aspect = w / h;
    camera.fov    = fovForAspect(42, camera.aspect);
    camera.updateProjectionMatrix();
  }
  composer?.setSize(w, h);
  if (bloomPass) bloomPass.resolution.set(w, h);
}

// ── Dispose ───────────────────────────────────────────────────────────────────
export function disposeLattice(): void {
  if (!initialized) return;
  vizModeUnsub?.();
  vizModeUnsub = null;

  if (nodesMesh) { scene?.remove(nodesMesh); nodesMesh.dispose(); nodesMesh = null; }
  if (bondsMesh) { scene?.remove(bondsMesh); bondsMesh.dispose(); bondsMesh = null; }
  nodesGeo?.dispose(); nodesGeo = null;
  bondsGeo?.dispose(); bondsGeo = null;
  nodesMat?.dispose(); nodesMat = null;
  bondsMat?.dispose(); bondsMat = null;
  composer?.dispose();
  renderer?.dispose();
  threeCanvas?.remove();

  threeCanvas = null; renderer = null; scene = null; camera = null;
  composer = null; bloomPass = null;
  initialized = false; builtN = -1; builtSpacing = -1;
  restPos = new Float32Array(0); dispPos = new Float32Array(0);
  bondPairs = new Uint16Array(0); nodeCount = 0; bondCount = 0;
}
