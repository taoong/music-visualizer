/**
 * Stacks: N wall-mounted rectangular relief boxes (one per frequency band);
 * each box protrudes from a dark wall proportional to its band amplitude;
 * single warm directional raking light creates deep shadows that reveal depth;
 * continuous CHOP-style lerp — beat fires camera dolly impulse, never a state cut;
 * restrained plaster→concrete palette with no glow or emissive.
 * Inspired by Donald Judd "Stack" (1967, MoMA) and his anodized aluminium box series,
 * and by the gallery lighting tradition that made industrial material feel immaterial.
 * sliders: Boxes (count 4–14, structural), Depth (extrusion amplitude), Patina (plaster→concrete)
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { store } from '../state/store';
import { getBandAverages, fovForAspect } from './helpers';
import { audioEngine } from '../audio/engine';
import { isMobile } from '../utils/constants';

// ── Module state ──────────────────────────────────────────────────────────────

let initialized    = false;
let threeCanvas    : HTMLCanvasElement | null = null;
let renderer       : THREE.WebGLRenderer | null = null;
let scene          : THREE.Scene | null = null;
let camera         : THREE.PerspectiveCamera | null = null;
let composer       : EffectComposer | null = null;
let vizModeUnsub   : (() => void) | null = null;

// Scene objects
let boxes          : THREE.Mesh[] = [];
let backWall       : THREE.Mesh | null = null;
let keyLight       : THREE.DirectionalLight | null = null;

// Animation state
let time           = 0;
let cameraX        = 1.8;
let cameraY        = 0.0;
let cameraZ        = 6.0;
let cameraVelZ     = 0.0;
let lastBeatIndex  = -1;
let boxDepths      : number[] = [];
let targetDepths   : number[] = [];
let builtCount     = 0;

// ── Box layout constants ──────────────────────────────────────────────────────

const BOX_W   = 2.4;
const BOX_H   = 0.24;
const BOX_GAP = 0.10;
const WALL_Z  = 0.0;   // back-face of boxes sits here

// ── Helpers ───────────────────────────────────────────────────────────────────

function countFromSlider(): number {
  const raw = store.config.stacksCount;
  return isMobile ? 7 : Math.min(14, Math.max(4, Math.round(4 + raw * 10)));
}

/** Colour interpolated between warm plaster and cool concrete based on patina. */
function boxColor(patina: number): THREE.Color {
  const warm = new THREE.Color(0xEDE5D0); // warm plaster/cream
  const cool = new THREE.Color(0x9A9A95); // cool concrete grey
  return warm.clone().lerp(cool, patina);
}

// ── Scene construction ────────────────────────────────────────────────────────

function buildBoxes(count: number, patina: number): void {
  if (!scene) return;

  // Dispose existing
  for (const m of boxes) {
    scene.remove(m);
    m.geometry.dispose();
    (m.material as THREE.Material).dispose();
  }
  boxes.length = 0;
  boxDepths    = new Array(count).fill(0.05);
  targetDepths = new Array(count).fill(0.05);

  const col  = boxColor(patina);
  const rgh  = 0.25 + patina * 0.65;
  const totalH = count * (BOX_H + BOX_GAP) - BOX_GAP;
  const startY = totalH / 2 - BOX_H / 2;

  for (let i = 0; i < count; i++) {
    // Single-unit-deep box; we scale.z each frame to change depth
    const geo = new THREE.BoxGeometry(BOX_W, BOX_H, 1.0);
    const mat = new THREE.MeshStandardMaterial({
      color      : col,
      roughness  : rgh,
      metalness  : 0.0,
    });
    const mesh = new THREE.Mesh(geo, mat);
    // sub-bass at bottom (i=0), brilliance at top (i=count-1)
    mesh.position.set(0, startY - i * (BOX_H + BOX_GAP), WALL_Z + 0.5);
    mesh.castShadow    = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
    boxes.push(mesh);
  }
  builtCount = count;
}

function setup(): void {
  threeCanvas = document.createElement('canvas');
  threeCanvas.style.cssText =
    'position:fixed;top:0;left:0;width:100%;height:100%;z-index:10;pointer-events:none;display:block';
  document.body.appendChild(threeCanvas);

  const dpr = isMobile ? 1.0 : Math.min(window.devicePixelRatio, 2);

  renderer = new THREE.WebGLRenderer({ canvas: threeCanvas, antialias: !isMobile, alpha: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(dpr);
  renderer.shadowMap.enabled = !isMobile;
  renderer.shadowMap.type    = THREE.PCFSoftShadowMap;
  renderer.toneMapping       = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  renderer.outputColorSpace  = THREE.SRGBColorSpace;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0C0A09);

  const aspect = window.innerWidth / window.innerHeight;
  camera = new THREE.PerspectiveCamera(fovForAspect(50, aspect), aspect, 0.1, 100);
  camera.position.set(cameraX, cameraY, cameraZ);
  camera.lookAt(0, 0, 0);

  // ── Back wall ──────────────────────────────────────────────────────────────
  const wallGeo = new THREE.PlaneGeometry(10, 12);
  const wallMat = new THREE.MeshStandardMaterial({
    color    : new THREE.Color(0x1A1715),
    roughness: 0.98,
    metalness: 0.0,
  });
  backWall = new THREE.Mesh(wallGeo, wallMat);
  backWall.position.set(0, 0, WALL_Z - 0.01); // just behind the boxes
  backWall.receiveShadow = true;
  scene.add(backWall);

  // ── Key light — warm, raking from upper-left ───────────────────────────────
  keyLight = new THREE.DirectionalLight(new THREE.Color(1.0, 0.91, 0.76), 3.0);
  keyLight.position.set(-5, 7, 9);
  keyLight.castShadow = true;
  if (keyLight.shadow) {
    const mapSize = isMobile ? 1024 : 2048;
    keyLight.shadow.mapSize.set(mapSize, mapSize);
    keyLight.shadow.camera.near   = 0.5;
    keyLight.shadow.camera.far    = 25;
    keyLight.shadow.camera.left   = -5;
    keyLight.shadow.camera.right  =  5;
    keyLight.shadow.camera.top    =  6;
    keyLight.shadow.camera.bottom = -6;
    keyLight.shadow.bias          = -0.001;
  }
  scene.add(keyLight);

  // Cool fill from lower-right — reveals surfaces without washing out shadows
  const fill = new THREE.DirectionalLight(new THREE.Color(0.6, 0.72, 0.9), 0.35);
  fill.position.set(6, -3, 5);
  scene.add(fill);

  // Minimal ambient so deep shadow isn't pure black
  scene.add(new THREE.AmbientLight(new THREE.Color(0.18, 0.15, 0.13), 1.0));

  // ── Post-processing — just colour space output, no bloom ──────────────────
  const rp = new RenderPass(scene, camera);
  const op = new OutputPass();
  composer = new EffectComposer(renderer);
  composer.addPass(rp);
  composer.addPass(op);

  // ── Initial boxes ─────────────────────────────────────────────────────────
  buildBoxes(countFromSlider(), store.config.stacksPatina);

  vizModeUnsub = store.on('vizModeChange', () => {
    if (store.state.vizMode !== 'stacks') disposeStacks();
  });

  initialized = true;
}

// ── Draw ──────────────────────────────────────────────────────────────────────

export function drawStacks(_p: unknown, dt: number): void {
  if (!initialized) setup();
  if (!renderer || !scene || !camera || !composer || boxes.length === 0) return;

  const cfg   = store.config;
  const { amps } = getBandAverages(7);

  time += dt * 0.016;

  // ── Rebuild if box count changed ───────────────────────────────────────────
  const targetCount = countFromSlider();
  if (targetCount !== builtCount) {
    buildBoxes(targetCount, cfg.stacksPatina);
  } else {
    // Update material if patina changed without rebuild
    const rgh = 0.25 + cfg.stacksPatina * 0.65;
    const col = boxColor(cfg.stacksPatina);
    for (const m of boxes) {
      const mat = m.material as THREE.MeshStandardMaterial;
      if (mat.roughness !== rgh) mat.roughness = rgh;
      if (!mat.color.equals(col)) mat.color.copy(col);
    }
  }

  // ── Beat detection — camera dolly impulse ────────────────────────────────
  const { state } = store;
  if (state.beatIntervalSec > 0 && state.isPlaying) {
    const pos      = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    const beatIdx  = adjusted >= 0 ? Math.floor(adjusted / state.beatIntervalSec) : -1;
    if (beatIdx > lastBeatIndex && beatIdx >= 0) {
      lastBeatIndex = beatIdx;
      cameraVelZ += -0.6;  // push camera forward on beat
    }
  }

  // ── Camera — gallery lateral sway with beat-driven dolly ─────────────────
  const swayPeriod = 22.0;  // seconds for full left→right→left
  const targetCamX = 1.0 + Math.sin(time / swayPeriod * Math.PI * 2) * 1.4;
  const targetCamY = Math.sin(time / (swayPeriod * 0.6) * Math.PI * 2) * 0.25;

  cameraX += (targetCamX - cameraX) * 0.025 * dt;
  cameraY += (targetCamY - cameraY) * 0.015 * dt;
  cameraVelZ *= Math.pow(0.88, dt);
  cameraZ += cameraVelZ * dt * 0.016;
  cameraZ = cameraZ < 3.8 ? 3.8 + (3.8 - cameraZ) * 0.5 : cameraZ;
  cameraZ = cameraZ > 7.0 ? 7.0 : cameraZ;

  camera.position.set(cameraX, cameraY, cameraZ);
  camera.lookAt(0, 0, 0);

  // ── Box depth CHOP-style continuous update ────────────────────────────────
  const n       = boxes.length;
  const minD    = 0.06;
  const maxExt  = 0.4 + cfg.stacksDepth * 2.2;
  const lerpRate = 0.055 * dt;

  for (let i = 0; i < n; i++) {
    const bandIdx = Math.min(6, Math.floor((i / n) * 7));
    targetDepths[i] = minD + amps[bandIdx] * maxExt;
    boxDepths[i] += (targetDepths[i] - boxDepths[i]) * lerpRate;

    const d   = boxDepths[i];
    const box = boxes[i];
    box.scale.z    = d;
    box.position.z = WALL_Z + d * 0.5;  // back face stays at WALL_Z
  }

  // ── Handle resize ──────────────────────────────────────────────────────────
  const w = window.innerWidth;
  const h = window.innerHeight;
  if (renderer.domElement.width !== Math.round(w * renderer.getPixelRatio()) ||
      renderer.domElement.height !== Math.round(h * renderer.getPixelRatio())) {
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.fov    = fovForAspect(50, w / h);
    camera.updateProjectionMatrix();
    composer.setSize(w, h);
  }

  composer.render();
}

// ── Reset ─────────────────────────────────────────────────────────────────────

export function resetStacks(): void {
  if (!initialized) return;
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer?.setSize(w, h);
  if (camera) {
    camera.aspect = w / h;
    camera.fov    = fovForAspect(50, w / h);
    camera.updateProjectionMatrix();
  }
  composer?.setSize(w, h);
  time          = 0;
  lastBeatIndex = -1;
  cameraX       = 1.8;
  cameraY       = 0.0;
  cameraZ       = 6.0;
  cameraVelZ    = 0.0;
}

// ── Dispose ───────────────────────────────────────────────────────────────────

export function disposeStacks(): void {
  if (!initialized) return;

  vizModeUnsub?.();
  vizModeUnsub = null;

  if (scene) {
    for (const m of boxes) {
      scene.remove(m);
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    }
    if (backWall) {
      scene.remove(backWall);
      backWall.geometry.dispose();
      (backWall.material as THREE.Material).dispose();
    }
  }

  composer?.dispose();
  renderer?.dispose();
  threeCanvas?.remove();

  threeCanvas = null;
  renderer    = null;
  scene       = null;
  camera      = null;
  composer    = null;
  keyLight    = null;
  backWall    = null;
  boxes       = [];

  time          = 0;
  lastBeatIndex = -1;
  cameraX       = 1.8;
  cameraY       = 0.0;
  cameraZ       = 6.0;
  cameraVelZ    = 0.0;
  builtCount    = 0;

  initialized   = false;
}
