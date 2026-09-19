/**
 * Skyspace — Three.js architectural interior
 * Inspired by James Turrell's "Breathing Light" (LACMA, 2013) and his
 * Skyspace aperture-room series (1974–present). A minimalist plaster chamber
 * viewed from within; a single circular aperture in the ceiling glows with
 * slowly shifting sky-color light; interior walls breathe with the music.
 *
 * No neon, no rainbows, no radial symmetry. Matte surfaces, real lighting,
 * meditative camera drift. Color moves through a single warm↔cool axis.
 *
 * Sliders:
 *   Aperture — radius of the ceiling opening (structural)
 *   Warmth   — sky color temperature (cool twilight → warm amber sunrise)
 *   Drift    — camera movement speed
 */
import * as THREE from 'three';
import { store } from '../state/store';
import { getBandAverages } from './helpers';
import { audioEngine } from '../audio/engine';
import { isMobile } from '../utils/constants';

// ── Room dimensions ────────────────────────────────────────────────────────────

const ROOM_W = 9.0;
const ROOM_H = 5.5;
const ROOM_D = 9.0;
const CEIL_Y =  ROOM_H * 0.5;
const FLOOR_Y = -ROOM_H * 0.5;

// ── Module state ───────────────────────────────────────────────────────────────

let initialized  = false;
let threeCanvas: HTMLCanvasElement | null = null;
let renderer:    THREE.WebGLRenderer | null = null;
let scene:       THREE.Scene | null = null;
let camera:      THREE.PerspectiveCamera | null = null;
let vizModeUnsub: (() => void) | null = null;

// Scene objects
let apertureMesh: THREE.Mesh | null = null;
let apertureMat:  THREE.MeshBasicMaterial | null = null;
let roomMat:      THREE.MeshLambertMaterial | null = null;
let floorMat:     THREE.MeshLambertMaterial | null = null;
let skyLight:     THREE.PointLight | null = null;
let warmLight:    THREE.PointLight | null = null;
let roomMeshes:   THREE.Mesh[] = [];

// Animation state
let time          = 0;
let beatBrightness = 0;
let lastBeatIndex = -1;

// ── Color helper ──────────────────────────────────────────────────────────────

function skyColorFromWarmth(warmth: number): THREE.Color {
  // hue: 0.62 (cool blue) → 0.10 (warm amber) as warmth goes 0 → 1
  const hue = 0.62 - warmth * 0.52;
  return new THREE.Color().setHSL(hue, 0.60, 0.75);
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
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x060608);

  camera = new THREE.PerspectiveCamera(
    55,
    window.innerWidth / window.innerHeight,
    0.1,
    100,
  );
  camera.position.set(0, -0.4, 2.2);

  // ── Materials ────────────────────────────────────────────────────────────────

  // Matte plaster — warm cream/white
  roomMat = new THREE.MeshLambertMaterial({ color: 0xe4e0d8 });

  // Floor — slightly warmer, more textured look
  floorMat = new THREE.MeshLambertMaterial({ color: 0xd4d0c8 });

  // Aperture — emissive sky color, no lighting interaction
  apertureMat = new THREE.MeshBasicMaterial({ color: 0xffffff, depthWrite: false });

  // ── Room geometry ─────────────────────────────────────────────────────────────

  const segs = isMobile ? 1 : 1; // simple flat panels

  const buildWall = (
    mat: THREE.Material,
    w: number, h: number,
    rx: number, ry: number,
    px: number, py: number, pz: number,
  ): THREE.Mesh => {
    const geo = new THREE.PlaneGeometry(w, h, segs, segs);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.rotation.set(rx, ry, 0);
    mesh.position.set(px, py, pz);
    scene!.add(mesh);
    roomMeshes.push(mesh);
    return mesh;
  };

  // Floor (normal +Y, faces up)
  buildWall(floorMat, ROOM_W, ROOM_D, -Math.PI / 2, 0, 0, FLOOR_Y, 0);

  // Ceiling surround — large plane so aperture never exposes background at edges
  buildWall(roomMat, ROOM_W * 2, ROOM_D * 2, Math.PI / 2, 0, 0, CEIL_Y, 0);

  // Back wall
  buildWall(roomMat, ROOM_W, ROOM_H, 0, 0, 0, 0, -ROOM_D * 0.5);

  // Left wall
  buildWall(roomMat, ROOM_D, ROOM_H, 0, Math.PI / 2, -ROOM_W * 0.5, 0, 0);

  // Right wall
  buildWall(roomMat, ROOM_D, ROOM_H, 0, -Math.PI / 2, ROOM_W * 0.5, 0, 0);

  // ── Aperture disk ─────────────────────────────────────────────────────────────

  const circleSegs = isMobile ? 32 : 64;
  const apertureGeo = new THREE.CircleGeometry(1.0, circleSegs);
  apertureMesh = new THREE.Mesh(apertureGeo, apertureMat);
  apertureMesh.rotation.x = Math.PI / 2; // face downward (-Y normal)
  apertureMesh.position.y = CEIL_Y - 0.004;
  apertureMesh.renderOrder = 1;
  scene.add(apertureMesh);

  // ── Lights ────────────────────────────────────────────────────────────────────

  // Sky light — positioned just inside the aperture, shines down
  skyLight = new THREE.PointLight(0xffffff, 2.0, ROOM_H * 4);
  skyLight.position.set(0, CEIL_Y - 0.15, 0);
  scene.add(skyLight);

  // Warm accent — low near-floor strip for atmospheric depth
  warmLight = new THREE.PointLight(0xffe8c0, 0.5, ROOM_H * 2.5);
  warmLight.position.set(0, FLOOR_Y + 0.8, -0.5);
  scene.add(warmLight);

  // Ambient base — very low so walls catch shadow contrast
  scene.add(new THREE.AmbientLight(0x181828, 0.5));

  // ── Viz switch handler ────────────────────────────────────────────────────────

  vizModeUnsub = store.on('vizModeChange', (data) => {
    if (!threeCanvas) return;
    threeCanvas.style.display = data === 'skyspace' ? 'block' : 'none';
  });

  initialized = true;
}

// ── Draw ──────────────────────────────────────────────────────────────────────

export function drawSkyspace(_p: unknown, dt: number): void {
  if (!initialized) setup();

  time += dt * 0.016;

  const { amps } = getBandAverages(7);
  const avgAmp  = amps.reduce((s, v) => s + v, 0) / amps.length;
  const bassAmp = amps[1] ?? 0;
  const subAmp  = amps[0] ?? 0;

  // Beat detection
  const { state } = store;
  if (state.beatIntervalSec > 0 && state.isPlaying) {
    const pos      = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    const beatIdx  = adjusted >= 0 ? Math.floor(adjusted / state.beatIntervalSec) : -1;
    if (beatIdx > lastBeatIndex) {
      lastBeatIndex = beatIdx;
      beatBrightness = Math.min(1.0, beatBrightness + 0.7);
    }
  }

  beatBrightness *= Math.pow(0.88, dt);

  // Config
  const warmth     = store.config.skyspaceWarmth;    // 0–1
  const driftAmt   = store.config.skyspaceDrift;     // 0–1
  const apertureV  = store.config.skyspaceAperture;  // 0.1–1.0

  // Subtle centroid modulation of warmth (more treble → slightly cooler)
  const centroid = store.audioState.smoothedCentroid;
  const adjWarmth = Math.max(0, Math.min(1, warmth - (centroid - 0.5) * 0.12));
  const skyCol = skyColorFromWarmth(adjWarmth);

  // Aperture material — ganzfeld luminance driven by amplitude + beat
  if (apertureMat) {
    const brightness = 0.75 + avgAmp * 0.55 + beatBrightness * 0.75 + subAmp * 0.15;
    apertureMat.color.setRGB(
      Math.min(1, skyCol.r * brightness),
      Math.min(1, skyCol.g * brightness),
      Math.min(1, skyCol.b * brightness),
    );
  }

  // Aperture scale — structural slider changes the size of the opening
  if (apertureMesh) {
    const r = apertureV * ROOM_W * 0.44;
    apertureMesh.scale.set(r, r, 1);
  }

  // Sky light — color + intensity from audio
  if (skyLight) {
    skyLight.color.copy(skyCol);
    skyLight.intensity = 1.2 + avgAmp * 2.8 + beatBrightness * 3.5 + bassAmp * 1.2;
    skyLight.distance  = ROOM_H * (1.8 + apertureV * 2.5);
  }

  // Warm accent — pulse slightly on bass
  if (warmLight) {
    warmLight.intensity = 0.4 + bassAmp * 0.4;
  }

  // Camera drift — gentle meditative motion
  if (camera) {
    const ds = 0.04 + driftAmt * 0.28;

    camera.position.x = Math.sin(time * 0.083) * ds * ROOM_W * 0.09;
    camera.position.y = -0.4 + Math.sin(time * 0.067 + 1.3) * ds * 0.35
                             + bassAmp * 0.18;
    camera.position.z = 2.2 + Math.sin(time * 0.051 + 2.0) * ds * ROOM_D * 0.06;

    const lookX = Math.sin(time * 0.121 + 0.7) * ds * ROOM_W * 0.12;
    const lookY = CEIL_Y - 0.7 + beatBrightness * 0.09;
    const lookZ = -1.6 + Math.sin(time * 0.163) * ds * ROOM_D * 0.10;
    camera.lookAt(lookX, lookY, lookZ);
  }

  if (renderer && scene && camera) {
    renderer.render(scene, camera);
  }
}

// ── Reset (resize) ────────────────────────────────────────────────────────────

export function resetSkyspace(): void {
  if (!initialized) return;
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer?.setSize(w, h);
  if (camera) { camera.aspect = w / h; camera.updateProjectionMatrix(); }
}

// ── Dispose ───────────────────────────────────────────────────────────────────

export function disposeSkyspace(): void {
  if (!initialized) return;
  vizModeUnsub?.();
  vizModeUnsub = null;

  for (const mesh of roomMeshes) {
    mesh.geometry.dispose();
  }
  roomMeshes = [];

  apertureMesh?.geometry.dispose();
  apertureMat?.dispose();
  roomMat?.dispose();
  floorMat?.dispose();

  renderer?.dispose();
  threeCanvas?.remove();

  threeCanvas  = null;
  renderer     = null;
  scene        = null;
  camera       = null;
  apertureMesh = null;
  apertureMat  = null;
  skyLight     = null;
  warmLight    = null;
  roomMat      = null;
  floorMat     = null;

  time          = 0;
  beatBrightness = 0;
  lastBeatIndex = -1;
  initialized   = false;
}
