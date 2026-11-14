/**
 * Plexus: luminous thread installation in a dark studio space.
 * 7 frequency bands map to 7 lateral columns of vertical threads
 * (sub-bass=left → brilliance=right); band amplitude drives thread brightness
 * and midpoint sag; near-monochrome warm-amber (bass) → cool steel-blue (treble)
 * palette — no rainbow. Camera orbits at eye height with slow sinusoidal vertical
 * drift. Beat fires a lateral displacement kick that pushes thread midpoints
 * outward and slowly returns.
 *
 * Inspired by Gabriel Dawe "Plexus A1" (2015, Museum of Arts and Design, New York)
 * and his ongoing "Plexus" thread installation series (2011–present).
 * https://www.gabrieldawe.com/plexus
 *
 * Key technique: 7 LineSegments meshes (one per band) with a single shared
 * ShaderMaterial; positions updated in-place each frame via Float32Array writes —
 * zero geometry recreation = zero GC pressure.
 *
 * sliders: Strands (thread count per band — structural), Sag (midpoint curvature),
 *          Glow (emissive brightness)
 * keyboard: F66
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { store } from '../state/store';
import { getBandAverages, fovForAspect } from './helpers';
import { audioEngine } from '../audio/engine';
import { isMobile } from '../utils/constants';

// ── Geometry constants ─────────────────────────────────────────────────────────

const SEGS     = isMobile ? 8 : 14;   // bezier segments per thread
const Y_TOP    =  3.8;                 // ceiling y-position
const Y_BOT    = -3.8;                 // floor y-position
const Z_RANGE  =  5.0;                 // threads span z ∈ [-Z_RANGE, Z_RANGE]
const X_JITTER =  0.9;                 // per-thread random x spread within a band

// ── Band palette: warm amber → cool steel-blue (no rainbow) ───────────────────

// Stored as [r, g, b] tuples for the GLSL uniform; linear colour space
const BAND_COLORS_RGB: [number, number, number][] = [
  [0.878, 0.533, 0.063],  // sub-bass:   warm amber
  [0.816, 0.627, 0.188],  // bass:       warm gold
  [0.878, 0.847, 0.753],  // low-mid:    pale warm cream
  [0.847, 0.878, 0.910],  // mid:        neutral-cool white
  [0.722, 0.784, 0.847],  // upper-mid:  cool silver
  [0.565, 0.659, 0.753],  // presence:   steel blue
  [0.471, 0.596, 0.722],  // brilliance: ice blue
];

// ── Module state ───────────────────────────────────────────────────────────────

let initialized    = false;
let threeCanvas    : HTMLCanvasElement | null = null;
let renderer       : THREE.WebGLRenderer | null = null;
let scene          : THREE.Scene | null = null;
let camera         : THREE.PerspectiveCamera | null = null;
let composer       : EffectComposer | null = null;
let vizModeUnsub   : (() => void) | null = null;
let sharedMat      : THREE.ShaderMaterial | null = null;

// Thread field geometry
interface ThreadDatum {
  topX: number; topZ: number;
  botX: number; botZ: number;
  sagX: number; sagZ: number;   // rest XZ midpoint displacement
}
let threadData  : ThreadDatum[][] = [];   // [bandIdx][strandIdx]
let bandLines   : THREE.LineSegments[] = [];
let bandGeos    : THREE.BufferGeometry[] = [];
let builtStrands = 0;

// Camera / animation
let time           = 0;
let camTheta       = 0;
let camY           = 0;
let lastBeatIndex  = -1;
let beatKickX      = 0;
let beatKickZ      = 0;

// ── GLSL shaders ───────────────────────────────────────────────────────────────

const VERT = /* glsl */`
  attribute float aBandIdx;
  varying   float vBandIdx;
  void main() {
    vBandIdx    = aBandIdx;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FRAG = /* glsl */`
  uniform float uBands[7];
  uniform vec3  uColors[7];
  uniform float uGlow;
  varying float vBandIdx;

  void main() {
    int   b   = int(vBandIdx + 0.5);
    float amp = uBands[b];
    vec3  col = uColors[b];
    // Minimum dim glow + audio-reactive brightness
    float brightness = 0.05 + amp * (0.35 + uGlow * 1.5);
    gl_FragColor = vec4(col * brightness, 1.0);
  }
`;

// ── Helpers ────────────────────────────────────────────────────────────────────

function strandCount(): number {
  const raw = store.config.plexusStrands;
  const max = isMobile ? 6 : 15;
  return Math.max(3, Math.round(3 + raw * (max - 3)));
}

// Deterministic pseudo-random from seed
function seededRand(seed: number): number {
  const x = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

// Quadratic bezier at parameter t ∈ [0, 1]
function bezier(p0: number, p1: number, p2: number, t: number): number {
  const mt = 1.0 - t;
  return mt * mt * p0 + 2.0 * mt * t * p1 + t * t * p2;
}

// ── Build / rebuild the thread field ──────────────────────────────────────────

function buildField(M: number): void {
  if (!scene || !sharedMat) return;

  // Dispose existing
  for (let b = 0; b < bandLines.length; b++) {
    scene.remove(bandLines[b]);
    bandGeos[b]?.dispose();
  }
  bandLines.length  = 0;
  bandGeos.length   = 0;
  threadData.length = 0;

  // 7 band x-centres spread across [-7.2, 7.2]
  const bandCenters = [-7.2, -4.8, -2.4, 0.0, 2.4, 4.8, 7.2];

  for (let b = 0; b < 7; b++) {
    // Pre-compute per-thread anchor data deterministically
    const tData: ThreadDatum[] = [];
    for (let t = 0; t < M; t++) {
      const seed = b * 1000 + t;
      const topX = bandCenters[b] + (seededRand(seed)       - 0.5) * X_JITTER * 2;
      const topZ = -Z_RANGE + seededRand(seed + 1) * Z_RANGE * 2;
      const botX = topX + (seededRand(seed + 2) - 0.5) * 0.8;
      const botZ = topZ + (seededRand(seed + 3) - 0.5) * 0.8;
      const sagX = (seededRand(seed + 4) - 0.5) * 2.4;
      const sagZ = (seededRand(seed + 5) - 0.5) * 2.4;
      tData.push({ topX, topZ, botX, botZ, sagX, sagZ });
    }
    threadData.push(tData);

    // Allocate vertex + index buffers
    const vertCount = M * (SEGS + 1);
    const idxCount  = M * SEGS * 2;

    const positions   = new Float32Array(vertCount * 3);
    const bandIdxAttr = new Float32Array(vertCount);
    const indices     = new Uint16Array(idxCount);

    // Fill constant band-index attribute
    for (let v = 0; v < vertCount; v++) bandIdxAttr[v] = b;

    // Build LineSegments indices: each pair draws one segment within a thread
    let ip = 0;
    for (let t = 0; t < M; t++) {
      const base = t * (SEGS + 1);
      for (let s = 0; s < SEGS; s++) {
        indices[ip++] = base + s;
        indices[ip++] = base + s + 1;
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('aBandIdx', new THREE.BufferAttribute(bandIdxAttr, 1));
    geo.setIndex(new THREE.BufferAttribute(indices, 1));

    const lineSegments = new THREE.LineSegments(geo, sharedMat);
    scene.add(lineSegments);

    bandLines.push(lineSegments);
    bandGeos.push(geo);
  }

  builtStrands = M;
}

// ── Update thread positions (called every frame, O(threads) ───────────────────

function updatePositions(amps: number[], sag: number): void {
  for (let b = 0; b < 7; b++) {
    const geo   = bandGeos[b];
    const tData = threadData[b];
    if (!geo || !tData) continue;

    const posAttr = geo.getAttribute('position') as THREE.BufferAttribute;
    const positions = posAttr.array as Float32Array;

    const amp       = amps[b] ?? 0;
    const sagAmount = sag * (0.5 + amp * 1.5);

    for (let t = 0; t < tData.length; t++) {
      const td   = tData[t];
      const base = t * (SEGS + 1);

      // Bezier control points
      const p0x = td.topX;
      const p0y = Y_TOP;
      const p0z = td.topZ;

      // Midpoint: displaced by sag + beat kick
      const p1x = (td.topX + td.botX) * 0.5 + td.sagX * sagAmount + beatKickX;
      const p1y = -sag * amp * 2.2;   // threads droop downward at high amplitude
      const p1z = (td.topZ + td.botZ) * 0.5 + td.sagZ * sagAmount + beatKickZ;

      const p2x = td.botX;
      const p2y = Y_BOT;
      const p2z = td.botZ;

      for (let s = 0; s <= SEGS; s++) {
        const tParam = s / SEGS;
        const vi     = (base + s) * 3;
        positions[vi]     = bezier(p0x, p1x, p2x, tParam);
        positions[vi + 1] = bezier(p0y, p1y, p2y, tParam);
        positions[vi + 2] = bezier(p0z, p1z, p2z, tParam);
      }
    }

    posAttr.needsUpdate = true;
    geo.computeBoundingSphere();
  }
}

// ── Setup ──────────────────────────────────────────────────────────────────────

function setup(): void {
  threeCanvas = document.createElement('canvas');
  threeCanvas.style.cssText =
    'position:fixed;top:0;left:0;width:100%;height:100%;z-index:10;pointer-events:none;display:block';
  document.body.appendChild(threeCanvas);

  const dpr = isMobile ? 1.0 : Math.min(window.devicePixelRatio, 2);

  renderer = new THREE.WebGLRenderer({
    canvas:    threeCanvas,
    antialias: !isMobile,
    alpha:     true,
  });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(dpr);
  renderer.toneMapping        = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  renderer.outputColorSpace   = THREE.SRGBColorSpace;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x030305);

  const aspect = window.innerWidth / window.innerHeight;
  camera = new THREE.PerspectiveCamera(fovForAspect(55, aspect), aspect, 0.1, 100);
  camera.position.set(13, 0, 0);
  camera.lookAt(0, 0, 0);

  // Shared ShaderMaterial — additive blending for luminous glow on dark field
  sharedMat = new THREE.ShaderMaterial({
    vertexShader:   VERT,
    fragmentShader: FRAG,
    uniforms: {
      uBands:  { value: new Array(7).fill(0) },
      uColors: { value: BAND_COLORS_RGB.map(([r, g, b]) => new THREE.Vector3(r, g, b)) },
      uGlow:   { value: 0.5 },
    },
    blending:    THREE.AdditiveBlending,
    depthWrite:  false,
    transparent: true,
  });

  // Post-processing: subtle bloom on desktop only
  const rp    = new RenderPass(scene, camera);
  const bloom = new UnrealBloomPass(
    new THREE.Vector2(window.innerWidth, window.innerHeight),
    0.7,   // strength
    0.5,   // radius
    0.25,  // threshold
  );
  const op = new OutputPass();
  composer = new EffectComposer(renderer);
  composer.addPass(rp);
  if (!isMobile) composer.addPass(bloom);
  composer.addPass(op);

  buildField(strandCount());

  vizModeUnsub = store.on('vizModeChange', () => {
    if (store.state.vizMode !== 'plexus') disposePlexus();
  });

  initialized = true;
}

// ── Draw ───────────────────────────────────────────────────────────────────────

export function drawPlexus(_p: unknown, dt: number): void {
  if (!initialized) setup();
  if (!renderer || !scene || !camera || !composer || !sharedMat) return;

  time += dt * 0.016;

  const cfg   = store.config;
  const { amps } = getBandAverages(7);

  // ── Rebuild field if strand count changed ──────────────────────────────────
  const M = strandCount();
  if (M !== builtStrands) buildField(M);

  // ── Beat detection ─────────────────────────────────────────────────────────
  const { state } = store;
  if (state.beatIntervalSec > 0 && state.isPlaying) {
    const pos      = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    const beatIdx  = adjusted >= 0 ? Math.floor(adjusted / state.beatIntervalSec) : -1;
    if (beatIdx > lastBeatIndex && beatIdx >= 0) {
      lastBeatIndex = beatIdx;
      // Lateral kick direction rotates over time for variety
      const angle = time * 0.4;
      beatKickX += Math.cos(angle) * 1.6;
      beatKickZ += Math.sin(angle) * 1.6;
    }
  }

  // ── Decay beat kick continuously (CHOP-style) ──────────────────────────────
  const decayRate = Math.pow(0.91, dt);
  beatKickX *= decayRate;
  beatKickZ *= decayRate;

  // ── Update uniforms ────────────────────────────────────────────────────────
  sharedMat.uniforms['uBands'].value = amps.slice();
  sharedMat.uniforms['uGlow'].value  = 0.08 + cfg.plexusGlow * 0.92;

  // ── Update bloom strength with glow slider ─────────────────────────────────
  if (!isMobile && composer.passes[1]) {
    const bloomPass = composer.passes[1] as InstanceType<typeof UnrealBloomPass>;
    if (bloomPass) bloomPass.strength = 0.4 + cfg.plexusGlow * 0.9;
  }

  // ── Update thread positions ────────────────────────────────────────────────
  updatePositions(amps, cfg.plexusSag);

  // ── Camera orbit — slow elliptical path, gentle vertical drift ────────────
  camTheta += 0.00042 * dt;   // ~1 full orbit per ~2.5 min
  const targetCamY = Math.sin(time * 0.065) * 2.2;
  camY += (targetCamY - camY) * 0.013 * dt;

  const camRadius = 13.5;
  camera.position.set(
    Math.cos(camTheta) * camRadius,
    camY,
    Math.sin(camTheta) * camRadius,
  );
  // Look slightly above/below centre based on camera height
  camera.lookAt(0, camY * 0.35, 0);

  composer.render();
}

// ── Reset (window resize) ──────────────────────────────────────────────────────

export function resetPlexus(): void {
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

export function disposePlexus(): void {
  if (!initialized) return;

  vizModeUnsub?.();
  vizModeUnsub = null;

  for (let b = 0; b < bandLines.length; b++) {
    scene?.remove(bandLines[b]);
    bandGeos[b]?.dispose();
  }
  bandLines.length  = 0;
  bandGeos.length   = 0;
  threadData.length = 0;

  sharedMat?.dispose();
  sharedMat = null;

  composer?.dispose();
  renderer?.dispose();
  threeCanvas?.remove();

  threeCanvas = null;
  renderer    = null;
  scene       = null;
  camera      = null;
  composer    = null;

  time          = 0;
  camTheta      = 0;
  camY          = 0;
  lastBeatIndex = -1;
  beatKickX     = 0;
  beatKickZ     = 0;
  builtStrands  = 0;

  initialized = false;
}
