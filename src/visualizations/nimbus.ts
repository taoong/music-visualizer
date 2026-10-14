/**
 * Nimbus — volumetric storm-cloud chamber
 *
 * GLSL fullscreen-quad raymarching of a 3D layered-noise density field.
 * Seven audio bands modulate cloud density at octave-spaced spatial scales
 * (sub-bass = large slow billows, brilliance = fine surface wisps). The
 * camera drifts in a lazy Lissajous path through the cloud volume.
 * Beat fires a warm amber lightning flash from within.
 *
 * No rainbow palette, no additive neon.
 * Palette: near-black indigo void → cool grey-blue cloud → warm cream-white
 * lit face; amber/gold only on beat-driven lightning flash.
 *
 * Technique: single fullscreen quad + ShaderMaterial (Three.js provides
 * canvas/renderer/clock). All geometry and volumetric shading live in the
 * GLSL fragment shader. Front-to-back Beer-Lambert accumulation with a
 * single-sample shadow ray per occupied voxel. No post-processing pass —
 * tone-mapping baked into the fragment shader.
 *
 * Inspired by:
 *   Olafur Eliasson "Your Blind Passenger" (2010, ARoS Aarhus / gallery shows)
 *   — the walk-through fog tunnel that makes visitors lose spatial reference;
 *   Inigo Quilez's real-time cloud rendering articles (iquilezles.org/articles/cld/);
 *   the atmospheric VJ aesthetic of Ben Frost / Burial live visuals.
 *
 * Sliders:
 *   Coverage  — cloud density 0=near-empty wisps → 1=dense overcast (structural)
 *   Turbulence — domain-warp chaos: calm smooth billows → violent storm
 *   Lightning  — beat flash + internal backlight intensity
 */

import * as THREE from 'three';
import { store }          from '../state/store';
import { getBandAverages } from './helpers';
import { audioEngine }     from '../audio/engine';
import { isMobile }        from '../utils/constants';

// ── Module state ──────────────────────────────────────────────────────────────

let initialized  = false;
let threeCanvas  : HTMLCanvasElement | null = null;
let renderer     : THREE.WebGLRenderer | null = null;
let scene        : THREE.Scene | null = null;
let orthoCamera  : THREE.OrthographicCamera | null = null;
let quadMesh     : THREE.Mesh | null = null;
let shaderMat    : THREE.ShaderMaterial | null = null;
let vizModeUnsub : (() => void) | null = null;

let time          = 0.0;
let lastBeatIndex = -1;
let beatKick      = 0.0;   // decays 0→1 impulse sent to shader

const smoothedBands = new Float32Array(7);

// ── Uniforms (mutated in-place every frame) ───────────────────────────────────

const uTime       : THREE.IUniform<number>        = { value: 0.0 };
const uAspect     : THREE.IUniform<number>        = { value: 1.0 };
const uBands      : THREE.IUniform<number[]>      = { value: new Array(7).fill(0) };
const uBeatKick   : THREE.IUniform<number>        = { value: 0.0 };
const uCamPos     : THREE.IUniform<THREE.Vector3> = { value: new THREE.Vector3() };
const uCamFwd     : THREE.IUniform<THREE.Vector3> = { value: new THREE.Vector3(0, 0, -1) };
const uCamRight   : THREE.IUniform<THREE.Vector3> = { value: new THREE.Vector3(1, 0,  0) };
const uCamUp      : THREE.IUniform<THREE.Vector3> = { value: new THREE.Vector3(0, 1,  0) };
const uCoverage   : THREE.IUniform<number>        = { value: 0.5 };
const uTurbulence : THREE.IUniform<number>        = { value: 0.4 };
const uLightning  : THREE.IUniform<number>        = { value: 0.5 };

// ── GLSL ──────────────────────────────────────────────────────────────────────

const VERT = /* glsl */`
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

// MAX_STEPS injected at build time so mobile gets a lighter loop.
function buildFrag(maxSteps: number): string {
  return /* glsl */`
  precision highp float;

  uniform float     uTime;
  uniform float     uAspect;
  uniform float     uBands[7];
  uniform float     uBeatKick;
  uniform vec3      uCamPos;
  uniform vec3      uCamFwd;
  uniform vec3      uCamRight;
  uniform vec3      uCamUp;
  uniform float     uCoverage;
  uniform float     uTurbulence;
  uniform float     uLightning;

  varying vec2 vUv;

  // ── Value noise (faster than gradient Perlin) ─────────────────────────────

  float h2(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }

  float vnoise2(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(h2(i),             h2(i+vec2(1,0)), u.x),
               mix(h2(i+vec2(0,1)),   h2(i+vec2(1,1)), u.x), u.y) * 2.0 - 1.0;
  }

  float vnoise3(vec3 p) {
    vec3 i = floor(p), f = fract(p);
    vec3 u = f * f * (3.0 - 2.0 * f);
    float v000 = h2(i.xy + vec2(i.z * 37.0,  0.0));
    float v100 = h2(i.xy + vec2(i.z * 37.0,  1.0) + vec2(1,0));
    float v010 = h2(i.xy + vec2(i.z * 37.0, -1.0) + vec2(0,1));
    float v110 = h2(i.xy + vec2(i.z * 37.0,  0.0) + vec2(1,1));
    float v001 = h2((i+vec3(0,0,1)).xy + vec2((i.z+1.0) * 37.0,  0.0));
    float v101 = h2((i+vec3(0,0,1)).xy + vec2((i.z+1.0) * 37.0,  1.0) + vec2(1,0));
    float v011 = h2((i+vec3(0,0,1)).xy + vec2((i.z+1.0) * 37.0, -1.0) + vec2(0,1));
    float v111 = h2((i+vec3(0,0,1)).xy + vec2((i.z+1.0) * 37.0,  0.0) + vec2(1,1));
    return mix(
      mix(mix(v000, v100, u.x), mix(v010, v110, u.x), u.y),
      mix(mix(v001, v101, u.x), mix(v011, v111, u.x), u.y),
      u.z
    ) * 2.0 - 1.0;
  }

  // 3-octave FBM — fast enough for the inner loop
  float fbm3(vec3 p) {
    return vnoise3(p) * 0.5
         + vnoise3(p * 2.03 + vec3(1.7, 9.2, 3.5)) * 0.25
         + vnoise3(p * 4.07 + vec3(5.1, 3.3, 8.8)) * 0.125;
  }

  // ── Cloud density field ───────────────────────────────────────────────────
  //
  // Seven audio bands each perturb the field at a different spatial frequency.
  // uCoverage scales the final value — low coverage keeps only the peaks.
  // uTurbulence controls domain-warp strength (organic billow vs. calm rolls).

  float cloudD(vec3 p) {
    // Domain warp: two FBM passes bend coordinate space
    float wStr = uTurbulence * 2.2;
    vec3 q = p + vec3(
      fbm3(p * 0.5  + vec3(0.0, 0.0, uTime * 0.05)),
      fbm3(p * 0.5  + vec3(1.7, 9.2, uTime * 0.04)),
      fbm3(p * 0.5  + vec3(8.3, 2.8, uTime * 0.035))
    ) * wStr;

    // Base low-frequency billow
    float d = fbm3(q * 0.28 + uTime * 0.012) * 0.6;

    // Per-band contributions (low bands = coarse structure; high = detail wisps)
    d += uBands[0] * 0.50 * vnoise3(q * 0.18 + uTime * 0.020);
    d += uBands[1] * 0.40 * vnoise3(q * 0.36 + uTime * 0.030);
    d += uBands[2] * 0.30 * vnoise3(q * 0.72 + uTime * 0.042);
    d += uBands[3] * 0.20 * vnoise3(q * 1.44 + uTime * 0.058);
    d += uBands[4] * 0.14 * vnoise3(q * 2.88 + uTime * 0.078);
    d += uBands[5] * 0.08 * vnoise3(q * 5.76 + uTime * 0.100);
    d += uBands[6] * 0.04 * vnoise3(q * 11.5 + uTime * 0.125);

    // Coverage threshold: lower coverage means higher threshold (less cloud)
    float threshold = mix(0.40, -0.05, uCoverage);
    return max(0.0, d - threshold);
  }

  // Single shadow-ray sample along sun direction
  float shadowAtten(vec3 p, vec3 sunDir) {
    float acc = 0.0;
    vec3  sp  = p;
    float dt  = 0.3;
    for (int i = 0; i < 4; i++) {
      sp  += sunDir * dt;
      acc += cloudD(sp) * dt * 3.0;
      dt  += 0.15;
    }
    return exp(-acc);
  }

  // ── Volume march ──────────────────────────────────────────────────────────

  vec4 march(vec3 ro, vec3 rd) {
    // Static warm sun direction (upper-left)
    vec3 sunDir    = normalize(vec3(-0.4, 0.9, 0.3));

    // Cloud face colors: lit (cream-white) vs. shadow (cool grey-blue)
    vec3 cLit    = vec3(0.90, 0.91, 0.95);   // lit face: near-white cool
    vec3 cShadow = vec3(0.22, 0.26, 0.38);   // shadow: deep slate-blue

    // Background sky gradient: bottom → top
    vec3 bgBot   = vec3(0.01, 0.01, 0.03);   // near-black bottom
    vec3 bgTop   = vec3(0.04, 0.06, 0.13);   // deep indigo top

    // Beat-driven warm internal lightning glow
    float lightning = uBeatKick * uLightning * 2.8;

    vec3  col   = vec3(0.0);
    float trans = 1.0;
    float t     = 0.5;
    float dt    = 0.22;

    for (int i = 0; i < ${maxSteps}; i++) {
      // Bound to a sphere of radius 9 to keep cloud volume finite
      if (dot(uCamPos + rd * t, uCamPos + rd * t) > 81.0) break;

      vec3  p    = uCamPos + rd * t;
      float dens = cloudD(p);

      if (dens > 0.003) {
        // Beer-Lambert extinction step
        float alpha = 1.0 - exp(-dens * dt * 5.5);

        // Sun shading (single shadow sample)
        float sunShadow = shadowAtten(p, sunDir);

        // Internal glow (lightning from audio transients)
        float glow = dens * lightning * 0.6;

        // Composite sample color
        vec3 sampleCol = mix(cShadow, cLit, sunShadow)
                       + vec3(1.00, 0.80, 0.45) * glow;  // warm amber flash

        col   += trans * alpha * sampleCol;
        trans *= (1.0 - alpha);
      }

      if (trans < 0.01) break;
      t  += dt;
      dt *= 1.05;   // step grows slightly for distant samples
      if (t > 18.0) break;
    }

    // Background sky
    float sky = clamp(rd.y * 0.5 + 0.5, 0.0, 1.0);
    col += trans * mix(bgBot, bgTop, sky * sky);

    // Subtle lightning flash across the whole frame
    col += vec3(0.90, 0.75, 0.40) * uBeatKick * uLightning * 0.18;

    // Simple Reinhard tone mapping + gamma
    col  = col / (col + 0.65);
    col  = pow(col, vec3(0.45));

    return vec4(col, 1.0);
  }

  void main() {
    vec2 uv = vUv * 2.0 - 1.0;
    uv.x *= uAspect;

    float fovScale = 0.65;  // ~65 degrees horizontal
    vec3  rd = normalize(uCamFwd
                       + uCamRight * uv.x * fovScale
                       + uCamUp    * uv.y * fovScale);

    gl_FragColor = march(uCamPos, rd);
  }
  `;
}

// ── Camera ────────────────────────────────────────────────────────────────────

const _tgt  = new THREE.Vector3();
const _fwd  = new THREE.Vector3();
const _rght = new THREE.Vector3();
const _up   = new THREE.Vector3();
const _yUp  = new THREE.Vector3(0, 1, 0);

function updateCamera(t: number): void {
  // Lissajous drift — stays within a bounded region, never exits cloud volume
  const x = Math.sin(t * 0.14) * 2.2 + Math.cos(t * 0.07) * 1.0;
  const y = Math.sin(t * 0.06) * 0.9;
  const z = Math.cos(t * 0.10) * 2.4 + Math.sin(t * 0.05) * 1.2;

  uCamPos.value.set(x, y, z);

  // Look slowly toward a drifting target ahead and slightly inward
  _tgt.set(
    x + Math.sin(t * 0.09) * 0.5,
    y + Math.cos(t * 0.04) * 0.3,
    z - 2.5,
  );

  _fwd.subVectors(_tgt, uCamPos.value).normalize();

  // Handle near-vertical look direction gracefully
  const dot = Math.abs(_fwd.dot(_yUp));
  const ref  = dot > 0.97 ? new THREE.Vector3(1, 0, 0) : _yUp;
  _rght.crossVectors(_fwd, ref).normalize();
  _up.crossVectors(_rght, _fwd).normalize();

  uCamFwd.value.copy(_fwd);
  uCamRight.value.copy(_rght);
  uCamUp.value.copy(_up);
}

// ── Setup ─────────────────────────────────────────────────────────────────────

function setup(): void {
  threeCanvas = document.createElement('canvas');
  threeCanvas.style.cssText =
    'position:fixed;top:0;left:0;width:100%;height:100%;z-index:10;pointer-events:none;display:block';
  document.body.appendChild(threeCanvas);

  const pr = Math.min(window.devicePixelRatio, isMobile ? 0.5 : 1.0);
  renderer = new THREE.WebGLRenderer({ canvas: threeCanvas, antialias: false });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(pr);

  scene       = new THREE.Scene();
  orthoCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  const geo     = new THREE.PlaneGeometry(2, 2);
  const maxSteps = isMobile ? 28 : 52;

  shaderMat = new THREE.ShaderMaterial({
    vertexShader:   VERT,
    fragmentShader: buildFrag(maxSteps),
    uniforms: {
      uTime,
      uAspect,
      uBands,
      uBeatKick,
      uCamPos,
      uCamFwd,
      uCamRight,
      uCamUp,
      uCoverage,
      uTurbulence,
      uLightning,
    },
  });

  quadMesh = new THREE.Mesh(geo, shaderMat);
  scene.add(quadMesh);

  uAspect.value = window.innerWidth / window.innerHeight;

  const onResize = (): void => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    renderer?.setSize(w, h);
    uAspect.value = w / h;
  };
  window.addEventListener('resize', onResize);
  (threeCanvas as HTMLCanvasElement & { _resizeHandler?: () => void })._resizeHandler = onResize;

  vizModeUnsub = store.on('vizModeChange', () => {
    disposeNimbus();
  });

  initialized = true;
}

// ── Draw ──────────────────────────────────────────────────────────────────────

export function drawNimbus(_p: unknown, dt: number): void {
  if (!initialized) setup();
  if (!renderer || !scene || !orthoCamera) return;

  time += dt * 0.016;

  const { amps } = getBandAverages(7);

  // Continuous CHOP-style smoothing toward live audio values
  const lerpAlpha = 1.0 - Math.pow(0.04, dt / 60.0);
  for (let i = 0; i < 7; i++) {
    smoothedBands[i] += ((amps[i] ?? 0) - smoothedBands[i]) * lerpAlpha;
  }
  uBands.value  = Array.from(smoothedBands);
  uTime.value   = time;

  // Config sliders
  const cfg = store.config;
  uCoverage.value   = cfg.nimbusCoverage;
  uTurbulence.value = cfg.nimbusTurbulence;
  uLightning.value  = cfg.nimbusLightning;

  // Beat detection — continuous kick decay
  const { state } = store;
  if (state.beatIntervalSec > 0 && state.isPlaying) {
    const pos     = audioEngine.getPlaybackPosition();
    const beatIdx = pos >= 0
      ? Math.floor((pos - state.beatOffset) / state.beatIntervalSec)
      : -1;
    if (beatIdx > lastBeatIndex) {
      lastBeatIndex = beatIdx;
      beatKick      = 1.0;
    }
  }
  beatKick       *= Math.pow(0.84, dt);
  uBeatKick.value = beatKick;

  updateCamera(time);

  renderer.render(scene, orthoCamera);
}

// ── Reset (resize) ────────────────────────────────────────────────────────────

export function resetNimbus(): void {
  if (!initialized) return;
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer?.setSize(w, h);
  uAspect.value = w / h;
}

// ── Dispose ───────────────────────────────────────────────────────────────────

export function disposeNimbus(): void {
  if (!initialized) return;

  vizModeUnsub?.();
  vizModeUnsub = null;

  const canvas = threeCanvas as (HTMLCanvasElement & { _resizeHandler?: () => void }) | null;
  if (canvas?._resizeHandler) window.removeEventListener('resize', canvas._resizeHandler);

  quadMesh?.geometry.dispose();
  shaderMat?.dispose();
  scene?.clear();
  renderer?.dispose();
  threeCanvas?.remove();

  threeCanvas  = null;
  renderer     = null;
  scene        = null;
  orthoCamera  = null;
  quadMesh     = null;
  shaderMat    = null;
  initialized  = false;
  time         = 0.0;
  lastBeatIndex = -1;
  beatKick     = 0.0;
  smoothedBands.fill(0);
}
