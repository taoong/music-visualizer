/**
 * Infinitum — 1–7 nested Möbius strips with audio-driven surface waves
 *
 * A family of mathematical one-sided surfaces arranged in concentric rings.
 * Each strip maps to one frequency band; audio amplitude drives a standing
 * wave that travels around the loop. The camera orbits at mid-elevation,
 * tilting slowly to reveal the strips' topology from different angles.
 *
 * Near-monochrome palette (cool steel to warm amber) lit by a two-point
 * studio rig. No additive glow, no rainbow palette, no beat-snap — only
 * continuous CHOP-style parameter easing and a brief beat kick impulse.
 *
 * Inspired by Max Bill "Endless Ribbon" (1935–1994), Charles O. Perry's
 * mathematical sculptures at the Bridges Conference on Mathematics and Arts
 * (https://bridgesmathart.org/), and Erik Demaine's curved origami work at
 * MIT CSAIL (https://erikdemaine.org/curved/).
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

// ── Geometry constants ────────────────────────────────────────────────────────

const U_SEGS  = isMobile ? 120 : 240;  // around the loop
const V_SEGS  = isMobile ? 14  : 28;   // across the strip width
const STRIP_W = 0.52;                  // half-width of each strip

// 7 concentric radii — evenly spaced with slightly increasing gaps
const RADII = [3.0, 4.2, 5.3, 6.3, 7.2, 8.0, 8.7];

// Each strip gets a slight angular phase offset so wave crests don't align
const PHASE_OFFSETS = [0.0, 0.31, 0.63, 0.94, 1.26, 1.57, 1.88];

// ── Module state ──────────────────────────────────────────────────────────────

let initialized  = false;
let threeCanvas  : HTMLCanvasElement | null = null;
let renderer     : THREE.WebGLRenderer | null = null;
let scene        : THREE.Scene | null = null;
let camera       : THREE.PerspectiveCamera | null = null;
let composer     : EffectComposer | null = null;
let vizModeUnsub : (() => void) | null = null;

interface StripEntry {
  mesh     : THREE.Mesh;
  mat      : THREE.MeshStandardMaterial;
  userData : {
    uBand : THREE.IUniform<number>;
    uTime : THREE.IUniform<number>;
    uWave : THREE.IUniform<number>;
  };
  bandSmooth: number;
}

let strips    : StripEntry[] = [];
let keyLight  : THREE.DirectionalLight | null = null;
let fillLight : THREE.DirectionalLight | null = null;

let time        = 0;
let camTheta    = Math.PI * 0.25;  // azimuth angle (orbit around Y axis)
let camPhi      = Math.PI * 0.28;  // elevation angle
let camThetaDot = 0.0;             // angular velocity — beat kick adds to this
let lastBeatIdx = -1;
let beatKick    = 0;               // decays each frame

// ── Build one Möbius strip geometry ───────────────────────────────────────────
// Standard Möbius parametrisation with 1 half-twist:
//   P(u,v) where u ∈ [0,2π], v ∈ [-1,1]
//   r(u,v) = R + W·v·cos(u/2)
//   P = ( r·cos(u),  W·v·sin(u/2),  r·sin(u) )
// Strip lies roughly in the XZ plane; Y is the vertical twist axis.

function buildMobiusGeo(radius: number): THREE.BufferGeometry {
  const cols = U_SEGS + 1;
  const rows = V_SEGS + 1;

  const positions = new Float32Array(cols * rows * 3);
  const uvs       = new Float32Array(cols * rows * 2);
  const indexArr  : number[] = [];

  let vi = 0, uvi = 0;
  for (let col = 0; col < cols; col++) {
    const u     = (col / U_SEGS) * Math.PI * 2;
    const cosU  = Math.cos(u);
    const sinU  = Math.sin(u);
    const cosH  = Math.cos(u * 0.5);
    const sinH  = Math.sin(u * 0.5);

    for (let row = 0; row < rows; row++) {
      const v = (row / V_SEGS) * 2.0 - 1.0;  // [-1, 1]
      const r = radius + STRIP_W * v * cosH;

      positions[vi]     = r * cosU;
      positions[vi + 1] = STRIP_W * v * sinH;
      positions[vi + 2] = r * sinU;
      vi += 3;

      uvs[uvi]     = col / U_SEGS;
      uvs[uvi + 1] = row / V_SEGS;
      uvi += 2;
    }
  }

  for (let col = 0; col < U_SEGS; col++) {
    for (let row = 0; row < V_SEGS; row++) {
      const a = col * rows + row;
      const b = col * rows + row + 1;
      const c = (col + 1) * rows + row + 1;
      const d = (col + 1) * rows + row;
      indexArr.push(a, b, d,  b, c, d);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv',       new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indexArr);
  geo.computeVertexNormals();
  return geo;
}

// ── Material factory ──────────────────────────────────────────────────────────
// Injects a vertex-displacement wave into MeshStandardMaterial via onBeforeCompile.
// The wave travels along the u-axis of the strip, amplitude driven by uBand.

function buildMaterial(
  userData  : StripEntry['userData'],
  phaseOffset: number,
): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({
    color    : new THREE.Color(0xbec8d4),
    metalness: 0.80,
    roughness: 0.25,
    side     : THREE.DoubleSide,
  });

  const pOff = phaseOffset.toFixed(4);

  mat.onBeforeCompile = (shader) => {
    shader.uniforms['uBand'] = userData.uBand;
    shader.uniforms['uTime'] = userData.uTime;
    shader.uniforms['uWave'] = userData.uWave;

    shader.vertexShader = /* glsl */`
      uniform float uBand;
      uniform float uTime;
      uniform float uWave;
    ` + shader.vertexShader;

    // Displace vertices along their normal by an audio-driven wave
    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      /* glsl */`
      #include <begin_vertex>
      float wavePhase = uv.x * 6.0 * 6.2832 + uTime * 2.4 + ${pOff};
      float disp = uBand * uWave * 0.28 * sin(wavePhase);
      transformed += normal * disp;
      `,
    );
  };

  mat.needsUpdate = true;
  return mat;
}

// ── Setup ─────────────────────────────────────────────────────────────────────

function setup(): void {
  threeCanvas = document.createElement('canvas');
  threeCanvas.style.cssText =
    'position:fixed;top:0;left:0;width:100%;height:100%;z-index:10;pointer-events:none;display:block';
  document.body.appendChild(threeCanvas);

  renderer = new THREE.WebGLRenderer({
    canvas         : threeCanvas,
    antialias      : !isMobile,
    alpha          : true,
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(isMobile ? 1 : Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.toneMapping         = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;

  scene  = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 500);

  // ── Lighting ──────────────────────────────────────────────────────────────
  const ambient = new THREE.AmbientLight(0x1a1e24, 0.6);
  scene.add(ambient);

  keyLight = new THREE.DirectionalLight(0xffa050, 2.2);
  keyLight.position.set(12, 10, 6);
  scene.add(keyLight);

  fillLight = new THREE.DirectionalLight(0x5080c0, 1.1);
  fillLight.position.set(-8, -4, -10);
  scene.add(fillLight);

  // ── Build strips ──────────────────────────────────────────────────────────
  strips = [];
  for (let i = 0; i < 7; i++) {
    const geo = buildMobiusGeo(RADII[i]);
    const userData: StripEntry['userData'] = {
      uBand: { value: 0 },
      uTime: { value: 0 },
      uWave: { value: 0.5 },
    };
    const mat  = buildMaterial(userData, PHASE_OFFSETS[i]);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.visible = i < 4;  // default: 4 loops (~0.43 on slider)
    scene.add(mesh);
    strips.push({ mesh, mat, userData, bandSmooth: 0 });
  }

  // ── Post-processing (subtle bloom on desktop only) ────────────────────────
  const rp = new RenderPass(scene, camera);
  const bp = new UnrealBloomPass(
    new THREE.Vector2(window.innerWidth, window.innerHeight),
    isMobile ? 0 : 0.30,
    0.4,
    0.88,
  );
  const op = new OutputPass();
  composer = new EffectComposer(renderer);
  composer.addPass(rp);
  composer.addPass(bp);
  composer.addPass(op);

  vizModeUnsub = store.on('vizModeChange', () => {
    if (store.state.vizMode !== 'infinitum') disposeInfinitum();
  });

  initialized = true;
}

// ── Draw ──────────────────────────────────────────────────────────────────────

export function drawInfinitum(_p: unknown, dt: number): void {
  if (!initialized) setup();
  if (!renderer || !scene || !camera || !composer) return;

  const { amps } = getBandAverages(7);
  const { config, state } = store;

  time += dt * 0.016667;

  // ── Beat detection ────────────────────────────────────────────────────────
  if (state.beatIntervalSec > 0 && state.isPlaying) {
    const pos      = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    const beatIdx  = adjusted >= 0 ? Math.floor(adjusted / state.beatIntervalSec) : -1;
    if (beatIdx > lastBeatIdx) {
      lastBeatIdx = beatIdx;
      beatKick    = 1.0;
    }
  }

  // Beat kick adds a brief angular impulse to the camera orbit
  beatKick    *= Math.pow(0.78, dt);
  camThetaDot += beatKick * 0.012 * dt;
  camThetaDot *= Math.pow(0.94, dt);

  // ── Structural: active strip count from slider ────────────────────────────
  // infinitumLoops: 0 → 1 maps to 1 → 7 strips
  const loopCount = Math.max(1, Math.round(1 + config.infinitumLoops * 6));

  // ── Camera orbit ──────────────────────────────────────────────────────────
  const baseSpeed = 0.00018 + config.infinitumOrbit * 0.00060;
  camTheta += (baseSpeed + camThetaDot) * dt * Math.PI;

  // Slow sinusoidal elevation drift — reveals topology from different angles
  camPhi = Math.PI * (0.20 + 0.12 * Math.sin(time * 0.07));

  const camDist = 20.0;
  camera.position.set(
    camDist * Math.sin(camPhi) * Math.cos(camTheta),
    camDist * Math.cos(camPhi),
    camDist * Math.sin(camPhi) * Math.sin(camTheta),
  );
  camera.lookAt(0, 0, 0);

  // ── Warmth slider: lerp lighting ──────────────────────────────────────────
  const w = config.infinitumWarmth;
  if (keyLight) {
    keyLight.color.setRGB(
      0.82 + w * 0.19,
      0.88 - w * 0.25,
      1.00 - w * 0.75,
    );
    keyLight.intensity = 2.0 + w * 0.6;
  }
  if (fillLight) {
    fillLight.color.setRGB(
      0.31 - w * 0.16,
      0.50 - w * 0.38,
      0.75 - w * 0.60,
    );
  }

  // ── Update each strip ─────────────────────────────────────────────────────
  const waveAmt = config.infinitumWave;

  for (let i = 0; i < 7; i++) {
    const strip = strips[i];
    strip.mesh.visible = i < loopCount;
    if (!strip.mesh.visible) continue;

    // Smooth the band value (CHOP-style continuous easing)
    const target = amps[i] ?? 0;
    strip.bandSmooth += (target - strip.bandSmooth) * Math.min(0.12 * dt, 0.6);

    strip.userData.uBand.value = strip.bandSmooth;
    strip.userData.uTime.value = time;
    strip.userData.uWave.value = waveAmt;

    // Slight roughness reduction at higher warmth (more mirror-like)
    strip.mat.roughness = 0.28 - w * 0.14;
  }

  composer.render();
}

// ── Reset (resize) ─────────────────────────────────────────────────────────────

export function resetInfinitum(): void {
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

export function disposeInfinitum(): void {
  if (!initialized) return;

  vizModeUnsub?.();
  vizModeUnsub = null;

  for (const strip of strips) {
    strip.mesh.geometry.dispose();
    strip.mat.dispose();
  }
  strips = [];
  keyLight  = null;
  fillLight = null;

  composer?.dispose();
  renderer?.dispose();
  threeCanvas?.remove();

  threeCanvas = null;
  renderer    = null;
  scene       = null;
  camera      = null;
  composer    = null;

  time        = 0;
  camTheta    = Math.PI * 0.25;
  camPhi      = Math.PI * 0.28;
  camThetaDot = 0;
  lastBeatIdx = -1;
  beatKick    = 0;

  initialized = false;
}
