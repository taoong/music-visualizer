/**
 * Scales — Three.js WebGL overlay visualization
 * Dense overlapping metallic scales tessellate a large convex surface; each
 * of 7 horizontal band-zones fans its scales outward proportional to audio
 * amplitude. Inspired by Nick Cave's "Soundsuits" textile sculptures and
 * El Anatsui's shimmering bottle-cap tapestries.
 *
 * Key design choices (anti-house-style):
 * - No concentric rings, no rainbow hue mapping
 * - Single warm 2-point studio rig (amber key + steel fill), no neon glow
 * - CHOP-style continuous lerp — beat adds a decaying kick, never snaps state
 * - Camera slowly sweeps through three elevation phases; no radial pulse
 * - Copper/bronze near-monochrome palette (warmth shifts with bass/treble ratio)
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

// ── Config ────────────────────────────────────────────────────────────────────

const SURFACE_RADIUS  = 28;        // radius of the convex host sphere
const SCALE_PITCH     = isMobile ? 2.6 : 2.0;    // angular grid spacing (deg)
const SCALE_SIZE      = isMobile ? 1.6 : 1.3;    // base half-height of each scale
const MAX_TILT_ANGLE  = Math.PI * 0.42;           // max lift angle when fully loud
const CAM_DIST_BASE   = 44;
const BLOOM_STRENGTH  = isMobile ? 0.0 : 0.25;   // very subtle; not neon

function getBandForLat(latDeg: number): number {
  const a = Math.abs(latDeg);
  if (a <= 15)  return 0; // sub-bass
  if (a <= 30)  return 1; // bass
  if (a <= 50)  return 2 + (latDeg >= 0 ? 1 : 0); // lowMid / mid
  if (a <= 70)  return 4 + (latDeg >= 0 ? 1 : 0); // upperMid / presence
  return 6;               // brilliance
}

// ── Module state ──────────────────────────────────────────────────────────────

let initialized    = false;
let threeCanvas    : HTMLCanvasElement | null = null;
let renderer       : THREE.WebGLRenderer | null = null;
let scene          : THREE.Scene | null = null;
let camera         : THREE.PerspectiveCamera | null = null;
let composer       : EffectComposer | null = null;
let vizModeUnsub   : (() => void) | null = null;

let scalesMesh     : THREE.InstancedMesh | null = null;
let scaleCount     = 0;
let keyLight       : THREE.DirectionalLight | null = null;

// Per-instance data stored once at setup
interface ScaleData {
  bandIdx : number;    // audio band this scale belongs to
  lat     : number;    // latitude in degrees (−90…+90)
  lon     : number;    // longitude in degrees (0…360)
  baseQuat: THREE.Quaternion; // rest-pose orientation
  hingeAxis: THREE.Vector3;  // local axis to rotate around when lifting
}

let instanceData: ScaleData[] = [];
let bandAmps      = new Float32Array(7);
let smoothedAmps  = new Float32Array(7);
let beatKick      = 0;
let lastBeatIndex = -1;
let time          = 0;

// Camera motion
let camTheta    = 0;    // azimuth (radians)
let camElevation = 0.3; // elevation above equator (radians)
let camPhase    = 0;    // slow oscillation timer

const _mat4  = new THREE.Matrix4();
const _pos   = new THREE.Vector3();
const _quat  = new THREE.Quaternion();
const _scale = new THREE.Vector3(1, 1, 1);
const _rotQ  = new THREE.Quaternion();
const _axisV = new THREE.Vector3();

// ── Build scale geometry (a small flattened teardrop/petal shape) ─────────────

function buildScaleGeometry(size: number): THREE.BufferGeometry {
  // A scale is a small shield shape: wider at the tip, narrow at the base
  // We build it as a flat polygon in the XZ plane, hinged at origin (base),
  // tip pointing in +Z direction.
  const shape = new THREE.Shape();
  const h = size;
  const w = size * 0.55;
  // Base (hinge point) at z=0, tip at z=h
  shape.moveTo(0, 0);
  shape.bezierCurveTo(-w, h * 0.2, -w * 0.8, h * 0.6, 0, h);
  shape.bezierCurveTo(w * 0.8, h * 0.6, w, h * 0.2, 0, 0);

  const geo = new THREE.ShapeGeometry(shape, 6);
  // ShapeGeometry is in XY plane; rotate so it lies in XZ plane (facing +Y)
  geo.applyMatrix4(new THREE.Matrix4().makeRotationX(-Math.PI / 2));
  // Center: hinge at origin, scale extends in -Z direction locally.
  // After rotation: X stays, Z becomes the tip direction, Y is "up out of surface"
  return geo;
}

// ── Setup ─────────────────────────────────────────────────────────────────────

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
  renderer.shadowMap.enabled = !isMobile;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0d0a08);  // very dark warm brown
  scene.fog = new THREE.Fog(0x0d0a08, 50, 120);

  const aspect = window.innerWidth / window.innerHeight;
  camera = new THREE.PerspectiveCamera(52, aspect, 0.1, 300);

  // ── Lights ──

  // Key: warm amber directional, casting shadows
  keyLight = new THREE.DirectionalLight(0xffcf88, 2.8);
  keyLight.position.set(30, 25, 20);
  keyLight.castShadow = !isMobile;
  if (keyLight.shadow) {
    keyLight.shadow.mapSize.set(1024, 1024);
    keyLight.shadow.camera.near = 1;
    keyLight.shadow.camera.far = 150;
    keyLight.shadow.camera.left = -50;
    keyLight.shadow.camera.right = 50;
    keyLight.shadow.camera.top = 50;
    keyLight.shadow.camera.bottom = -50;
    keyLight.shadow.bias = -0.001;
  }
  scene.add(keyLight);

  // Fill: cool steel-blue from opposite side
  const fillLight = new THREE.DirectionalLight(0x8aacdd, 0.6);
  fillLight.position.set(-20, 10, -15);
  scene.add(fillLight);

  // Ambient: very dim warm
  scene.add(new THREE.AmbientLight(0x3d2a1a, 0.4));

  // ── Build instanced scales mesh ──

  buildScalesMesh();

  // ── Post-processing (desktop only) ──

  if (!isMobile) {
    const renderPass = new RenderPass(scene, camera);
    const bloomPass = new UnrealBloomPass(
      new THREE.Vector2(window.innerWidth, window.innerHeight),
      BLOOM_STRENGTH, 0.4, 0.95,
    );
    const outputPass = new OutputPass();
    composer = new EffectComposer(renderer);
    composer.addPass(renderPass);
    composer.addPass(bloomPass);
    composer.addPass(outputPass);
  }

  vizModeUnsub = store.on('vizModeChange', () => {
    if (store.state.vizMode !== 'scales') disposeScales();
  });

  initialized = true;
}

// ── Build the instanced mesh from scratch ────────────────────────────────────

function buildScalesMesh(): void {
  if (!scene) return;

  // Remove existing mesh if any
  if (scalesMesh) {
    scene.remove(scalesMesh);
    scalesMesh.geometry.dispose();
    (scalesMesh.material as THREE.Material).dispose();
    scalesMesh = null;
    instanceData = [];
  }

  // Determine grid resolution from slider (scalesDensity: 0=large/sparse → 1=small/dense)
  const density = store.config.scalesDensity ?? 0.5;
  const pitch = SCALE_PITCH * (1 + (1 - density) * 1.5); // 2°–5° spacing
  const scaleSize = SCALE_SIZE * (1 + (1 - density) * 0.5);

  const geo = buildScaleGeometry(scaleSize);

  // Copper/bronze palette — no per-band rainbow
  const polish = store.config.scalesPolish ?? 0.5;
  const mat = new THREE.MeshStandardMaterial({
    color: 0xb87333,         // copper
    metalness: 0.75 + polish * 0.2,
    roughness: 0.5 - polish * 0.4,
    envMapIntensity: 1.0,
  });

  // Place scales on the front hemisphere (lon: -90 to +90, lat: -80 to +80)
  const instances: ScaleData[] = [];

  for (let latDeg = -78; latDeg <= 78; latDeg += pitch) {
    // longitude range narrows at poles (cosine of latitude)
    const cosLat = Math.cos((latDeg * Math.PI) / 180);
    const lonStep = pitch / Math.max(cosLat, 0.15);
    for (let lonDeg = -90; lonDeg < 90; lonDeg += lonStep) {
      const latRad = (latDeg * Math.PI) / 180;
      const lonRad = (lonDeg * Math.PI) / 180;

      // Position on sphere surface
      const px = SURFACE_RADIUS * Math.cos(latRad) * Math.sin(lonRad);
      const py = SURFACE_RADIUS * Math.sin(latRad);
      const pz = SURFACE_RADIUS * Math.cos(latRad) * Math.cos(lonRad);

      // Surface normal (outward)
      const normal = new THREE.Vector3(px, py, pz).normalize();

      // Orientation: scale lies flat on surface, tip pointing "upward" along sphere
      // We want: local +Y = normal, local +Z = toward north pole
      const up = new THREE.Vector3(0, 1, 0);
      const right = new THREE.Vector3().crossVectors(up, normal).normalize();
      if (right.lengthSq() < 0.001) {
        right.set(1, 0, 0);
      }
      const forward = new THREE.Vector3().crossVectors(normal, right).normalize();

      // Build rest-pose matrix: position on sphere + orientation
      const rot = new THREE.Matrix4().makeBasis(right, normal, forward);
      const baseQuat = new THREE.Quaternion().setFromRotationMatrix(rot);

      // Hinge axis = right vector (scales fan up around the base, tilting outward)
      const hingeAxis = right.clone();

      instances.push({
        bandIdx: getBandForLat(latDeg),
        lat: latDeg,
        lon: lonDeg,
        baseQuat,
        hingeAxis,
      });
    }
  }

  scaleCount = instances.length;
  instanceData = instances;

  scalesMesh = new THREE.InstancedMesh(geo, mat, scaleCount);
  scalesMesh.castShadow = !isMobile;
  scalesMesh.receiveShadow = !isMobile;
  scalesMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  scene.add(scalesMesh);

  // Set initial transforms (flat rest pose)
  updateScaleMatrices(new Float32Array(7));
  scalesMesh.instanceMatrix.needsUpdate = true;
}

// ── Per-frame matrix update ────────────────────────────────────────────────────

function updateScaleMatrices(amps: Float32Array): void {
  if (!scalesMesh) return;

  const tiltScale = store.config.scalesTilt ?? 0.5;
  const beatBoost = beatKick * 0.4;

  for (let i = 0; i < scaleCount; i++) {
    const d = instanceData[i];
    const amp = amps[d.bandIdx] ?? 0;
    // Continuous CHOP-style tilt
    const tiltAngle = (amp + beatBoost) * MAX_TILT_ANGLE * tiltScale;

    // Position on sphere
    const latRad = (d.lat * Math.PI) / 180;
    const lonRad = (d.lon * Math.PI) / 180;
    _pos.set(
      SURFACE_RADIUS * Math.cos(latRad) * Math.sin(lonRad),
      SURFACE_RADIUS * Math.sin(latRad),
      SURFACE_RADIUS * Math.cos(latRad) * Math.cos(lonRad),
    );

    // Rotation: base orientation + audio-driven tilt around hinge axis
    _axisV.copy(d.hingeAxis);
    _rotQ.setFromAxisAngle(_axisV, tiltAngle);
    _quat.copy(d.baseQuat).multiply(_rotQ);

    _mat4.compose(_pos, _quat, _scale);
    scalesMesh.setMatrixAt(i, _mat4);
  }
  scalesMesh.instanceMatrix.needsUpdate = true;
}

// ── Draw ──────────────────────────────────────────────────────────────────────

export function drawScales(_p: unknown, dt: number): void {
  if (!initialized) setup();
  if (!renderer || !scene || !camera) return;

  time += dt * 0.016;

  const { amps } = getBandAverages(7);
  const cfg = store.config;

  // Smooth audio → CHOP-style continuous lerp
  const lerpRate = 0.12;
  for (let b = 0; b < 7; b++) {
    const target = (amps[b] ?? 0) * 1.5;
    smoothedAmps[b] += (target - smoothedAmps[b]) * lerpRate * dt;
    bandAmps[b] = smoothedAmps[b];
  }

  // Beat detection → kick impulse (continuous decay, not state snap)
  if (store.state.beatIntervalSec > 0 && store.state.isPlaying) {
    const pos      = audioEngine.getPlaybackPosition();
    const adjusted = pos - store.state.beatOffset;
    const beatIdx  = adjusted >= 0 ? Math.floor(adjusted / store.state.beatIntervalSec) : -1;
    if (beatIdx > lastBeatIndex) {
      lastBeatIndex = beatIdx;
      beatKick = 1.0;
    }
  }
  beatKick *= Math.pow(0.82, dt);
  if (beatKick < 0.001) beatKick = 0;

  // Rebuild mesh if density slider changed structurally
  // (checked once per second to avoid rebuilding every frame)
  if (time % 1 < 0.016) {
    // density-driven count change is expensive; only rebuild if significantly different
    // We skip continuous rebuild; density only takes effect on next dispose/setup
  }

  // ── Camera motion ──
  // Slow azimuthal drift + subtle elevation oscillation
  camTheta += dt * 0.0028 * cfg.rotationSpeed;
  camPhase += dt * 0.0015;
  camElevation = 0.25 + Math.sin(camPhase * 0.7) * 0.18 + beatKick * 0.08;

  const camR = CAM_DIST_BASE + (1 - (bandAmps[0] + bandAmps[1]) * 0.5) * 4;
  camera.position.set(
    camR * Math.sin(camTheta) * Math.cos(camElevation),
    camR * Math.sin(camElevation),
    camR * Math.cos(camTheta) * Math.cos(camElevation),
  );
  camera.lookAt(0, 0, 0);

  // ── Key light — orbits slowly, casting shifting shadows ──
  if (keyLight) {
    const keyAngle = time * 0.08 + 0.6;
    keyLight.position.set(
      30 * Math.cos(keyAngle),
      25 + Math.sin(keyAngle * 0.5) * 5,
      20 * Math.sin(keyAngle),
    );
    // Warmth: bass lifts toward amber, brilliance toward cool
    const bassEnergy = (bandAmps[0] + bandAmps[1]) * 0.5;
    const trebEnergy = (bandAmps[5] + bandAmps[6]) * 0.5;
    const warmthRatio = 0.5 + bassEnergy * 0.3 - trebEnergy * 0.15;
    const warmR = 1.0;
    const warmG = 0.78 + warmthRatio * 0.1;
    const warmB = 0.53 - warmthRatio * 0.12;
    keyLight.color.setRGB(warmR, warmG, warmB);
    keyLight.intensity = 2.5 + (bandAmps[0] + beatKick * 0.5) * 1.0;
  }

  // ── Update scale transforms ──
  updateScaleMatrices(bandAmps);

  // ── Render ──
  if (composer) {
    // Update bloom from tilt slider
    const bloom = composer.passes[1] as UnrealBloomPass;
    bloom.strength = BLOOM_STRENGTH * cfg.scalesTilt;
    composer.render();
  } else {
    renderer.render(scene, camera);
  }
}

// ── Reset ─────────────────────────────────────────────────────────────────────

export function resetScales(): void {
  if (!initialized) return;
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer?.setSize(w, h);
  if (camera) {
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  composer?.setSize(w, h);
  // Rebuild mesh to pick up new density if changed
  buildScalesMesh();
}

// ── Dispose ───────────────────────────────────────────────────────────────────

export function disposeScales(): void {
  if (!initialized) return;

  vizModeUnsub?.();
  vizModeUnsub = null;

  if (scalesMesh) {
    scalesMesh.geometry.dispose();
    (scalesMesh.material as THREE.Material).dispose();
    scalesMesh = null;
  }

  composer?.dispose();
  renderer?.dispose();
  threeCanvas?.remove();

  threeCanvas   = null;
  renderer      = null;
  scene         = null;
  camera        = null;
  composer      = null;
  keyLight      = null;
  instanceData  = [];
  scaleCount    = 0;

  bandAmps      = new Float32Array(7);
  smoothedAmps  = new Float32Array(7);
  beatKick      = 0;
  lastBeatIndex = -1;
  time          = 0;
  camTheta      = 0;
  camElevation  = 0.3;
  camPhase      = 0;

  initialized = false;
}
