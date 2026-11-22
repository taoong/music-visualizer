/**
 * Impasto — 7 thick calligraphic 3D tube strokes in a dark studio space
 *
 * Each stroke maps to one audio frequency band. The strokes glow internally
 * with amplitude via emissive intensity; bloom carries the light outward.
 * A single warm Rembrandt key light + cool secondary fill reveal the paint
 * surface. No rainbow, no radial symmetry, no centre pulse — drama comes
 * from the material, the light, and the spatial arrangement.
 *
 * CHOP-style signal flow: emissive intensity lerps toward its target every
 * frame; a beat transient fires a decaying kick that subsides in ~0.8 s.
 *
 * Inspired by: Ryoji Ikeda "datamatics [ver.2.0]" (2012, Carriageworks Sydney,
 * https://www.ryojiikeda.com/project/datamatics/) — the aesthetic of thick
 * data-traces in deep space — combined with Joan Mitchell's gestural studio
 * paintings ("La Grande Vallée", 1983–84) and Zach Lieberman's real-time 3D
 * calligraphy work in openFrameworks.
 *
 * Sliders
 *   Bundle  — 0 = tight parallel bundle of strokes, 1 = spread sculptural
 *             arrangement (structural: rebuilds tube geometry when changed)
 *   Swell   — amplitude sensitivity for the emissive glow (0 = muted, 1 = vivid)
 *   Drift   — camera orbit speed (0 = static, 1 = fast sweep)
 */
import * as THREE from 'three';
import { EffectComposer }   from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass }       from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass }  from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass }       from 'three/addons/postprocessing/OutputPass.js';
import { store }            from '../state/store';
import { getBandAverages }  from './helpers';
import { audioEngine }      from '../audio/engine';
import { isMobile }         from '../utils/constants';

// ── Constants ──────────────────────────────────────────────────────────────────

const BAND_COUNT    = 7;
const TUBE_SEGS     = isMobile ? 10 : 20;   // tubular segments along path
const RADIAL_SEGS   = isMobile ? 5  : 8;    // radial segments around tube
const REBUILD_THRESHOLD = 0.04;             // min bundle change to trigger rebuild
const BEAT_KICK_DECAY   = 0.015;            // kick decay per frame (60 fps base)
const AMP_LERP_RATE     = 0.08;             // CHOP lerp speed toward target band amp

// Earth-tone palette — warm-to-cool, not rainbow
const STROKE_COLORS: THREE.ColorRepresentation[] = [
  0x8B2515, // sub-bass  — deep vermilion
  0x9C4B25, // bass      — burnt sienna
  0x7A6235, // low-mid   — raw ochre
  0x3D5A45, // mid       — dark forest
  0x2A3E5E, // upper-mid — prussian blue
  0x3E3058, // presence  — deep slate violet
  0x887E72, // brilliance— warm ash grey
];

// Per-stroke path parameters — base positions and shape in "spread" state (bundle=1).
// Each stroke is a smooth arc through space. Parameters:
//   cp0: start control point
//   cp1: start-side handle
//   cp2: end-side handle
//   cp3: end control point
//   radius: base tube cross-section radius (world units)
interface StrokeParam {
  cp: THREE.Vector3[];  // 5 control points forming a CatmullRom spine
  radius: number;
}

const STROKE_PARAMS: StrokeParam[] = [
  { radius: 0.28, cp: [
      new THREE.Vector3(-5.0, -1.2, -4.0),
      new THREE.Vector3(-2.5,  0.4, -1.5),
      new THREE.Vector3( 0.0,  1.0,  0.5),
      new THREE.Vector3( 2.5,  0.6,  2.5),
      new THREE.Vector3( 5.0, -1.0,  4.5),
    ]},
  { radius: 0.22, cp: [
      new THREE.Vector3(-4.5,  2.0, -3.5),
      new THREE.Vector3(-2.0,  1.5, -1.0),
      new THREE.Vector3( 0.2,  0.5,  1.0),
      new THREE.Vector3( 2.2,  1.8,  3.0),
      new THREE.Vector3( 4.5,  2.5,  5.0),
    ]},
  { radius: 0.32, cp: [
      new THREE.Vector3(-4.0, -2.5, -2.5),
      new THREE.Vector3(-1.5, -1.0, -0.5),
      new THREE.Vector3( 0.5,  0.0,  1.5),
      new THREE.Vector3( 2.5, -0.5,  3.5),
      new THREE.Vector3( 5.5, -2.0,  5.5),
    ]},
  { radius: 0.18, cp: [
      new THREE.Vector3(-6.0,  0.5, -1.0),
      new THREE.Vector3(-3.0,  0.0,  0.5),
      new THREE.Vector3(-0.5, -0.5,  2.0),
      new THREE.Vector3( 2.5, -0.2,  3.5),
      new THREE.Vector3( 5.5,  0.5,  4.5),
    ]},
  { radius: 0.25, cp: [
      new THREE.Vector3( 1.0,  3.5, -5.0),
      new THREE.Vector3( 1.5,  2.0, -1.5),
      new THREE.Vector3( 0.0,  0.0,  1.5),
      new THREE.Vector3(-1.5,  2.0,  3.5),
      new THREE.Vector3(-1.0,  3.5,  6.0),
    ]},
  { radius: 0.20, cp: [
      new THREE.Vector3(-3.5,  1.0,  1.0),
      new THREE.Vector3(-1.0,  0.5,  2.0),
      new THREE.Vector3( 0.5, -0.5,  3.0),
      new THREE.Vector3( 2.5,  0.5,  4.5),
      new THREE.Vector3( 4.5,  1.5,  5.5),
    ]},
  { radius: 0.15, cp: [
      new THREE.Vector3( 2.5, -3.0, -3.0),
      new THREE.Vector3( 1.5, -1.5, -0.5),
      new THREE.Vector3(-0.5,  0.5,  2.0),
      new THREE.Vector3(-2.0, -0.5,  4.0),
      new THREE.Vector3(-3.5, -2.5,  6.0),
    ]},
];

// Bundle=0 spine: all strokes collapse to a parallel bundle along Z, offset by Y
// to match count, so they're slightly stacked vertically
function bundleControlPoints(i: number, bundleT: number): THREE.Vector3[] {
  const spread = STROKE_PARAMS[i];
  const tightY  = (i - 3) * 0.55;  // vertical spacing in tight bundle
  const result: THREE.Vector3[] = [];
  for (let j = 0; j < 5; j++) {
    const t0 = -5 + j * 2.5;        // tight: z only, spread from -5 to +5
    const tight = new THREE.Vector3(0, tightY, t0);
    const sp    = spread.cp[j];
    result.push(new THREE.Vector3(
      tight.x + (sp.x - tight.x) * bundleT,
      tight.y + (sp.y - tight.y) * bundleT,
      tight.z + (sp.z - tight.z) * bundleT,
    ));
  }
  return result;
}

// ── Module state ───────────────────────────────────────────────────────────────

let initialized    = false;
let threeCanvas    : HTMLCanvasElement | null = null;
let renderer       : THREE.WebGLRenderer | null = null;
let scene          : THREE.Scene | null = null;
let camera         : THREE.PerspectiveCamera | null = null;
let composer       : EffectComposer | null = null;
let vizModeUnsub   : (() => void) | null = null;

const tubeMeshes   : THREE.Mesh[]      = [];
const tubeMats     : THREE.MeshStandardMaterial[] = [];
const tubeGeos     : THREE.TubeGeometry[] = [];

// CHOP-style signal state
const smoothedAmps : Float32Array = new Float32Array(BAND_COUNT);
const beatKicks    : Float32Array = new Float32Array(BAND_COUNT);

let time           = 0;
let camTheta       = 0;
let lastBeatIndex  = -1;
let lastBundleT    = -1;    // last bundle value used to build geometry

// ── Geometry builder ──────────────────────────────────────────────────────────

function buildTubes(bundleT: number): void {
  // Dispose old geometry
  for (let i = 0; i < tubeGeos.length; i++) {
    tubeGeos[i]?.dispose();
  }
  tubeGeos.length    = 0;
  tubeMeshes.length  = 0;
  tubeMats.length    = 0;

  if (!scene) return;

  for (let i = 0; i < BAND_COUNT; i++) {
    const pts  = bundleControlPoints(i, bundleT);
    const curve = new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.5);
    const geo   = new THREE.TubeGeometry(curve, TUBE_SEGS, STROKE_PARAMS[i].radius, RADIAL_SEGS, false);
    const mat   = new THREE.MeshStandardMaterial({
      color:            new THREE.Color(STROKE_COLORS[i]),
      emissive:         new THREE.Color(STROKE_COLORS[i]),
      emissiveIntensity: 0.0,
      roughness:        0.75,
      metalness:        0.05,
    });
    const mesh  = new THREE.Mesh(geo, mat);
    scene.add(mesh);
    tubeGeos.push(geo);
    tubeMats.push(mat);
    tubeMeshes.push(mesh);
  }

  lastBundleT = bundleT;
}

// ── Setup ──────────────────────────────────────────────────────────────────────

function setup(): void {
  threeCanvas = document.createElement('canvas');
  threeCanvas.style.cssText =
    'position:fixed;top:0;left:0;width:100%;height:100%;z-index:10;pointer-events:none;display:block';
  document.body.appendChild(threeCanvas);

  renderer = new THREE.WebGLRenderer({
    canvas:    threeCanvas,
    antialias: !isMobile,
    alpha:     true,
  });
  renderer.setPixelRatio(isMobile ? 1.0 : Math.min(window.devicePixelRatio, 2.0));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.toneMapping        = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.2;
  renderer.shadowMap.enabled  = false;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x060608);

  camera = new THREE.PerspectiveCamera(52, window.innerWidth / window.innerHeight, 0.1, 100);
  camera.position.set(0, 3, 14);
  camera.lookAt(0, 0, 1);

  // Warm Rembrandt key light from upper-right
  const keyLight = new THREE.DirectionalLight(0xffd5a0, 2.6);
  keyLight.position.set(8, 10, 5);
  scene.add(keyLight);

  // Cool secondary fill from lower-left
  const fillLight = new THREE.DirectionalLight(0x5080c0, 0.8);
  fillLight.position.set(-8, -4, 8);
  scene.add(fillLight);

  // Very dim ambient so deep shadows are not pure black
  const ambient = new THREE.AmbientLight(0x0a0a14, 1.0);
  scene.add(ambient);

  // Build initial tubes
  const cfg = store.config;
  buildTubes(cfg.impastoBundle);

  // Post-processing — bloom only on desktop
  const renderPass  = new RenderPass(scene, camera);
  const outputPass  = new OutputPass();
  composer = new EffectComposer(renderer);
  composer.addPass(renderPass);
  if (!isMobile) {
    const bloomPass = new UnrealBloomPass(
      new THREE.Vector2(window.innerWidth, window.innerHeight),
      0.55,   // very subtle bloom strength
      0.5,    // radius
      0.75,   // threshold (only glowing parts bloom)
    );
    composer.addPass(bloomPass);
  }
  composer.addPass(outputPass);

  // Resize handler
  const onResize = () => {
    if (!renderer || !camera || !composer) return;
    const w = window.innerWidth, h = window.innerHeight;
    renderer.setSize(w, h);
    composer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  window.addEventListener('resize', onResize);

  // Teardown on viz change
  vizModeUnsub = store.on('vizModeChange', () => disposeImpasto());
}

// ── Draw ───────────────────────────────────────────────────────────────────────

export function drawImpasto(_p: unknown, dt: number): void {
  if (!initialized) {
    setup();
    initialized = true;
  }
  if (!renderer || !scene || !camera || !composer) return;

  time += dt * 0.016667;  // time in seconds (60 fps base)

  const cfg    = store.config;
  const bandAvg = getBandAverages(BAND_COUNT);
  const bands  = bandAvg.amps;

  // Rebuild tubes when bundle slider moves significantly
  if (Math.abs(cfg.impastoBundle - lastBundleT) > REBUILD_THRESHOLD) {
    buildTubes(cfg.impastoBundle);
  }

  // Beat detection
  const { state } = store;
  const { detectedBPM: bpm, beatOffset } = state;
  let beatFired = false;
  if (bpm > 0) {
    const beatIntervalSec = 60.0 / bpm;
    const pos = audioEngine.getPlaybackPosition();
    const beatIndex = Math.floor((pos - beatOffset) / beatIntervalSec);
    if (beatIndex !== lastBeatIndex && beatIndex >= 0) {
      lastBeatIndex = beatIndex;
      beatFired = true;
    }
  }

  // Update CHOP-style smoothed amplitudes
  const swell = cfg.impastoSwell;
  for (let i = 0; i < BAND_COUNT; i++) {
    const target = bands[i] ?? 0;
    smoothedAmps[i] += (target - smoothedAmps[i]) * AMP_LERP_RATE;

    if (beatFired) {
      beatKicks[i] += 0.6 * (target * 0.5 + 0.3); // kick proportional to band + base
    }
    beatKicks[i] *= (1 - BEAT_KICK_DECAY);
    if (beatKicks[i] < 0.001) beatKicks[i] = 0;
  }

  // Update emissive intensity and subtle rotation per tube
  for (let i = 0; i < BAND_COUNT; i++) {
    if (!tubeMats[i] || !tubeMeshes[i]) continue;
    const amp    = smoothedAmps[i] + beatKicks[i];
    const glow   = amp * swell * 1.8;
    tubeMats[i].emissiveIntensity = Math.min(glow, 2.5);

    // Gentle oscillation: different frequency and phase per stroke
    const freq = 0.08 + i * 0.03;
    const phase = i * 0.9;
    tubeMeshes[i].rotation.z = Math.sin(time * freq + phase) * 0.04;
    tubeMeshes[i].rotation.x = Math.cos(time * freq * 0.7 + phase + 1.2) * 0.025;
  }

  // Camera slow orbit
  const drift = cfg.impastoDrift;
  camTheta += dt * drift * 0.0004;
  const radius   = 13.5;
  const camY     = 2.5 + Math.sin(time * 0.07) * 1.2;
  camera.position.set(
    Math.sin(camTheta) * radius,
    camY,
    Math.cos(camTheta) * radius,
  );
  camera.lookAt(0, 0.5, 1.0);

  composer.render();
}

// ── Reset ──────────────────────────────────────────────────────────────────────

export function resetImpasto(): void {
  smoothedAmps.fill(0);
  beatKicks.fill(0);
  time          = 0;
  camTheta      = 0;
  lastBeatIndex = -1;
}

// ── Dispose ────────────────────────────────────────────────────────────────────

export function disposeImpasto(): void {
  vizModeUnsub?.();
  vizModeUnsub = null;

  if (scene) {
    for (const mesh of tubeMeshes) {
      scene.remove(mesh);
    }
  }
  for (const geo  of tubeGeos)  geo?.dispose();
  for (const mat  of tubeMats)  mat?.dispose();
  tubeGeos.length    = 0;
  tubeMeshes.length  = 0;
  tubeMats.length    = 0;

  composer?.dispose();
  renderer?.dispose();
  threeCanvas?.parentNode?.removeChild(threeCanvas);

  composer    = null;
  renderer    = null;
  scene       = null;
  camera      = null;
  threeCanvas = null;
  initialized = false;
  lastBundleT = -1;

  smoothedAmps.fill(0);
  beatKicks.fill(0);
  time          = 0;
  camTheta      = 0;
  lastBeatIndex = -1;
}
