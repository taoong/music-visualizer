/**
 * Mirror Room — GLSL ray-marched infinity mirror room
 *
 * A camera orbits inside a perfect mirrored cube. Seven incandescent orbs
 * (one per frequency band) drift and pulse inside the room; each reflection
 * off the walls reveals the orbs from a new angle, creating Kusama-style
 * infinite regression. The viewer is always inside — there is no outside.
 *
 * Technical approach: a fullscreen quad ShaderMaterial whose fragment shader
 * ray-traces through a mirrored AABB, accumulating orb glow per ray segment
 * over up to MAX_BOUNCES reflections. All geometry lives in GLSL — Three.js
 * provides only the canvas, renderer, and frame timing. No post-processing
 * stack needed: the shader produces HDR values and tone-maps internally.
 *
 * Inspired by Yayoi Kusama "Infinity Mirrored Room — The Souls of Millions of
 * Light Years Away" (2013, Hirshhorn Museum Washington D.C.,
 * https://hirshhorn.si.edu/kusama/) and the infinity mirror room tradition in
 * installation art.
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

let initialized  = false;
let threeCanvas  : HTMLCanvasElement | null = null;
let renderer     : THREE.WebGLRenderer | null = null;
let scene        : THREE.Scene | null = null;
let camera       : THREE.OrthographicCamera | null = null;
let quadMesh     : THREE.Mesh | null = null;
let shaderMat    : THREE.ShaderMaterial | null = null;
let composer     : EffectComposer | null = null;
let vizModeUnsub : (() => void) | null = null;

let time          = 0;
let lastBeatIndex = -1;
let beatFlash     = 0;    // decays from 1 → 0 on beat

// ── Uniforms ──────────────────────────────────────────────────────────────────

const uTime      : THREE.IUniform<number>   = { value: 0.0 };
const uAspect    : THREE.IUniform<number>   = { value: 1.0 };
const uBands     : THREE.IUniform<number[]> = { value: new Array(7).fill(0) };
const uBeatFlash : THREE.IUniform<number>   = { value: 0.0 };
const uBounces   : THREE.IUniform<number>   = { value: 8 };
const uSpread    : THREE.IUniform<number>   = { value: 0.6 };
const uGlow      : THREE.IUniform<number>   = { value: 0.5 };

// ── Shaders ───────────────────────────────────────────────────────────────────

const VERTEX_SHADER = /* glsl */`
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

// MAX_BOUNCES must be a compile-time constant in GLSL ES 1.0.
// The uniform uBounces drives an early-break so the user can tune depth at run-time.
const FRAGMENT_SHADER = /* glsl */`
  precision highp float;

  varying vec2 vUv;

  uniform float uTime;
  uniform float uAspect;
  uniform float uBands[7];
  uniform float uBeatFlash;
  uniform float uBounces;
  uniform float uSpread;
  uniform float uGlow;

  #define MAX_BOUNCES 14
  #define BOX 0.983

  // Soft incandescent palette — Kusama room hues (amber, vermilion, rose,
  // violet, cobalt, cyan mint, warm white). Deliberately not the neon
  // violet→magenta spectrum.
  vec3 orbColor(int i) {
    if (i == 0) return vec3(1.00, 0.65, 0.20);
    if (i == 1) return vec3(1.00, 0.28, 0.28);
    if (i == 2) return vec3(0.95, 0.40, 0.90);
    if (i == 3) return vec3(0.60, 0.25, 1.00);
    if (i == 4) return vec3(0.20, 0.55, 1.00);
    if (i == 5) return vec3(0.20, 0.95, 0.80);
    return          vec3(1.00, 0.95, 0.70);
  }

  // Orb positions drift via Lissajous-like motion driven by uTime
  vec3 orbPos(int i) {
    float ph = float(i) * 0.9;
    float s  = uSpread * 0.72;
    return s * vec3(
      sin(uTime * 0.29 + ph * 1.13),
      cos(uTime * 0.19 + ph * 1.73) * 0.55,
      cos(uTime * 0.37 + ph * 2.31)
    );
  }

  // Find next wall hit from inside the box. Returns hit distance; sets norm.
  float boxExit(vec3 ro, vec3 rd, out vec3 norm) {
    vec3 inv  = 1.0 / rd;
    vec3 t1   = (-BOX - ro) * inv;
    vec3 t2   = ( BOX - ro) * inv;
    vec3 tmax = max(t1, t2);
    float t   = min(min(tmax.x, tmax.y), tmax.z);
    if      (abs(t - tmax.x) < 1e-5) norm = vec3(-sign(rd.x), 0.0, 0.0);
    else if (abs(t - tmax.y) < 1e-5) norm = vec3(0.0, -sign(rd.y), 0.0);
    else                              norm = vec3(0.0, 0.0, -sign(rd.z));
    return max(t, 0.001);
  }

  // Accumulate light from one orb along ray segment [0, tMax].
  // Returns HDR colour contribution.
  vec3 sampleOrb(vec3 ro, vec3 rd, float tMax, int i) {
    float band  = uBands[i];
    float rad   = 0.055 + band * 0.09 + uBeatFlash * 0.045;
    vec3  color = orbColor(i);
    float bright = (0.45 + uGlow * 1.6 + band * 0.75 + uBeatFlash * 0.5);

    vec3  oc   = ro - orbPos(i);
    float b    = dot(oc, rd);
    float c    = dot(oc, oc) - rad * rad;
    float disc = b * b - c;
    vec3  col  = vec3(0.0);

    // Sphere core: solid intersection through the orb body
    if (disc > 0.0) {
      float sq = sqrt(disc);
      float t1 = -b - sq;
      float t2 = -b + sq;
      if (t1 < tMax && t2 > 0.0) {
        float len = min(t2, tMax) - max(t1, 0.0);
        col += color * len * bright * 14.0;
      }
    }

    // Halo: soft volumetric glow around the orb
    float ct = clamp(-b, 0.0, tMax);
    vec3  near = oc + ct * rd;
    float d2   = dot(near, near);
    float hr   = rad * 2.8;
    col += color * bright * exp(-d2 / (hr * hr)) * rad * 0.65;

    return col;
  }

  void main() {
    vec2 uv = vUv * 2.0 - 1.0;
    uv.x *= uAspect;

    // Camera orbits inside the box at a small radius; handheld sway
    float ct = uTime * 0.14;
    float cr = 0.28;
    vec3 ro = vec3(
      cr * cos(ct) + 0.012 * sin(uTime * 1.1),
      0.06 * sin(uTime * 0.23) + 0.008 * cos(uTime * 0.71),
      cr * sin(ct) + 0.012 * cos(uTime * 0.93)
    );

    // Camera looks toward the room centre with a slight upward tilt
    vec3 target = vec3(0.0, 0.08 + 0.04 * sin(uTime * 0.19), 0.0);
    vec3 fw = normalize(target - ro);
    vec3 rt = normalize(cross(fw, vec3(0.0, 1.0, 0.0)));
    vec3 up = cross(rt, fw);
    vec3 rd = normalize(fw + uv.x * rt * 0.76 + uv.y * up * 0.76);

    // --- Ray march through the mirrored box ---
    vec3  col   = vec3(0.0);
    float atten = 1.0;

    for (int b = 0; b < MAX_BOUNCES; b++) {
      if (float(b) >= uBounces) break;

      vec3  norm;
      float t = boxExit(ro, rd, norm);

      // Ceiling tint (slightly blue-cool) and floor tint (slightly amber-warm)
      vec3 tint = vec3(1.0);
      if (norm.y > 0.5)  tint = vec3(0.90, 0.92, 1.05);
      if (norm.y < -0.5) tint = vec3(1.05, 1.00, 0.88);

      // Accumulate orb glow along this ray segment
      for (int i = 0; i < 7; i++) {
        col += atten * sampleOrb(ro, rd, t, i) * tint;
      }

      // Advance to wall, then reflect
      ro    = ro + rd * (t - 0.002);
      rd    = reflect(rd, norm);
      atten *= 0.80;   // walls absorb ~20 % per bounce
    }

    // Faint ambient so the room is never pure black between orbs
    col += vec3(0.012, 0.010, 0.016);

    // Reinhard tone map
    col = col / (col + vec3(1.0));
    // Mild gamma lift
    col = pow(col, vec3(0.88));

    gl_FragColor = vec4(col, 1.0);
  }
`;

// ── Setup ─────────────────────────────────────────────────────────────────────

function setup(): void {
  const w = window.innerWidth;
  const h = window.innerHeight;

  threeCanvas = document.createElement('canvas');
  threeCanvas.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;z-index:0;pointer-events:none;';
  document.body.appendChild(threeCanvas);

  renderer = new THREE.WebGLRenderer({ canvas: threeCanvas, antialias: false });
  renderer.setPixelRatio(isMobile ? 1.0 : Math.min(window.devicePixelRatio, 2));
  renderer.setSize(w, h);

  scene  = new THREE.Scene();
  camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  uAspect.value = w / h;

  const geo = new THREE.PlaneGeometry(2, 2);
  shaderMat = new THREE.ShaderMaterial({
    vertexShader:   VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    uniforms: {
      uTime:      uTime,
      uAspect:    uAspect,
      uBands:     uBands,
      uBeatFlash: uBeatFlash,
      uBounces:   uBounces,
      uSpread:    uSpread,
      uGlow:      uGlow,
    },
    depthTest:  false,
    depthWrite: false,
  });

  quadMesh = new THREE.Mesh(geo, shaderMat);
  scene.add(quadMesh);

  // Subtle bloom on desktop — threshold 0.9 so only brightest orb cores bloom
  if (!isMobile) {
    composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    const bloom = new UnrealBloomPass(new THREE.Vector2(w, h), 0.25, 0.5, 0.88);
    composer.addPass(bloom);
    composer.addPass(new OutputPass());
  }

  vizModeUnsub = store.on('vizModeChange', () => {
    disposeMirrorCube();
  });

  const onResize = () => {
    const nw = window.innerWidth;
    const nh = window.innerHeight;
    renderer?.setSize(nw, nh);
    uAspect.value = nw / nh;
    composer?.setSize(nw, nh);
  };
  window.addEventListener('resize', onResize);
  (threeCanvas as HTMLCanvasElement & { _resizeHandler?: () => void })._resizeHandler = onResize;

  initialized = true;
}

// ── Draw ──────────────────────────────────────────────────────────────────────

export function drawMirrorCube(_p: unknown, dt: number): void {
  if (!initialized) setup();
  if (!renderer || !scene || !camera || !shaderMat) return;

  time += dt * 0.016;

  const { amps } = getBandAverages(7);
  uBands.value  = amps.slice();
  uTime.value   = time;

  // Slider → uniforms
  const cfg = store.config;
  const maxB = isMobile ? 6 : 14;
  uBounces.value = Math.round(2 + cfg.mirrorcubeBounces * (maxB - 2));
  uSpread.value  = cfg.mirrorcubeSpread;
  uGlow.value    = cfg.mirrorcubeGlow;

  // Beat detection
  const { state } = store;
  if (state.beatIntervalSec > 0 && state.isPlaying) {
    const pos     = audioEngine.getPlaybackPosition();
    const beatIdx = pos >= 0 ? Math.floor((pos - state.beatOffset) / state.beatIntervalSec) : -1;
    if (beatIdx > lastBeatIndex) {
      lastBeatIndex = beatIdx;
      beatFlash     = 1.0;
    }
  }

  beatFlash   *= Math.pow(0.84, dt);
  uBeatFlash.value = beatFlash;

  if (composer) {
    // Keep bloom in sync with glow slider
    const bloomPass = composer.passes[1] as InstanceType<typeof UnrealBloomPass>;
    if (bloomPass) bloomPass.strength = 0.1 + cfg.mirrorcubeGlow * 0.3;
    composer.render();
  } else {
    renderer.render(scene, camera);
  }
}

// ── Reset ─────────────────────────────────────────────────────────────────────

export function resetMirrorCube(): void {
  if (!initialized) return;
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer?.setSize(w, h);
  uAspect.value = w / h;
  composer?.setSize(w, h);
}

// ── Dispose ───────────────────────────────────────────────────────────────────

export function disposeMirrorCube(): void {
  if (!initialized) return;

  vizModeUnsub?.();
  vizModeUnsub = null;

  const handler = (threeCanvas as HTMLCanvasElement & { _resizeHandler?: () => void })?._resizeHandler;
  if (handler) window.removeEventListener('resize', handler);

  quadMesh?.geometry.dispose();
  shaderMat?.dispose();
  composer?.dispose();
  scene?.clear();
  renderer?.dispose();
  threeCanvas?.remove();

  threeCanvas  = null;
  renderer     = null;
  scene        = null;
  camera       = null;
  quadMesh     = null;
  shaderMat    = null;
  composer     = null;

  time          = 0;
  lastBeatIndex = -1;
  beatFlash     = 0;

  initialized = false;
}
