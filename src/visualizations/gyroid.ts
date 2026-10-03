/**
 * Gyroid — raymarched fly-through of a triply-periodic minimal surface
 *
 * The gyroid is a minimal surface discovered by Alan Schoen (1970):
 *   f(x,y,z) = cos(x)sin(y) + cos(y)sin(z) + cos(z)sin(x) = 0
 *
 * It divides all of 3-space into two interlocking labyrinthine channels.
 * This viz positions a camera inside one channel and flies through it
 * continuously. Audio bands warp the gyroid equation's scale and phase,
 * making the tunnels breathe and deform. A thin-film iridescence shader
 * colours the surface by the angle between the surface normal and the view
 * ray — warm on face-on facets, cool shimmer at grazing angles.
 *
 * The three sliders:
 *   Scale  (structural) — gyroid spatial frequency; small = tight lattice,
 *                          large = wide open channels
 *   Warp   (audio) ——— how strongly each freq band deforms the surface
 *   Film   ———————————— thin-film iridescence intensity / brightness
 *
 * Inspired by:
 *   @tdhooper's Shadertoy gyroid explorations (shadertoy.com/user/tdhooper),
 *   Iris van Herpen "Syntopia" 3D-printed gyroid garments (2020),
 *   and Char Davies' immersive VR environments "Osmose" / "Ephémère" (1995–98)
 *   which established the precedent of flying through organic implicit surfaces
 *   as an audio-reactive real-time experience.
 */

import * as THREE from 'three';
import { store } from '../state/store';
import { getBandAverages } from './helpers';
import { isMobile } from '../utils/constants';

// ── Module state ──────────────────────────────────────────────────────────────

let initialized   = false;
let threeCanvas   : HTMLCanvasElement | null = null;
let renderer      : THREE.WebGLRenderer | null = null;
let scene         : THREE.Scene | null = null;
let camera        : THREE.OrthographicCamera | null = null;
let quadMesh      : THREE.Mesh | null = null;
let shaderMat     : THREE.ShaderMaterial | null = null;
let vizModeUnsub  : (() => void) | null = null;

let time      = 0.0;
let beatPulse = 0.0;   // decays after kick transient

// Camera position in gyroid space — advances along a smooth Lissajous path
let camPos = new THREE.Vector3(0.5, 0.8, 0.3);
// Smoothed band array for continuous motion
const smoothedBands = new Float32Array(7);

// ── Uniforms ──────────────────────────────────────────────────────────────────

const uTime      : THREE.IUniform<number>   = { value: 0.0 };
const uAspect    : THREE.IUniform<number>   = { value: 1.0 };
const uBands     : THREE.IUniform<number[]> = { value: new Array(7).fill(0) };
const uBeatPulse : THREE.IUniform<number>   = { value: 0.0 };
const uCamPos    : THREE.IUniform<THREE.Vector3> = { value: new THREE.Vector3() };
const uScale     : THREE.IUniform<number>   = { value: 0.5 };  // gyroid scale slider
const uWarp      : THREE.IUniform<number>   = { value: 0.5 };  // audio warp slider
const uFilm      : THREE.IUniform<number>   = { value: 0.5 };  // thin-film slider

// ── GLSL ──────────────────────────────────────────────────────────────────────

const VERTEX_SHADER = /* glsl */`
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const FRAGMENT_SHADER = /* glsl */`
  precision highp float;

  uniform float uTime;
  uniform float uAspect;
  uniform float uBands[7];
  uniform float uBeatPulse;
  uniform vec3  uCamPos;
  uniform float uScale;
  uniform float uWarp;
  uniform float uFilm;

  varying vec2 vUv;

  // ── Gyroid SDF ─────────────────────────────────────────────────────────────

  // The gyroid surface is the zero set of:
  //   g(p) = cos(px)·sin(py) + cos(py)·sin(pz) + cos(pz)·sin(px)
  //
  // We use it as a signed-distance approximation (not exact) which is good
  // enough for sphere-marching through the tunnels.
  //
  // uScale maps [0,1] → spatial frequency [0.6, 2.4] (in units of the
  // repeating cell). Low scale = large open tunnels. High scale = fine
  // tight lattice.

  float gyroid(vec3 p) {
    return dot(cos(p), sin(p.yzx));
  }

  // Audio-warped gyroid: 7 bands each add a sinusoidal perturbation at a
  // distinct spatial frequency and orientation. This breaks the perfect
  // periodicity and creates organic deformations that track the spectrum.
  float gSDF(vec3 p) {
    // Map scale slider [0,1] → frequency [0.6, 2.4]
    float freq = mix(0.6, 2.4, uScale);
    vec3 q = p * freq;

    // Base gyroid value at this scale
    float g = gyroid(q);

    // Audio warp: each band bends the surface along a different axis
    float warp = uWarp * 0.35;
    if (warp > 0.001) {
      float b0 = uBands[0], b1 = uBands[1], b2 = uBands[2];
      float b3 = uBands[3], b4 = uBands[4], b5 = uBands[5], b6 = uBands[6];

      // Each band perturbs the lookup position at a harmonically related frequency
      q += warp * vec3(
        b0 * sin(q.y * 1.0 + uTime * 0.3),
        b2 * sin(q.z * 1.3 + uTime * 0.4),
        b4 * sin(q.x * 1.7 + uTime * 0.25)
      );
      // Mid-range bands twist the surface
      g += warp * (b1 * gyroid(q * 0.7 + vec3(uTime * 0.2)) * 0.5
                  + b3 * gyroid(q * 1.1 - vec3(uTime * 0.15)) * 0.3
                  + b5 * sin(q.x + q.y + uTime * 0.5) * 0.2
                  + b6 * cos(q.z * 2.0 + uTime * 0.1) * 0.15);
    }

    // Beat pulse briefly swells/contracts the whole surface
    g *= 1.0 + uBeatPulse * 0.15;

    // Return as a surface distance approximation (the gradient |∇g| ≈ freq for
    // a pure gyroid, so dividing by freq gives a Lipschitz-1 estimate)
    return g / max(freq, 0.1);
  }

  // Finite-difference gradient (used for normals and ambient occlusion)
  vec3 gNormal(vec3 p) {
    const float eps = 0.003;
    return normalize(vec3(
      gSDF(p + vec3(eps, 0, 0)) - gSDF(p - vec3(eps, 0, 0)),
      gSDF(p + vec3(0, eps, 0)) - gSDF(p - vec3(0, eps, 0)),
      gSDF(p + vec3(0, 0, eps)) - gSDF(p - vec3(0, 0, eps))
    ));
  }

  // ── Thin-film iridescence ──────────────────────────────────────────────────
  //
  // Optical thin-film interference: the reflected colour depends on the
  // film thickness (here = view-angle proxy via dot(N,V)) and the film
  // refractive index. We approximate the full Airy function with three
  // sinusoids at RGB wavelengths (450/550/680 nm).
  //
  // uFilm maps [0,1] → film thickness [0.5, 3.5] (in wavelengths).

  vec3 thinFilm(float cosTheta, float filmSlider) {
    float thickness = mix(0.5, 3.5, filmSlider);
    float phase = 2.0 * 3.14159 * thickness * cosTheta;
    // Shift each channel by its wavelength ratio (red/green/blue ≈ 1.0/0.81/0.66)
    float r = 0.5 + 0.5 * cos(phase * 1.00);
    float g = 0.5 + 0.5 * cos(phase * 0.81 + 1.0);
    float b = 0.5 + 0.5 * cos(phase * 0.66 + 2.0);
    return vec3(r, g, b);
  }

  // ── Raymarching ────────────────────────────────────────────────────────────

  // We march a sphere-tracing loop. Because the gyroid SDF is only an
  // approximation, we use a conservative step fraction (0.55) to avoid
  // over-stepping through thin walls.
  const int MAX_STEPS = 96;
  const float MAX_DIST = 20.0;
  const float SURF_DIST = 0.004;

  vec2 raymarch(vec3 ro, vec3 rd) {
    float t = 0.01;
    for (int i = 0; i < MAX_STEPS; i++) {
      vec3 p = ro + rd * t;
      float d = abs(gSDF(p));  // abs() so we can march from inside
      if (d < SURF_DIST) return vec2(t, float(i));
      t += d * 0.55;
      if (t > MAX_DIST) break;
    }
    return vec2(-1.0, float(MAX_STEPS));
  }

  // Simple ambient occlusion: sample the SDF at several distances along the
  // surface normal and look for nearby geometry.
  float ao(vec3 p, vec3 n) {
    float occ = 0.0;
    float weight = 1.0;
    for (int i = 1; i <= 5; i++) {
      float dist = float(i) * 0.08;
      occ += weight * (dist - abs(gSDF(p + n * dist)));
      weight *= 0.5;
    }
    return clamp(1.0 - occ * 2.5, 0.0, 1.0);
  }

  // ── Camera ─────────────────────────────────────────────────────────────────
  //
  // Build a camera matrix from a position (uCamPos, driven by JS) and a
  // look-ahead direction derived from the surface gradient — so the camera
  // stays pointed into the tunnel.

  mat3 camMatrix(vec3 ro, vec3 forward) {
    vec3 up = vec3(sin(uTime * 0.07), 1.0, cos(uTime * 0.05));
    vec3 right = normalize(cross(forward, up));
    up = cross(right, forward);
    return mat3(right, up, forward);
  }

  // ── Main ───────────────────────────────────────────────────────────────────

  void main() {
    vec2 uv = vUv * 2.0 - 1.0;
    uv.x *= uAspect;

    // Camera
    vec3 ro = uCamPos;
    // Compute a "forward" direction that keeps us moving along the channel.
    // We nudge ro slightly along a smooth Lissajous path (done in JS), and
    // use the tangent of the path as forward here.
    float t = uTime;
    vec3 forward = normalize(vec3(
      cos(t * 0.13) * 0.7 + cos(t * 0.31) * 0.3,
      sin(t * 0.19) * 0.5 + sin(t * 0.17) * 0.5,
      cos(t * 0.07) * 0.6 + sin(t * 0.41) * 0.4
    ));

    mat3 cam = camMatrix(ro, forward);
    float fov = 0.85 + uBands[1] * 0.08 + uBeatPulse * 0.04;
    vec3 rd = cam * normalize(vec3(uv, fov));

    // March
    vec2 res = raymarch(ro, rd);
    float hitDist = res.x;

    vec3 col;
    if (hitDist < 0.0) {
      // Miss — deep background with subtle vignette
      float vig = 1.0 - length(uv) * 0.4;
      col = vec3(0.01, 0.01, 0.015) * vig;
    } else {
      vec3 p = ro + rd * hitDist;
      vec3 n = gNormal(p);

      // Signed gyroid value tells us which side of the surface we are —
      // ensure normal points toward the camera.
      float gVal = gSDF(p);
      if (dot(n, rd) > 0.0) n = -n;

      float NdotV = max(dot(n, -rd), 0.0);
      float NdotL = max(dot(n, normalize(vec3(0.4, 0.7, -0.3))), 0.0);

      // ── Thin-film iridescent colour ──────────────────────────────────────
      // Primary: iridescence based on view angle (angle of incidence)
      vec3 irid = thinFilm(NdotV, uFilm);

      // Secondary: desaturate toward warm white at face-on facets
      float facing = pow(1.0 - NdotV, 3.0);
      vec3 faceCol = vec3(0.95, 0.92, 0.88);  // warm white
      vec3 baseCol = mix(irid, faceCol, 0.5 - facing * 0.3);

      // ── Lighting ──────────────────────────────────────────────────────────
      // Key: soft directional from upper-right, warm tone
      vec3 keyLight = vec3(1.0, 0.95, 0.85) * NdotL * 0.7;
      // Rim: cool blue from opposite side
      float NdotRim = max(dot(n, normalize(vec3(-0.5, -0.2, 0.7))), 0.0);
      vec3 rimLight = vec3(0.3, 0.5, 0.8) * pow(NdotRim, 3.0) * 0.5;
      // Ambient: dark teal-grey
      vec3 ambLight = vec3(0.04, 0.06, 0.07);

      // Ambient occlusion (expensive but beautiful)
      float occ = ao(p, n);

      col = baseCol * (keyLight + rimLight + ambLight) * occ;

      // Subsurface-scatter proxy: thin walls near the surface let more light
      // through. The abs(gSDF) value from nearby surfaces gives wall thickness.
      float thin = 1.0 - clamp(hitDist * 0.08, 0.0, 1.0);
      col += vec3(0.1, 0.15, 0.2) * thin * 0.3;

      // Specular: Blinn-Phong highlight, bright white
      vec3 halfVec = normalize(-rd + normalize(vec3(0.4, 0.7, -0.3)));
      float spec = pow(max(dot(n, halfVec), 0.0), 64.0);
      col += vec3(1.0, 0.98, 0.95) * spec * 0.8;

      // Distance fog into the tunnel — keeps depth legible
      float fog = exp(-hitDist * 0.18);
      col = mix(vec3(0.01, 0.01, 0.015), col, fog);

      // Beat flash: brief warm-white overlay
      col += vec3(0.3, 0.25, 0.2) * uBeatPulse * 0.25 * fog;
    }

    // Vignette
    col *= 1.0 - 0.35 * dot(uv * 0.7, uv * 0.7);

    // Subtle film grain
    float grain = fract(sin(dot(vUv + uTime * 0.01, vec2(127.1, 311.7))) * 43758.5);
    col += (grain - 0.5) * 0.012;

    // Tone map: ACES approx
    col = col * (2.51 * col + 0.03) / (col * (2.43 * col + 0.59) + 0.14);
    col = clamp(col, 0.0, 1.0);
    col = pow(col, vec3(1.0 / 2.2));  // gamma

    gl_FragColor = vec4(col, 1.0);
  }
`;

// ── Setup ─────────────────────────────────────────────────────────────────────

function setup(): void {
  threeCanvas = document.createElement('canvas');
  threeCanvas.style.cssText =
    'position:fixed;top:0;left:0;width:100%;height:100%;z-index:10;pointer-events:none;display:block';
  document.body.appendChild(threeCanvas);

  renderer = new THREE.WebGLRenderer({
    canvas: threeCanvas,
    antialias: false,  // not needed for raymarching
    alpha: false,
  });
  const pr = isMobile ? 1.0 : Math.min(window.devicePixelRatio, 1.5);
  renderer.setPixelRatio(pr);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;

  scene = new THREE.Scene();
  camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  const geo = new THREE.PlaneGeometry(2, 2);
  shaderMat = new THREE.ShaderMaterial({
    uniforms: {
      uTime:      uTime,
      uAspect:    uAspect,
      uBands:     uBands,
      uBeatPulse: uBeatPulse,
      uCamPos:    uCamPos,
      uScale:     uScale,
      uWarp:      uWarp,
      uFilm:      uFilm,
    },
    vertexShader:   VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    depthWrite: false,
    depthTest:  false,
  });

  quadMesh = new THREE.Mesh(geo, shaderMat);
  scene.add(quadMesh);

  uAspect.value = window.innerWidth / window.innerHeight;

  vizModeUnsub = store.on('vizModeChange', () => {
    // nothing to reset structurally
  });

  initialized = true;
}

// ── Draw ──────────────────────────────────────────────────────────────────────

export function drawGyroid(_p: unknown, dt: number): void {
  if (!initialized) setup();

  const { amps, transients } = getBandAverages(7);
  const cfg = store.config;

  // Beat detection via transients (kick + sub-bass)
  const rawT = Math.max(transients[0] ?? 1, transients[1] ?? 1) - 1.0;
  if (rawT > 0.4) {
    beatPulse = Math.min(beatPulse + rawT * 0.6, 1.0);
  }
  beatPulse *= Math.pow(0.90, dt);

  // Smooth bands for continuous uniforms
  const kUp = 0.25, kDown = 0.12;
  for (let i = 0; i < 7; i++) {
    const a = amps[i] ?? 0;
    const k = a > smoothedBands[i] ? kUp : kDown;
    smoothedBands[i] += (a - smoothedBands[i]) * k * dt;
    uBands.value[i] = smoothedBands[i];
  }

  // Advance camera along a smooth 3D Lissajous path inside the gyroid tunnels.
  // The path is parameterized by time — the gyroid's interior channels follow
  // this class of curves naturally. We move slowly enough that the marcher
  // always starts inside a channel, and fast enough to feel like flight.
  const speed = 0.018 * dt;
  const t = time;
  // Lissajous with incommensurable frequencies: never repeats exactly
  const newCam = new THREE.Vector3(
    0.5 + Math.sin(t * 0.11) * 2.8 + Math.cos(t * 0.23) * 1.2,
    0.8 + Math.cos(t * 0.13) * 2.4 + Math.sin(t * 0.19) * 1.5,
    0.3 + Math.sin(t * 0.07) * 3.1 + Math.cos(t * 0.17) * 1.8
  );
  camPos.lerp(newCam, speed * 0.6);
  uCamPos.value.copy(camPos);

  // Slider uniforms
  uScale.value = cfg.gyroidScale ?? 0.5;
  uWarp.value  = cfg.gyroidWarp  ?? 0.5;
  uFilm.value  = cfg.gyroidFilm  ?? 0.5;

  // Beat adds a brief forward surge
  const bassAmp = amps[1] ?? 0;
  time += 0.016 * dt * (1.0 + bassAmp * 0.6 + beatPulse * 0.3);

  uTime.value = time;
  uBeatPulse.value = beatPulse;

  renderer!.render(scene!, camera!);
}

// ── Reset (resize) ────────────────────────────────────────────────────────────

export function resetGyroid(): void {
  if (!initialized) return;
  const w = window.innerWidth, h = window.innerHeight;
  renderer?.setSize(w, h);
  uAspect.value = w / h;
}

// ── Dispose ───────────────────────────────────────────────────────────────────

export function disposeGyroid(): void {
  if (!initialized) return;
  vizModeUnsub?.();
  vizModeUnsub = null;
  (quadMesh?.geometry as THREE.BufferGeometry | undefined)?.dispose();
  shaderMat?.dispose();
  renderer?.dispose();
  threeCanvas?.remove();
  threeCanvas = null;
  renderer = null;
  scene = null;
  camera = null;
  quadMesh = null;
  shaderMat = null;
  time = 0;
  beatPulse = 0;
  smoothedBands.fill(0);
  camPos.set(0.5, 0.8, 0.3);
  initialized = false;
}
