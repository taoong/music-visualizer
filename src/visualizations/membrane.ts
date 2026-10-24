/**
 * Membrane — a large iridescent metal surface resonating with 7 standing-wave
 * harmonic modes driven by audio frequency bands.  MeshPhysicalMaterial
 * thin-film iridescence colours every wave crest according to the viewing angle
 * and surface normal; a warm SpotLight key + cool fill DirectionalLight create
 * a restrained studio rig where the drama comes from light catching wave crests.
 * CPU vertex displacement writes directly to the Float32Array each frame so
 * Three.js can recompute normals correctly — the iridescence effect requires
 * accurate normals.  No rainbow palette, no neon glow, no centre pulse.
 *
 * Inspired by Tokujin Yoshioka "Crystallize" (2011, Swarovski Crystal Palace,
 * Design Miami) https://www.tokujin.com/work/crystallize — and the broader VJ
 * technique of driving material parameters (not just colour) directly from a
 * CHOP-style audio signal so the surface itself becomes the instrument.
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass }     from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass }     from 'three/addons/postprocessing/OutputPass.js';
import { store }          from '../state/store';
import { getBandAverages, fovForAspect } from './helpers';
import { isMobile }       from '../utils/constants';

// ── Module-level state (no classes) ──────────────────────────────────────────

let initialized  = false;
let threeCanvas  : HTMLCanvasElement | null = null;
let renderer     : THREE.WebGLRenderer | null = null;
let scene        : THREE.Scene | null = null;
let camera       : THREE.PerspectiveCamera | null = null;
let composer     : EffectComposer | null = null;
let mesh         : THREE.Mesh | null = null;
let geometry     : THREE.PlaneGeometry | null = null;
let material     : THREE.MeshPhysicalMaterial | null = null;
let keyLight     : THREE.SpotLight | null = null;
let vizModeUnsub : (() => void) | null = null;

let camT         = 0;   // accumulated orbit time
let beatKick     = 0;   // transient-kick amplitude — decays each frame
let lastSegments = -1;  // geometry rebuild guard

// Phase accumulators for each band's travelling wave components
const phaseX = new Float32Array(7);
const phaseY = new Float32Array(7);

// Standing-wave spatial parameters, indexed 0 (sub-bass) → 6 (brilliance).
// kx/ky: spatial frequency in radians per world-unit; higher bands carry
// higher spatial frequency so bass = long slow swells, brilliance = fine ripple.
const WAVES: { kx: number; ky: number; speedX: number; speedY: number }[] = [
  { kx: 0.50, ky: 0.30, speedX: 0.55, speedY: 0.40 },
  { kx: 0.90, ky: 0.65, speedX: 0.72, speedY: 0.58 },
  { kx: 1.50, ky: 1.20, speedX: 0.95, speedY: 0.80 },
  { kx: 2.30, ky: 1.90, speedX: 1.25, speedY: 1.05 },
  { kx: 3.40, ky: 2.80, speedX: 1.60, speedY: 1.40 },
  { kx: 4.80, ky: 4.10, speedX: 2.05, speedY: 1.85 },
  { kx: 6.60, ky: 5.80, speedX: 2.70, speedY: 2.45 },
];

const PLATE  = 14; // world-unit side length of the membrane

// ── Segment count from slider ─────────────────────────────────────────────────

function targetSegs(v: number): number {
  return isMobile ? Math.round(16 + v * 12) : Math.round(20 + v * 40);
}

// ── Setup ─────────────────────────────────────────────────────────────────────

function setup(): void {
  threeCanvas = document.createElement('canvas');
  threeCanvas.style.cssText =
    'position:fixed;top:0;left:0;width:100%;height:100%;z-index:10;pointer-events:none;display:block';
  document.body.appendChild(threeCanvas);

  renderer = new THREE.WebGLRenderer({ canvas: threeCanvas, antialias: !isMobile, alpha: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, isMobile ? 1 : 2));
  renderer.toneMapping      = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x03040a);

  const aspect = window.innerWidth / window.innerHeight;
  camera = new THREE.PerspectiveCamera(fovForAspect(52, aspect), aspect, 0.1, 200);
  camera.position.set(0, 3.5, 6.8);
  camera.lookAt(0, 0, 0);

  // ── Studio lighting ──────────────────────────────────────────────────────
  // Warm SpotLight from upper-left — sweeps specular bands across the ripples
  keyLight = new THREE.SpotLight(0xffcc80, 9.0, 45, Math.PI / 4.5, 0.5, 1.5);
  keyLight.position.set(-5, 9, 3);
  scene.add(keyLight);
  scene.add(keyLight.target);   // target stays at origin

  // Cool DirectionalLight from right — fills shadows with blue-tinted light
  const fill = new THREE.DirectionalLight(0x80a8ff, 1.6);
  fill.position.set(4, -1, -4);
  scene.add(fill);

  // Faint back-rim from behind and below — separates surface from background
  const rim = new THREE.DirectionalLight(0xd0c0ff, 0.5);
  rim.position.set(0, -5, -9);
  scene.add(rim);

  scene.add(new THREE.AmbientLight(0x06050a, 1.0));

  // ── Membrane geometry & physical material ────────────────────────────────
  const segs = targetSegs(store.config.membraneDetail);
  lastSegments = segs;
  geometry = new THREE.PlaneGeometry(PLATE, PLATE, segs, segs);

  material = new THREE.MeshPhysicalMaterial({
    color:                     0xc8d4dc,
    metalness:                 1.0,
    roughness:                 0.03,
    iridescence:               1.0,
    iridescenceIOR:            1.35,
    iridescenceThicknessRange: [150, 400],
    envMapIntensity:           0.0,  // studio lights only — no env map
    side:                      THREE.DoubleSide,
  });

  mesh = new THREE.Mesh(geometry, material);
  mesh.rotation.x = -Math.PI / 2;  // lay flat in world XZ plane
  scene.add(mesh);

  // ── Post-processing ──────────────────────────────────────────────────────
  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  if (!isMobile) {
    // Very subtle bloom — only the sharpest specular highlights catch light
    const bloom = new UnrealBloomPass(
      new THREE.Vector2(window.innerWidth, window.innerHeight),
      0.12,  // strength
      0.35,  // radius
      0.88,  // threshold
    );
    composer.addPass(bloom);
  }
  composer.addPass(new OutputPass());

  vizModeUnsub = store.on('vizModeChange', (data) => {
    if (threeCanvas) threeCanvas.style.display = data === 'membrane' ? 'block' : 'none';
  });

  initialized = true;
}

// ── Draw ──────────────────────────────────────────────────────────────────────

export function drawMembrane(_p: unknown, dt: number): void {
  if (!initialized) setup();

  const { amps, transients } = getBandAverages(7);
  const ampScale  = store.config.membraneAmplitude;  // 0–1
  const filmValue = store.config.membraneFilm;       // 0–1

  // Beat kick — sub-bass + bass transients add a brief extra-displacement
  // impulse that decays continuously (CHOP-style: no state cuts)
  const kickMag = Math.max(0, transients[0] - 1.0, transients[1] - 1.0);
  beatKick = Math.max(beatKick - dt * 0.06, 0);
  if (kickMag > 0.3) beatKick = Math.min(beatKick + kickMag * 0.55, 1.2);

  // ── Rebuild geometry when Detail slider changes ───────────────────────────
  const tSegs = targetSegs(store.config.membraneDetail);
  if (tSegs !== lastSegments && mesh) {
    geometry?.dispose();
    geometry = new THREE.PlaneGeometry(PLATE, PLATE, tSegs, tSegs);
    mesh.geometry = geometry;
    lastSegments = tSegs;
    phaseX.fill(0);
    phaseY.fill(0);
  }

  // ── Advance wave phases (continuous, never snaps on beat) ─────────────────
  for (let b = 0; b < 7; b++) {
    phaseX[b] += WAVES[b].speedX * 0.005 * dt;
    phaseY[b] += WAVES[b].speedY * 0.005 * dt;
  }

  // ── CPU vertex displacement ───────────────────────────────────────────────
  if (geometry) {
    const posAttr = geometry.getAttribute('position') as THREE.BufferAttribute;
    const posArr  = posAttr.array as Float32Array;
    const count   = posAttr.count;
    const maxZ    = 1.5 * ampScale + beatKick * 0.3;

    for (let i = 0; i < count; i++) {
      const x = posArr[i * 3];
      const y = posArr[i * 3 + 1];
      let z = 0;
      for (let b = 0; b < 7; b++) {
        const a = amps[b] * maxZ;
        if (a < 0.002) continue;
        const w = WAVES[b];
        z += a * Math.sin(w.kx * x + phaseX[b]) * Math.sin(w.ky * y + phaseY[b]);
      }
      posArr[i * 3 + 2] = z;
    }
    posAttr.needsUpdate = true;
    geometry.computeVertexNormals();  // accurate normals needed for iridescence
  }

  // ── Update iridescence film parameters in-place ───────────────────────────
  // Film=0: thin blue-violet shimmer; Film=1: thick soap-bubble full spectrum
  if (material) {
    material.iridescenceThicknessRange[0] = 100 + filmValue * 120;   // 100–220 nm
    material.iridescenceThicknessRange[1] = 250 + filmValue * 550;   // 250–800 nm
    material.iridescenceIOR = 1.2 + filmValue * 0.45;                // 1.2–1.65
  }

  // ── Camera orbit — slow sinusoidal path, never snaps ─────────────────────
  camT += dt * 0.0018;
  const R   = 6.8;
  const H   = 3.4 + Math.sin(camT * 0.21) * 0.9 + beatKick * 0.12;
  const ang = camT * 0.7;
  if (camera) {
    camera.position.set(R * Math.sin(ang), H, R * Math.cos(ang));
    camera.lookAt(0, 0, 0);
  }

  // Slowly sweep the key light so specular bands cross the wave crests
  if (keyLight) {
    const lt = camT * 0.55;
    keyLight.position.set(-5 + Math.sin(lt) * 2.5, 9, 3 + Math.cos(lt * 0.7) * 2.0);
  }

  if (composer) composer.render();
}

// ── Reset (window resize) ─────────────────────────────────────────────────────

export function resetMembrane(): void {
  if (!initialized) return;
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer?.setSize(w, h);
  if (camera) {
    camera.aspect = w / h;
    camera.fov    = fovForAspect(52, camera.aspect);
    camera.updateProjectionMatrix();
  }
  composer?.setSize(w, h);
}

// ── Dispose (called on viz switch or page unload) ─────────────────────────────

export function disposeMembrane(): void {
  if (!initialized) return;
  vizModeUnsub?.();
  vizModeUnsub = null;
  geometry?.dispose();
  material?.dispose();
  composer?.dispose();
  renderer?.dispose();
  threeCanvas?.remove();
  threeCanvas = null; renderer = null; scene    = null; camera   = null;
  composer   = null; mesh     = null; geometry = null; material = null;
  keyLight   = null;
  initialized = false;
}
