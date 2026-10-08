/**
 * Vessels — seven lathe-turned glass vessels filled with audio-reactive liquid
 * Inspired by Roni Horn "Vatnasafn / Library of Water" (2007, Stykkishólmur, Iceland)
 * https://www.ronihorn.com/library-of-water/
 *
 * 7 tall glass vessels in an arc; each filled with liquid whose level rises
 * with its frequency band's amplitude. Camera drifts slowly through the
 * gallery at human height. Real glass-transmission material on desktop.
 * Restrained warm-amber → cool-ice palette — no neon, no rainbow glow.
 */
import * as THREE from 'three';
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages, fovForAspect } from './helpers';
import { isMobile } from '../utils/constants';

// ── Palette: 7 liquid hues from warm amber to cold crystal ──────────────────

const LIQUID_HUES: THREE.ColorRepresentation[] = [
  0xd4721a, // Sub-bass    – deep amber
  0xe8a020, // Bass        – warm gold
  0xd4c040, // Low-mid     – pale yellow
  0x90c080, // Mid         – sage
  0x60a8d0, // Upper-mid   – sky
  0x4488cc, // Presence    – steel blue
  0x8ac0e8, // Brilliance  – crystal ice
];

// ── Module state ─────────────────────────────────────────────────────────────

const VESSEL_COUNT = 7;

let initialized    = false;
let threeCanvas    : HTMLCanvasElement | null = null;
let renderer       : THREE.WebGLRenderer | null = null;
let scene          : THREE.Scene | null = null;
let camera         : THREE.PerspectiveCamera | null = null;
let vizModeUnsub   : (() => void) | null = null;

let vesselMeshes   : THREE.Mesh[] = [];
let vesselGeos     : THREE.LatheGeometry[] = [];
let vesselMats     : THREE.MeshPhysicalMaterial[] = [];

let liquidMeshes   : THREE.Mesh[] = [];
let liquidGeos     : THREE.CylinderGeometry[] = [];
let liquidMats     : THREE.MeshStandardMaterial[] = [];

let keyLight       : THREE.SpotLight | null = null;
let rimLight       : THREE.DirectionalLight | null = null;
let floorMesh      : THREE.Mesh | null = null;

// Per-frame state
let camAngle       = 0.15; // start slightly off-centre
let camTime        = 0;
let lastBeatIndex  = -1;
let beatFlash      = 0;
let smoothedAmps   = new Float32Array(VESSEL_COUNT);

// ── Vessel profile (LatheGeometry 2D cross-section) ──────────────────────────

function makeVesselProfile(): THREE.Vector2[] {
  // (radius, height) pairs describing an apothecary-style glass vessel
  // wider belly, narrow shoulder, slight lip — like a flask or specimen jar
  return [
    new THREE.Vector2(0.000, 0.000),
    new THREE.Vector2(0.220, 0.000),
    new THREE.Vector2(0.270, 0.060),
    new THREE.Vector2(0.290, 0.200),
    new THREE.Vector2(0.285, 0.600),
    new THREE.Vector2(0.275, 1.200),
    new THREE.Vector2(0.260, 1.800),
    new THREE.Vector2(0.235, 2.300),
    new THREE.Vector2(0.195, 2.700),
    new THREE.Vector2(0.160, 2.900),
    new THREE.Vector2(0.170, 3.000),
    new THREE.Vector2(0.175, 3.050),
  ];
}

// ── Setup ─────────────────────────────────────────────────────────────────────

function setup(): void {
  // Overlay canvas
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
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, isMobile ? 1.0 : 1.5));
  renderer.shadowMap.enabled = !isMobile;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.3;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x07090d);
  scene.fog = new THREE.FogExp2(0x07090d, 0.07);

  {
    const aspect = window.innerWidth / window.innerHeight;
    camera = new THREE.PerspectiveCamera(fovForAspect(42, aspect), aspect, 0.1, 80);
  }

  // ── Lights ───────────────────────────────────────────────────────────────

  // Warm overhead spotlight — gallery track light
  keyLight = new THREE.SpotLight(0xffeedd, 4.5);
  keyLight.position.set(1, 9, 4);
  keyLight.angle   = 0.6;
  keyLight.penumbra = 0.55;
  keyLight.castShadow = !isMobile;
  if (keyLight.shadow) {
    keyLight.shadow.mapSize.set(isMobile ? 512 : 1024, isMobile ? 512 : 1024);
    keyLight.shadow.camera.near = 1;
    keyLight.shadow.camera.far  = 25;
  }
  scene.add(keyLight);
  scene.add(keyLight.target);
  keyLight.target.position.set(0, 0, 0);

  // Cool ambient fill — simulates bounce light from pale concrete walls
  const ambientLight = new THREE.AmbientLight(0xc8d8ec, 0.35);
  scene.add(ambientLight);

  // Cold rim/back light — separates vessels from background
  rimLight = new THREE.DirectionalLight(0xb0c8e4, 0.5);
  rimLight.position.set(-4, 4, -8);
  scene.add(rimLight);

  // ── Floor ─────────────────────────────────────────────────────────────────

  const floorGeo = new THREE.PlaneGeometry(50, 50);
  const floorMat = new THREE.MeshStandardMaterial({
    color: 0x0e1218,
    roughness: 0.92,
    metalness: 0.08,
  });
  floorMesh = new THREE.Mesh(floorGeo, floorMat);
  floorMesh.rotation.x = -Math.PI / 2;
  floorMesh.receiveShadow = !isMobile;
  scene.add(floorMesh);

  // ── Vessels ──────────────────────────────────────────────────────────────

  const profile   = makeVesselProfile();
  const latSegs   = isMobile ? 18 : 40;
  const cylSegs   = isMobile ? 12 : 24;

  vesselMeshes = [];
  vesselGeos   = [];
  vesselMats   = [];
  liquidMeshes = [];
  liquidGeos   = [];
  liquidMats   = [];

  for (let i = 0; i < VESSEL_COUNT; i++) {
    const t  = (i / (VESSEL_COUNT - 1)) * 2 - 1; // -1..1
    const x  = t * 4.2;                            // span ≈8.4 units
    const z  = -t * t * 1.2;                       // gentle concave arc

    // Outer glass vessel ──────────────────────────────────────────────────
    const vGeo = new THREE.LatheGeometry(profile, latSegs);
    vesselGeos.push(vGeo);

    const vMat = new THREE.MeshPhysicalMaterial({
      color    : 0xffffff,
      roughness: 0.04,
      metalness: 0.0,
      transmission: isMobile ? 0.0 : 0.88,
      thickness   : 0.15,
      ior         : 1.52,
      transparent : true,
      opacity     : isMobile ? 0.28 : 1.0,
      side        : THREE.FrontSide,
    });
    vesselMats.push(vMat);

    const vessel = new THREE.Mesh(vGeo, vMat);
    vessel.position.set(x, 0, z);
    vessel.castShadow  = true;
    vessel.receiveShadow = false;
    scene.add(vessel);
    vesselMeshes.push(vessel);

    // Inner liquid ────────────────────────────────────────────────────────
    // Cylinder height=1.0, centred at y=0 → bottom at y=-0.5
    // We reposition so bottom stays at y=0.05 (floor of vessel cavity)
    const lGeo = new THREE.CylinderGeometry(0.200, 0.205, 1.0, cylSegs, 1, false);
    liquidGeos.push(lGeo);

    const lColor = new THREE.Color(LIQUID_HUES[i]);
    const lMat = new THREE.MeshStandardMaterial({
      color  : lColor,
      emissive: lColor,
      emissiveIntensity: 0.20,
      roughness: 0.05,
      metalness: 0.0,
      transparent: true,
      opacity: 0.80,
    });
    liquidMats.push(lMat);

    const liquid = new THREE.Mesh(lGeo, lMat);
    liquid.position.set(x, 0.5, z); // updated each frame
    scene.add(liquid);
    liquidMeshes.push(liquid);
  }

  smoothedAmps  = new Float32Array(VESSEL_COUNT);
  lastBeatIndex = -1;
  beatFlash     = 0;
  camAngle      = 0.15;
  camTime       = 0;

  // Hide canvas when switching away from this viz
  vizModeUnsub = store.on('vizModeChange', (data) => {
    if (!threeCanvas) return;
    threeCanvas.style.display = data === 'vessels' ? 'block' : 'none';
  });

  initialized = true;
}

// ── Draw ──────────────────────────────────────────────────────────────────────

export function drawVessels(_p: unknown, dt: number): void {
  if (!initialized) setup();

  const { amps } = getBandAverages(VESSEL_COUNT);
  const { state, config } = store;

  const fill    = config.vesselsFill;    // 0–1: base level + amplitude sensitivity
  const clarity = config.vesselsClarity; // 0–1: frosted (0) → crystal clear (1)
  const orbit   = config.vesselsOrbit;   // 0–1: camera drift speed

  // ── Audio smoothing ───────────────────────────────────────────────────────
  for (let i = 0; i < VESSEL_COUNT; i++) {
    const a = amps[i] ?? 0;
    smoothedAmps[i] += (a - smoothedAmps[i]) * Math.min(0.12 * dt, 0.9);
  }

  // ── Beat detection ────────────────────────────────────────────────────────
  if (state.beatIntervalSec > 0 && state.isPlaying) {
    const pos     = audioEngine.getPlaybackPosition();
    const adj     = pos - state.beatOffset;
    const beatIdx = adj >= 0 ? Math.floor(adj / state.beatIntervalSec) : -1;
    if (beatIdx > lastBeatIndex) {
      lastBeatIndex = beatIdx;
      beatFlash = 1.0;
    }
  }
  beatFlash *= Math.pow(0.78, dt);
  if (beatFlash < 0.005) beatFlash = 0;

  // ── Camera motion ─────────────────────────────────────────────────────────
  // Slow sinusoidal sweep across the vessel arc (not a full circle)
  // plus a gentle vertical bob
  camTime += dt * 0.016 * orbit; // seconds equivalent
  const sweepAngle = Math.sin(camTime * 0.12) * 0.65; // ±37°
  camAngle += (sweepAngle - camAngle) * 0.005 * dt;

  const camDist = 11;
  const camY    = 1.85 + Math.sin(camTime * 0.07) * 0.25 + beatFlash * 0.12;
  const camX    = Math.sin(camAngle) * camDist;
  const camZ    = Math.cos(camAngle) * camDist;

  if (camera) {
    camera.position.set(camX, camY, camZ);
    camera.lookAt(0, 1.6, 0);
  }

  // ── Key light: beat flash + amplitude ─────────────────────────────────────
  if (keyLight) {
    const avgAmp = Array.from(smoothedAmps).reduce((s, v) => s + v, 0) / VESSEL_COUNT;
    keyLight.intensity = 4.5 + avgAmp * 2.0 + beatFlash * 6.0;
  }

  // ── Update vessels ────────────────────────────────────────────────────────
  for (let i = 0; i < VESSEL_COUNT; i++) {
    const amp = smoothedAmps[i] ?? 0;

    // Liquid level: base fill level + audio-driven rise
    const baseFill   = fill * 0.55;           // slider sets resting depth
    const audioRise  = amp * (0.4 + fill * 0.8);
    const liquidH    = Math.max(0.04, Math.min(2.85, baseFill * 2.85 + audioRise * 2.85));

    // Cylinder scales from centre — reposition to keep bottom at y≈0.05
    const liqMesh = liquidMeshes[i];
    liqMesh.scale.y = liquidH;
    liqMesh.position.y = 0.05 + liquidH * 0.5;

    // Emissive: brightest when loud or beat
    liquidMats[i].emissiveIntensity = 0.12 + amp * 0.90 + beatFlash * 0.55;

    // Glass clarity: roughness inversely tracks slider; transmission holds at max
    const roughTarget = 0.38 * (1.0 - clarity) + 0.02;
    vesselMats[i].roughness = roughTarget;
    if (!isMobile) {
      vesselMats[i].transmission = 0.72 + clarity * 0.22;
    }
  }

  renderer?.render(scene!, camera!);
}

// ── Reset (resize) ────────────────────────────────────────────────────────────

export function resetVessels(): void {
  if (!initialized) return;
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer?.setSize(w, h);
  if (camera) {
    camera.aspect = w / h;
    camera.fov    = fovForAspect(42, camera.aspect);
    camera.updateProjectionMatrix();
  }
}

// ── Dispose ───────────────────────────────────────────────────────────────────

export function disposeVessels(): void {
  if (!initialized) return;

  vizModeUnsub?.();
  vizModeUnsub = null;

  for (const geo of vesselGeos)  geo.dispose();
  for (const mat of vesselMats)  mat.dispose();
  for (const geo of liquidGeos)  geo.dispose();
  for (const mat of liquidMats)  mat.dispose();

  floorMesh?.geometry.dispose();
  (floorMesh?.material as THREE.Material | undefined)?.dispose();
  keyLight?.dispose();
  rimLight?.dispose();

  renderer?.dispose();
  threeCanvas?.remove();

  threeCanvas  = null;
  renderer     = null;
  scene        = null;
  camera       = null;
  keyLight     = null;
  rimLight     = null;
  floorMesh    = null;
  vesselMeshes = [];
  vesselGeos   = [];
  vesselMats   = [];
  liquidMeshes = [];
  liquidGeos   = [];
  liquidMats   = [];

  lastBeatIndex = -1;
  beatFlash     = 0;
  camAngle      = 0.15;
  camTime       = 0;
  smoothedAmps  = new Float32Array(VESSEL_COUNT);
  initialized   = false;
}
