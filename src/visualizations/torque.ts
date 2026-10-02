/**
 * Torque — Richard Serra steel plate installation
 *
 * Massive curved Corten-steel walls (torqued-ellipse sections) fill a darkened
 * industrial gallery; camera orbits inside the installation at eye level,
 * threading through the tight passages between plates; a single strong warm
 * sidelight (evoking Dia:Beacon's clerestory windows) casts deep shadows;
 * bass leans the plates; beats lurch the camera forward; no additive neon glow,
 * no rainbow palette — form and light carry everything.
 *
 * Inspired by Richard Serra "Torqued Ellipses" (1997–1998, Dia:Beacon,
 * Dia Art Foundation, Beacon NY, permanent collection since 2003).
 * https://www.diaart.org/exhibition/exhibitions-projects/richard-serra-exhibition
 */
import * as THREE from 'three';
import { store } from '../state/store';
import { getBandAverages } from './helpers';
import { audioEngine } from '../audio/engine';
import { isMobile } from '../utils/constants';

// ── Module state ───────────────────────────────────────────────────────────────

let initialized = false;
let threeCanvas: HTMLCanvasElement | null = null;
let renderer: THREE.WebGLRenderer | null = null;
let scene: THREE.Scene | null = null;
let camera: THREE.PerspectiveCamera | null = null;
let keyLight: THREE.DirectionalLight | null = null;
let vizModeUnsub: (() => void) | null = null;

const plateMeshes:    THREE.Mesh[] = [];
const plateMaterials: THREE.MeshStandardMaterial[] = [];
const plateBaseRotY:  number[] = [];
const plateBaseRotZ:  number[] = [];
const platePosAngle:  number[] = [];  // world angle for lean-axis computation

const camPathPoints: THREE.Vector3[] = [];
let camPathT      = 0.0;
let lurchVel      = 0.0;
let lastBeatIndex = -1;
let cachedPlates  = -1;
let animTime      = 0.0;

// ── Geometry ───────────────────────────────────────────────────────────────────

function makePlateGeom(): THREE.BufferGeometry {
  const arcSegs  = isMobile ? 18 : 36;
  const hSegs    = isMobile ?  4 :  8;
  // Open partial-cylinder arc: 225° gives a deep C-curve
  return new THREE.CylinderGeometry(
    2.6, 2.6,           // top / bottom radius (uniform — pure cylinder section)
    8.0,                // height
    arcSegs, hSegs,
    true,               // open-ended (no top / bottom caps)
    0,
    Math.PI * 1.25      // 225° arc
  );
}

// ── Camera path ────────────────────────────────────────────────────────────────

function buildCamPath(n: number): void {
  camPathPoints.length = 0;
  const STEPS = isMobile ? 300 : 500;
  const rBase = 1.3;     // orbit radius inside the installation
  const eyeH  = 1.6;     // eye level
  const vOsc  = 0.5;     // vertical oscillation range

  for (let i = 0; i < STEPS; i++) {
    const t   = i / STEPS;
    const ang = t * Math.PI * 2 * 2.3;              // 2.3 orbits total
    const weave = 0.45 * Math.sin(t * Math.PI * 2 * n); // weave count = plate count
    const r = rBase + weave;
    camPathPoints.push(new THREE.Vector3(
      Math.cos(ang) * r,
      eyeH + vOsc * Math.sin(t * Math.PI * 2 * 2.5),
      Math.sin(ang) * r,
    ));
  }
}

// ── Plate setup ────────────────────────────────────────────────────────────────

const STEEL_COLOR = new THREE.Color(0x1e1c1a);  // dark gunmetal
const RUST_COLOR  = new THREE.Color(0x6b2e10);  // deep Corten rust

function rebuildPlates(n: number, patina: number): void {
  for (const m of plateMeshes) { scene?.remove(m); m.geometry.dispose(); }
  for (const m of plateMaterials) m.dispose();
  plateMeshes.length    = 0;
  plateMaterials.length = 0;
  plateBaseRotY.length  = 0;
  plateBaseRotZ.length  = 0;
  platePosAngle.length  = 0;

  const PLATE_RADIUS = 3.1;

  for (let i = 0; i < n; i++) {
    const ang = (i / n) * Math.PI * 2;

    const geom = makePlateGeom();
    const mat  = new THREE.MeshStandardMaterial({
      color:     STEEL_COLOR.clone().lerp(RUST_COLOR, patina),
      roughness: 0.93,
      metalness: 0.55,
      side: THREE.DoubleSide,
    });

    const mesh = new THREE.Mesh(geom, mat);
    mesh.castShadow    = true;
    mesh.receiveShadow = !isMobile;

    mesh.position.set(
      Math.cos(ang) * PLATE_RADIUS,
      0,
      Math.sin(ang) * PLATE_RADIUS,
    );
    // Rotate so the arc opens inward; alternate a slight Z lean per plate
    mesh.rotation.y = ang + Math.PI * 0.5;
    mesh.rotation.z = 0.05 * (i % 2 === 0 ? 1 : -1);

    plateBaseRotY.push(mesh.rotation.y);
    plateBaseRotZ.push(mesh.rotation.z);
    platePosAngle.push(ang);

    scene?.add(mesh);
    plateMeshes.push(mesh);
    plateMaterials.push(mat);
  }

  buildCamPath(n);
  cachedPlates = n;
}

// ── Setup ──────────────────────────────────────────────────────────────────────

function setup(): void {
  initialized = true;

  threeCanvas = document.createElement('canvas');
  threeCanvas.style.cssText =
    'position:fixed;top:0;left:0;width:100%;height:100%;z-index:10;pointer-events:none;display:block';
  document.body.appendChild(threeCanvas);

  renderer = new THREE.WebGLRenderer({
    canvas:    threeCanvas,
    antialias: !isMobile,
    alpha:     true,
  });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, isMobile ? 1.0 : 1.5));
  renderer.shadowMap.enabled  = !isMobile;
  renderer.shadowMap.type     = THREE.PCFSoftShadowMap;
  renderer.toneMapping        = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.outputColorSpace   = THREE.SRGBColorSpace;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x050506);
  scene.fog        = new THREE.FogExp2(0x050506, 0.075);

  camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 50);

  // Warm sidelight — Dia:Beacon's clerestory windows admit raking daylight
  keyLight = new THREE.DirectionalLight(0xffd8b0, 3.2);
  keyLight.position.set(7, 11, -5);
  keyLight.castShadow = !isMobile;
  if (keyLight.shadow) {
    const sc = keyLight.shadow.camera as THREE.OrthographicCamera;
    keyLight.shadow.mapSize.set(isMobile ? 512 : 1024, isMobile ? 512 : 1024);
    sc.near = 0.5; sc.far = 45;
    sc.left = -14; sc.right = 14;
    sc.top  =  14; sc.bottom = -14;
  }
  scene.add(keyLight);

  // Cool fill from opposite low angle
  const fill = new THREE.DirectionalLight(0x304860, 1.0);
  fill.position.set(-6, 2, 7);
  scene.add(fill);

  // Minimal ambient — keep shadow interiors deeply dark
  scene.add(new THREE.AmbientLight(0x0c0c10, 1.2));

  // Dark polished concrete floor
  const floorGeom = new THREE.PlaneGeometry(40, 40, 1, 1);
  const floorMat  = new THREE.MeshStandardMaterial({
    color:     0x0c0c0c,
    roughness: 0.98,
    metalness: 0.0,
  });
  const floor = new THREE.Mesh(floorGeom, floorMat);
  floor.rotation.x  = -Math.PI / 2;
  floor.receiveShadow = !isMobile;
  scene.add(floor);

  // Initial plates
  const numPlates = Math.round(1 + store.config.torquePlates * 4);
  rebuildPlates(numPlates, store.config.torquePatina);

  vizModeUnsub = store.on('vizModeChange', () => disposeTorque());
}

// ── Draw ───────────────────────────────────────────────────────────────────────

export function drawTorque(_p: unknown, dt: number): void {
  if (!initialized) setup();
  if (!renderer || !scene || !camera) return;

  const { amps } = getBandAverages(7);
  const subBass  = amps[0] ?? 0;
  const bass     = amps[1] ?? 0;
  const lowMid   = amps[2] ?? 0;
  const mid      = amps[3] ?? 0;
  const upperMid = amps[4] ?? 0;
  const midAvg   = (lowMid + mid + upperMid) / 3;

  animTime += dt * 0.016;

  // Config
  const numPlates = Math.round(1 + store.config.torquePlates * 4);
  const lean      = store.config.torqueLean;
  const patina    = store.config.torquePatina;

  if (numPlates !== cachedPlates) rebuildPlates(numPlates, patina);

  // Update material color to reflect patina slider (cheap — only lerps color)
  for (const mat of plateMaterials) {
    mat.color.copy(STEEL_COLOR).lerp(RUST_COLOR, patina);
  }

  // Beat detection (matches shard.ts / neon.ts pattern)
  const { state } = store;
  if (state.beatIntervalSec > 0 && state.isPlaying) {
    const pos      = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    const beatI    = adjusted >= 0 ? Math.floor(adjusted / state.beatIntervalSec) : -1;
    if (beatI > lastBeatIndex) {
      lastBeatIndex = beatI;
      lurchVel = 0.0022;  // camera surge on beat
    }
  }

  // Advance camera along path
  lurchVel  *= Math.pow(0.88, dt);
  const fwd  = 0.00013 * dt;
  camPathT   = (camPathT + fwd + lurchVel) % 1.0;

  if (camPathPoints.length > 0) {
    const total = camPathPoints.length;
    const rawI  = camPathT * total;
    const idx   = Math.floor(rawI) % total;
    const frac  = rawI - Math.floor(rawI);
    const ahead = (idx + Math.floor(total * 0.025)) % total; // look-ahead ~2.5% of path

    const p0 = camPathPoints[idx];
    const p1 = camPathPoints[(idx + 1) % total];
    const pA = camPathPoints[ahead];

    const camPos = p0.clone().lerp(p1, frac);
    camPos.y += subBass * 0.1;   // sub-bass makes floor feel heavier

    // Look toward ahead-point and slightly up at high bass amplitude
    const lookTarget = pA.clone();
    lookTarget.y += bass * 0.4;  // bass tilts gaze upward toward plate tops

    camera.position.copy(camPos);
    camera.lookAt(lookTarget);
  }

  // Plate lean: each plate sways toward/away from center driven by its band
  const maxLean = lean * 0.28;
  for (let i = 0; i < plateMeshes.length; i++) {
    const mesh   = plateMeshes[i];
    const bIdx   = Math.min(i, 6);
    const amp    = amps[bIdx] ?? 0;
    const phase  = platePosAngle[i];

    mesh.rotation.y = plateBaseRotY[i];
    mesh.rotation.z = plateBaseRotZ[i] + amp * maxLean * Math.sin(animTime * 0.5 + phase);
    mesh.rotation.x =                    amp * maxLean * 0.4 * Math.cos(animTime * 0.4 + phase * 0.7);
  }

  // Key light breathes with mid-range energy — walls catch changing light
  if (keyLight) {
    keyLight.intensity = 2.8 + midAvg * 0.8 + bass * 0.5;
  }

  renderer.render(scene, camera);
}

// ── Reset ──────────────────────────────────────────────────────────────────────

export function resetTorque(): void {
  if (!initialized) return;
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer?.setSize(w, h);
  if (camera) { camera.aspect = w / h; camera.updateProjectionMatrix(); }
}

// ── Dispose ────────────────────────────────────────────────────────────────────

export function disposeTorque(): void {
  if (!initialized) return;
  vizModeUnsub?.();
  vizModeUnsub = null;
  for (const m of plateMeshes)    { scene?.remove(m); m.geometry.dispose(); }
  for (const m of plateMaterials) { m.dispose(); }
  plateMeshes.length    = 0;
  plateMaterials.length = 0;
  plateBaseRotY.length  = 0;
  plateBaseRotZ.length  = 0;
  platePosAngle.length  = 0;
  camPathPoints.length  = 0;
  renderer?.dispose();
  threeCanvas?.remove();
  threeCanvas    = null;
  renderer       = null;
  scene          = null;
  camera         = null;
  keyLight       = null;
  initialized    = false;
  cachedPlates   = -1;
  camPathT       = 0;
  lurchVel       = 0;
  lastBeatIndex  = -1;
  animTime       = 0;
}
