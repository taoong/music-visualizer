/**
 * Strata — GLSL sphere-traced alien terrain visualization.
 *
 * Seven audio frequency bands drive distinct geological strata heights in a
 * raymarched landscape. Sub-bass heaves the ground in slow continental
 * rolls; brilliance peppers the surface with fine crystalline facets.
 * A single warm sidelight rakes across matte stone from a low sun angle;
 * the camera orbits steadily at medium altitude, never jump-cutting.
 *
 * Inspired by "Elevated" (Rgba & TBC, Breakpoint 2009,
 * https://www.pouet.net/prod.php?which=52938) — the ur-example of real-time
 * raymarched terrain — and by the VJ terrain aesthetic popularised in
 * live electronic music performance (Aphex Twin, Autechre stage visuals).
 *
 * Technique: single fullscreen quad + ShaderMaterial; all geometry and depth
 * born inside the GLSL fragment shader (sphere-march a 7-band height field).
 * Three.js provides canvas, renderer, and a clock; the camera matrix is
 * computed in JS each frame and sent as vec3 uniforms.
 * No rainbow palette, no additive neon — warm ochre/rust/limestone geology.
 */

import * as THREE from 'three';
import { store } from '../state/store';
import { getBandAverages } from './helpers';
import { audioEngine } from '../audio/engine';
import { isMobile } from '../utils/constants';

// ── Module state ──────────────────────────────────────────────────────────────

let initialized   = false;
let threeCanvas   : HTMLCanvasElement | null = null;
let renderer      : THREE.WebGLRenderer | null = null;
let scene         : THREE.Scene | null = null;
let orthoCamera   : THREE.OrthographicCamera | null = null;
let quadMesh      : THREE.Mesh | null = null;
let shaderMat     : THREE.ShaderMaterial | null = null;
let vizModeUnsub  : (() => void) | null = null;

let time          = 0;
let camTheta      = 0;     // orbit angle in radians
let lastBeatIndex = -1;
let beatKick      = 0;     // decays 0→1 impulse sent to shader

// Smooth lerp targets for bands (continuous CHOP-style signal)
const smoothedBands = new Float32Array(7);

// ── Uniforms (mutated in-place each frame) ────────────────────────────────────

const uTime      : THREE.IUniform<number>          = { value: 0.0 };
const uAspect    : THREE.IUniform<number>          = { value: 1.0 };
const uBands     : THREE.IUniform<number[]>        = { value: new Array(7).fill(0) };
const uBeatKick  : THREE.IUniform<number>          = { value: 0.0 };
const uCamPos    : THREE.IUniform<THREE.Vector3>   = { value: new THREE.Vector3() };
const uCamFwd    : THREE.IUniform<THREE.Vector3>   = { value: new THREE.Vector3(0, -1, 0) };
const uCamRight  : THREE.IUniform<THREE.Vector3>   = { value: new THREE.Vector3(1, 0, 0) };
const uCamUp     : THREE.IUniform<THREE.Vector3>   = { value: new THREE.Vector3(0, 0, -1) };
const uStrataScale: THREE.IUniform<number>         = { value: 0.5 };
const uWarp      : THREE.IUniform<number>          = { value: 0.3 };
const uHeight    : THREE.IUniform<number>          = { value: 0.4 };

// ── GLSL ──────────────────────────────────────────────────────────────────────

const VERTEX_SHADER = /* glsl */`
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

// The step count is injected at build time so mobile gets fewer iterations.
function buildFragmentShader(maxSteps: number): string {
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
  uniform float     uStrataScale;  // 0=zoomed-in, 1=wide panorama
  uniform float     uWarp;         // domain-warp strength
  uniform float     uHeight;       // camera altitude (0=low, 1=high)

  varying vec2 vUv;

  // ── Value noise ────────────────────────────────────────────────────────────

  float hash2(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }

  float vnoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(hash2(i),             hash2(i + vec2(1.0, 0.0)), u.x),
      mix(hash2(i + vec2(0.0, 1.0)), hash2(i + vec2(1.0, 1.0)), u.x),
      u.y
    ) * 2.0 - 1.0;
  }

  // ── Terrain height field ───────────────────────────────────────────────────
  //
  // Each of 7 frequency bands drives a different spatial scale of the terrain:
  //   bands[0] (sub-bass)  → large continental rolls
  //   bands[6] (brilliance)→ microscopic surface crystal facets
  //
  // uStrataScale zooms in/out (smaller = more zoomed-in, larger features).
  // uWarp bends coordinate space before sampling (domain warp).

  float terrainH(vec2 p) {
    // Base scale: mix 0.08 (wide, feature-rich) to 0.35 (close-up zoomed in)
    float baseFreq = mix(0.08, 0.35, uStrataScale);
    p *= baseFreq;

    // Domain warp: two noise passes bend the coordinate space
    float wStr = uWarp * 2.5;
    float wx   = vnoise(p * 0.8 + vec2(3.7, 1.2) + uTime * 0.008) * wStr;
    float wy   = vnoise(p * 0.8 + vec2(8.3, 5.4) + uTime * 0.006) * wStr;
    vec2  wp   = p + vec2(wx, wy);

    // Layered height: band[i] drives spatial freq 2^i relative to base
    float h = 0.0;
    h += uBands[0] * 2.20 * vnoise(wp * 0.50 + uTime * 0.008);
    h += uBands[1] * 1.60 * vnoise(wp * 1.00 + uTime * 0.012);
    h += uBands[2] * 1.10 * vnoise(wp * 2.00 + uTime * 0.018);
    h += uBands[3] * 0.70 * vnoise(wp * 4.00 + uTime * 0.026);
    h += uBands[4] * 0.40 * vnoise(wp * 8.00 + uTime * 0.036);
    h += uBands[5] * 0.20 * vnoise(wp * 16.0 + uTime * 0.050);
    h += uBands[6] * 0.10 * vnoise(wp * 32.0 + uTime * 0.070);

    // Beat kick adds a brief ground-heave
    h += uBeatKick * 0.6 * vnoise(wp * 0.3 + uTime * 0.5);

    return h;
  }

  // ── Ray-terrain intersection ───────────────────────────────────────────────
  //
  // Sphere march along ray, using (p.y - terrainH(p.xz)) as the SDF residual.
  // Step conservatively with dt = residual * 0.5 so we don't overshoot.

  bool castRay(vec3 ro, vec3 rd, out float t) {
    t = 0.5;
    for (int i = 0; i < ${maxSteps}; i++) {
      vec3  p = ro + rd * t;
      float d = p.y - terrainH(p.xz);
      if (d < 0.006 * (1.0 + t * 0.05)) return true;
      t += max(d * 0.45, 0.02);
      if (t > 60.0) break;
    }
    return false;
  }

  // ── Terrain normal via central differences ─────────────────────────────────

  vec3 terrainNormal(vec2 xz) {
    float e = 0.04;
    float hL = terrainH(xz - vec2(e, 0.0));
    float hR = terrainH(xz + vec2(e, 0.0));
    float hD = terrainH(xz - vec2(0.0, e));
    float hU = terrainH(xz + vec2(0.0, e));
    return normalize(vec3(hL - hR, 2.0 * e, hD - hU));
  }

  // ── Geological colour based on relative height ─────────────────────────────
  //
  // Maps normalised height (0–1 over max possible band sum ≈ 6.3) to a
  // geological palette:  dark basalt → rust iron → warm ochre → pale limestone
  // No per-band rainbow — the audio drives form, not hue.

  vec3 rockColor(float hNorm) {
    // four control points
    vec3 c0 = vec3(0.04, 0.03, 0.03);   // 0.00 — void / deep shadow basalt
    vec3 c1 = vec3(0.38, 0.14, 0.07);   // 0.18 — rust / iron oxide red
    vec3 c2 = vec3(0.72, 0.52, 0.22);   // 0.45 — warm sandstone ochre
    vec3 c3 = vec3(0.84, 0.78, 0.62);   // 0.72 — pale limestone
    vec3 c4 = vec3(0.96, 0.95, 0.91);   // 1.00 — bleached bone / quartz

    if (hNorm < 0.18) return mix(c0, c1, hNorm / 0.18);
    if (hNorm < 0.45) return mix(c1, c2, (hNorm - 0.18) / 0.27);
    if (hNorm < 0.72) return mix(c2, c3, (hNorm - 0.45) / 0.27);
    return mix(c3, c4, clamp((hNorm - 0.72) / 0.28, 0.0, 1.0));
  }

  // ── Soft shadow (single-sample penumbra) ──────────────────────────────────

  float softshadow(vec3 ro, vec3 rd, float tmin, float tmax) {
    float res = 1.0;
    float t   = tmin;
    for (int i = 0; i < 24; i++) {
      vec3  p = ro + rd * t;
      float h = p.y - terrainH(p.xz);
      res = min(res, 8.0 * h / t);
      t  += clamp(h * 0.5, 0.05, 0.8);
      if (res < 0.01 || t > tmax) break;
    }
    return clamp(res, 0.0, 1.0);
  }

  // ── Main ──────────────────────────────────────────────────────────────────

  void main() {
    vec2 uv = vUv * 2.0 - 1.0;
    uv.x *= uAspect;

    // Construct ray from camera uniforms
    float fov  = 0.75;   // tan of half-FOV ≈ 36°
    vec3  ro   = uCamPos;
    vec3  rd   = normalize(uCamFwd + uv.x * uCamRight * fov + uv.y * uCamUp * fov);

    // Sky colour: deep indigo-charcoal, brightens near horizon
    float skyT   = clamp(rd.y * 2.0 + 0.3, 0.0, 1.0);
    vec3  skyCol = mix(vec3(0.08, 0.07, 0.10), vec3(0.20, 0.18, 0.25), skyT);

    // Sun disk (not audio-reactive, just world-space constant direction)
    vec3  sunDir = normalize(vec3(0.55, 0.30, -0.78));
    float sunDot = dot(rd, sunDir);
    if (sunDot > 0.998) {
      skyCol += vec3(1.0, 0.85, 0.55) * 3.0;  // tiny hot sun disk
    }

    // March terrain
    float t;
    if (!castRay(ro, rd, t)) {
      // Sky path — add faint sun halo
      float halo = clamp((sunDot - 0.90) / 0.10, 0.0, 1.0);
      skyCol += vec3(0.80, 0.55, 0.25) * halo * halo * 0.6;
      gl_FragColor = vec4(skyCol, 1.0);
      return;
    }

    // Terrain hit
    vec3  pos     = ro + rd * t;
    vec3  nor     = terrainNormal(pos.xz);
    float hAbs    = pos.y;
    float hNorm   = clamp(hAbs / 6.3, 0.0, 1.0);
    vec3  baseCol = rockColor(hNorm);

    // Phong shading — warm sun key + cool sky fill
    float diff    = clamp(dot(nor, sunDir), 0.0, 1.0);
    float shad    = softshadow(pos + nor * 0.05, sunDir, 0.1, 24.0);
    float skyFill = clamp(0.5 + 0.5 * nor.y, 0.0, 1.0);  // sky hemisphere
    float specW   = pow(max(dot(reflect(-sunDir, nor), -rd), 0.0), 16.0);

    vec3 sunCol   = vec3(1.05, 0.88, 0.60);  // warm amber sun
    vec3 ambient  = vec3(0.18, 0.22, 0.30) * skyFill;

    vec3 col = baseCol * (ambient + sunCol * diff * shad)
             + vec3(1.0, 0.92, 0.75) * specW * shad * 0.3;

    // Add slight slope darkening (crevasse AO proxy)
    col *= (0.7 + 0.3 * nor.y);

    // Exponential depth fog: deep indigo at distance
    float fogFactor = 1.0 - exp(-t * 0.022);
    vec3  fogCol    = vec3(0.07, 0.06, 0.12);
    col = mix(col, fogCol, fogFactor);

    // Subtle vignette
    float vig = 1.0 - 0.35 * dot(vUv - 0.5, vUv - 0.5) * 4.0;
    col *= vig;

    // Gamma
    col = pow(max(col, vec3(0.0)), vec3(1.0 / 2.2));

    gl_FragColor = vec4(col, 1.0);
  }
`;
}

// ── Camera orbit helpers ──────────────────────────────────────────────────────

const _camPos   = new THREE.Vector3();
const _target   = new THREE.Vector3(0, 0, 0);
const _fwd      = new THREE.Vector3();
const _right    = new THREE.Vector3();
const _up       = new THREE.Vector3();
const _worldUp  = new THREE.Vector3(0, 1, 0);

function updateCamera(theta: number, altitudeSlider: number): void {
  // Orbit radius and height driven by altitude slider
  const radius = 14.0;
  const camH   = 3.5 + altitudeSlider * 9.0;

  _camPos.set(
    Math.cos(theta) * radius,
    camH,
    Math.sin(theta) * radius
  );

  _fwd.copy(_target).sub(_camPos).normalize();
  _right.crossVectors(_fwd, _worldUp).normalize();
  _up.crossVectors(_right, _fwd).normalize();

  uCamPos.value.copy(_camPos);
  uCamFwd.value.copy(_fwd);
  uCamRight.value.copy(_right);
  uCamUp.value.copy(_up);
}

// ── Setup ─────────────────────────────────────────────────────────────────────

function setup(): void {
  threeCanvas = document.createElement('canvas');
  threeCanvas.style.cssText =
    'position:fixed;top:0;left:0;width:100%;height:100%;z-index:10;pointer-events:none;display:block';
  document.body.appendChild(threeCanvas);

  const w = window.innerWidth;
  const h = window.innerHeight;

  // Lower pixel ratio on mobile — fragment shader is the bottleneck
  const dpr = isMobile
    ? Math.min(window.devicePixelRatio, 0.6)
    : Math.min(window.devicePixelRatio, 1.25);

  renderer = new THREE.WebGLRenderer({
    canvas: threeCanvas,
    antialias: false,  // no geometry edges to smooth
    alpha: false,
  });
  renderer.setSize(w, h);
  renderer.setPixelRatio(dpr);
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;

  scene      = new THREE.Scene();
  orthoCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  uAspect.value = w / h;

  const maxSteps = isMobile ? 90 : 150;

  shaderMat = new THREE.ShaderMaterial({
    vertexShader:   VERTEX_SHADER,
    fragmentShader: buildFragmentShader(maxSteps),
    uniforms: {
      uTime:        uTime,
      uAspect:      uAspect,
      uBands:       uBands,
      uBeatKick:    uBeatKick,
      uCamPos:      uCamPos,
      uCamFwd:      uCamFwd,
      uCamRight:    uCamRight,
      uCamUp:       uCamUp,
      uStrataScale: uStrataScale,
      uWarp:        uWarp,
      uHeight:      uHeight,
    },
    depthTest:  false,
    depthWrite: false,
  });

  const geo  = new THREE.PlaneGeometry(2, 2);
  quadMesh   = new THREE.Mesh(geo, shaderMat);
  scene.add(quadMesh);

  // Dispose on viz-mode switch
  vizModeUnsub = store.on('vizModeChange', () => {
    disposeStrata();
  });

  const onResize = (): void => {
    const nw = window.innerWidth;
    const nh = window.innerHeight;
    renderer?.setSize(nw, nh);
    uAspect.value = nw / nh;
  };
  window.addEventListener('resize', onResize);
  (threeCanvas as HTMLCanvasElement & { _resizeHandler?: () => void })._resizeHandler = onResize;

  initialized = true;
}

// ── Draw (called by p5 draw loop at ~60 fps) ──────────────────────────────────

export function drawStrata(_p: unknown, dt: number): void {
  if (!initialized) setup();
  if (!renderer || !scene || !orthoCamera || !shaderMat) return;

  time     += dt * 0.016;
  camTheta += 0.0012 * dt;   // ~0.4° per frame → full orbit in ~15 min

  const { amps } = getBandAverages(7);

  // Smooth audio bands — continuous CHOP-style lerp toward target
  const lerpAlpha = 1.0 - Math.pow(0.05, dt / 60.0);
  for (let i = 0; i < 7; i++) {
    smoothedBands[i] += (amps[i] - smoothedBands[i]) * lerpAlpha;
  }
  uBands.value  = Array.from(smoothedBands);
  uTime.value   = time;

  // Config sliders
  const cfg      = store.config;
  uStrataScale.value = cfg.strataScale;
  uWarp.value        = cfg.strataWarp;
  uHeight.value      = cfg.strataHeight;

  // Beat detection — adds transient kick uniform
  const { state } = store;
  if (state.beatIntervalSec > 0 && state.isPlaying) {
    const pos     = audioEngine.getPlaybackPosition();
    const beatIdx = pos >= 0
      ? Math.floor((pos - state.beatOffset) / state.beatIntervalSec)
      : -1;
    if (beatIdx > lastBeatIndex) {
      lastBeatIndex = beatIdx;
      beatKick = 1.0;
    }
  }
  beatKick         *= Math.pow(0.88, dt);
  uBeatKick.value   = beatKick;

  // Camera orbit — altitude driven by slider
  updateCamera(camTheta, cfg.strataHeight);

  renderer.render(scene, orthoCamera);
}

// ── Reset (resize) ────────────────────────────────────────────────────────────

export function resetStrata(): void {
  if (!initialized) return;
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer?.setSize(w, h);
  uAspect.value = w / h;
}

// ── Dispose ───────────────────────────────────────────────────────────────────

export function disposeStrata(): void {
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

  threeCanvas = null;
  renderer    = null;
  scene       = null;
  orthoCamera = null;
  quadMesh    = null;
  shaderMat   = null;
  initialized = false;
  time        = 0;
  camTheta    = 0;
  lastBeatIndex = -1;
  beatKick    = 0;
  smoothedBands.fill(0);
}
