/**
 * Foam — 3D Voronoi cellular foam, GLSL raymarching
 *
 * A soap-bubble-like cellular structure fills a dark void; thin glowing
 * walls separate each Voronoi cell. Audio deforms the boundary surfaces
 * continuously — each of 7 freq bands adds a standing-wave modulation at
 * its own spatial frequency and axis, so the foam breathes and shimmers
 * with the music rather than just changing brightness. Beat fires a brief
 * compression impulse that momentarily tightens all cell walls then eases
 * back. Camera drifts in a slow tilted orbit, always looking inward, so the
 * viewer sees the foam from constantly shifting angles.
 *
 * Palette: near-monochrome — warm amber for bass-energy regions,
 * cool blue-white for treble-energy regions. No per-band rainbow.
 *
 * Inspired by Erwin Hauer's "Continua" modular architectural screens
 * (1950s–60s, https://www.erwinhauer.com/) — periodic cellular surfaces
 * cast in concrete and fibreglass — and Floris Kaayk's CG animation
 * "Metalosis Maligna" (2006) which treats cellular foam as a growing
 * architectural material.
 *
 * Sliders
 *  Density: Voronoi cell scale — few large cells → many small cells (structural)
 *  Wall   : cell-wall brightness and thickness
 *  Glow   : overall luminosity + camera distance (affects depth perception)
 */

import * as THREE from 'three';
import { store }          from '../state/store';
import { getBandAverages } from './helpers';
import { audioEngine }     from '../audio/engine';
import { isMobile }        from '../utils/constants';

// ── Module state ──────────────────────────────────────────────────────────────

let initialized    = false;
let threeCanvas    : HTMLCanvasElement | null = null;
let renderer       : THREE.WebGLRenderer | null = null;
let scene          : THREE.Scene | null = null;
let camera         : THREE.OrthographicCamera | null = null;
let quadMesh       : THREE.Mesh | null = null;
let shaderMat      : THREE.ShaderMaterial | null = null;
let vizModeUnsub   : (() => void) | null = null;

let time          = 0;
let cameraTheta   = 0;
let cameraPhi     = 0.4;
let lastBeatIndex = -1;
let beatPulse     = 0;

// ── Uniforms (mutated in place each frame) ─────────────────────────────────────

const uTime      : THREE.IUniform<number>   = { value: 0.0 };
const uAspect    : THREE.IUniform<number>   = { value: 1.0 };
const uBands     : THREE.IUniform<number[]> = { value: [0, 0, 0, 0, 0, 0, 0] };
const uBeatPulse : THREE.IUniform<number>   = { value: 0.0 };
const uDensity   : THREE.IUniform<number>   = { value: 2.0 };
const uWall      : THREE.IUniform<number>   = { value: 0.5 };
const uGlow      : THREE.IUniform<number>   = { value: 0.5 };
// Initialized in setup() to avoid module-level THREE constructor call (keeps this chunk lazy-splittable)
let uCamPos      : THREE.IUniform<THREE.Vector3> | null = null;

// ── GLSL ──────────────────────────────────────────────────────────────────────

const VERT = /* glsl */`
  varying vec2 vUv;
  void main() {
    vUv = uv * 2.0 - 1.0;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const MARCH_STEPS = isMobile ? 48 : 80;

const FRAG = /* glsl */`
  precision highp float;

  #define MARCH_STEPS ${MARCH_STEPS}

  uniform float     uTime;
  uniform float     uAspect;
  uniform float     uBands[7];
  uniform float     uBeatPulse;
  uniform float     uDensity;
  uniform float     uWall;
  uniform float     uGlow;
  uniform vec3      uCamPos;

  varying vec2 vUv;

  // ── Noise / hash ───────────────────────────────────────────────────────────

  // IQ-style 3D hash — returns pseudo-random vec3 in [0,1]^3
  vec3 hash33(vec3 p) {
    p = fract(p * vec3(443.8975, 397.2973, 491.1871));
    p += dot(p.zxy, p.yxz + 19.19);
    return fract(p.x * p.y * p.z * (p + vec3(0.0)));
  }

  // Smooth hash for time-animated seeds
  vec3 animSeed(vec3 cell, float t) {
    vec3 s = hash33(cell);
    // Drift at a glacial pace per cell
    float drift = float(int(cell.x * 7.0 + cell.y * 13.0 + cell.z * 17.0));
    s += 0.04 * sin(t * 0.3 + drift * vec3(1.0, 1.3, 0.7));
    return clamp(s, 0.1, 0.9);
  }

  // ── 3D Voronoi ─────────────────────────────────────────────────────────────
  // Returns (d_nearest, d_second_nearest) / cellScale
  // Checks 3×3×3 neighboring cells (27 evaluations) — IQ Worley approach
  vec2 voronoi(vec3 p) {
    vec3 cell  = floor(p);
    vec3 local = fract(p);

    float d1 = 1e9, d2 = 1e9;
    for (int x = -1; x <= 1; x++) {
      for (int y = -1; y <= 1; y++) {
        for (int z = -1; z <= 1; z++) {
          vec3 nb   = vec3(float(x), float(y), float(z));
          vec3 seed = animSeed(cell + nb, uTime);
          vec3 off  = nb + seed - local;
          float d   = dot(off, off); // squared distance (no sqrt yet)
          if (d < d1) { d2 = d1; d1 = d; }
          else if (d < d2) { d2 = d; }
        }
      }
    }
    return vec2(sqrt(d1), sqrt(d2));
  }

  // ── SDF: foam boundary ─────────────────────────────────────────────────────
  // d2 - d1 ≈ 0 at Voronoi cell boundaries → our glowing wall surface
  float foamSdf(vec3 p) {
    vec3 sp = p * uDensity;   // scale to desired cell density
    vec2 v  = voronoi(sp);

    // Audio modulation: 7 standing waves at golden-angle-distributed axes
    float audioMod = 0.0;
    for (int b = 0; b < 7; b++) {
      float fb  = float(b);
      float phi = fb * 2.39996; // golden angle
      float th  = fb * 1.61803;
      vec3  dir = vec3(cos(phi) * sin(th), sin(phi) * sin(th), cos(th));
      float spatFreq = 1.0 + fb * 0.7;
      audioMod += uBands[b] * sin(dot(sp, dir) * spatFreq + uTime * (0.4 + fb * 0.06)) * 0.18;
    }

    // Beat impulse: briefly compresses walls (makes them narrower/sharper)
    float wallShift = uBeatPulse * 0.12;

    return (v.y - v.x) + audioMod - wallShift;
  }

  // ── Normal estimation ──────────────────────────────────────────────────────
  vec3 calcNormal(vec3 p) {
    const float h = 0.003;
    return normalize(vec3(
      foamSdf(p + vec3(h, 0, 0)) - foamSdf(p - vec3(h, 0, 0)),
      foamSdf(p + vec3(0, h, 0)) - foamSdf(p - vec3(0, h, 0)),
      foamSdf(p + vec3(0, 0, h)) - foamSdf(p - vec3(0, 0, h))
    ));
  }

  // ── Ray-march ─────────────────────────────────────────────────────────────
  // Returns t of hit (>0) or negative if no hit
  float march(vec3 ro, vec3 rd) {
    float t   = 0.0;
    float tWall = 0.04;
    for (int i = 0; i < MARCH_STEPS; i++) {
      vec3  p = ro + rd * t;
      float d = foamSdf(p) - tWall;
      float step = clamp(d * 0.45, 0.002, 0.4);
      t += step;
      if (d < 0.0002)  return t;
      if (t > 12.0)    break;
    }
    return -1.0;
  }

  // ── Two-tone palette: warm amber (bass) ↔ cool steel-blue (treble) ─────────
  // The blend is based on spatial position relative to camera, not per-seed.
  vec3 wallColor(vec3 p, vec3 n) {
    // Compute bass vs treble energy balance
    float bass    = (uBands[0] + uBands[1] + uBands[2]) / 3.0;
    float treble  = (uBands[4] + uBands[5] + uBands[6]) / 3.0;
    float balance = clamp(treble / (bass + treble + 0.001), 0.0, 1.0);

    // Warm amber (1.0, 0.62, 0.18) to cool blue-white (0.55, 0.78, 1.0)
    vec3 warmCol = vec3(1.0, 0.62, 0.18);
    vec3 coolCol = vec3(0.55, 0.78, 1.0);
    vec3 baseCol = mix(warmCol, coolCol, balance);

    // World-space shading via two virtual lights
    vec3 lightA  = normalize(vec3(0.6, 0.8, 0.4));    // warm key
    vec3 lightB  = normalize(vec3(-0.5, -0.3, 0.7));   // cool fill

    float diffA  = max(dot(n, lightA), 0.0);
    float diffB  = max(dot(n, lightB), 0.0) * 0.3;

    // Rim light: back-lit effect for translucency feel
    float rim    = 1.0 - abs(dot(n, normalize(-uCamPos)));
    rim = pow(rim, 2.5) * 0.4;

    return baseCol * (0.1 + diffA * 0.65 + diffB + rim);
  }

  // ── Main ───────────────────────────────────────────────────────────────────
  void main() {
    // Camera setup: build ray from orthographic-ish NDC coords
    vec3 ro = uCamPos;
    vec3 target = vec3(0.0);
    vec3 fwd    = normalize(target - ro);
    vec3 right  = normalize(cross(fwd, vec3(0.0, 1.0, 0.0)));
    vec3 up     = cross(right, fwd);

    float fov = 1.0;  // tan(fov/2) ≈ 45°
    vec3 rd = normalize(fwd + (vUv.x * uAspect * fov) * right + (vUv.y * fov) * up);

    float t = march(ro, rd);

    // Background: near-black void with subtle vignette
    float vignette = 1.0 - smoothstep(0.5, 1.4, length(vUv));
    vec3 bg = vec3(0.02, 0.02, 0.03) * vignette;

    if (t < 0.0) {
      gl_FragColor = vec4(bg, 1.0);
      return;
    }

    vec3 p = ro + rd * t;
    vec3 n = calcNormal(p);

    // Foam wall: brightness driven by wall thickness setting + beat
    // Closer to SDF=0 → brighter
    float wallDist = abs(foamSdf(p));
    float wallMask = smoothstep(0.06, 0.0, wallDist);
    float brightness = uWall * 1.8 + uBeatPulse * 0.6;

    vec3 col = wallColor(p, n) * brightness * wallMask;

    // Global luminosity slider: scales overall scene
    col *= (0.6 + uGlow * 1.0);

    // Distance fog: cells in the far field fade into the void
    float fog = exp(-t * 0.18);
    col = mix(bg, col, fog);

    // Subtle glow halo: add a soft ambient of the wall color for glow feel
    col += wallColor(p, n) * uGlow * 0.15 * smoothstep(0.2, 0.0, wallDist);

    gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
  }
`;

// ── Setup ─────────────────────────────────────────────────────────────────────

function setup(): void {
  threeCanvas = document.createElement('canvas');
  threeCanvas.style.cssText =
    'position:fixed;top:0;left:0;width:100%;height:100%;z-index:10;pointer-events:none;display:block';
  document.body.appendChild(threeCanvas);

  const w   = window.innerWidth;
  const h   = window.innerHeight;
  const dpr = isMobile ? 0.6 : Math.min(window.devicePixelRatio, 1.5);

  renderer = new THREE.WebGLRenderer({ canvas: threeCanvas, antialias: false });
  renderer.setSize(w, h);
  renderer.setPixelRatio(dpr);
  renderer.setClearColor(0x000000, 1);

  // Orthographic camera just to host the fullscreen quad
  camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  scene = new THREE.Scene();

  uCamPos = { value: new THREE.Vector3(0, 0, 3) };

  shaderMat = new THREE.ShaderMaterial({
    vertexShader:   VERT,
    fragmentShader: FRAG,
    uniforms: {
      uTime:      uTime,
      uAspect:    uAspect,
      uBands:     uBands,
      uBeatPulse: uBeatPulse,
      uDensity:   uDensity,
      uWall:      uWall,
      uGlow:      uGlow,
      uCamPos:    uCamPos,
    },
  });

  // Fullscreen quad — two triangles covering NDC [-1,1]
  const geo = new THREE.PlaneGeometry(2, 2);
  quadMesh  = new THREE.Mesh(geo, shaderMat);
  scene.add(quadMesh);

  // Unsubscribe from vizMode changes to self-dispose
  vizModeUnsub = store.on('vizModeChange', () => { disposeFoam(); });
}

// ── Camera positioning ────────────────────────────────────────────────────────

function positionCamera(): void {
  const r = 4.5 - store.config.foamGlow * 1.2; // Glow slider also tightens camera
  const x = r * Math.sin(cameraTheta) * Math.cos(cameraPhi);
  const y = r * Math.sin(cameraPhi);
  const z = r * Math.cos(cameraTheta) * Math.cos(cameraPhi);
  uCamPos?.value.set(x, y, z);
}

// ── Draw ──────────────────────────────────────────────────────────────────────

export function drawFoam(_p: unknown, dt: number): void {
  if (!initialized) { setup(); initialized = true; }
  if (!renderer || !scene || !camera || !shaderMat) return;

  time += dt * 0.016667; // convert 60fps dt to seconds
  uTime.value = time;
  uAspect.value = window.innerWidth / window.innerHeight;

  // Read audio data
  const { amps } = getBandAverages(7);
  uBands.value   = amps;

  // Density: structural slider — cell scale 1.2 (large cells) → 4.5 (fine cells)
  uDensity.value = 1.2 + store.config.foamDensity * 3.3;

  // Wall: brightness / thickness of cell boundaries
  uWall.value = 0.2 + store.config.foamWall * 1.0;

  // Glow: luminosity + implicitly affects camera radius (see positionCamera)
  uGlow.value = 0.1 + store.config.foamGlow * 0.9;

  // Beat detection — continuous easing approach (CHOP-style impulse)
  const { state } = store;
  if (state.beatIntervalSec > 0 && state.isPlaying) {
    const pos      = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    const beatIdx  = adjusted >= 0 ? Math.floor(adjusted / state.beatIntervalSec) : -1;
    if (beatIdx > lastBeatIndex) {
      lastBeatIndex = beatIdx;
      beatPulse = 1.0;
    }
  }
  beatPulse      *= Math.pow(0.88, dt);
  uBeatPulse.value = beatPulse;

  // Camera: slow tilted orbit — two simultaneous rotations at different rates
  const speed = 0.00032 + store.config.foamGlow * 0.00015;
  cameraTheta += dt * speed;
  cameraPhi    = 0.4 + Math.sin(time * 0.07) * 0.35; // gentle altitude drift

  positionCamera();

  renderer.render(scene, camera);
}

// ── Reset (on window resize) ──────────────────────────────────────────────────

export function resetFoam(): void {
  if (!initialized) return;
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer?.setSize(w, h);
  uAspect.value = w / h;
}

// ── Dispose (release all GPU resources) ──────────────────────────────────────

export function disposeFoam(): void {
  if (!initialized) return;
  vizModeUnsub?.();
  vizModeUnsub = null;

  (quadMesh?.geometry as THREE.BufferGeometry | undefined)?.dispose();
  shaderMat?.dispose();
  renderer?.dispose();
  threeCanvas?.remove();

  threeCanvas  = null;
  renderer     = null;
  scene        = null;
  camera       = null;
  quadMesh     = null;
  shaderMat    = null;
  uCamPos      = null;

  time          = 0;
  cameraTheta   = 0;
  cameraPhi     = 0.4;
  lastBeatIndex = -1;
  beatPulse     = 0;

  initialized = false;
}
