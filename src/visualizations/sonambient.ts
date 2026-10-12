/**
 * Sonambient — audio-reactive metal rod field
 *
 * A dense grid of thin metallic rods stands in a darkened space; each rod
 * continuously oscillates by tilting from its base — sub-bass rods at the
 * centre sway slowly and widely, brilliance rods at the periphery quiver in
 * tight high-frequency tremors. A warm amber key light and a cold steel fill
 * reveal the physical metal surface; no emissive glow, no rainbow palette.
 * Camera sits low and orbits the field. Beat fires a ring wave that travels
 * outward from centre, briefly amplifying every rod it crosses.
 *
 * Inspired by Harry Bertoia "Sonambient" sculptures (1960s–70s, Bally PA;
 * Chinati Foundation permanent collection, Marfa TX,
 * https://www.bertoia.org/sonambient.html) and the TouchDesigner community's
 * instanced-cylinder audio-reactive patches (Derivative forum 2019–2024).
 */

import * as THREE from 'three';
import { EffectComposer }  from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass }      from 'three/addons/postprocessing/RenderPass.js';
import { OutputPass }      from 'three/addons/postprocessing/OutputPass.js';
import { store }            from '../state/store';
import { getBandAverages }  from './helpers';
import { audioEngine }      from '../audio/engine';
import { isMobile }         from '../utils/constants';

// ── Module state ──────────────────────────────────────────────────────────────

let initialized     = false;
let threeCanvas     : HTMLCanvasElement | null = null;
let renderer        : THREE.WebGLRenderer | null = null;
let scene           : THREE.Scene | null = null;
let camera          : THREE.PerspectiveCamera | null = null;
let composer        : EffectComposer | null = null;
let rodMesh         : THREE.InstancedMesh | null = null;
let rodMat          : THREE.MeshStandardMaterial | null = null;
let keyLight        : THREE.DirectionalLight | null = null;
let vizModeUnsub    : (() => void) | null = null;

let time            = 0;
let cameraTheta     = 0;
let beatKick        = 0;
let beatRing        = 0;   // expanding ring radius
let lastBeatIndex   = -1;
let lastDensityN    = -1;

let rodCount        = 0;
let rodData         : Float32Array | null = null; // [x, z, dist, band, phase] × N²

const dummy = new THREE.Object3D();

// ── Geometry helpers ──────────────────────────────────────────────────────────

const FIELD  = 14;   // world units: rods span ±7 on X and Z
const ROD_H  = 1.8;  // rod height

// Radial distance cutoffs for the 7 frequency bands (sub-bass=centre, brilliance=rim)
const BAND_CUTS = [1.2, 2.4, 3.6, 4.8, 5.8, 6.8, 12.0];

function bandFor(d: number): number {
  for (let b = 0; b < 7; b++) if (d <= BAND_CUTS[b]) return b;
  return 6;
}

// Per-band oscillation frequencies (real-time scale: ~0.16 Hz per unit)
// Band 0 (sub-bass) ≈ 0.3 Hz, Band 6 (brilliance) ≈ 3.4 Hz
const OSC_FREQ = [2.0, 3.0, 4.5, 6.5, 9.5, 14.5, 22.0];

function buildRods(n: number): void {
  if (rodMesh) { scene?.remove(rodMesh); rodMesh.geometry.dispose(); rodMesh = null; }

  rodCount = n * n;

  // Cylinder bottom at y=0, top at y=ROD_H
  const geo = new THREE.CylinderGeometry(0.038, 0.050, ROD_H, isMobile ? 8 : 12, 1);
  geo.translate(0, ROD_H * 0.5, 0);

  rodMesh = new THREE.InstancedMesh(geo, rodMat!, rodCount);
  scene?.add(rodMesh);

  // Pre-compute spatial data per rod
  rodData = new Float32Array(rodCount * 5);
  const spacing = FIELD / Math.max(n - 1, 1);

  for (let iz = 0; iz < n; iz++) {
    for (let ix = 0; ix < n; ix++) {
      const i   = iz * n + ix;
      const x   = -FIELD * 0.5 + ix * spacing;
      const z   = -FIELD * 0.5 + iz * spacing;
      const d   = Math.sqrt(x * x + z * z);
      rodData[i * 5 + 0] = x;
      rodData[i * 5 + 1] = z;
      rodData[i * 5 + 2] = d;
      rodData[i * 5 + 3] = bandFor(d);
      rodData[i * 5 + 4] = Math.random() * Math.PI * 2;
    }
  }
}

// ── Setup ─────────────────────────────────────────────────────────────────────

function setup(): void {
  threeCanvas = document.createElement('canvas');
  threeCanvas.style.cssText =
    'position:fixed;top:0;left:0;width:100%;height:100%;z-index:10;pointer-events:none;display:block';
  document.body.appendChild(threeCanvas);

  renderer = new THREE.WebGLRenderer({
    canvas: threeCanvas, antialias: !isMobile, alpha: true,
  });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, isMobile ? 1.0 : 2.0));
  renderer.toneMapping       = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  renderer.outputColorSpace  = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = false;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0a0a0a);
  scene.fog        = new THREE.FogExp2(0x0a0a0a, 0.055);

  camera = new THREE.PerspectiveCamera(52, window.innerWidth / window.innerHeight, 0.1, 80);

  // Two-point studio rig: warm key + cold fill (no rainbow palette)
  keyLight = new THREE.DirectionalLight(0xffd580, 3.0);  // warm amber key
  keyLight.position.set(9, 14, 7);
  scene.add(keyLight);

  const fillLight = new THREE.DirectionalLight(0x8ab4e8, 0.9);  // cold steel fill
  fillLight.position.set(-7, 5, -9);
  scene.add(fillLight);

  scene.add(new THREE.AmbientLight(0x141414, 1.0));

  // Polished metal material — colour lives entirely in light response
  rodMat = new THREE.MeshStandardMaterial({
    color:     0xb0b0b0,
    metalness: 0.95,
    roughness: 0.12,
  });

  // Dark reflective base plane
  const floorMat = new THREE.MeshStandardMaterial({
    color: 0x0d0d0d, metalness: 0.6, roughness: 0.7,
  });
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(FIELD + 4, FIELD + 4), floorMat);
  floor.rotation.x = -Math.PI * 0.5;
  floor.position.y  = -0.02;
  scene.add(floor);

  // Minimal post: just tone-map + gamma output
  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  composer.addPass(new OutputPass());

  vizModeUnsub = store.on('vizModeChange', (data) => {
    if (threeCanvas) threeCanvas.style.display = data === 'sonambient' ? 'block' : 'none';
  });

  initialized = true;
}

// ── Draw ──────────────────────────────────────────────────────────────────────

export function drawSonambient(_p: unknown, dt: number): void {
  if (!initialized) setup();
  if (!scene || !camera || !composer || !rodMat || !keyLight) return;

  time += dt * 0.016;

  const { amps } = getBandAverages(7);

  // ── Structural rebuild when density slider changes ────────────────────────
  const density    = store.config.sonambientDensity;
  const rawN       = isMobile ? 8 + density * 6 : 10 + density * 10;
  const n          = Math.max(2, Math.round(rawN));
  if (n !== lastDensityN) { lastDensityN = n; buildRods(n); }

  // ── Material patina slider → roughness ───────────────────────────────────
  rodMat.roughness = 0.04 + store.config.sonambientPatina * 0.78;

  // ── Key light breathes very slightly with overall amplitude ───────────────
  const overallAmp = amps.reduce((s, v) => s + v, 0) / 7;
  keyLight.intensity = 2.6 + overallAmp * 1.0;

  // ── Beat detection ────────────────────────────────────────────────────────
  const { state } = store;
  if (state.beatIntervalSec > 0 && state.isPlaying) {
    const pos  = audioEngine.getPlaybackPosition();
    const adj  = pos - state.beatOffset;
    const bidx = adj >= 0 ? Math.floor(adj / state.beatIntervalSec) : -1;
    if (bidx > lastBeatIndex) {
      lastBeatIndex = bidx;
      beatKick = 1.0;
      beatRing = 0.0;
    }
  }
  beatKick *= Math.pow(0.90, dt);
  beatRing += dt * 3.8;            // ring expands across the field

  // ── Update rod instance matrices ─────────────────────────────────────────
  if (rodMesh && rodData) {
    const resonance = store.config.sonambientResonance;
    const maxTilt   = 0.14 + resonance * 0.38;  // 0.14–0.52 rad max tilt

    for (let i = 0; i < rodCount; i++) {
      const base  = i * 5;
      const x     = rodData[base];
      const z     = rodData[base + 1];
      const d     = rodData[base + 2];
      const band  = rodData[base + 3];
      const phase = rodData[base + 4];

      const amp  = amps[Math.round(band)] ?? 0;
      const freq = OSC_FREQ[Math.round(band)] ?? 6;

      // Spatial wave phase makes adjacent rods look like a travelling wave
      const wavePhase = (x + z) * 0.35 + phase;

      // Continuous CHOP-style oscillation — no beat discontinuity
      const tX = amp * maxTilt * Math.sin(time * freq + wavePhase);
      const tZ = amp * maxTilt * Math.cos(time * freq * 0.97 + wavePhase * 1.1);

      // Beat ring perturbation: brief kick as wavefront passes each rod
      const ringDist  = Math.abs(d - beatRing);
      const ringBoost = beatKick * 0.7 * Math.exp(-ringDist * ringDist * 0.6);
      const bX        = ringBoost * maxTilt * Math.sin(time * 5.0 + wavePhase);
      const bZ        = ringBoost * maxTilt * Math.cos(time * 5.0 + wavePhase * 1.2);

      dummy.position.set(x, 0, z);
      dummy.rotation.set(tX + bX, 0, tZ + bZ);
      dummy.updateMatrix();
      rodMesh.setMatrixAt(i, dummy.matrix);
    }
    rodMesh.instanceMatrix.needsUpdate = true;
  }

  // ── Camera: low orbit, bass lifts view slightly ───────────────────────────
  cameraTheta += dt * 0.00055 * (0.6 + store.config.rotationSpeed);
  const orbitR = 13.5;
  camera.position.x = Math.sin(cameraTheta) * orbitR;
  camera.position.z = Math.cos(cameraTheta) * orbitR;
  camera.position.y = 0.55 + (amps[0] ?? 0) * 0.8;
  camera.lookAt(0, 1.0, 0);

  composer.render();
}

// ── Reset ─────────────────────────────────────────────────────────────────────

export function resetSonambient(): void {
  if (!initialized) return;
  renderer?.setSize(window.innerWidth, window.innerHeight);
  if (camera) { camera.aspect = window.innerWidth / window.innerHeight; camera.updateProjectionMatrix(); }
  composer?.setSize(window.innerWidth, window.innerHeight);
}

// ── Dispose ───────────────────────────────────────────────────────────────────

export function disposeSonambient(): void {
  if (!initialized) return;
  vizModeUnsub?.(); vizModeUnsub = null;
  if (rodMesh) { scene?.remove(rodMesh); rodMesh.geometry.dispose(); rodMesh = null; }
  rodMat?.dispose(); rodMat = null;
  composer?.dispose(); composer = null;
  renderer?.dispose(); renderer = null;
  threeCanvas?.remove(); threeCanvas = null;
  scene = null; camera = null; keyLight = null;
  rodData = null;
  initialized = false;
  time = 0; cameraTheta = 0; beatKick = 0; beatRing = 0;
  lastBeatIndex = -1; lastDensityN = -1; rodCount = 0;
}
