/**
 * Tesserae — Three.js hexagonal glass prism field
 *
 * A dense hex close-packed array of glass prisms emerges from a dark floor;
 * 7 column zones map frequency bands to prism height so the field breathes
 * continuously with the music. Warm overhead SpotLight and cool back-fill
 * reveal iridescent depth in the glass. Camera sweeps slowly at eye level,
 * revealing the depth of the prism forest.
 *
 * Grid slider (structural): 0=low eye-level view across tall prisms →
 *   1=elevated bird's-eye mosaic view.
 * Height slider: audio amplitude sensitivity.
 * Shimmer slider: material character — 0=frosted matte → 1=crystal clear
 *   with vivid thin-film iridescence.
 *
 * Inspired by Dan Graham's "Pavilion" sculptures (1978–present) and
 * James Carpenter Design Associates' dichroic architectural glass installations.
 * https://www.daniel-graham.com/
 * https://www.jcdainc.com/projects/
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

// ── Module state ──────────────────────────────────────────────────────────────

let initialized = false;
let threeCanvas: HTMLCanvasElement | null = null;
let renderer: THREE.WebGLRenderer | null = null;
let scene: THREE.Scene | null = null;
let camera: THREE.PerspectiveCamera | null = null;
let composer: EffectComposer | null = null;
let prismMesh: THREE.InstancedMesh | null = null;
let prismMat: THREE.MeshPhysicalMaterial | null = null;
let spotLight: THREE.SpotLight | null = null;
let vizModeUnsub: (() => void) | null = null;

interface PrismCell {
  x: number;
  z: number;
  bandIndex: number;
  currentHeight: number;
}

const dummy = new THREE.Object3D();
let cells: PrismCell[] = [];
let time = 0;
let cameraX = 0;
let cameraY = 2.5;
let cameraZ = -11.0;
let cameraLookY = 2.0;
let lastBeatIndex = -1;
let beatKick = 0;
const bandHeights = new Float32Array(7);

// ── Grid config ───────────────────────────────────────────────────────────────

const HEX_R = isMobile ? 0.65 : 0.52;
const COLS   = isMobile ? 10 : 24;
const ROWS   = isMobile ? 8  : 18;
const TOTAL  = COLS * ROWS;

function buildCells(): void {
  cells = [];
  const colSpacing = Math.sqrt(3) * HEX_R;
  const rowSpacing = 1.5 * HEX_R;
  const totalW = COLS * colSpacing;
  const startX = -totalW / 2;
  const startZ = -(ROWS * rowSpacing) / 2;

  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      const x = startX + col * colSpacing + (row % 2 === 0 ? 0 : colSpacing / 2);
      const z = startZ + row * rowSpacing;
      const normX = (x - startX) / totalW;
      const bandIndex = Math.min(6, Math.floor(normX * 7));
      cells.push({ x, z, bandIndex, currentHeight: 0.12 });
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
    canvas: threeCanvas,
    antialias: !isMobile,
    alpha: false,
  });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, isMobile ? 1.0 : 1.5));
  renderer.shadowMap.enabled = !isMobile;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x060504);
  scene.fog = new THREE.Fog(0x060504, 18, 48);

  const aspect = window.innerWidth / window.innerHeight;
  camera = new THREE.PerspectiveCamera(68, aspect, 0.1, 80);
  camera.position.set(0, 2.5, -11);
  camera.lookAt(0, 2.0, 2);

  // Warm overhead SpotLight — primary key light
  spotLight = new THREE.SpotLight(0xffd070, isMobile ? 3.0 : 4.5, 70, Math.PI / 5.5, 0.4, 1.2);
  spotLight.position.set(0, 22, 4);
  spotLight.target.position.set(0, 0, 2);
  spotLight.castShadow = !isMobile;
  if (!isMobile) {
    spotLight.shadow.mapSize.set(1024, 1024);
    spotLight.shadow.camera.near = 12;
    spotLight.shadow.camera.far = 60;
  }
  scene.add(spotLight);
  scene.add(spotLight.target);

  // Cool directional fill from behind — back-lighting the glass
  const fill = new THREE.DirectionalLight(0x7090c0, 0.55);
  fill.position.set(1, 4, 20);
  scene.add(fill);

  // Very dim ambient
  scene.add(new THREE.AmbientLight(0x080706, 1.0));

  // Dark floor plane
  const floorGeo = new THREE.PlaneGeometry(100, 100);
  const floorMat = new THREE.MeshStandardMaterial({ color: 0x040303, roughness: 0.9, metalness: 0.05 });
  const floor = new THREE.Mesh(floorGeo, floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = !isMobile;
  scene.add(floor);

  // Build hex grid cells
  buildCells();

  // Prism geometry — CylinderGeometry with 6 radial segments → hexagonal
  // height=1.0 centered; we scale+translate per instance so base sits at y=0
  const geo = new THREE.CylinderGeometry(HEX_R * 0.90, HEX_R * 0.90, 1.0, 6, 1);
  geo.translate(0, 0.5, 0); // pivot at bottom face

  prismMat = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(0xddd0a8),
    roughness: 0.12,
    metalness: 0.05,
    transparent: true,
    opacity: 0.82,
    iridescence: 0.5,
    iridescenceIOR: 1.65,
    iridescenceThicknessRange: [120, 420],
    side: THREE.DoubleSide,
    depthWrite: false,
  });

  prismMesh = new THREE.InstancedMesh(geo, prismMat, TOTAL);
  prismMesh.castShadow = !isMobile;
  prismMesh.receiveShadow = false;
  scene.add(prismMesh);

  // Initialise matrices
  for (let i = 0; i < TOTAL; i++) {
    const cell = cells[i]!;
    dummy.position.set(cell.x, 0, cell.z);
    dummy.scale.set(1, cell.currentHeight, 1);
    dummy.updateMatrix();
    prismMesh.setMatrixAt(i, dummy.matrix);
  }
  prismMesh.instanceMatrix.needsUpdate = true;

  // Post-processing — subtle bloom on desktop only
  if (!isMobile) {
    composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    const bloom = new UnrealBloomPass(
      new THREE.Vector2(window.innerWidth, window.innerHeight),
      0.28,  // strength
      0.5,   // radius
      0.80,  // threshold
    );
    composer.addPass(bloom);
    composer.addPass(new OutputPass());
  }

  vizModeUnsub = store.on('vizModeChange', (data) => {
    if (threeCanvas) {
      threeCanvas.style.display = data === 'tesserae' ? 'block' : 'none';
    }
  });

  initialized = true;
}

// ── Draw ──────────────────────────────────────────────────────────────────────

export function drawTesserae(_p: unknown, dt: number): void {
  if (!initialized) setup();

  time += dt * 0.016;

  const { amps } = getBandAverages(7);
  const { config, state } = store;

  // Beat detection
  if (state.beatIntervalSec > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    const beatIdx = adjusted >= 0 ? Math.floor(adjusted / state.beatIntervalSec) : -1;
    if (beatIdx > lastBeatIndex) {
      lastBeatIndex = beatIdx;
      beatKick = 1.0;
    }
  }
  beatKick *= Math.pow(0.78, dt);

  // CHOP-style band height lerp
  const heightScale = 0.6 + config.tesseraeHeight * 7.5;
  for (let b = 0; b < 7; b++) {
    const amp = amps[b] ?? 0;
    const target = amp * heightScale + beatKick * 0.9 * (heightScale * 0.12);
    bandHeights[b] += (target - bandHeights[b]) * Math.min(0.1 * dt, 0.5);
  }

  // Update shimmer / material CHOP-style
  if (prismMat) {
    const shimmer = config.tesseraeShimmer;
    prismMat.roughness    = 0.25 - shimmer * 0.24;
    prismMat.iridescence  = shimmer;
    prismMat.opacity      = 0.60 + shimmer * 0.32;
  }

  // Update instance matrices
  const baseH = 0.12;
  if (prismMesh) {
    for (let i = 0; i < TOTAL; i++) {
      const cell = cells[i]!;
      const target = baseH + bandHeights[cell.bandIndex];
      cell.currentHeight += (target - cell.currentHeight) * Math.min(0.14 * dt, 0.6);
      dummy.position.set(cell.x, 0, cell.z);
      dummy.scale.set(1, Math.max(0.01, cell.currentHeight), 1);
      dummy.updateMatrix();
      prismMesh.setMatrixAt(i, dummy.matrix);
    }
    prismMesh.instanceMatrix.needsUpdate = true;
  }

  // Camera behaviour driven by Grid slider (structural)
  //   Grid=0 → low eye-level shot looking across prisms
  //   Grid=1 → elevated bird's-eye mosaic view
  const gridT = config.tesseraeGrid;
  const targetCamY    = 2.5  + gridT * 11.0;
  const targetCamZ    = -11.0 + gridT * 8.0;
  const targetLookY   = 1.5  + gridT * 3.5;
  const sweepAmp      = 3.5  - gridT * 1.5; // less lateral sweep overhead

  cameraY    += (targetCamY  - cameraY)    * Math.min(0.025 * dt, 0.2);
  cameraZ    += (targetCamZ  - cameraZ)    * Math.min(0.025 * dt, 0.2);
  cameraLookY += (targetLookY - cameraLookY) * Math.min(0.025 * dt, 0.2);

  const targetX = Math.sin(time * 0.065) * sweepAmp;
  cameraX += (targetX - cameraX) * Math.min(0.012 * dt, 0.1);

  if (camera) {
    camera.position.set(cameraX, cameraY, cameraZ);
    camera.lookAt(0, cameraLookY, 3.5);
  }

  // Spot light follows camera X slightly for subtle key-light sweep
  if (spotLight) {
    spotLight.position.x += (cameraX * 0.25 - spotLight.position.x) * Math.min(0.03 * dt, 0.15);
  }

  if (composer && !isMobile) {
    composer.render();
  } else {
    renderer?.render(scene!, camera!);
  }
}

// ── Reset (resize) ─────────────────────────────────────────────────────────────

export function resetTesserae(): void {
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

export function disposeTesserae(): void {
  if (!initialized) return;
  vizModeUnsub?.();
  vizModeUnsub = null;

  if (prismMesh) {
    prismMesh.geometry.dispose();
    prismMat?.dispose();
    prismMesh = null;
  }

  composer?.dispose();
  renderer?.dispose();
  threeCanvas?.remove();

  threeCanvas = null;
  renderer = null;
  scene = null;
  camera = null;
  composer = null;
  prismMat = null;
  spotLight = null;
  cells = [];
  time = 0;
  cameraX = 0;
  cameraY = 2.5;
  cameraZ = -11.0;
  cameraLookY = 2.0;
  lastBeatIndex = -1;
  beatKick = 0;
  bandHeights.fill(0);
  initialized = false;
}
