/**
 * Shimmer — audio-reactive caustic water surface
 *
 * A dark water plane ripples with 7 sinusoidal wave modes driven by the
 * 7 frequency bands; the analytical Jacobian of the wave field (the
 * frequency-squared weighted sum of band amplitudes) concentrates
 * light energy into moving caustic bright-lines exactly as physical
 * optics predicts. Camera orbits at a low grazing angle over the surface
 * in a slow elliptical path.
 *
 * Palette: near-monochrome deep navy + warm/cool caustic light; no rainbow
 * per-band hues. Beats fire a Gaussian pressure wave from the centre that
 * decays continuously (CHOP-style — no state cut, just an impulse added on
 * top of the flowing system).
 *
 * Inspired by Doug Aitken "SONG 1" (2012, Hirshhorn Museum, Washington DC,
 * https://dougaitkenworkshop.com/works/song-1) — a 360° circular video facade
 * with shimmering aquatic reflections — and the TouchDesigner community's
 * real-time water caustic patches via the Jacobian focusing technique first
 * described in Nishita & Nakamae (1994) SIGGRAPH.
 *
 * Sliders
 *   Depth   — structural: caustic focus depth (0=diffuse wide→1=sharp narrow lines)
 *   Chop    — wave amplitude sensitivity (0=glassy calm→1=turbulent)
 *   Warmth  — caustic colour temperature (0=cool lunar blue→1=warm amber sunlight)
 */

import * as THREE from 'three';
import { EffectComposer }   from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass }       from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass }  from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass }       from 'three/addons/postprocessing/OutputPass.js';
import { store }            from '../state/store';
import { getBandAverages, fovForAspect } from './helpers';
import { audioEngine }      from '../audio/engine';
import { isMobile }         from '../utils/constants';

// ── Module state ──────────────────────────────────────────────────────────────

let initialized    = false;
let threeCanvas    : HTMLCanvasElement     | null = null;
let renderer       : THREE.WebGLRenderer  | null = null;
let scene          : THREE.Scene          | null = null;
let camera         : THREE.PerspectiveCamera | null = null;
let composer       : EffectComposer       | null = null;
let bloomPass      : UnrealBloomPass      | null = null;
let waterMesh      : THREE.Mesh           | null = null;
let waterMat       : THREE.ShaderMaterial | null = null;
let vizModeUnsub   : (() => void)         | null = null;

let time        = 0;
let camAngle    = 0;
let beatKick    = 0;
let lastBeatIdx = -1;

// ── Uniforms ──────────────────────────────────────────────────────────────────

const uTime:     THREE.IUniform<number>   = { value: 0 };
const uAmps:     THREE.IUniform<number[]> = { value: new Array(7).fill(0) };
const uBeatKick: THREE.IUniform<number>   = { value: 0 };
const uDepth:    THREE.IUniform<number>   = { value: 0.4 };
const uChop:     THREE.IUniform<number>   = { value: 0.5 };
const uWarmth:   THREE.IUniform<number>   = { value: 0.5 };

// ── GLSL ──────────────────────────────────────────────────────────────────────

// Wave directions: 7 unit vectors evenly distributed in the XZ plane
// (using GLSL 1.00 compatible if-chain rather than array constructors)
const WAVE_DIR_GLSL = /* glsl */`
vec2 waveDir(int k) {
  if (k == 0) return vec2( 0.9749,  0.2225);
  if (k == 1) return vec2( 0.6235,  0.7818);
  if (k == 2) return vec2( 0.0000,  1.0000);
  if (k == 3) return vec2(-0.6235,  0.7818);
  if (k == 4) return vec2(-0.9749,  0.2225);
  if (k == 5) return vec2(-0.9010, -0.4339);
  return          vec2(-0.2225, -0.9749);
}
`;

const VERT_SHADER = /* glsl */`
  uniform float uTime;
  uniform float uAmps[7];
  uniform float uBeatKick;
  uniform float uChop;

  varying float vHeight;
  varying float vLaplacian;
  varying vec3  vWorldNormal;
  varying vec3  vWorldPos;

  ${WAVE_DIR_GLSL}

  void main() {
    vec2 xz = vec2(position.x, position.z);

    float h    = 0.0;
    float dhdx = 0.0;
    float dhdz = 0.0;
    float wh   = 0.0;   // freq²-weighted height sum = -Laplacian * scale

    for (int k = 0; k < 7; k++) {
      float freq  = float(k + 1);
      float speed = 0.40 + 0.12 * float(k);
      float kscale = 1.1;
      vec2 kd  = waveDir(k);
      float arg = dot(kd, xz) * freq * kscale - uTime * speed;
      float sk  = sin(arg);
      float ck  = cos(arg);
      float ak  = uAmps[k] * uChop * 0.35;

      h    += ak * sk;
      dhdx += ak * ck * kd.x * freq * kscale;
      dhdz += ak * ck * kd.y * freq * kscale;
      // Laplacian contribution: -(freq*kscale)² * h_k (klen²=1 since kd is unit)
      wh   += ak * sk * freq * freq * kscale * kscale;
    }

    // Beat: decaying Gaussian radial pulse (adds brief broad heave)
    float r    = length(xz);
    float bump = uBeatKick * exp(-r * r * 0.08);
    h    += bump * 0.5;
    dhdx += -bump * 2.0 * xz.x * 0.08 * 0.5;
    dhdz += -bump * 2.0 * xz.y * 0.08 * 0.5;
    wh   += bump * 4.0;    // approx Laplacian of the Gaussian pulse

    vHeight    = h;
    vLaplacian = -wh;      // Laplacian of the total height field

    // Displaced position (y = height above XZ plane)
    vec3 displaced = position;
    displaced.y    = h;

    // Analytical surface normal: (-dh/dx, 1, -dh/dz) normalised
    vec3 localNorm = normalize(vec3(-dhdx, 1.0, -dhdz));
    vWorldNormal   = normalize(mat3(modelMatrix) * localNorm);

    vec4 worldPos = modelMatrix * vec4(displaced, 1.0);
    vWorldPos     = worldPos.xyz;
    gl_Position   = projectionMatrix * viewMatrix * worldPos;
  }
`;

const FRAG_SHADER = /* glsl */`
  uniform float uDepth;
  uniform float uWarmth;
  uniform float uBeatKick;
  uniform float uAmps[7];

  varying float vHeight;
  varying float vLaplacian;
  varying vec3  vWorldNormal;
  varying vec3  vWorldPos;

  void main() {
    // ── Caustic intensity via Jacobian focusing ──────────────────────────────
    // Physical model: Jacobian J = 1 - focusScale * Laplacian(h)
    // Caustic is bright where J → 0 (focus point) or J < 0 (caustic cusp)
    float focusScale = mix(0.012, 0.18, uDepth);
    float J          = 1.0 - focusScale * vLaplacian;
    // Map to brightness: 1/|J| clamped; subtract 1 so plain-flat surface is dark
    float caustic    = clamp(1.0 / max(0.03, abs(J)) - 0.6, 0.0, 5.0);

    // ── Total audio energy ───────────────────────────────────────────────────
    float totalAmp = 0.0;
    for (int k = 0; k < 7; k++) totalAmp += uAmps[k];
    totalAmp /= 7.0;

    // ── Colour temperature ───────────────────────────────────────────────────
    vec3 coolColor = vec3(0.50, 0.75, 1.00);   // cool lunar silver-blue
    vec3 warmColor = vec3(1.00, 0.78, 0.38);   // warm amber sunlight
    vec3 causticCol = mix(coolColor, warmColor, uWarmth);

    // ── Water base colour ────────────────────────────────────────────────────
    vec3 deepWater = vec3(0.015, 0.030, 0.085);
    vec3 crestWater = vec3(0.040, 0.085, 0.175);
    float hn = clamp(vHeight * 2.5 + 0.5, 0.0, 1.0);
    vec3 baseColor = mix(deepWater, crestWater, hn);

    // ── Add caustic highlight ────────────────────────────────────────────────
    baseColor += causticCol * caustic * (0.08 + totalAmp * 0.55);

    // ── Fresnel rim (edge lighting effect) ───────────────────────────────────
    vec3 N = normalize(vWorldNormal);
    vec3 V = normalize(cameraPosition - vWorldPos);
    float ndotv  = abs(dot(N, V));
    float fresnel = pow(1.0 - ndotv, 4.0);
    baseColor += causticCol * fresnel * (0.20 + totalAmp * 0.50);

    // ── Beat flash ───────────────────────────────────────────────────────────
    baseColor += vec3(0.06, 0.12, 0.25) * uBeatKick;

    gl_FragColor = vec4(baseColor, 1.0);
  }
`;

// ── Setup ─────────────────────────────────────────────────────────────────────

function setup(): void {
  threeCanvas = document.createElement('canvas');
  threeCanvas.style.cssText =
    'position:fixed;top:0;left:0;width:100%;height:100%;z-index:10;pointer-events:none;display:block';
  document.body.appendChild(threeCanvas);

  const w = window.innerWidth;
  const h = window.innerHeight;

  renderer = new THREE.WebGLRenderer({ canvas: threeCanvas, antialias: !isMobile });
  renderer.setSize(w, h);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, isMobile ? 1 : 1.5));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x010308);
  scene.fog = new THREE.FogExp2(0x010308, isMobile ? 0.09 : 0.065);

  const aspect = w / h;
  camera = new THREE.PerspectiveCamera(fovForAspect(50, aspect), aspect, 0.1, 80);

  // Water plane: high-resolution mesh in the XZ plane
  const segs = isMobile ? 90 : 220;
  const geo = new THREE.PlaneGeometry(16, 16, segs, segs);
  geo.rotateX(-Math.PI / 2);  // flat in XZ, normals point up

  waterMat = new THREE.ShaderMaterial({
    uniforms: {
      uTime:     uTime,
      uAmps:     uAmps,
      uBeatKick: uBeatKick,
      uDepth:    uDepth,
      uChop:     uChop,
      uWarmth:   uWarmth,
    },
    vertexShader:   VERT_SHADER,
    fragmentShader: FRAG_SHADER,
    side: THREE.DoubleSide,
  });

  waterMesh = new THREE.Mesh(geo, waterMat);
  scene.add(waterMesh);

  // Post-processing: bloom for the caustic glow
  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));

  bloomPass = new UnrealBloomPass(
    new THREE.Vector2(w, h),
    isMobile ? 0.35 : 0.55,  // strength
    0.55,                     // radius
    0.65,                     // threshold
  );
  composer.addPass(bloomPass);
  composer.addPass(new OutputPass());

  // Hide canvas when switching away
  vizModeUnsub = store.on('vizModeChange', (data) => {
    if (threeCanvas) threeCanvas.style.display = data === 'shimmer' ? 'block' : 'none';
  });

  initialized = true;
}

// ── Draw ──────────────────────────────────────────────────────────────────────

export function drawShimmer(_p: unknown, dt: number): void {
  if (!initialized) setup();
  if (!renderer || !scene || !camera || !composer) return;

  const { amps, transients } = getBandAverages(7);

  // Beat detection (CHOP-style: impulse on beat, continuous decay)
  const { state } = store;
  if (state.beatIntervalSec > 0 && state.isPlaying) {
    const pos  = audioEngine.getPlaybackPosition();
    const adj  = pos - state.beatOffset;
    const bidx = adj >= 0 ? Math.floor(adj / state.beatIntervalSec) : -1;
    if (bidx > lastBeatIdx) {
      lastBeatIdx = bidx;
      beatKick = 1.0;
    }
  }
  // Also kick on strong transients (mic mode / no BPM)
  const maxTransient = Math.max(...transients);
  if (maxTransient > 1.8 && beatKick < 0.4) beatKick = 0.6;

  beatKick *= Math.pow(0.84, dt);  // exponential decay

  time += dt * 0.016;

  // Update uniforms from config
  const cfg = store.config;
  uDepth.value    = cfg.shimmerDepth;
  uChop.value     = cfg.shimmerChop;
  uWarmth.value   = cfg.shimmerWarmth;
  uBeatKick.value = beatKick;
  uTime.value     = time;
  for (let k = 0; k < 7; k++) {
    uAmps.value[k] = Math.max(0, amps[k] ?? 0);
  }

  // Camera: slow elliptical orbit at low grazing angle over the water
  camAngle += 0.0028 * dt;
  const rX = 7.0 + Math.sin(camAngle * 0.37) * 1.2;
  const rZ = 7.5 + Math.cos(camAngle * 0.47) * 1.0;
  const camY = 2.8 + Math.sin(camAngle * 0.21) * 0.8;  // gentle height bob
  camera.position.set(
    Math.cos(camAngle) * rX,
    camY,
    Math.sin(camAngle) * rZ,
  );
  // Look slightly ahead of origin to avoid always looking straight down
  const lookTarget = new THREE.Vector3(
    Math.cos(camAngle + 0.4) * 0.8,
    0,
    Math.sin(camAngle + 0.4) * 0.8,
  );
  camera.lookAt(lookTarget);

  composer.render();
}

// ── Reset (resize) ────────────────────────────────────────────────────────────

export function resetShimmer(): void {
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
  bloomPass?.setSize(w, h);
}

// ── Dispose ───────────────────────────────────────────────────────────────────

export function disposeShimmer(): void {
  if (!initialized) return;
  vizModeUnsub?.();
  vizModeUnsub = null;
  waterMesh?.geometry.dispose();
  waterMat?.dispose();
  composer?.dispose();
  renderer?.dispose();
  threeCanvas?.remove();
  threeCanvas = null;
  renderer   = null;
  scene      = null;
  camera     = null;
  composer   = null;
  bloomPass  = null;
  waterMesh  = null;
  waterMat   = null;
  initialized = false;
}
