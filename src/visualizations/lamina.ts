/**
 * Lamina — Three.js WebGL overlay visualization.
 *
 * Hundreds of thin metallic plates cluster in a dark void; each plate is
 * assigned to one of 7 frequency bands and continuously eases toward an
 * audio-driven radial target (closer = quiet, further = loud). Beat fires
 * an outward impulse that decays smoothly — a TD/VJ-style additive kick
 * on top of an already-flowing system, never a hard state cut. Warm key
 * + cool fill studio rig, physical MeshStandardMaterial with IBL, no
 * rainbow palette — the Warmth slider shifts the entire cluster from
 * cool brushed steel to warm amber-gold.
 *
 * Inspired by Studio DRIFT "Fragile Future" chandelier sculptures
 * (2006–present, https://www.studiodrift.com/work/fragile-future) — light
 * assemblies of hundreds of dandelion seeds, each tipped with a tiny LED,
 * that breathe and ripple in real time — and Sabine Marcelis' suspended
 * glass-panel color-light installations (2019–present,
 * https://sabinemarcelis.com/project/colour-vivid/). The VJ signature is
 * treating each plate as an independent signal path: its radial offset is
 * a CHOP-style per-band continuous value rather than a threshold trigger.
 */
import * as THREE from 'three';
import { EffectComposer }   from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass }       from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass }  from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass }       from 'three/addons/postprocessing/OutputPass.js';
import { RoomEnvironment }  from 'three/addons/environments/RoomEnvironment.js';
import { store }            from '../state/store';
import { getBandAverages, fovForAspect } from './helpers';
import { audioEngine }      from '../audio/engine';
import { isMobile }         from '../utils/constants';

// ── Constants ─────────────────────────────────────────────────────────────────

const BAND_COUNT  = 7;
const SPHERE_R    = 3.2;    // radius of home-position sphere
const PLATE_W     = 0.55;
const PLATE_H     = 0.80;
const PLATE_D     = 0.035;  // thinness

// ── Module state ──────────────────────────────────────────────────────────────

let initialized   = false;
let threeCanvas   : HTMLCanvasElement | null = null;
let renderer      : THREE.WebGLRenderer | null = null;
let scene         : THREE.Scene | null = null;
let camera        : THREE.PerspectiveCamera | null = null;
let composer      : EffectComposer | null = null;
let plateMesh     : THREE.InstancedMesh | null = null;
let plateMat      : THREE.MeshStandardMaterial | null = null;
let envTexture    : THREE.Texture | null = null;
let vizModeUnsub  : (() => void) | null = null;

// ── Per-plate arrays (rebuilt when Count slider changes) ──────────────────────

let plateCount   = 0;
let plateHome    : THREE.Vector3[] = [];   // Fibonacci-sphere home positions
let plateCurrent : THREE.Vector3[] = [];   // current positions (lerped each frame)
let plateVelMag  : number[]        = [];   // outward radial velocity (beat kick)
let plateBand    : number[]        = [];   // assigned freq band [0..6]
let plateRotAxis : THREE.Vector3[] = [];   // random rotation axis (unit)
let plateRotAngle: number[]        = [];   // current rotation angle (radians)
let plateRotSpeed: number[]        = [];   // rotation speed (rad/s equiv)

// ── Dummy / scratch ───────────────────────────────────────────────────────────

const dummy     = new THREE.Object3D();
const tmpColor  = new THREE.Color();
const tmpQuat   = new THREE.Quaternion();
const tmpAx     = new THREE.Vector3();

// ── Time / beat ───────────────────────────────────────────────────────────────

let time          = 0;
let cameraAngle   = 0;
let cameraAlt     = 0;
let beatImpulse   = 0;     // 0→1 on beat, decays to 0 per frame
let lastBeatIndex = -1;
let lastCount     = -1;    // detect slider change to rebuild plates

// ── Fibonacci-sphere plate builder ────────────────────────────────────────────

function buildPlates(count: number): void {
  plateCount = count;
  plateHome    = [];
  plateCurrent = [];
  plateVelMag  = [];
  plateBand    = [];
  plateRotAxis = [];
  plateRotAngle= [];
  plateRotSpeed= [];

  const golden = Math.PI * (3 - Math.sqrt(5)); // golden angle ≈ 137.508°

  for (let i = 0; i < count; i++) {
    // Fibonacci sphere point
    const y   = 1 - (i / (count - 1)) * 2;
    const r   = Math.sqrt(Math.max(0, 1 - y * y));
    const phi = golden * i;
    const x   = r * Math.cos(phi);
    const z   = r * Math.sin(phi);

    const home = new THREE.Vector3(x * SPHERE_R, y * SPHERE_R, z * SPHERE_R);
    plateHome.push(home);
    plateCurrent.push(home.clone());
    plateVelMag.push(0);
    plateBand.push(i % BAND_COUNT);

    // Random rotation axis
    const ax = new THREE.Vector3(
      Math.random() - 0.5,
      Math.random() - 0.5,
      Math.random() - 0.5,
    ).normalize();
    plateRotAxis.push(ax);
    plateRotAngle.push(Math.random() * Math.PI * 2);
    // Slower rotation for larger plates; random direction
    plateRotSpeed.push((0.15 + Math.random() * 0.35) * (Math.random() < 0.5 ? 1 : -1));
  }
}

// ── Update per-plate colors (call on warmth slider change + each rebuild) ─────

function refreshColors(amps: number[], warmth: number): void {
  if (!plateMesh) return;
  for (let i = 0; i < plateCount; i++) {
    const band = plateBand[i];
    const t    = band / (BAND_COUNT - 1);  // 0=sub-bass, 1=brilliance

    // Warm: amber-gold hue 38°, cool: steel-blue hue 210°
    // Warmth=1 → sub-bass plate is gold, brilliance plate is silver
    // Warmth=0 → sub-bass plate is cooler blue, brilliance plate is near-white cool
    const warmFactor = warmth * (1 - t) + (1 - warmth) * t * 0.25;

    const wH = 38  / 360, wS = 0.58, wL = 0.70;
    const cH = 210 / 360, cS = 0.22, cL = 0.76;

    const h = cH + (wH - cH) * warmFactor;
    const s = cS + (wS - cS) * warmFactor;
    const l = cL + (wL - cL) * warmFactor;

    // Brightness boost from amplitude
    const boost = (amps[band] ?? 0) * 0.18;
    tmpColor.setHSL(h, s, Math.min(0.98, l + boost));
    plateMesh.setColorAt(i, tmpColor);
  }
  if (plateMesh.instanceColor) plateMesh.instanceColor.needsUpdate = true;
}

// ── Scene setup ───────────────────────────────────────────────────────────────

function setup(): void {
  const w = window.innerWidth;
  const h = window.innerHeight;

  // ── Canvas + renderer ──
  threeCanvas = document.createElement('canvas');
  threeCanvas.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:0';
  threeCanvas.width  = w;
  threeCanvas.height = h;
  document.body.appendChild(threeCanvas);

  renderer = new THREE.WebGLRenderer({
    canvas:     threeCanvas,
    antialias:  !isMobile,
    alpha:      false,
    powerPreference: 'high-performance',
  });
  renderer.setSize(w, h);
  renderer.setPixelRatio(isMobile ? Math.min(window.devicePixelRatio, 1.5) : window.devicePixelRatio);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;

  // ── Scene ──
  scene  = new THREE.Scene();
  scene.background = new THREE.Color(0x050507);

  // ── Camera ──
  camera = new THREE.PerspectiveCamera(
    fovForAspect(50, w / h),
    w / h, 0.1, 120,
  );
  camera.position.set(0, 2, 10);

  // ── IBL environment (PMREMGenerator from RoomEnvironment) ──
  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  const roomEnv = new RoomEnvironment();
  envTexture    = pmrem.fromScene(roomEnv).texture;
  roomEnv.dispose();
  pmrem.dispose();
  scene.environment = envTexture;

  // ── Lights ──
  //   Warm key from upper-right front
  const key = new THREE.DirectionalLight(0xfff0d8, 2.2);
  key.position.set(5, 8, 6);
  scene.add(key);

  //   Cool fill from left-rear
  const fill = new THREE.DirectionalLight(0xd0e8ff, 0.7);
  fill.position.set(-6, 2, -4);
  scene.add(fill);

  //   Soft ambient
  scene.add(new THREE.AmbientLight(0xffffff, 0.15));

  // ── Plate geometry + material ──
  const geo = new THREE.BoxGeometry(PLATE_W, PLATE_H, PLATE_D, 1, 1, 1);

  plateMat = new THREE.MeshStandardMaterial({
    roughness:       0.18,
    metalness:       0.80,
    envMapIntensity: 1.4,
  });

  const initCount = isMobile ? 100 : 200;
  buildPlates(initCount);
  lastCount = initCount;

  plateMesh = new THREE.InstancedMesh(geo, plateMat, initCount);
  plateMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  plateMesh.castShadow    = false;
  plateMesh.receiveShadow = false;
  scene.add(plateMesh);

  // Initialise all instance transforms to home positions
  for (let i = 0; i < initCount; i++) {
    dummy.position.copy(plateHome[i]);
    dummy.setRotationFromAxisAngle(plateRotAxis[i], plateRotAngle[i]);
    dummy.updateMatrix();
    plateMesh.setMatrixAt(i, dummy.matrix);
  }
  plateMesh.instanceMatrix.needsUpdate = true;

  // Initial colors
  refreshColors(new Array(BAND_COUNT).fill(0), store.config.laminaWarmth);

  // ── Post-processing ──
  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));

  if (!isMobile) {
    const bloom = new UnrealBloomPass(
      new THREE.Vector2(w, h),
      0.22,  // strength (subtle)
      0.55,  // radius
      0.85,  // threshold
    );
    composer.addPass(bloom);
  }

  composer.addPass(new OutputPass());

  // ── Unsub on viz switch ──
  vizModeUnsub = store.on('vizModeChange', () => { disposeLamina(); });

  initialized = true;
}

// ── Draw (called every frame) ─────────────────────────────────────────────────

export function drawLamina(_p: unknown, dt: number): void {
  if (!initialized) setup();
  if (!scene || !camera || !composer || !renderer || !plateMesh || !plateMat) return;

  const { amps, transients } = getBandAverages(BAND_COUNT);

  // ── Beat detection via playback position ──
  const { beatIntervalSec, beatOffset, isPlaying } = store.state;
  if (beatIntervalSec > 0 && isPlaying) {
    const pos      = audioEngine.getPlaybackPosition();
    const adjusted = pos - beatOffset;
    const beatIdx  = adjusted >= 0 ? Math.floor(adjusted / beatIntervalSec) : -1;
    if (beatIdx > lastBeatIndex) {
      lastBeatIndex = beatIdx;
      const maxAmp = Math.max(...amps);
      if (maxAmp > 0.08) {
        beatImpulse = Math.min(1.0, beatImpulse + 0.7 + maxAmp * 0.5);
      }
    }
  }

  // Also add to beat impulse from transients (works in mic mode / no BPM)
  const maxTransient = Math.max(...transients);
  if (maxTransient > 1.4) {
    beatImpulse = Math.min(1.0, beatImpulse + (maxTransient - 1.0) * 0.5);
  }

  // Decay
  beatImpulse *= Math.pow(0.92, dt);
  time        += 0.016 * dt;
  cameraAngle += 0.0045 * dt;
  cameraAlt    = Math.sin(time * 0.031) * 1.8;

  // ── Camera orbit ──
  const camDist = 10.5 + Math.sin(time * 0.023) * 0.8;
  camera.position.set(
    Math.sin(cameraAngle) * camDist,
    cameraAlt + 1.0,
    Math.cos(cameraAngle) * camDist,
  );
  camera.lookAt(0, 0, 0);

  // ── Check if Count slider changed (structural rebuild) ──
  const targetCount = Math.round(
    isMobile
      ? store.config.laminaCount * 0.35 + 15   // mobile: ~15–120
      : store.config.laminaCount,
  );
  if (targetCount !== lastCount) {
    lastCount = targetCount;
    buildPlates(targetCount);

    // Rebuild InstancedMesh (count changed → need a new one)
    if (scene && plateMesh) {
      scene.remove(plateMesh);
      plateMesh.dispose();
    }
    const geo = new THREE.BoxGeometry(PLATE_W, PLATE_H, PLATE_D, 1, 1, 1);
    plateMesh = new THREE.InstancedMesh(geo, plateMat!, targetCount);
    plateMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(plateMesh);
  }

  // ── Per-plate update ──
  const scatter      = store.config.laminaScatter;
  const lerpK        = 1 - Math.pow(0.88, dt);       // position lerp speed
  const rotK         = 0.016 * dt;                    // rotation step
  const beatOutward  = beatImpulse * scatter * 2.8;   // beat adds radial push

  for (let i = 0; i < plateCount; i++) {
    const band   = plateBand[i];
    const amp    = amps[band] ?? 0;

    // Radial target = home radius + audio offset + beat impulse
    const radialOffset = amp * 2.2 + beatOutward;
    const homeDir      = plateHome[i].clone().normalize();
    const target       = homeDir.multiplyScalar(SPHERE_R + radialOffset);

    // Smooth lerp toward target
    plateCurrent[i].lerp(target, lerpK);

    // Rotation on random axis, speed modulated by amplitude
    const rotSpeed = plateRotSpeed[i] * (1.0 + amp * 0.8);
    plateRotAngle[i] += rotSpeed * rotK;

    // Build matrix
    dummy.position.copy(plateCurrent[i]);
    tmpAx.copy(plateRotAxis[i]);
    tmpQuat.setFromAxisAngle(tmpAx, plateRotAngle[i]);
    dummy.quaternion.copy(tmpQuat);
    dummy.updateMatrix();
    plateMesh!.setMatrixAt(i, dummy.matrix);
  }
  plateMesh.instanceMatrix.needsUpdate = true;

  // ── Per-plate colors (warm/cool by band, amplitude brightness) ──
  refreshColors(amps, store.config.laminaWarmth);

  // ── Material roughness from warmth (warmer = fractionally more matte) ──
  const warmth = store.config.laminaWarmth;
  plateMat.roughness = 0.10 + warmth * 0.18;

  composer.render();
}

// ── Reset (called on window resize / viz switch-in) ──────────────────────────

export function resetLamina(): void {
  if (!initialized) return;
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer?.setSize(w, h);
  if (camera) {
    camera.aspect = w / h;
    camera.fov    = fovForAspect(50, camera.aspect);
    camera.updateProjectionMatrix();
  }
  composer?.setSize(w, h);
}

// ── Dispose (called when switching away from this viz) ────────────────────────

export function disposeLamina(): void {
  if (!initialized) return;

  vizModeUnsub?.();
  vizModeUnsub = null;

  if (plateMesh && scene) {
    scene.remove(plateMesh);
    plateMesh.geometry.dispose();
    plateMesh.dispose();
    plateMesh = null;
  }

  plateMat?.dispose();
  envTexture?.dispose();
  composer?.dispose();
  renderer?.dispose();
  threeCanvas?.remove();

  threeCanvas = null;
  renderer    = null;
  scene       = null;
  camera      = null;
  composer    = null;
  plateMat    = null;
  envTexture  = null;

  // Reset arrays
  plateHome    = [];
  plateCurrent = [];
  plateVelMag  = [];
  plateBand    = [];
  plateRotAxis = [];
  plateRotAngle= [];
  plateRotSpeed= [];
  plateCount   = 0;

  time          = 0;
  cameraAngle   = 0;
  cameraAlt     = 0;
  beatImpulse   = 0;
  lastBeatIndex = -1;
  lastCount     = -1;

  initialized = false;
}

