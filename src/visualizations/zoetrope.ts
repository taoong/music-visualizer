/**
 * Zoetrope — Three.js WebGL overlay visualization
 *
 * N terracotta spike-cones arranged in a golden-angle (Fibonacci) phyllotaxis
 * pattern on a flat disc or hemisphere; each cone's height is driven by its
 * radial frequency-band zone. The structure spins continuously under a single
 * dramatic warm overhead light. On every beat the light fires a brief "strobe
 * flash" — at the right spin speed, the Fibonacci spiral arms appear to stand
 * still or scroll in slow motion, exactly like John Edmark's "Blooms" kinetic
 * zoetrope sculptures.
 *
 * Spiral slider (structural): morphs the spike field from a flat disc (0) to a
 *   hemisphere dome (1); at 0 all cones point straight up, at 1 they radiate
 *   outward from the sphere surface.
 * Strobe slider: flash intensity on beats — high values amplify the stroboscopic
 *   illusion; low values give continuous soft lighting.
 * Spin slider: base rotation speed — tune to music BPM for the golden-angle
 *   standing-wave illusion; at ~0.47 with BPM 140 each beat advances exactly
 *   one golden-angle step (137.5°) so spirals appear stationary.
 *
 * Palette: warm terracotta (#C47B56) on deep charcoal — single dramatic raking
 * overhead light, soft cool fill, no rainbow, no bloom, no neon glow.
 *
 * Inspired by John Edmark "Blooms" kinetic zoetrope sculptures (2014,
 * https://www.instructables.com/Blooms-Fibonacci-Zoetrope-Sculptures/) —
 * 3D-printed Fibonacci spiral structures that reveal hidden animation under
 * stroboscopic light.
 */
import * as THREE from 'three';
import { store } from '../state/store';
import { getBandAverages } from './helpers';
import { audioEngine } from '../audio/engine';
import { isMobile } from '../utils/constants';

// ── Constants ─────────────────────────────────────────────────────────────────

const N_DESKTOP    = 260;
const N_MOBILE     = 110;
const GOLDEN_ANGLE = 2.3998632;   // 137.507764° in radians
const SPACING      = isMobile ? 0.37 : 0.42;
const BASE_H       = 0.06;        // minimum cone height
const MAX_AMP_H    = 1.6;         // max height added by audio amplitude
const CONE_RADIUS  = 0.07;        // cone base radius (world units)

// ── Module state ──────────────────────────────────────────────────────────────

let initialized    = false;
let threeCanvas    : HTMLCanvasElement           | null = null;
let renderer       : THREE.WebGLRenderer         | null = null;
let scene          : THREE.Scene                 | null = null;
let camera         : THREE.PerspectiveCamera     | null = null;
let spineGroup     : THREE.Group                 | null = null;
let coneMesh       : THREE.InstancedMesh         | null = null;
let coneMat        : THREE.MeshStandardMaterial  | null = null;
let floorGeo       : THREE.CircleGeometry        | null = null;
let floorMat       : THREE.MeshStandardMaterial  | null = null;
let keyLight       : THREE.DirectionalLight      | null = null;
let vizModeUnsub   : (() => void)                | null = null;

let rotationAngle  = 0;
let cameraTheta    = 0;
let lastBeatIndex  = -1;
let strobePulse    = 0;
let beatCameraKick = 0;

// Pre-computed phyllotaxis geometry (computed once at setup)
let flatPositions   : THREE.Vector3[]    = [];
let domePositions   : THREE.Vector3[]    = [];
let domeQuaternions : THREE.Quaternion[] = [];
let bandIndices     : number[]           = [];
let maxRadius       = 0;

// Reusable scratch objects (avoids per-frame allocations)
const dummy     = new THREE.Object3D();
const tmpVec    = new THREE.Vector3();
const tmpQ      = new THREE.Quaternion();
const IDENTITY_Q = new THREE.Quaternion();   // (0,0,0,1)
const UP        = new THREE.Vector3(0, 1, 0);

// ── Setup ─────────────────────────────────────────────────────────────────────

function setup(): void {
  const N = isMobile ? N_MOBILE : N_DESKTOP;

  // ── Overlay canvas ─────────────────────────────────────────────────────────
  threeCanvas = document.createElement('canvas');
  threeCanvas.style.cssText =
    'position:fixed;top:0;left:0;width:100%;height:100%;z-index:10;pointer-events:none;display:block';
  document.body.appendChild(threeCanvas);

  // ── Renderer ───────────────────────────────────────────────────────────────
  renderer = new THREE.WebGLRenderer({
    canvas   : threeCanvas,
    antialias: !isMobile,
    alpha    : true,
  });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, isMobile ? 1 : 2));
  renderer.toneMapping        = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  renderer.outputColorSpace   = THREE.SRGBColorSpace;
  if (!isMobile) {
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type    = THREE.PCFSoftShadowMap;
  }

  // ── Scene & camera ─────────────────────────────────────────────────────────
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0a0806);

  camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 100);

  // ── Phyllotaxis geometry ───────────────────────────────────────────────────
  flatPositions   = [];
  domePositions   = [];
  domeQuaternions = [];
  bandIndices     = [];
  maxRadius       = Math.sqrt(N - 1) * SPACING;

  for (let i = 0; i < N; i++) {
    const r     = Math.sqrt(i) * SPACING;
    const a     = i * GOLDEN_ANGLE;
    const px    = r * Math.cos(a);
    const pz    = r * Math.sin(a);
    const normR = Math.min(1, maxRadius > 0 ? r / maxRadius : 0);

    flatPositions.push(new THREE.Vector3(px, 0, pz));

    const domeY = Math.sqrt(Math.max(0, 1 - normR * normR)) * maxRadius;
    domePositions.push(new THREE.Vector3(px, domeY, pz));

    // Quaternion from UP to radial outward normal on dome surface
    const normal = new THREE.Vector3(px, domeY, pz);
    const nLen   = normal.length();
    if (nLen > 1e-6) normal.divideScalar(nLen); else normal.copy(UP);
    const q = new THREE.Quaternion();
    q.setFromUnitVectors(UP, normal);
    domeQuaternions.push(q);

    // Assign frequency band by radial zone (sub-bass=centre, brilliance=rim)
    bandIndices.push(Math.min(6, Math.floor(normR * 7)));
  }

  // ── Cone geometry ──────────────────────────────────────────────────────────
  // ConeGeometry: tip at +Y/2, base at -Y/2 (centred by default).
  // Translate +0.5 so base sits at Y=0 and tip at Y=+1 — then Y-scale = cone height.
  const coneGeo = new THREE.ConeGeometry(CONE_RADIUS, 1.0, 6, 1);
  coneGeo.translate(0, 0.5, 0);

  coneMat = new THREE.MeshStandardMaterial({
    color    : 0xC47B56,   // warm terracotta
    roughness: 0.72,
    metalness: 0.03,
  });

  coneMesh = new THREE.InstancedMesh(coneGeo, coneMat, N);
  coneMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  if (!isMobile) {
    coneMesh.castShadow    = true;
    coneMesh.receiveShadow = true;
  }

  spineGroup = new THREE.Group();
  spineGroup.add(coneMesh);
  scene.add(spineGroup);

  // ── Floor disc ─────────────────────────────────────────────────────────────
  floorGeo = new THREE.CircleGeometry(maxRadius + 2.0, 64);
  floorMat = new THREE.MeshStandardMaterial({
    color    : 0x0d0b08,
    roughness: 1.0,
    metalness: 0.0,
  });
  const floor = new THREE.Mesh(floorGeo, floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -0.02;
  if (!isMobile) floor.receiveShadow = true;
  scene.add(floor);

  // ── Lighting ───────────────────────────────────────────────────────────────
  // Warm overhead key light — doubles as the "strobe"
  keyLight = new THREE.DirectionalLight(0xFFE8C8, 0.8);
  keyLight.position.set(3.0, 10, 2.5);
  if (!isMobile) {
    keyLight.castShadow              = true;
    keyLight.shadow.mapSize.width    = 1024;
    keyLight.shadow.mapSize.height   = 1024;
    keyLight.shadow.camera.near      = 0.5;
    keyLight.shadow.camera.far       = 50;
    const hw = maxRadius + 2.5;
    keyLight.shadow.camera.left      = -hw;
    keyLight.shadow.camera.right     =  hw;
    keyLight.shadow.camera.top       =  hw;
    keyLight.shadow.camera.bottom    = -hw;
  }
  scene.add(keyLight);
  scene.add(keyLight.target);  // target stays at origin

  // Cool fill from opposite side — very dim
  const fillLight = new THREE.DirectionalLight(0xC8D8F0, 0.10);
  fillLight.position.set(-3, 2, -5);
  scene.add(fillLight);

  // Ambient
  scene.add(new THREE.AmbientLight(0x1E1810, 0.40));

  // ── Viz-switch hide/show ───────────────────────────────────────────────────
  vizModeUnsub = store.on('vizModeChange', (data) => {
    if (threeCanvas) threeCanvas.style.display = data === 'zoetrope' ? 'block' : 'none';
  });

  initialized = true;
}

// ── Draw (called by p5 draw loop ~60 fps) ─────────────────────────────────────

export function drawZoetrope(_p: unknown, dt: number): void {
  if (!initialized) setup();
  if (!renderer || !scene || !camera || !coneMesh || !spineGroup || !keyLight) return;

  const { amps } = getBandAverages(7);
  const N = isMobile ? N_MOBILE : N_DESKTOP;

  // ── Beat detection ────────────────────────────────────────────────────────
  const { state } = store;
  if (state.beatIntervalSec > 0 && state.isPlaying) {
    const pos    = audioEngine.getPlaybackPosition();
    const adj    = pos - state.beatOffset;
    const beatIdx = adj >= 0 ? Math.floor(adj / state.beatIntervalSec) : -1;
    if (beatIdx > lastBeatIndex) {
      lastBeatIndex  = beatIdx;
      strobePulse    = 1.0;
      beatCameraKick = 0.6;
    }
  }

  // ── Decay pulses (CHOP-style continuous) ──────────────────────────────────
  strobePulse    *= Math.pow(0.48, dt);   // fast strobe: gone in ~1–2 frames
  beatCameraKick *= Math.pow(0.86, dt);   // slower camera bump

  // ── Spin group ────────────────────────────────────────────────────────────
  // Max speed at Spin=1: ~7 rpm ≈ 0.73 rad/s ≈ 0.012 rad/frame @60fps
  const spinRate    = store.config.zoetropeSpin * 0.012;
  rotationAngle    += spinRate * dt;
  spineGroup.rotation.y = rotationAngle;

  // ── Strobe light ──────────────────────────────────────────────────────────
  const strobeAmt     = store.config.zoetropeStrobe;
  const baseIntensity = 0.55 + (amps[0] ?? 0) * 0.45;   // sub-bass breathing
  keyLight.intensity  = baseIntensity + strobePulse * strobeAmt * 14.0;

  // ── Instance matrices ─────────────────────────────────────────────────────
  const spiralT = store.config.zoetropeSpiral;

  for (let i = 0; i < N; i++) {
    const bandAmp = amps[bandIndices[i]] ?? 0;
    const h       = BASE_H + bandAmp * MAX_AMP_H;

    // Lerp position: flat disc ↔ dome
    tmpVec.lerpVectors(flatPositions[i], domePositions[i], spiralT);
    dummy.position.copy(tmpVec);

    // Slerp rotation: identity (all UP) ↔ dome outward normals
    tmpQ.copy(IDENTITY_Q);
    tmpQ.slerp(domeQuaternions[i], spiralT);
    dummy.quaternion.copy(tmpQ);

    // Scale: Y = cone height driven by audio
    dummy.scale.set(1, h, 1);

    dummy.updateMatrix();
    coneMesh.setMatrixAt(i, dummy.matrix);
  }
  coneMesh.instanceMatrix.needsUpdate = true;

  // ── Camera orbit ──────────────────────────────────────────────────────────
  // Speed tied loosely to spin so they look related, but orbit always moves
  const orbitRate  = (0.003 + store.config.zoetropeSpin * 0.004) * dt;
  cameraTheta     += orbitRate;

  // Elevation: flat=low angle (shows perspective of spinning disc), dome=higher
  const baseElev = 25 + spiralT * 15;   // 25°→40° as disc becomes dome
  const elevDeg  = baseElev + beatCameraKick * 6;
  const elevRad  = elevDeg * (Math.PI / 180);
  const orbitR   = maxRadius * 1.85 + 2;

  camera.position.set(
    orbitR * Math.cos(cameraTheta) * Math.cos(elevRad),
    orbitR * Math.sin(elevRad),
    orbitR * Math.sin(cameraTheta) * Math.cos(elevRad),
  );
  // Look slightly above the base plane so dome is centred
  camera.lookAt(0, maxRadius * spiralT * 0.35, 0);

  const aspect = window.innerWidth / window.innerHeight;
  if (camera.aspect !== aspect) {
    camera.aspect = aspect;
    camera.updateProjectionMatrix();
  }

  renderer.render(scene, camera);
}

// ── Reset (called on window resize) ───────────────────────────────────────────

export function resetZoetrope(): void {
  if (!initialized) return;
  renderer?.setSize(window.innerWidth, window.innerHeight);
  if (camera) {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
  }
}

// ── Dispose (called when switching away permanently) ──────────────────────────

export function disposeZoetrope(): void {
  if (!initialized) return;
  vizModeUnsub?.();
  vizModeUnsub = null;
  coneMesh?.geometry.dispose();
  coneMat?.dispose();
  floorGeo?.dispose();
  floorMat?.dispose();
  renderer?.dispose();
  threeCanvas?.remove();

  threeCanvas    = null;
  renderer       = null;
  scene          = null;
  camera         = null;
  spineGroup     = null;
  coneMesh       = null;
  coneMat        = null;
  floorGeo       = null;
  floorMat       = null;
  keyLight       = null;
  vizModeUnsub   = null;

  flatPositions   = [];
  domePositions   = [];
  domeQuaternions = [];
  bandIndices     = [];

  rotationAngle  = 0;
  cameraTheta    = 0;
  lastBeatIndex  = -1;
  strobePulse    = 0;
  beatCameraKick = 0;
  initialized    = false;
}
