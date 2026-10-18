/**
 * Filaments — hanging resin strand curtain
 * Inspired by Yasuaki Onishi "Reverse of Volume" (2009–present)
 * https://www.yasuaki-onishi.com/works/reverse-of-volume/
 *
 * N vertical tube strands descend from a virtual ceiling into darkness.
 * Each strand sways continuously driven by 7 freq bands.
 * A beat fires a downward travelling wave along the strands.
 * MeshPhysicalMaterial transmission for amber-glass resin look.
 * Warm tungsten key light + cool ambient fill — no rainbow, no neon glow.
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { store } from '../state/store';
import { getBandAverages } from './helpers';
import { isMobile } from '../utils/constants';

// ── Module state ───────────────────────────────────────────────────────────────

let threeCanvas: HTMLCanvasElement | null = null;
let renderer: THREE.WebGLRenderer | null = null;
let scene: THREE.Scene | null = null;
let camera: THREE.PerspectiveCamera | null = null;
let composer: EffectComposer | null = null;
let vizModeUnsub: (() => void) | null = null;
let initialized = false;

// Per-strand data
interface Strand {
  mesh: THREE.Mesh;
  geo: THREE.TubeGeometry;
  mat: THREE.MeshPhysicalMaterial;
  x: number;           // fixed X grid position
  z: number;           // fixed Z grid position
  band: number;        // freq band index 0-6
  phase: number;       // Perlin phase offset for independent drift
  swayX: number;       // current sway offset in X (eased)
  swayZ: number;       // current sway offset in Z (eased)
  waveMag: number;     // current beat-wave magnitude (decays each frame)
}

let strands: Strand[] = [];
let keyLight: THREE.SpotLight | null = null;
let rimLight: THREE.DirectionalLight | null = null;

// Time accumulator (seconds)
let time = 0;

// Beat wave propagation state
let waveFront = 0;   // normalised 0–1 (0=ceiling,1=floor)
let waveActive = false;

const STRAND_HEIGHT = 8.0;   // world-unit height of each strand
const CEILING_Y     =  3.0;

// Simple deterministic pseudo-random (Wang hash)
function hash(n: number): number {
  let x = Math.imul(n ^ (n >>> 17), 0xbf324a6b);
  x ^= (x >>> 13);
  x = Math.imul(x, 0x9f7eda17);
  x ^= (x >>> 16);
  return (x >>> 0) / 0xffffffff;
}

// ── Build a strand path (CatmullRomCurve3) ────────────────────────────────────

function buildStrandPath(
  x: number, z: number,
  swayX: number, swayZ: number,
  waveMag: number,
  segments: number
): THREE.CatmullRomCurve3 {
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i <= segments; i++) {
    const t   = i / segments;
    const y   = CEILING_Y - t * STRAND_HEIGHT;
    // Gravity droop: tips sway further than root
    const sway = t * t;
    // Beat wave: sinusoidal perturbation travelling downward
    const waveDist = Math.abs(t - waveFront);
    const waveDisp = waveActive ? waveMag * Math.exp(-waveDist * waveDist * 30) : 0;
    pts.push(new THREE.Vector3(
      x + swayX * sway + waveDisp * 0.15,
      y,
      z + swayZ * sway + waveDisp * 0.10
    ));
  }
  return new THREE.CatmullRomCurve3(pts);
}

// ── Setup ─────────────────────────────────────────────────────────────────────

function setup(): void {
  const density = store.config.filamentsDensity; // 0–1
  const clarity  = store.config.filamentsClarity;

  // canvas overlay
  threeCanvas = document.createElement('canvas');
  threeCanvas.style.cssText =
    'position:fixed;top:0;left:0;width:100%;height:100%;z-index:10;pointer-events:none;display:block';
  document.body.appendChild(threeCanvas);

  renderer = new THREE.WebGLRenderer({ canvas: threeCanvas, antialias: !isMobile, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, isMobile ? 1 : 1.5));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  // Transmissive materials need localClippingEnabled off (default) but do need this:
  renderer.shadowMap.enabled = false;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x070705); // near-black warm charcoal
  scene.fog = new THREE.FogExp2(0x070705, 0.12);

  const aspect = window.innerWidth / window.innerHeight;
  camera = new THREE.PerspectiveCamera(50, aspect, 0.1, 60);
  camera.position.set(0, 0, 7);

  // Lighting — warm tungsten key from upper-right + cool blue rim from left
  keyLight = new THREE.SpotLight(0xffcc77, isMobile ? 60 : 100, 30, Math.PI * 0.35, 0.5, 1.5);
  keyLight.position.set(4, 5, 5);
  scene.add(keyLight);
  scene.add(keyLight.target);

  rimLight = new THREE.DirectionalLight(0x8ab8e8, 0.8);
  rimLight.position.set(-3, 1, -3);
  scene.add(rimLight);

  scene.add(new THREE.AmbientLight(0x1a1610, 0.6));

  // Build strands
  buildStrands(density, clarity);

  // EffectComposer — subtle bloom only on desktop
  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  if (!isMobile) {
    const bloom = new UnrealBloomPass(
      new THREE.Vector2(window.innerWidth, window.innerHeight),
      0.25,   // strength
      0.5,    // radius
      0.85    // threshold
    );
    composer.addPass(bloom);
  }
  composer.addPass(new OutputPass());

  vizModeUnsub = store.on('vizModeChange', (data) => {
    if (!threeCanvas) return;
    threeCanvas.style.display = data === 'filaments' ? 'block' : 'none';
  });

  initialized = true;
}

// ── Build / rebuild strand meshes ─────────────────────────────────────────────

function buildStrands(density: number, clarity: number): void {
  if (!scene) return;

  // Dispose old strands
  for (const s of strands) {
    scene.remove(s.mesh);
    s.geo.dispose();
    s.mat.dispose();
  }
  strands = [];

  // density 0→1 maps to 6→60 strands (3–30 on mobile)
  const maxStrands = isMobile ? 30 : 60;
  const minStrands = isMobile ? 3  : 6;
  const count = Math.round(minStrands + density * (maxStrands - minStrands));

  // Grid layout: roughly square root for rows×cols
  const cols = Math.ceil(Math.sqrt(count * 1.6));
  const rows = Math.ceil(count / cols);
  const spacingX = 6.0 / Math.max(cols - 1, 1);
  const spacingZ = 4.0 / Math.max(rows - 1, 1);

  const pathSegs = isMobile ? 8 : 14;
  const tubeSegs = isMobile ? 4 : 6;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const idx = r * cols + c;
      if (idx >= count) break;

      const jx = (hash(idx * 13 + 7) - 0.5) * spacingX * 0.3;
      const jz = (hash(idx * 17 + 3) - 0.5) * spacingZ * 0.3;
      const x  = -3.0 + c * spacingX + jx;
      const z  = -2.0 + r * spacingZ + jz;

      // radius: thin variation
      const baseR = 0.018 + hash(idx * 23) * 0.012;

      // map strand to one of 7 freq bands
      const band = idx % 7;

      const curve = buildStrandPath(x, z, 0, 0, 0, pathSegs);
      const geo   = new THREE.TubeGeometry(curve, pathSegs, baseR, tubeSegs, false);

      // Amber-glass resin material
      // clarity 0→1: frosted amber → clear glass
      const transmission = clarity;
      const roughness    = 0.3 - clarity * 0.28; // frosted→glossy
      const mat = new THREE.MeshPhysicalMaterial({
        color:        new THREE.Color(0.95, 0.60, 0.15), // warm amber
        transmission: transmission,
        roughness:    roughness,
        metalness:    0.0,
        ior:          1.5,
        thickness:    0.05,
        attenuationColor: new THREE.Color(0.9, 0.5, 0.1),
        attenuationDistance: 0.3,
        emissive:     new THREE.Color(0.25, 0.12, 0.02),
        emissiveIntensity: 0.0,
        transparent:  true,
        opacity:      0.85 + clarity * 0.12,
        side:         THREE.DoubleSide,
      });

      const mesh = new THREE.Mesh(geo, mat);
      scene!.add(mesh);

      strands.push({
        mesh, geo, mat, x, z, band,
        phase:   hash(idx * 31) * Math.PI * 2,
        swayX:   0,
        swayZ:   0,
        waveMag: 0,
      });
    }
  }
}

// ── Draw ───────────────────────────────────────────────────────────────────────

export function drawFilaments(_p: unknown, dt: number): void {
  if (!initialized) setup();
  if (!scene || !camera || !composer || !renderer) return;

  const { amps, transients } = getBandAverages(7);
  const sway    = store.config.filamentsSway;    // 0–1
  const clarity  = store.config.filamentsClarity;

  // Detect beat — strongest transient across bands 0–2
  const maxTransient = Math.max(
    transients[0] ?? 1, transients[1] ?? 1, transients[2] ?? 1
  );
  if (maxTransient > 1.5 && !waveActive) {
    waveActive = true;
    waveFront  = 0.0;
  }

  // Advance beat wave
  const waveSpeed = 0.025 * dt;
  if (waveActive) {
    waveFront += waveSpeed;
    if (waveFront > 1.3) { waveActive = false; waveFront = 0; }
  }

  time += 0.016 * dt;

  const cfg = store.config;
  const density = cfg.filamentsDensity;

  // Rebuild strands if density or clarity changed significantly
  // (do this at most once per 2 seconds to avoid GPU thrash)
  if (strands.length > 0) {
    const maxStrands = isMobile ? 30 : 60;
    const minStrands = isMobile ? 3  : 6;
    const expectedCount = Math.round(minStrands + density * (maxStrands - minStrands));
    if (Math.abs(expectedCount - strands.length) > 2) {
      buildStrands(density, clarity);
    }
  }

  const pathSegs = isMobile ? 8 : 14;

  for (const s of strands) {
    const amp = amps[s.band] ?? 0;
    const swayScale = sway * 0.6;

    // Target sway: slow sine driven by audio amplitude + time
    const freqX = 0.3 + s.band * 0.04;
    const freqZ = 0.2 + s.band * 0.03;
    const targetX = Math.sin(time * freqX + s.phase)       * amp * swayScale;
    const targetZ = Math.cos(time * freqZ + s.phase * 0.7) * amp * swayScale * 0.6;

    // Ease current sway toward target (spring-damper feel)
    const ease = 1.0 - Math.pow(0.04, dt / 16);
    s.swayX += (targetX - s.swayX) * ease;
    s.swayZ += (targetZ - s.swayZ) * ease;

    // Beat wave magnitude for this strand (proximity to waveFront)
    const waveMag = waveActive ? maxTransient - 1.0 : 0;
    s.waveMag += (waveMag - s.waveMag) * 0.15;

    // Rebuild TubeGeometry with updated path
    const curve    = buildStrandPath(s.x, s.z, s.swayX, s.swayZ, s.waveMag, pathSegs);
    const newGeo   = new THREE.TubeGeometry(curve, pathSegs, (s.geo.parameters as { radius?: number }).radius ?? 0.022, isMobile ? 4 : 6, false);
    s.geo.dispose();
    s.geo = newGeo;
    s.mesh.geometry = newGeo;

    // Emissive glow proportional to amplitude
    s.mat.emissiveIntensity = amp * 0.35 + (transients[s.band] ?? 1) * 0.08;

    // Update clarity live
    if (Math.abs(s.mat.transmission - clarity) > 0.05) {
      s.mat.transmission = clarity;
      s.mat.roughness    = 0.3 - clarity * 0.28;
      s.mat.opacity      = 0.85 + clarity * 0.12;
    }
  }

  // Camera: slow orbit around Y axis, looking at mid-strand height
  const camRadius = 7 + (amps[0] ?? 0) * 0.5;
  const camAngle  = time * 0.08;
  camera.position.set(
    Math.sin(camAngle) * camRadius,
    0.5 + Math.sin(time * 0.05) * 0.6,
    Math.cos(camAngle) * camRadius
  );
  camera.lookAt(0, 0.5, 0);

  // Key light slow drift for subtle lighting variation
  if (keyLight) {
    keyLight.intensity = (isMobile ? 60 : 100) + (amps[1] ?? 0) * (isMobile ? 20 : 40);
    keyLight.position.x = 3 + Math.sin(time * 0.13) * 1.5;
    keyLight.position.z = 4 + Math.cos(time * 0.09) * 1.5;
  }

  composer.render();
}

// ── Reset ──────────────────────────────────────────────────────────────────────

export function resetFilaments(): void {
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

// ── Dispose ────────────────────────────────────────────────────────────────────

export function disposeFilaments(): void {
  if (!initialized) return;
  vizModeUnsub?.();
  vizModeUnsub = null;
  for (const s of strands) {
    scene?.remove(s.mesh);
    s.geo.dispose();
    s.mat.dispose();
  }
  strands = [];
  composer?.dispose();
  renderer?.dispose();
  threeCanvas?.remove();
  threeCanvas = null;
  renderer = null;
  scene = null;
  camera = null;
  composer = null;
  keyLight = null;
  rimLight = null;
  time = 0;
  waveFront = 0;
  waveActive = false;
  initialized = false;
}
