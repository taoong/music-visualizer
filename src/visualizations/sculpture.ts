/**
 * Sculpture — Three.js WebGL overlay visualization
 * 8 flat panels arranged in a circle, each showing a vertical strip of the
 * user's image. Camera orbits and transitions between panels on beats.
 * Audio reactivity via panel tilt, emissive glow, spacing pulse, and edge lines.
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { getUserImageUrl } from './userImage';

// ── Constants ─────────────────────────────────────────────────────────────────

const PANEL_COUNT     = 8;
const PANEL_WIDTH     = 14;
const PANEL_HEIGHT    = 20;
const CIRCLE_RADIUS   = 22;
const CAMERA_DIST_FAR  = 55;     // zoom slider = 0
const CAMERA_DIST_NEAR = 25;     // zoom slider = 1
const FOV             = 45;
const CAMERA_LERP     = 0.04;
const INWARD_TILT     = 0.26;    // ~15° inward tilt
const TILT_RANGE      = 0.087;   // ±5° Y-rotation from audio
const SPACING_PULSE   = 2;       // max radius increase on bass hit
const IDLE_ROTATION   = 0.0004;  // slow group rotation

const BAND_COLORS = [
  0xaa44ff, // Sub       – violet
  0x4466ff, // Bass      – blue
  0x00ddff, // Low-Mid   – cyan
  0x00ff88, // Mid       – green
  0xffff00, // Upper-Mid – yellow
  0xff8800, // Presence  – orange
  0xff2244, // Brilliance– red
  0xcc66ff, // wrap      – light violet
] as const;

// Camera presets: one per panel, aligned to face each panel directly
const CAMERA_PRESETS: { angle: number; y: number }[] = [];
for (let i = 0; i < PANEL_COUNT; i++) {
  const angle = (i * Math.PI * 2) / PANEL_COUNT;
  const y = 2 + (i % 3) * 2;  // slight height variation
  CAMERA_PRESETS.push({ angle, y });
}

// ── Module state ──────────────────────────────────────────────────────────────

let initialized    = false;
let threeCanvas    : HTMLCanvasElement | null = null;
let renderer       : THREE.WebGLRenderer | null = null;
let scene          : THREE.Scene | null = null;
let camera         : THREE.PerspectiveCamera | null = null;
let composer       : EffectComposer | null = null;
let vizModeUnsub   : (() => void) | null = null;
let imageUnsub     : (() => void) | null = null;

let panelGroup     : THREE.Group | null = null;
let panels         : THREE.Mesh[] = [];
let panelMats      : THREE.MeshStandardMaterial[] = [];
let edgeLines      : THREE.LineSegments[] = [];
let imageTexture   : THREE.Texture | null = null;
let ambientLight   : THREE.AmbientLight | null = null;

// Camera animation
let currentCamAngle = CAMERA_PRESETS[0].angle;
let currentCamY     = CAMERA_PRESETS[0].y;
let targetCamAngle  = CAMERA_PRESETS[0].angle;
let targetCamY      = CAMERA_PRESETS[0].y;
let lastBeatIndex   = -1;
let lastPresetIndex = -1;

// Audio smoothing
let smoothedBass     = 0;
let smoothedTotal    = 0;
let beatFlashDecay   = 0;
let spacingOffset    = 0;

// ── Angle lerp (shortest path, handles 0/2π wrap) ────────────────────────────

function lerpAngle(from: number, to: number, t: number): number {
  let diff = to - from;
  // Wrap to [-PI, PI]
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  return from + diff * t;
}

// ── Setup ─────────────────────────────────────────────────────────────────────

function setup(): void {
  // Overlay canvas
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
  scene.background = new THREE.Color(0x050510);

  // Camera
  camera = new THREE.PerspectiveCamera(FOV, window.innerWidth / window.innerHeight, 0.1, 500);

  // Lights — bright enough to clearly show image textures on vertical panels
  ambientLight = new THREE.AmbientLight(0xffffff, 0.8);
  scene.add(ambientLight);
  // Hemisphere: sky/ground fill so vertical panels are lit from all angles
  const hemiLight = new THREE.HemisphereLight(0xccccff, 0x444466, 0.6);
  scene.add(hemiLight);
  // Point light at camera height to illuminate facing panel
  const keyLight = new THREE.PointLight(0xffffff, 1.2, 200);
  keyLight.position.set(30, 5, 30);
  scene.add(keyLight);
  const fillLight = new THREE.PointLight(0xffffff, 0.8, 200);
  fillLight.position.set(-30, 5, -30);
  scene.add(fillLight);

  // Panel group (for idle rotation)
  panelGroup = new THREE.Group();
  scene.add(panelGroup);

  // Create panels
  panels = [];
  panelMats = [];
  edgeLines = [];

  for (let i = 0; i < PANEL_COUNT; i++) {
    const angle = (i * Math.PI * 2) / PANEL_COUNT;

    // Material — diffuse only, no specular
    const mat = new THREE.MeshStandardMaterial({
      color: BAND_COLORS[i],
      emissive: new THREE.Color(BAND_COLORS[i]),
      emissiveIntensity: 0.1,
      metalness: 0.0,
      roughness: 0.85,
      side: THREE.DoubleSide,
    });
    panelMats.push(mat);

    // Geometry with custom UVs for image strip
    const geo = new THREE.PlaneGeometry(PANEL_WIDTH, PANEL_HEIGHT);
    const uvAttr = geo.attributes['uv'] as THREE.BufferAttribute;
    const uMin = i / PANEL_COUNT;
    const uMax = (i + 1) / PANEL_COUNT;
    for (let v = 0; v < uvAttr.count; v++) {
      const origU = uvAttr.getX(v);  // 0 or 1
      const origV = uvAttr.getY(v);  // 0 or 1
      uvAttr.setXY(v, uMin + origU * (uMax - uMin), origV);
    }

    const mesh = new THREE.Mesh(geo, mat);

    // Position in circle, face outward, tilt inward
    mesh.position.set(
      Math.cos(angle) * CIRCLE_RADIUS,
      0,
      Math.sin(angle) * CIRCLE_RADIUS,
    );
    mesh.rotation.y = -angle + Math.PI / 2;  // face outward
    mesh.rotation.x = INWARD_TILT;           // tilt inward toward camera

    panelGroup.add(mesh);
    panels.push(mesh);

    // Edge glow lines
    const edgeGeo = new THREE.BufferGeometry();
    const hw = PANEL_WIDTH / 2;
    const hh = PANEL_HEIGHT / 2;
    const edgeVerts = new Float32Array([
      -hw, -hh, 0,  -hw,  hh, 0,
      -hw,  hh, 0,   hw,  hh, 0,
       hw,  hh, 0,   hw, -hh, 0,
       hw, -hh, 0,  -hw, -hh, 0,
    ]);
    edgeGeo.setAttribute('position', new THREE.BufferAttribute(edgeVerts, 3));
    const edgeMat = new THREE.LineBasicMaterial({
      color: BAND_COLORS[i],
      transparent: true,
      opacity: 0.4,
    });
    const line = new THREE.LineSegments(edgeGeo, edgeMat);
    line.position.copy(mesh.position);
    line.rotation.copy(mesh.rotation);
    panelGroup.add(line);
    edgeLines.push(line);
  }

  // If image already loaded, apply it
  const existingUrl = getUserImageUrl();
  if (existingUrl) applyImage(existingUrl);

  // Update camera position instantly
  currentCamAngle = CAMERA_PRESETS[0].angle;
  currentCamY = CAMERA_PRESETS[0].y;
  targetCamAngle = currentCamAngle;
  targetCamY = currentCamY;
  updateCameraPosition(1.0);

  // Post-processing
  const res = new THREE.Vector2(window.innerWidth, window.innerHeight);
  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  composer.addPass(new UnrealBloomPass(res, 0.6, 0.4, 0.3));
  composer.addPass(new OutputPass());

  // Hide canvas when switching away
  vizModeUnsub = store.on('vizModeChange', (data) => {
    if (!threeCanvas) return;
    threeCanvas.style.display = data === 'sculpture' ? 'block' : 'none';
  });

  // React to image load/remove
  imageUnsub = store.on('imageChange', (data) => {
    if (data) {
      const url = getUserImageUrl();
      if (url) applyImage(url);
    } else {
      clearImage();
    }
  });

  initialized = true;
}

// ── Image helpers ─────────────────────────────────────────────────────────────

function applyImage(url: string): void {
  new THREE.TextureLoader().load(url, (tex) => {
    tex.colorSpace = THREE.SRGBColorSpace;
    imageTexture?.dispose();
    imageTexture = tex;
    for (const mat of panelMats) {
      mat.map = tex;
      mat.color.set(0xffffff);
      mat.emissive.set(0x888888);
      mat.emissiveMap = tex;
      mat.needsUpdate = true;
    }
  });
}

function clearImage(): void {
  imageTexture?.dispose();
  imageTexture = null;
  for (let i = 0; i < panelMats.length; i++) {
    panelMats[i].map = null;
    panelMats[i].emissiveMap = null;
    panelMats[i].color.set(BAND_COLORS[i]);
    panelMats[i].emissive.set(BAND_COLORS[i]);
    panelMats[i].needsUpdate = true;
  }
}

// ── Camera helpers ────────────────────────────────────────────────────────────

function getCameraDist(): number {
  const zoom = store.config.sculptureZoom;  // 0 = far, 1 = near
  return CAMERA_DIST_FAR + (CAMERA_DIST_NEAR - CAMERA_DIST_FAR) * zoom;
}

function updateCameraPosition(lerpFactor: number): void {
  if (!camera) return;

  currentCamAngle = lerpAngle(currentCamAngle, targetCamAngle, lerpFactor);
  currentCamY += (targetCamY - currentCamY) * lerpFactor;

  const dist = getCameraDist();
  camera.position.set(
    Math.cos(currentCamAngle) * dist,
    currentCamY,
    Math.sin(currentCamAngle) * dist,
  );
  camera.lookAt(0, 0, 0);
}

function pickNewCameraTarget(): void {
  // 70% advance to next panel, 30% random jump (never same twice)
  let idx: number;
  if (Math.random() < 0.7 && lastPresetIndex >= 0) {
    idx = (lastPresetIndex + 1) % PANEL_COUNT;
  } else {
    do {
      idx = Math.floor(Math.random() * PANEL_COUNT);
    } while (idx === lastPresetIndex && PANEL_COUNT > 1);
  }
  lastPresetIndex = idx;

  targetCamAngle = CAMERA_PRESETS[idx].angle;
  targetCamY = CAMERA_PRESETS[idx].y;
}

// ── Draw ──────────────────────────────────────────────────────────────────────

export function drawSculpture(_p: unknown, dt: number): void {
  if (!initialized) setup();

  const { amps } = getBandAverages(7);
  const { state } = store;

  // Smooth audio values
  const bass  = (amps[0] + amps[1]) * 0.5;
  const total = amps.reduce((s, a) => s + a, 0) / 7;
  smoothedBass  += (bass - smoothedBass) * 0.15 * dt;
  smoothedTotal += (total - smoothedTotal) * 0.12 * dt;

  // Beat detection → camera transition + flash
  if (state.beatIntervalSec > 0 && state.isPlaying) {
    const pos      = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    const beatIdx  = adjusted >= 0 ? Math.floor(adjusted / state.beatIntervalSec) : -1;
    if (beatIdx > lastBeatIndex) {
      lastBeatIndex = beatIdx;
      pickNewCameraTarget();
      beatFlashDecay = 1.0;
    }
  }

  // Beat flash decay (~200ms at 60fps)
  beatFlashDecay *= Math.pow(0.85, dt);
  if (beatFlashDecay < 0.01) beatFlashDecay = 0;

  // Ambient light flash on beat
  if (ambientLight) {
    ambientLight.intensity = 0.6 + beatFlashDecay * 0.9;
  }

  // Spacing pulse: bass pushes panels outward, decay back
  const targetSpacing = smoothedBass * SPACING_PULSE * store.config.spikeScale;
  spacingOffset += (targetSpacing - spacingOffset) * 0.1 * dt;

  // Update camera (smooth lerp)
  updateCameraPosition(CAMERA_LERP * dt);

  // Update panels
  if (panelGroup) {
    const effectiveRadius = CIRCLE_RADIUS + spacingOffset;

    for (let i = 0; i < PANEL_COUNT; i++) {
      const angle = (i * Math.PI * 2) / PANEL_COUNT;
      const bandIdx = i % 7;
      const bandAmp = amps[bandIdx] ?? 0;

      // Reposition with spacing pulse
      panels[i].position.set(
        Math.cos(angle) * effectiveRadius,
        0,
        Math.sin(angle) * effectiveRadius,
      );

      // Panel tilt: base facing + breathing from band amplitude
      panels[i].rotation.y = -angle + Math.PI / 2 + (bandAmp - 0.5) * TILT_RANGE;
      panels[i].rotation.x = INWARD_TILT;

      // Emissive glow from band amplitude
      panelMats[i].emissiveIntensity = 0.1 + bandAmp * 1.2;

      // Edge line sync position and glow
      edgeLines[i].position.copy(panels[i].position);
      edgeLines[i].rotation.copy(panels[i].rotation);
      const edgeMat = edgeLines[i].material as THREE.LineBasicMaterial;
      edgeMat.opacity = 0.3 + bandAmp * 0.7 + beatFlashDecay * 0.3;
    }

    // Slow idle rotation
    panelGroup.rotation.y += dt * IDLE_ROTATION * store.config.rotationSpeed;
  }

  // Bloom strength from intensity slider
  if (composer && composer.passes[1]) {
    (composer.passes[1] as UnrealBloomPass).strength = 0.6 * store.config.intensity;
  }

  composer?.render();
}

// ── Reset ─────────────────────────────────────────────────────────────────────

export function resetSculpture(): void {
  if (!initialized) return;
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer?.setSize(w, h);
  if (camera) { camera.aspect = w / h; camera.updateProjectionMatrix(); }
  composer?.setSize(w, h);
}

// ── Dispose ───────────────────────────────────────────────────────────────────

export function disposeSculpture(): void {
  if (!initialized) return;
  vizModeUnsub?.();
  imageUnsub?.();
  vizModeUnsub = null;
  imageUnsub   = null;

  for (const mesh of panels) {
    mesh.geometry.dispose();
  }
  for (const mat of panelMats) {
    mat.dispose();
  }
  for (const line of edgeLines) {
    line.geometry.dispose();
    (line.material as THREE.LineBasicMaterial).dispose();
  }
  imageTexture?.dispose();

  composer?.dispose();
  renderer?.dispose();
  threeCanvas?.remove();

  threeCanvas = null; renderer = null; scene = null; camera = null;
  composer = null; panelGroup = null; ambientLight = null;
  panels = []; panelMats = []; edgeLines = [];
  imageTexture = null;

  lastBeatIndex = -1; lastPresetIndex = -1;
  smoothedBass = 0; smoothedTotal = 0;
  beatFlashDecay = 0; spacingOffset = 0;
  currentCamAngle = CAMERA_PRESETS[0].angle;
  currentCamY = CAMERA_PRESETS[0].y;
  targetCamAngle = CAMERA_PRESETS[0].angle;
  targetCamY = CAMERA_PRESETS[0].y;
  initialized = false;
}
