/**
 * Confluence — 3D metaball sculpture via Three.js MarchingCubes
 *
 * 7 luminous fluid spheres orbit in a dark void, one per frequency band.
 * Their scalar field is sampled on a cubic grid and reconstructed into a
 * smooth isosurface using the marching-cubes algorithm.  At low amplitude
 * the blobs remain as distinct separate orbs; at high amplitude they
 * merge into a single heaving organic mass.
 *
 * Aesthetic: biomorphic sculpture under a two-point studio rig — warm amber
 * key light + cool steel fill — no rainbow palette, no additive neon glow,
 * no per-beat hue snap.  Beat fires a continuous "merge surge" impulse that
 * decays like a CHOP signal.
 *
 * Inspired by Neri Oxman "Silk Pavilion" (2013, MIT Media Lab,
 * https://oxman.com/projects/silk-pavilion) — biologically-woven
 * structures where individual elements merge into a continuous surface —
 * and Refik Anadol "Machine Hallucinations: Nature Dreams" (2026,
 * KÖNIG GALERIE Berlin, https://refikanadol.com/works/machine-hallucinations-nature-dreams/)
 * continuous morphing of organic volumetric forms.
 *
 * Sliders
 *   Fuse    — isolation threshold (structural: 0=separate orbs, 1=tightly merged mass)
 *   Orbit   — orbital radius (structural: 0=compact, 1=spread out)
 *   Sheen   — material polish (0=warm matte clay → 1=cool glossy mercury)
 */
import * as THREE from 'three';
import { MarchingCubes } from 'three/addons/objects/MarchingCubes.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { store } from '../state/store';
import { getBandAverages, fovForAspect } from './helpers';
import { audioEngine } from '../audio/engine';
import { isMobile } from '../utils/constants';

// ── Module state ──────────────────────────────────────────────────────────────

let initialized    = false;
let setupStarted   = false;  // prevents re-entering async setup
let threeCanvas    : HTMLCanvasElement | null = null;
let renderer       : THREE.WebGLRenderer | null = null;
let scene          : THREE.Scene | null = null;
let camera         : THREE.PerspectiveCamera | null = null;
let composer       : EffectComposer | null = null;
let bloomPass      : UnrealBloomPass | null = null;
let march          : MarchingCubes | null = null;
let blobMat        : THREE.MeshPhysicalMaterial | null = null;
let keyLight       : THREE.DirectionalLight | null = null;
let fillLight      : THREE.DirectionalLight | null = null;
let vizModeUnsub   : (() => void) | null = null;

// Beat state
let lastBeatIndex  = -1;
let mergeSurge     = 0.0;  // extra isolation threshold drop on beat, CHOP-style decay

// Animation
let animTime       = 0.0;
let cameraTheta    = 0.0;
let cameraPhi      = 0.3;
let cameraVel      = 0.0;  // additional angular velocity kick on beat

// Per-blob orbit angles (constant, derived from golden angle)
const GOLDEN_ANGLE = Math.PI * (3.0 - Math.sqrt(5.0));
const BAND_COUNT   = 7;
const blobTheta    : number[] = [];  // azimuth base
const blobPhi      : number[] = [];  // elevation base
const blobOrbitT   : number[] = [];  // per-blob orbit time offset

for (let i = 0; i < BAND_COUNT; i++) {
  blobPhi.push(Math.asin(1 - (2 * i + 1) / BAND_COUNT));
  blobTheta.push(GOLDEN_ANGLE * i);
  blobOrbitT.push(i * 0.137);  // Fibonacci-spaced phase
}

// ── Setup ─────────────────────────────────────────────────────────────────────

async function setup(): Promise<void> {
  // Create canvas overlay
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
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, isMobile ? 1.0 : 1.5));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x040404);

  const aspect = window.innerWidth / window.innerHeight;
  camera = new THREE.PerspectiveCamera(fovForAspect(48, aspect), aspect, 0.1, 60);
  camera.position.set(0, 0, 4.5);

  // ── Lighting: warm amber key + cool steel fill + dim ambient ──
  keyLight  = new THREE.DirectionalLight(0xffd080, 3.5);
  keyLight.position.set(2.2, 3.0, 2.0);
  scene.add(keyLight);

  fillLight = new THREE.DirectionalLight(0x80aaff, 1.4);
  fillLight.position.set(-2.5, -1.5, -2.0);
  scene.add(fillLight);

  scene.add(new THREE.AmbientLight(0x181818, 1.0));

  // ── MarchingCubes blob ──
  const resolution = isMobile ? 18 : 26;

  blobMat = new THREE.MeshPhysicalMaterial({
    color:         0xf5ead8,   // warm ivory
    roughness:     0.35,
    metalness:     0.05,
    envMapIntensity: 0.4,
    // slight subsurface feel via transmission + thickness
    transmission:  0.08,
    thickness:     0.6,
    side: THREE.DoubleSide,
  });

  march = new MarchingCubes(resolution, blobMat, false, false, isMobile ? 16000 : 40000);
  march.isolation = 70.0;
  scene.add(march);

  // ── Post-processing ──
  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));

  if (!isMobile) {
    bloomPass = new UnrealBloomPass(
      new THREE.Vector2(window.innerWidth, window.innerHeight),
      0.35,   // strength
      0.5,    // radius
      0.88,   // threshold
    );
    composer.addPass(bloomPass);
  }
  composer.addPass(new OutputPass());

  // Hide when not active
  vizModeUnsub = store.on('vizModeChange', (m) => {
    if (threeCanvas) threeCanvas.style.display = m === 'confluence' ? 'block' : 'none';
  });

  initialized = true;
}

// ── Draw ──────────────────────────────────────────────────────────────────────

export function drawConfluence(_p: unknown, dt: number): void {
  if (!initialized) {
    if (!setupStarted) {
      setupStarted = true;
      void setup();
    }
    return;  // wait for async setup to complete
  }
  if (!renderer || !scene || !camera || !composer || !march || !blobMat) return;

  const { amps, transients } = getBandAverages(BAND_COUNT);
  const { state, config }    = store;

  // Config sliders (normalised 0–1)
  const fuseSlider  = config.confluenceFuse;   // 0 = separated, 1 = merged
  const orbitSlider = config.confluenceOrbit;  // 0 = compact, 1 = spread
  const sheenSlider = config.confluenceSheen;  // 0 = matte clay, 1 = glossy mercury

  animTime += dt * 0.016;

  // ── Beat detection ────────────────────────────────────────────────────────
  if (state.beatIntervalSec > 0 && state.isPlaying) {
    const pos      = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    const beatIdx  = adjusted >= 0 ? Math.floor(adjusted / state.beatIntervalSec) : -1;
    if (beatIdx > lastBeatIndex) {
      lastBeatIndex = beatIdx;
      mergeSurge  = 1.0;  // kick impulse
      cameraVel  += 0.018; // camera angular impulse
    }
  }

  // CHOP-style decay (no snap, continuous signal)
  mergeSurge = Math.max(0, mergeSurge - dt * 0.025);
  cameraVel  = Math.max(0, cameraVel  - dt * 0.01);

  // ── Update material based on Sheen slider ────────────────────────────────
  // Sheen=0 → warm clay: roughness 0.55, metalness 0.0, color warm ivory
  // Sheen=1 → cool mercury: roughness 0.02, metalness 0.9, color cool silver
  const s = sheenSlider;
  blobMat.roughness  = 0.55 - s * 0.53;
  blobMat.metalness  = s * 0.90;
  blobMat.color.setRGB(
    0.96 - s * 0.18,   // R: warm ivory → cool silver
    0.92 - s * 0.10,   // G
    0.85 + s * 0.15,   // B: warm → cool
  );

  // ── MarchingCubes blob update ─────────────────────────────────────────────
  // Isolation threshold: higher = harder to merge, lower = easier to merge
  // fuseSlider=0 → threshold 100 (hard to merge, separate orbs)
  // fuseSlider=1 → threshold 45 (easy to merge, unified mass)
  const baseThreshold  = 100.0 - fuseSlider * 55.0;
  const surgeThreshold = mergeSurge * 30.0;  // beat temporarily lowers threshold
  march.isolation      = baseThreshold - surgeThreshold;

  // Orbital radius (structural): 0 → 0.28, 1 → 0.42 (in march coords -1..1)
  const orbitR = 0.28 + orbitSlider * 0.14;

  march.reset();

  let overallAmp = 0;
  for (let b = 0; b < BAND_COUNT; b++) overallAmp += amps[b] ?? 0;
  overallAmp /= BAND_COUNT;

  for (let b = 0; b < BAND_COUNT; b++) {
    const amp      = amps[b] ?? 0;
    const tMult    = Math.max(0, (transients[b] ?? 1) - 1.0); // 0 at rest

    // Ball orbits at its golden-angle position, drifting slowly
    const orbitSpeed  = 0.05 + b * 0.013; // different speed per band
    const angle       = blobTheta[b] + animTime * orbitSpeed;
    const elev        = blobPhi[b]   + Math.sin(animTime * 0.07 + blobOrbitT[b]) * 0.4;
    const dynamicR    = orbitR * (1.0 + amp * 0.25);  // audio swells the orbit

    // Map to MarchingCubes coordinate space (centre 0.5, range 0..1)
    const x = 0.5 + dynamicR * Math.cos(elev) * Math.cos(angle);
    const y = 0.5 + dynamicR * Math.sin(elev);
    const z = 0.5 + dynamicR * Math.cos(elev) * Math.sin(angle);

    // Ball strength: base + amplitude + transient kick
    const strength = 0.55 + amp * 0.55 + tMult * 0.3;

    march.addBall(x, y, z, strength, 12.0);
  }

  march.update();

  // ── Camera orbit ─────────────────────────────────────────────────────────
  const baseSpeed = 0.0025;
  cameraTheta += dt * (baseSpeed + cameraVel);
  cameraPhi    = 0.28 + Math.sin(animTime * 0.14) * 0.14;

  // Slightly pull back when amplitude is high (more of the sculpture fits in frame)
  const camR = 4.0 + overallAmp * 0.5 + Math.sin(animTime * 0.09) * 0.3;

  camera.position.set(
    camR * Math.cos(cameraTheta) * Math.cos(cameraPhi),
    camR * Math.sin(cameraPhi),
    camR * Math.sin(cameraTheta) * Math.cos(cameraPhi),
  );
  camera.lookAt(0, 0, 0);
  camera.updateProjectionMatrix();

  // Key light slowly orbits too (adds dynamic shading shifts)
  if (keyLight) {
    keyLight.position.set(
      2.2 * Math.cos(animTime * 0.08),
      3.0,
      2.0 * Math.sin(animTime * 0.08),
    );
  }

  composer.render();
}

// ── Reset (resize) ────────────────────────────────────────────────────────────

export function resetConfluence(): void {
  if (!initialized) return;
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer?.setSize(w, h);
  if (camera) {
    camera.aspect = w / h;
    camera.fov    = fovForAspect(48, camera.aspect);
    camera.updateProjectionMatrix();
  }
  composer?.setSize(w, h);
}

// ── Dispose ───────────────────────────────────────────────────────────────────

export function disposeConfluence(): void {
  if (!initialized) return;
  vizModeUnsub?.();
  vizModeUnsub = null;
  march?.geometry.dispose();
  blobMat?.dispose();
  composer?.dispose();
  renderer?.dispose();
  threeCanvas?.remove();
  threeCanvas = null;
  renderer    = null;
  scene       = null;
  camera      = null;
  composer    = null;
  bloomPass   = null;
  march       = null;
  blobMat     = null;
  keyLight    = null;
  fillLight   = null;
  lastBeatIndex = -1;
  mergeSurge    = 0;
  cameraVel     = 0;
  animTime      = 0;
  cameraTheta   = 0;
  initialized   = false;
  setupStarted  = false;
}
