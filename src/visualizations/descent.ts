/**
 * Descent — GLSL Mandelbox fractal fly-through
 *
 * A first-person camera descends continuously into the interior of a
 * Mandelbox IFS fractal — an infinite recursive crystal lattice of
 * box-folded space, lit by a restrained two-light studio rig.
 * Audio bands warp the fold and scale parameters of the IFS, making
 * the crystal chambers breathe and twist with the music.  The camera
 * path gently sways (continuous, not beat-locked) to avoid mechanical
 * forward motion; a beat impulse adds a brief speed surge.
 *
 * Inspired by Knighty's Mandelbox explorations on Shadertoy and the
 * demoscene tradition of mathematical tunnel productions, specifically
 * Conspiracy's "Lemon" (Revision 2023) and Inigo Quilez's domain-
 * repetition distance fields (https://iquilezles.org/articles/menger/).
 *
 * Palette: near-monochrome — deep indigo-black void, cool bone-white
 * crystal surfaces lit by warm key + cool fill, no rainbow, no neon.
 *
 * Sliders
 *   Depth  — fold iterations 3–6 (structural: fewer = fast/loose,
 *             more = intricate/expensive geometry)
 *   Warp   — audio deformation strength (0 = static crystal,
 *             1 = music fully controls the lattice geometry)
 *   Speed  — camera flight velocity
 */
import * as THREE from 'three';
import { store }         from '../state/store';
import { getBandAverages } from './helpers';
import { audioEngine }   from '../audio/engine';
import { isMobile }      from '../utils/constants';

// ── Module state ──────────────────────────────────────────────────────────────

let initialized   = false;
let threeCanvas   : HTMLCanvasElement | null = null;
let renderer      : THREE.WebGLRenderer | null = null;
let scene         : THREE.Scene | null = null;
let camera        : THREE.OrthographicCamera | null = null;
let quadMesh      : THREE.Mesh | null = null;
let shaderMat     : THREE.ShaderMaterial | null = null;
let vizModeUnsub  : (() => void) | null = null;
let resizeHandler : (() => void) | null = null;

let time          = 0;
let flightZ       = 0;      // accumulated z-travel
let camVelZ       = 0;      // extra speed kick from beat
let lastBeatIndex = -1;
let beatPulse     = 0;      // 1 → 0 after each beat

// ── Uniforms ──────────────────────────────────────────────────────────────────

const uTime      : THREE.IUniform<number>   = { value: 0.0 };
const uAspect    : THREE.IUniform<number>   = { value: 1.0 };
const uBands     : THREE.IUniform<number[]> = { value: new Array(7).fill(0) };
const uBeatFlash : THREE.IUniform<number>   = { value: 0.0 };
const uFlightZ   : THREE.IUniform<number>   = { value: 0.0 };
const uDepth     : THREE.IUniform<number>   = { value: 0.6 };
const uWarp      : THREE.IUniform<number>   = { value: 0.5 };
const uSpeed     : THREE.IUniform<number>   = { value: 0.4 };
const uMobile    : THREE.IUniform<number>   = { value: isMobile ? 1.0 : 0.0 };

// ── GLSL shaders ──────────────────────────────────────────────────────────────

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
  uniform float uBeatFlash;
  uniform float uFlightZ;
  uniform float uDepth;
  uniform float uWarp;
  uniform float uSpeed;
  uniform float uMobile;

  varying vec2 vUv;

  // ── Mandelbox distance estimator ────────────────────────────────────────────
  //
  // Box fold + sphere fold IFS, after Tglad / Knighty's Mandelbox.
  // scale ≈ -2 gives an infinite network of cubic tunnels and halls
  // that the camera can fly through indefinitely.

  float DE(vec3 p, float fold, float scale, int iters) {
    vec3 z    = p;
    float dr  = 1.0;

    for (int i = 0; i < 6; i++) {
      if (i >= iters) break;

      // Box fold: reflect components outside [-fold, fold]
      z = clamp(z, -fold, fold) * 2.0 - z;

      // Sphere fold: magnify if inside minR, invert if inside fixedR
      float r2 = dot(z, z);
      if (r2 < 0.25) {          // minR = 0.5  →  minR² = 0.25
        z  *= 4.0;
        dr *= 4.0;
      } else if (r2 < 1.0) {    // fixedR = 1.0  →  fixedR² = 1.0
        float t = 1.0 / r2;
        z  *= t;
        dr *= t;
      }

      // Scale & translate back to seed point
      z  = scale * z + p;
      dr = abs(scale) * dr + 1.0;
    }

    return length(z) / abs(dr);
  }

  // ── Gradient normal (tetrahedron technique, Inigo Quilez) ───────────────────

  vec3 calcNormal(vec3 p, float fold, float scale, int iters) {
    const float eps = 0.0025;
    vec2 e = vec2(1.0, -1.0);
    return normalize(
      e.xyy * DE(p + e.xyy * eps, fold, scale, iters) +
      e.yyx * DE(p + e.yyx * eps, fold, scale, iters) +
      e.yxy * DE(p + e.yxy * eps, fold, scale, iters) +
      e.xxx * DE(p + e.xxx * eps, fold, scale, iters)
    );
  }

  // ── Primary raymarcher ──────────────────────────────────────────────────────

  const float SURF = 0.004;
  const float TMAX = 18.0;
  const int   MSTEPS_DESK = 80;
  const int   MSTEPS_MOB  = 48;

  vec3 march(vec3 ro, vec3 rd, float fold, float scale, int iters) {
    float t     = 0.01;
    int   steps = 0;
    bool  hit   = false;
    int maxS = (uMobile > 0.5) ? MSTEPS_MOB : MSTEPS_DESK;

    for (int i = 0; i < MSTEPS_DESK; i++) {
      if (i >= maxS) break;
      float d = DE(ro + rd * t, fold, scale, iters);
      if (d < SURF) { hit = true; break; }
      if (t > TMAX) break;
      t += max(d * 0.9, 0.0008);
      steps++;
    }

    // ── Palette ─────────────────────────────────────────────────────────────

    // Background: deep indigo-black (no pure black — has faint blue warmth)
    vec3 bgFar  = vec3(0.016, 0.018, 0.035);
    vec3 bgNear = vec3(0.025, 0.030, 0.055);
    vec3 col    = mix(bgNear, bgFar, smoothstep(0.0, TMAX, t));

    if (hit) {
      vec3  pos = ro + rd * t;
      vec3  nor = calcNormal(pos, fold, scale, iters);

      // Key light: warm, slightly above and to the right
      vec3  keyDir = normalize(vec3(1.4, 2.2, 0.6));
      float diff   = clamp(dot(nor, keyDir), 0.0, 1.0);
      float sha    = 1.0; // no shadow march — too expensive in a fractal

      // Cool fill from opposite side
      vec3  fillDir = normalize(vec3(-1.2, 0.4, -0.8));
      float fill    = clamp(dot(nor, fillDir), 0.0, 1.0) * 0.22;

      // Blinn-Phong specular
      vec3  hal  = normalize(keyDir - rd);
      float spec = pow(clamp(dot(nor, hal), 0.0, 1.0), 60.0) * 0.55;

      // Material: bone-white / cool grey  —  slightly warmed by sub-bass
      float bassW  = (uBands[0] * 0.5 + uBands[1] * 0.3) * uWarp;
      vec3  albedo = mix(vec3(0.78, 0.80, 0.88), vec3(0.88, 0.84, 0.76), bassW);

      // Ambient occlusion proxy: fewer steps = open space = brighter
      float ao = clamp(1.0 - float(steps) / float(maxS), 0.0, 1.0);
      ao = pow(ao, 1.6) * 0.9 + 0.1;

      // Assemble
      col  = albedo * (diff * sha * 0.75 + fill + 0.06 * ao);
      col += vec3(0.96, 0.96, 1.00) * spec;

      // Interior glow on edges: where AO is low, hint of deep blue
      col += vec3(0.06, 0.10, 0.22) * (1.0 - ao) * 0.5;

      // Depth fog
      float fog = exp(-t * 0.13);
      col = mix(bgFar, col, fog);

      // Beat flash
      col += vec3(0.82, 0.86, 0.95) * uBeatFlash * 0.22;
    }

    // ── Vignette ─────────────────────────────────────────────────────────────

    vec2 uv = vUv - 0.5;
    float vig = 1.0 - dot(uv, uv) * 2.2;
    col *= clamp(vig, 0.0, 1.0);

    // ── Simple filmic tone-map + gamma ────────────────────────────────────────

    col = col / (col + vec3(0.5));          // mild S-curve
    col = pow(max(col, vec3(0.0)), vec3(0.4545));

    return col;
  }

  // ── Entry point ──────────────────────────────────────────────────────────────

  void main() {
    vec2 uv = (vUv - 0.5) * 2.0;
    uv.x *= uAspect;

    // ── Audio parameters ────────────────────────────────────────────────────

    float bassAvg = (uBands[0] * 0.6 + uBands[1] * 0.4);
    float midAvg  = (uBands[2] * 0.4 + uBands[3] * 0.4 + uBands[4] * 0.2);

    // Fold limit: bass makes the box chambers open and close
    float fold  = 1.0 + (bassAvg - 0.5) * 0.25 * uWarp;
    fold = clamp(fold, 0.75, 1.35);

    // Scale: near -2.0 for tunnel geometry; mid nudges it slightly
    float scale = -2.0 + midAvg * 0.25 * uWarp;
    scale = clamp(scale, -2.45, -1.65);

    // Iteration count: Depth slider (structural)
    int iters = int(mix(3.0, 6.0, uDepth));
    // One extra on desktop for detail
    if (uMobile < 0.5) iters = min(iters + 1, 6);

    // ── Camera path ─────────────────────────────────────────────────────────
    //
    // Flies forward along Z, with gentle Lissajous-style sway in XY.
    // The sway is based on time (continuous), not beat-locked.
    // Beat impulse is captured in uFlightZ's rate of change (handled CPU-side).

    float sX = sin(uTime * 0.071 + 1.3) * 1.6
             + sin(uTime * 0.031 + 0.5) * 0.8;
    float sY = cos(uTime * 0.053 + 0.7) * 1.1
             + cos(uTime * 0.019 + 2.1) * 0.5;

    // Subtle audio-driven micro-sway for "breathing" feel
    sX += uBands[2] * 0.18 * uWarp;
    sY += uBands[3] * 0.14 * uWarp;

    vec3 ro = vec3(sX, sY, uFlightZ);

    // Look slightly ahead on the path to get a natural forward lean
    float fwdT  = 0.5;
    float sXf   = sin((uTime + fwdT) * 0.071 + 1.3) * 1.6
                + sin((uTime + fwdT) * 0.031 + 0.5) * 0.8;
    float sYf   = cos((uTime + fwdT) * 0.053 + 0.7) * 1.1
                + cos((uTime + fwdT) * 0.019 + 2.1) * 0.5;
    vec3  target = vec3(sXf, sYf, uFlightZ + 2.0);

    vec3 ww = normalize(target - ro);
    vec3 uu = normalize(cross(ww, vec3(0.0, 1.0, 0.0)));
    vec3 vv = cross(uu, ww);

    vec3 rd = normalize(uv.x * uu + uv.y * vv + 1.75 * ww);

    // ── March & output ───────────────────────────────────────────────────────

    vec3 col = march(ro, rd, fold, scale, iters);
    gl_FragColor = vec4(col, 1.0);
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

  // SDF raymarching is fragment-shader bound — lower pixel ratio on mobile
  const pr = isMobile
    ? Math.min(window.devicePixelRatio, 0.6)
    : Math.min(window.devicePixelRatio, 1.5);

  renderer = new THREE.WebGLRenderer({
    canvas:    threeCanvas,
    antialias: false,
    alpha:     false,
  });
  renderer.setSize(w, h);
  renderer.setPixelRatio(pr);
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace; // gamma in shader

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
      uFlightZ:   uFlightZ,
      uDepth:     uDepth,
      uWarp:      uWarp,
      uSpeed:     uSpeed,
      uMobile:    uMobile,
    },
    depthTest:  false,
    depthWrite: false,
  });

  quadMesh = new THREE.Mesh(geo, shaderMat);
  scene.add(quadMesh);

  // Dispose on viz switch
  vizModeUnsub = store.on('vizModeChange', () => {
    disposeDescent();
  });

  // Handle resize
  resizeHandler = () => {
    const nw = window.innerWidth;
    const nh = window.innerHeight;
    renderer?.setSize(nw, nh);
    uAspect.value = nw / nh;
  };
  window.addEventListener('resize', resizeHandler);

  initialized = true;
}

// ── Draw ──────────────────────────────────────────────────────────────────────

export function drawDescent(_p: unknown, dt: number): void {
  if (!initialized) setup();
  if (!renderer || !scene || !camera || !shaderMat) return;

  // dt is normalised so that 1.0 == one 60fps frame
  const dt_s = dt * (1 / 60);

  time += dt * 0.016;

  // Config
  const cfg      = store.config;
  uDepth.value   = cfg.descentDepth;
  uWarp.value    = cfg.descentWarp;
  uSpeed.value   = cfg.descentSpeed;

  // Flight: base speed from slider, plus beat-kick velocity
  const baseSpeed = 0.06 + cfg.descentSpeed * 0.45;
  const { state } = store;

  if (state.beatIntervalSec > 0 && state.isPlaying) {
    const pos     = audioEngine.getPlaybackPosition();
    const beatIdx = pos >= 0 ? Math.floor((pos - state.beatOffset) / state.beatIntervalSec) : -1;
    if (beatIdx > lastBeatIndex) {
      lastBeatIndex = beatIdx;
      beatPulse = 1.0;
      camVelZ   = baseSpeed * 3.5;  // sharp speed kick on beat
    }
  }

  // Decay beat-driven velocity (snappy attack, medium release)
  camVelZ   *= Math.pow(0.72, dt);
  beatPulse *= Math.pow(0.78, dt);

  flightZ += (baseSpeed + camVelZ) * dt_s;

  uTime.value      = time;
  uFlightZ.value   = flightZ;
  uBeatFlash.value = beatPulse;

  // Band amplitudes
  const { amps } = getBandAverages(7);
  uBands.value    = amps.slice();

  renderer.render(scene, camera);
}

// ── Reset ─────────────────────────────────────────────────────────────────────

export function resetDescent(): void {
  if (!initialized) return;
  renderer?.setSize(window.innerWidth, window.innerHeight);
  uAspect.value = window.innerWidth / window.innerHeight;
}

// ── Dispose ───────────────────────────────────────────────────────────────────

export function disposeDescent(): void {
  if (!initialized) return;

  vizModeUnsub?.();
  vizModeUnsub = null;

  if (resizeHandler) {
    window.removeEventListener('resize', resizeHandler);
    resizeHandler = null;
  }

  quadMesh?.geometry.dispose();
  shaderMat?.dispose();
  scene?.clear();
  renderer?.dispose();
  threeCanvas?.remove();

  threeCanvas  = null;
  renderer     = null;
  scene        = null;
  camera       = null;
  quadMesh     = null;
  shaderMat    = null;

  time          = 0;
  flightZ       = 0;
  camVelZ       = 0;
  lastBeatIndex = -1;
  beatPulse     = 0;

  initialized = false;
}
