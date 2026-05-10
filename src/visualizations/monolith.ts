/**
 * Monolith — Three.js WebGL overlay visualization
 *
 * A single tall faceted crystal obelisk sits at world origin. The camera
 * is the protagonist, executing choreographed orbital moves locked to
 * the beat: continuous orbit baseline, crash-zoom on every beat, periodic
 * Hitchcock dolly-zoom, sustained-bass pull-back, snap-cuts to inverted
 * angles, top-down / worm's-eye phases, and barrel rolls on hi-hat
 * transients.
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';

// ── Constants ─────────────────────────────────────────────────────────────────

const BAND_COUNT      = 7;
const CRYSTAL_RADIUS  = 8;
const Y_STRETCH       = 2.6;
const FOV_BASE        = 50;
const FOV_DOLLY_NEAR  = 25;     // narrow-FOV target during Hitchcock
const CAM_DIST_BASE   = 30;
const CAM_DIST_DOLLY  = 60;     // pulled-back during Hitchcock
const CAM_Y_BASE      = 4;
const CAM_Y_TOP       = 35;
const CAM_Y_BOTTOM    = -22;
const ORBIT_PERIOD_S  = 30;     // seconds per full revolution baseline
const FRAMES_REF      = 60;     // dt is normalized to 60fps

// HSB-style hues per band (sub→brilliance), as Three.js Color (HSL — note: Color uses HSL, but we choose
// values that visually match HSB). Values picked to match the warm→cool palette in sculpture.ts.
const BAND_HUES = [
  0.78,  // Sub        — violet
  0.66,  // Bass       — blue
  0.51,  // Low-Mid    — cyan
  0.40,  // Mid        — green
  0.16,  // Upper-Mid  — yellow
  0.08,  // Presence   — orange
  0.99,  // Brilliance — red
];

type Phase = 'orbit' | 'dollyZoom' | 'reverseDolly' | 'verticalTop' | 'verticalBottom' | 'snapCut';

// ── Module state ──────────────────────────────────────────────────────────────

let initialized = false;
let threeCanvas : HTMLCanvasElement | null = null;
let renderer    : THREE.WebGLRenderer | null = null;
let scene       : THREE.Scene | null = null;
let camera      : THREE.PerspectiveCamera | null = null;
let composer    : EffectComposer | null = null;
let vizModeUnsub: (() => void) | null = null;

// Object
let crystalGroup: THREE.Group | null = null;
let crystalMesh : THREE.Mesh | null = null;
let crystalMat  : THREE.MeshStandardMaterial | null = null;
let crystalEdge : THREE.LineSegments | null = null;
let faceBandMap : Uint8Array | null = null;   // [faceIdx] → bandIdx (0..6)
let colorAttr   : THREE.BufferAttribute | null = null;

// Lights
let ambientLight: THREE.AmbientLight | null = null;
let keyLight    : THREE.PointLight | null = null;

// Camera state
let phase           : Phase = 'orbit';
let phaseStartBeat  = 0;
let beatCount       = 0;
let lastBeatIndex   = -1;

let orbitAngle  = 0;
let camY        = CAM_Y_BASE;
let camDist     = CAM_DIST_BASE;
let fov         = FOV_BASE;
let zoomPunch   = 0;
let shakeX      = 0;
let shakeY      = 0;
let rollAngle   = 0;
let rollImpulse = 0;
let bassPullback = 0;

// Audio smoothing
let smoothedBass = 0;

// Reusable color helpers
const _color = new THREE.Color();

// ── Easing ────────────────────────────────────────────────────────────────────

function easeInOut(t: number): number {
  const x = Math.max(0, Math.min(1, t));
  return x * x * (3 - 2 * x);
}

// ── Setup ─────────────────────────────────────────────────────────────────────

function setup(): void {
  // Overlay canvas — same pattern as sculpture.ts
  threeCanvas = document.createElement('canvas');
  threeCanvas.style.cssText =
    'position:fixed;top:0;left:0;width:100%;height:100%;z-index:10;pointer-events:none;display:block';
  document.body.appendChild(threeCanvas);

  // Renderer
  renderer = new THREE.WebGLRenderer({ canvas: threeCanvas, antialias: true, alpha: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  // Scene
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x030308);

  // Camera
  camera = new THREE.PerspectiveCamera(FOV_BASE, window.innerWidth / window.innerHeight, 0.1, 500);
  camera.position.set(CAM_DIST_BASE, CAM_Y_BASE, 0);
  camera.lookAt(0, 0, 0);

  // Lights
  ambientLight = new THREE.AmbientLight(0x223344, 0.4);
  scene.add(ambientLight);
  const hemiLight = new THREE.HemisphereLight(0x4466aa, 0x110022, 0.5);
  scene.add(hemiLight);
  keyLight = new THREE.PointLight(0xffffff, 1.0, 200);
  keyLight.position.copy(camera.position);
  scene.add(keyLight);

  // Crystal: stretched icosahedron with per-face vertex colors
  crystalGroup = new THREE.Group();
  scene.add(crystalGroup);

  // IcosahedronGeometry returns non-indexed by default — no toNonIndexed() needed
  const geo: THREE.BufferGeometry = new THREE.IcosahedronGeometry(CRYSTAL_RADIUS, 1);
  const posAttr = geo.attributes['position'] as THREE.BufferAttribute;
  for (let i = 0; i < posAttr.count; i++) {
    posAttr.setY(i, posAttr.getY(i) * Y_STRETCH);
  }
  posAttr.needsUpdate = true;
  geo.computeVertexNormals();

  const faceCount = posAttr.count / 3;
  faceBandMap = new Uint8Array(faceCount);
  for (let f = 0; f < faceCount; f++) faceBandMap[f] = f % BAND_COUNT;

  // Vertex colors (3 per face, identical within a face)
  const colors = new Float32Array(posAttr.count * 3);
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  colorAttr = geo.attributes['color'] as THREE.BufferAttribute;

  crystalMat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    metalness: 0.4,
    roughness: 0.25,
    flatShading: true,
    emissive: new THREE.Color(0xffffff),
    emissiveIntensity: 0.0,
  });
  crystalMesh = new THREE.Mesh(geo, crystalMat);
  crystalGroup.add(crystalMesh);

  // Edge wireframe overlay for crisp facet definition
  const edgeGeo = new THREE.EdgesGeometry(geo, 1);
  const edgeMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.4 });
  crystalEdge = new THREE.LineSegments(edgeGeo, edgeMat);
  crystalGroup.add(crystalEdge);

  // Floor grid for depth reference
  const grid = new THREE.GridHelper(80, 20, 0x223344, 0x111122);
  grid.position.y = -22;
  (grid.material as THREE.Material).transparent = true;
  (grid.material as THREE.Material).opacity = 0.3;
  scene.add(grid);

  // Post-processing
  const res = new THREE.Vector2(window.innerWidth, window.innerHeight);
  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  composer.addPass(new UnrealBloomPass(res, 0.9, 0.5, 0.25));
  composer.addPass(new OutputPass());

  // Hide canvas when switching away
  vizModeUnsub = store.on('vizModeChange', (data) => {
    if (!threeCanvas) return;
    threeCanvas.style.display = data === 'monolith' ? 'block' : 'none';
  });

  initialized = true;
}

// ── Per-frame: update facet colors from band amps ─────────────────────────────

function updateFacetColors(amps: number[], transients: number[]): void {
  if (!colorAttr || !faceBandMap) return;
  const count = faceBandMap.length;
  for (let f = 0; f < count; f++) {
    const b = faceBandMap[f];
    const amp = amps[b] ?? 0;
    const t = (transients[b] ?? 1) - 1;
    const tSpike = t > 0 ? t * 0.6 : 0;
    const lightness = Math.min(0.85, 0.18 + amp * 0.55 + tSpike);
    _color.setHSL(BAND_HUES[b], 0.85, lightness);
    const i = f * 3 * 3; // 3 verts × 3 components per face
    for (let v = 0; v < 3; v++) {
      colorAttr.array[i + v * 3 + 0] = _color.r;
      colorAttr.array[i + v * 3 + 1] = _color.g;
      colorAttr.array[i + v * 3 + 2] = _color.b;
    }
  }
  colorAttr.needsUpdate = true;
}

// ── Camera phase scheduler ────────────────────────────────────────────────────

function scheduleNextPhaseOnBeat(transients: number[]): void {
  if (phase !== 'orbit') return;
  if (beatCount % 32 === 0 && beatCount > 0) {
    phase = 'verticalTop';
    phaseStartBeat = beatCount;
  } else if (beatCount % 32 === 16) {
    phase = 'verticalBottom';
    phaseStartBeat = beatCount;
  } else if (beatCount % 16 === 0 && beatCount > 0) {
    phase = 'dollyZoom';
    phaseStartBeat = beatCount;
  } else if (transients[6] > 1.8) {
    rollImpulse += 0.18;
  } else if (Math.random() < 0.05) {
    phase = 'snapCut';
    phaseStartBeat = beatCount;
  }
}

// ── Draw ──────────────────────────────────────────────────────────────────────

export function drawMonolith(_p: unknown, dt: number): void {
  if (!initialized) setup();
  if (!camera || !composer || !crystalGroup || !crystalMat || !keyLight) return;

  const { state } = store;
  const { amps, transients } = getBandAverages(BAND_COUNT);

  // Smooth bass for scale-pulse and pullback gating
  const bass = (amps[0] + amps[1]) * 0.5;
  smoothedBass += (bass - smoothedBass) * 0.15 * dt;

  // Beat detection
  let beatProgress = 0;
  if (state.beatIntervalSec > 0 && state.isPlaying) {
    const adjusted = audioEngine.getPlaybackPosition() - state.beatOffset;
    if (adjusted >= 0) {
      const beatIdx = Math.floor(adjusted / state.beatIntervalSec);
      beatProgress = (adjusted % state.beatIntervalSec) / state.beatIntervalSec;
      if (beatIdx > lastBeatIndex) {
        lastBeatIndex = beatIdx;
        beatCount++;
        zoomPunch = 0.35;
        shakeX = (Math.random() - 0.5) * 4;
        shakeY = (Math.random() - 0.5) * 4;
        scheduleNextPhaseOnBeat(transients);
      }
    }
  }

  // Phase update
  const beatsInPhase = beatCount - phaseStartBeat + beatProgress;
  switch (phase) {
    case 'orbit': {
      camY += (CAM_Y_BASE - camY) * 0.05 * dt;
      fov += (FOV_BASE - fov) * 0.05 * dt;
      const targetDist = CAM_DIST_BASE + bassPullback * 12;
      camDist += (targetDist - camDist) * 0.08 * dt;
      break;
    }
    case 'dollyZoom': {
      const t = Math.min(beatsInPhase / 2, 1);
      const e = easeInOut(t);
      fov = FOV_BASE - (FOV_BASE - FOV_DOLLY_NEAR) * e;
      camDist = CAM_DIST_BASE + (CAM_DIST_DOLLY - CAM_DIST_BASE) * e;
      camY += (CAM_Y_BASE - camY) * 0.05 * dt;
      if (t >= 1) {
        phase = 'reverseDolly';
        phaseStartBeat = beatCount + beatProgress;
      }
      break;
    }
    case 'reverseDolly': {
      const t = Math.min(beatsInPhase / 2, 1);
      const e = easeInOut(t);
      fov = FOV_DOLLY_NEAR + (FOV_BASE - FOV_DOLLY_NEAR) * e;
      camDist = CAM_DIST_DOLLY + (CAM_DIST_BASE - CAM_DIST_DOLLY) * e;
      if (t >= 1) {
        phase = 'orbit';
        phaseStartBeat = beatCount + beatProgress;
      }
      break;
    }
    case 'verticalTop': {
      // 4 beats lift, 4 beats hold, 4 beats return → 12 beats total
      let target = camY;
      if (beatsInPhase < 4) {
        target = CAM_Y_BASE + (CAM_Y_TOP - CAM_Y_BASE) * easeInOut(beatsInPhase / 4);
      } else if (beatsInPhase < 8) {
        target = CAM_Y_TOP;
      } else {
        target = CAM_Y_TOP + (CAM_Y_BASE - CAM_Y_TOP) * easeInOut((beatsInPhase - 8) / 4);
      }
      camY += (target - camY) * 0.25 * dt;
      if (beatsInPhase >= 12) {
        phase = 'orbit';
        phaseStartBeat = beatCount + beatProgress;
      }
      break;
    }
    case 'verticalBottom': {
      let target = camY;
      if (beatsInPhase < 4) {
        target = CAM_Y_BASE + (CAM_Y_BOTTOM - CAM_Y_BASE) * easeInOut(beatsInPhase / 4);
      } else if (beatsInPhase < 8) {
        target = CAM_Y_BOTTOM;
      } else {
        target = CAM_Y_BOTTOM + (CAM_Y_BASE - CAM_Y_BOTTOM) * easeInOut((beatsInPhase - 8) / 4);
      }
      camY += (target - camY) * 0.25 * dt;
      if (beatsInPhase >= 12) {
        phase = 'orbit';
        phaseStartBeat = beatCount + beatProgress;
      }
      break;
    }
    case 'snapCut': {
      if (beatsInPhase < 0.05) {
        orbitAngle = orbitAngle + Math.PI + (Math.random() - 0.5);
      }
      if (beatsInPhase >= 1) {
        phase = 'orbit';
        phaseStartBeat = beatCount + beatProgress;
      }
      break;
    }
  }

  // Sustained-bass pullback: charges up while bass is loud, releases otherwise
  const pullTarget = smoothedBass > 0.6 ? 1 : 0;
  bassPullback += (pullTarget - bassPullback) * 0.04 * dt;

  // Continuous orbit angle advance (radians per frame at 60fps reference)
  orbitAngle += dt * (Math.PI * 2) / (ORBIT_PERIOD_S * FRAMES_REF);

  // Decay impulses (frame-rate-independent)
  zoomPunch *= Math.pow(0.78, dt);
  if (zoomPunch < 0.001) zoomPunch = 0;
  shakeX *= Math.pow(0.80, dt);
  shakeY *= Math.pow(0.80, dt);
  rollImpulse *= Math.pow(0.88, dt);
  rollAngle += rollImpulse * dt;
  // Gradually unwind roll back to upright when there's no impulse
  if (Math.abs(rollImpulse) < 0.001) {
    rollAngle *= Math.pow(0.96, dt);
  }

  // Apply camera transforms
  const effDist = camDist * (1 - zoomPunch * 0.4);
  camera.fov = fov - zoomPunch * 8;
  camera.updateProjectionMatrix();
  camera.position.set(
    Math.cos(orbitAngle) * effDist + shakeX,
    camY + shakeY,
    Math.sin(orbitAngle) * effDist,
  );
  camera.up.set(Math.sin(rollAngle), Math.cos(rollAngle), 0);
  camera.lookAt(0, 0, 0);
  keyLight.position.copy(camera.position);

  // Crystal: bass scale-pulse + slow self-rotation
  const scale = 1 + smoothedBass * 0.08;
  crystalGroup.scale.set(scale, scale, scale);
  crystalGroup.rotation.y += dt * 0.002;

  // Per-frame: facet colors from band amps + transient spikes
  updateFacetColors(amps, transients);

  // Material emissive responds to total energy + crash-zoom flash
  const totalAmp = amps.reduce((s, a) => s + a, 0) / BAND_COUNT;
  crystalMat.emissiveIntensity = 0.05 + totalAmp * 0.35 + zoomPunch * 0.4;

  // Edge opacity follows total energy
  if (crystalEdge) {
    const edgeMat = crystalEdge.material as THREE.LineBasicMaterial;
    edgeMat.opacity = 0.25 + totalAmp * 0.4;
    crystalEdge.scale.copy(crystalGroup.scale);
    crystalEdge.rotation.copy(crystalGroup.rotation);
  }

  // Bloom strength from intensity slider (0..2 typical)
  if (composer.passes[1]) {
    (composer.passes[1] as UnrealBloomPass).strength = 0.9 * store.config.intensity;
  }

  composer.render();
}

// ── Reset ─────────────────────────────────────────────────────────────────────

export function resetMonolith(): void {
  if (!initialized) return;
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer?.setSize(w, h);
  if (camera) {
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  composer?.setSize(w, h);
}

// ── Dispose ───────────────────────────────────────────────────────────────────

export function disposeMonolith(): void {
  if (!initialized) return;
  vizModeUnsub?.();
  vizModeUnsub = null;

  crystalMesh?.geometry.dispose();
  crystalMat?.dispose();
  if (crystalEdge) {
    crystalEdge.geometry.dispose();
    (crystalEdge.material as THREE.LineBasicMaterial).dispose();
  }

  composer?.dispose();
  renderer?.dispose();
  threeCanvas?.remove();

  threeCanvas = null;
  renderer = null;
  scene = null;
  camera = null;
  composer = null;
  crystalGroup = null;
  crystalMesh = null;
  crystalMat = null;
  crystalEdge = null;
  faceBandMap = null;
  colorAttr = null;
  ambientLight = null;
  keyLight = null;

  phase = 'orbit';
  phaseStartBeat = 0;
  beatCount = 0;
  lastBeatIndex = -1;
  orbitAngle = 0;
  camY = CAM_Y_BASE;
  camDist = CAM_DIST_BASE;
  fov = FOV_BASE;
  zoomPunch = 0;
  shakeX = 0;
  shakeY = 0;
  rollAngle = 0;
  rollImpulse = 0;
  bassPullback = 0;
  smoothedBass = 0;

  initialized = false;
}
