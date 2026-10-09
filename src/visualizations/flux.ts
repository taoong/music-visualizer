/**
 * Flux — 3D vector field visualization; a lattice of metallic needles orient
 * themselves along a continuously evolving audio-driven field equation.
 * Sub-bass drives global field rotation, higher bands introduce turbulence;
 * quiet passages yield near-parallel alignment, loud passages twist the lattice
 * into swirling disorder. Camera orbits slowly on an elliptical path.
 *
 * Aesthetic: warm key / cool fill two-point studio lighting; near-monochrome
 * burnished-metal needles on a near-black background; no rainbow, no neon glow.
 * Inspired by Ryoji Ikeda's "datamatics" (2006–2010) field-density visualizations
 * and the magnetic vector-field installations of Julius von Bismarck (2008–2024).
 * https://www.ryojiikeda.com/project/datamatics/
 * https://juliusvonbismarck.com/bank/
 */

import * as THREE from 'three';
import { store } from '../state/store';
import { getBandAverages, fovForAspect } from './helpers';
import { audioEngine } from '../audio/engine';
import { isMobile } from '../utils/constants';

// ── Module state ───────────────────────────────────────────────────────────────

let initialized    = false;
let threeCanvas    : HTMLCanvasElement | null = null;
let renderer       : THREE.WebGLRenderer | null = null;
let scene          : THREE.Scene | null = null;
let camera         : THREE.PerspectiveCamera | null = null;
let needleMesh     : THREE.InstancedMesh | null = null;
let needleGeo      : THREE.CylinderGeometry | null = null;
let needleMat      : THREE.MeshStandardMaterial | null = null;
let tipMesh        : THREE.InstancedMesh | null = null;
let tipGeo         : THREE.ConeGeometry | null = null;
let tipMat         : THREE.MeshStandardMaterial | null = null;
let vizModeUnsub   : (() => void) | null = null;

let time         = 0;
let lastBeatIdx  = -1;
let beatKick     = 0;     // decays 1→0 after each beat
let currentN     = 0;
let camTheta     = 0;     // camera azimuth angle
let camPhi       = 0.5;   // camera elevation

// ── Pre-allocated objects (avoid GC in hot loop) ──────────────────────────────

const _dummy  = new THREE.Object3D();
const _yAxis  = new THREE.Vector3(0, 1, 0);
const _fv     = new THREE.Vector3();
const _tipPos = new THREE.Vector3();

// ── Constants ─────────────────────────────────────────────────────────────────

const NEEDLE_LEN    = isMobile ? 0.50 : 0.65;
const NEEDLE_RADIUS = 0.011;
const TIP_HEIGHT    = NEEDLE_LEN * 0.28;
const TIP_RADIUS    = NEEDLE_RADIUS * 2.2;
const MAX_GRID      = isMobile ? 7 : 10;
const MIN_GRID      = 3;

// ── Setup ─────────────────────────────────────────────────────────────────────

function setup(): void {
  threeCanvas = document.createElement('canvas');
  threeCanvas.style.cssText =
    'position:fixed;top:0;left:0;width:100%;height:100%;z-index:10;pointer-events:none;display:block';
  document.body.appendChild(threeCanvas);

  const pr = isMobile ? 1.0 : Math.min(window.devicePixelRatio, 2);
  renderer = new THREE.WebGLRenderer({ canvas: threeCanvas, antialias: !isMobile, alpha: true });
  renderer.setPixelRatio(pr);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputColorSpace  = THREE.SRGBColorSpace;
  renderer.toneMapping       = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.4;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x07070a);

  const aspect = window.innerWidth / window.innerHeight;
  camera = new THREE.PerspectiveCamera(fovForAspect(52, aspect), aspect, 0.05, 100);
  camera.position.set(0, 0, 6);

  // Warm key light from upper-right-front
  const key = new THREE.DirectionalLight(new THREE.Color(1.0, 0.92, 0.78), 3.2);
  key.position.set(4, 5, 3);
  scene.add(key);

  // Cool fill from left-rear
  const fill = new THREE.DirectionalLight(new THREE.Color(0.38, 0.52, 0.82), 0.9);
  fill.position.set(-5, 1, -3);
  scene.add(fill);

  // Soft ambient to keep dark areas readable
  scene.add(new THREE.AmbientLight(0x0d0d14, 1.0));

  buildNeedles();

  vizModeUnsub = store.on('vizModeChange', () => {
    if (store.state.vizMode !== 'flux') disposeFlux();
  });

  initialized = true;
}

// Build (or rebuild) the InstancedMesh lattice for the current grid density.
function buildNeedles(): void {
  if (!scene) return;

  if (needleMesh) { scene.remove(needleMesh); needleGeo?.dispose(); needleMesh = null; }
  if (tipMesh)    { scene.remove(tipMesh);    tipGeo?.dispose();    tipMesh = null;    }

  const N = clampGrid(store.config.fluxGrid);
  currentN = N;
  const total = N * N * N;

  // Shaft: thin cylinder (4-sided for faceted low-poly look)
  needleGeo = new THREE.CylinderGeometry(NEEDLE_RADIUS, NEEDLE_RADIUS, NEEDLE_LEN, 4, 1);
  needleMat = needleMat ?? new THREE.MeshStandardMaterial({
    color: new THREE.Color(0.78, 0.76, 0.72), // warm brushed silver
    roughness: 0.28,
    metalness: 0.90,
    emissive: new THREE.Color(0, 0, 0),
  });
  needleMesh = new THREE.InstancedMesh(needleGeo, needleMat, total);
  needleMesh.frustumCulled = false;
  scene.add(needleMesh);

  // Tip: small cone at the +Y end to indicate direction
  tipGeo = new THREE.ConeGeometry(TIP_RADIUS, TIP_HEIGHT, 4, 1);
  tipMat = tipMat ?? new THREE.MeshStandardMaterial({
    color: new THREE.Color(1.0, 0.88, 0.55), // warm amber tip — accent against silver
    roughness: 0.20,
    metalness: 0.95,
    emissive: new THREE.Color(0.12, 0.08, 0.01),
    emissiveIntensity: 1.0,
  });
  tipMesh = new THREE.InstancedMesh(tipGeo, tipMat, total);
  tipMesh.frustumCulled = false;
  scene.add(tipMesh);
}

function clampGrid(raw: number): number {
  return Math.max(MIN_GRID, Math.min(MAX_GRID, Math.round(raw)));
}

// ── Vector field ──────────────────────────────────────────────────────────────

// Returns a unit vector representing the field at world position (px, py, pz).
// The field is a superposition of a smooth base rotation and turbulent per-band
// modes. All computation is continuous — no beat-snapping.
function fieldAt(px: number, py: number, pz: number, t: number, amps: number[]): THREE.Vector3 {
  const turb = store.config.fluxTurbulence;  // 0–1

  // Base flow: global slow rotation in XZ plane, pitched by bass
  const baseSpd   = 0.28 + amps[0] * 0.35;   // sub-bass speeds up base rotation
  const baseAngle = t * baseSpd;
  const pitchAmt  = (amps[1] - 0.3) * 0.9 * turb;

  // 7 turbulent modes, one per band, each with its own spatial frequency and axis
  const f0 = 1.2 + amps[0] * 0.6;
  const f1 = 1.8 + amps[1] * 0.8;
  const f2 = 2.4 + amps[2] * 1.0;
  const f3 = 3.0 + amps[3] * 1.2;
  const f4 = 3.6 + amps[4] * 0.8;
  const f5 = 4.2 + amps[5] * 0.6;
  const f6 = 5.0 + amps[6] * 0.5;

  const tx =
    amps[1] * Math.sin(py * f1 + t * 0.62) * 0.7 +
    amps[3] * Math.cos(pz * f3 + t * 0.45) * 0.5 +
    amps[5] * Math.sin(px * f5 + t * 0.38) * 0.3;

  const ty =
    amps[0] * Math.cos(pz * f0 + t * 0.55) * 0.8 +
    amps[2] * Math.sin(px * f2 + t * 0.72) * 0.5 +
    amps[4] * Math.cos(py * f4 + t * 0.30) * 0.3 +
    amps[6] * Math.sin(pz * f6 + t * 0.82) * 0.2;

  const tz =
    amps[2] * Math.sin(px * f2 + t * 0.48) * 0.7 +
    amps[4] * Math.cos(py * f4 + t * 0.65) * 0.5 +
    amps[6] * Math.sin(pz * f6 + t * 0.40) * 0.3;

  const bx = Math.cos(baseAngle) + turb * tx;
  const by = Math.sin(pitchAmt)  + turb * ty * 0.6;
  const bz = Math.sin(baseAngle) + turb * tz;

  _fv.set(bx, by, bz);
  if (_fv.lengthSq() < 1e-6) _fv.set(0, 1, 0);
  return _fv.normalize();
}

// ── Draw ──────────────────────────────────────────────────────────────────────

export function drawFlux(_p: unknown, dt: number): void {
  if (!initialized) setup();
  if (!renderer || !scene || !camera || !needleMesh || !tipMesh) return;

  // Rebuild if grid density changed
  const N = clampGrid(store.config.fluxGrid);
  if (N !== currentN) buildNeedles();
  if (!needleMesh || !tipMesh) return;

  const { amps } = getBandAverages(7);
  const { state } = store;

  // Time accumulates in seconds-ish (dt is in 16.67ms units)
  time += dt * 0.0006;

  // Beat detection
  if (state.beatIntervalSec > 0 && state.isPlaying) {
    const pos     = audioEngine.getPlaybackPosition();
    const beatIdx = Math.floor((pos - state.beatOffset) / state.beatIntervalSec);
    if (beatIdx > lastBeatIdx) {
      lastBeatIdx = beatIdx;
      beatKick = 1.0;
    }
  }
  beatKick *= Math.pow(0.90, dt); // decay with dt for frame-rate independence

  // ── Field spacing ──
  // fluxGrid = 3–MAX_GRID; fieldScale governs how spread-out the lattice is
  const fieldHalfSize = 1.6 + store.config.fluxLength * 1.2; // 1.6–2.8
  const spacing       = (fieldHalfSize * 2) / Math.max(N - 1, 1);
  const origin        = -fieldHalfSize;

  let idx = 0;
  for (let ix = 0; ix < N; ix++) {
    for (let iy = 0; iy < N; iy++) {
      for (let iz = 0; iz < N; iz++) {
        const px = origin + ix * spacing;
        const py = origin + iy * spacing;
        const pz = origin + iz * spacing;

        const fv = fieldAt(px, py, pz, time, amps);

        // Needle shaft (centered at lattice point, oriented along fv)
        _dummy.position.set(px, py, pz);
        _dummy.quaternion.setFromUnitVectors(_yAxis, fv);
        _dummy.scale.setScalar(1.0 + beatKick * 0.06);
        _dummy.updateMatrix();
        needleMesh!.setMatrixAt(idx, _dummy.matrix);

        // Tip cone placed at +Y end of needle
        _tipPos.copy(fv).multiplyScalar(NEEDLE_LEN * 0.5 + TIP_HEIGHT * 0.5);
        _tipPos.add(_dummy.position);
        _dummy.position.copy(_tipPos);
        // quaternion already set above — reuse it (tip oriented same as needle)
        _dummy.scale.setScalar(1.0 + beatKick * 0.06);
        _dummy.updateMatrix();
        tipMesh!.setMatrixAt(idx, _dummy.matrix);

        idx++;
      }
    }
  }

  needleMesh.instanceMatrix.needsUpdate = true;
  tipMesh.instanceMatrix.needsUpdate    = true;

  // ── Material response ──
  if (needleMat && tipMat) {
    const energy = amps.reduce((s, a) => s + a, 0) / 7;
    // Subtle emissive warmth on beats — like forge-heated metal
    const emR = 0.04 + beatKick * 0.12;
    const emG = 0.03 + beatKick * 0.06;
    const emB = 0.01 + beatKick * 0.02;
    needleMat.emissive.setRGB(emR * 0.4, emG * 0.4, emB * 0.4);
    needleMat.emissiveIntensity = 1.0;
    needleMat.roughness = Math.max(0.15, 0.28 - energy * 0.12);

    tipMat.emissiveIntensity = 0.8 + beatKick * 1.2 + energy * 0.6;
  }

  // ── Camera orbit ──
  camTheta += dt * 0.00018;  // slow azimuth rotation
  camPhi    = 0.42 + Math.sin(time * 0.11) * 0.22; // gentle elevation sway

  const camDist = fieldHalfSize * (isMobile ? 3.4 : 2.8) + beatKick * 0.2;
  camera.position.set(
    camDist * Math.sin(camTheta) * Math.cos(camPhi),
    camDist * Math.sin(camPhi),
    camDist * Math.cos(camTheta) * Math.cos(camPhi),
  );
  camera.lookAt(0, 0, 0);

  renderer.render(scene, camera);
}

// ── Reset (window resize) ─────────────────────────────────────────────────────

export function resetFlux(): void {
  if (!initialized) return;
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer?.setSize(w, h);
  if (camera) {
    camera.aspect = w / h;
    camera.fov    = fovForAspect(52, camera.aspect);
    camera.updateProjectionMatrix();
  }
}

// ── Dispose ───────────────────────────────────────────────────────────────────

export function disposeFlux(): void {
  if (!initialized) return;
  vizModeUnsub?.();
  vizModeUnsub = null;
  if (scene && needleMesh) scene.remove(needleMesh);
  if (scene && tipMesh)    scene.remove(tipMesh);
  needleGeo?.dispose();
  needleMat?.dispose();
  tipGeo?.dispose();
  tipMat?.dispose();
  renderer?.dispose();
  threeCanvas?.remove();
  threeCanvas = null;
  renderer    = null;
  scene       = null;
  camera      = null;
  needleMesh  = null;
  needleGeo   = null;
  needleMat   = null;
  tipMesh     = null;
  tipGeo      = null;
  tipMat      = null;
  initialized = false;
}
