/**
 * Melt — GLSL SDF raymarching visualization
 * Seven biomorphic forms drift in a darkened void, merging and separating
 * with the music. A single warm sidelight carves Caravaggio shadows across
 * their alabaster surfaces; soft ambient occlusion keeps the mass grounded.
 *
 * Inspired by Anish Kapoor's "Svayambh" (2007, Haus der Kunst Munich /
 * Royal Academy of Arts London) — a self-generating wax mass that slowly
 * moved through museum galleries, depositing itself on walls and doorways —
 * and by Louise Bourgeois's organic latex sculpture "Untitled (with Growth)"
 * (1989, Tate Modern).
 *
 * Technical approach: a single fullscreen quad hosts a ShaderMaterial whose
 * fragment shader raymarches 7 smooth-blended spheres (polynomial smin).
 * All form/depth is born inside the GLSL; Three.js only provides the canvas,
 * renderer, and timing. No geometry subdivision, no post-processing stack —
 * the craft lives in the equations.
 */

import * as THREE from 'three';
import { store } from '../state/store';
import { getBandAverages } from './helpers';
import { audioEngine } from '../audio/engine';
import { isMobile } from '../utils/constants';

// ── Module state ──────────────────────────────────────────────────────────────

let initialized    = false;
let threeCanvas    : HTMLCanvasElement | null = null;
let renderer       : THREE.WebGLRenderer | null = null;
let scene          : THREE.Scene | null = null;
let camera         : THREE.OrthographicCamera | null = null;
let quadMesh       : THREE.Mesh | null = null;
let shaderMat      : THREE.ShaderMaterial | null = null;
let vizModeUnsub   : (() => void) | null = null;

let time         = 0;
let lastBeatIndex = -1;
let beatPulse    = 0;    // decays from 1 → 0 after each beat

// ── Uniforms (mutated each frame) ─────────────────────────────────────────────

const uTime      : THREE.IUniform<number>   = { value: 0.0 };
const uAspect    : THREE.IUniform<number>   = { value: 1.0 };
const uBands     : THREE.IUniform<number[]> = { value: new Array(7).fill(0) };
const uBeatPulse : THREE.IUniform<number>   = { value: 0.0 };
const uMerge     : THREE.IUniform<number>   = { value: 0.5 };   // smin k (smoothness)
const uDrift     : THREE.IUniform<number>   = { value: 0.5 };   // animation speed
const uWarmth    : THREE.IUniform<number>   = { value: 0.5 };   // inner subsurface warmth

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
  uniform float uMerge;
  uniform float uDrift;
  uniform float uWarmth;

  varying vec2 vUv;

  // ── SDF helpers ────────────────────────────────────────────────────────────

  // Polynomial smooth-min (Inigo Quilez).
  // k=0 ≈ hard min; k→large = very blended.
  float smin(float a, float b, float k) {
    if (k < 0.001) return min(a, b);
    float h = max(k - abs(a - b), 0.0) / k;
    return min(a, b) - h * h * k * 0.25;
  }

  // Sphere SDF
  float sdSphere(vec3 p, vec3 c, float r) {
    return length(p - c) - r;
  }

  // ── Scene SDF ─────────────────────────────────────────────────────────────
  //
  // 7 spheres at asymmetric Lissajous-style positions; each drifts on its own
  // orbital loop so none ever sit perfectly radially symmetric.

  float sceneSDF(vec3 p) {
    float spd  = max(uDrift, 0.05);
    float t    = uTime * spd;
    float beat = 1.0 + uBeatPulse * 0.45;

    // Band amplitudes
    float b0 = uBands[0];
    float b1 = uBands[1];
    float b2 = uBands[2];
    float b3 = uBands[3];
    float b4 = uBands[4];
    float b5 = uBands[5];
    float b6 = uBands[6];

    // Sphere centres — distinct frequencies to avoid lockstep
    vec3 c0 = vec3(-0.45 + 0.32 * sin(t * 0.71),
                    0.22 + 0.24 * sin(t * 0.53 + 1.1),
                   -0.12 + 0.20 * cos(t * 0.61 + 2.3));
    vec3 c1 = vec3( 0.52 + 0.26 * cos(t * 0.83 + 1.6),
                    0.00 + 0.30 * sin(t * 0.67 + 0.4),
                    0.24 + 0.22 * cos(t * 0.57 + 3.1));
    vec3 c2 = vec3(-0.10 + 0.30 * sin(t * 0.91 + 2.6),
                   -0.42 + 0.26 * cos(t * 0.73 + 0.9),
                    0.28 + 0.20 * sin(t * 0.79 + 1.4));
    vec3 c3 = vec3( 0.12 + 0.34 * cos(t * 0.63 + 3.2),
                    0.38 + 0.24 * sin(t * 0.77 + 1.7),
                   -0.28 + 0.22 * cos(t * 0.69 + 0.5));
    vec3 c4 = vec3(-0.32 + 0.28 * sin(t * 0.87 + 0.8),
                   -0.18 + 0.30 * cos(t * 0.59 + 2.2),
                   -0.22 + 0.24 * sin(t * 0.65 + 1.9));
    vec3 c5 = vec3( 0.38 + 0.22 * cos(t * 0.97 + 1.2),
                   -0.32 + 0.28 * sin(t * 0.81 + 2.9),
                    0.16 + 0.20 * cos(t * 0.61 + 0.7));
    vec3 c6 = vec3(-0.05 + 0.22 * sin(t * 1.13 + 2.1),
                    0.12 + 0.22 * cos(t * 0.93 + 1.8),
                    0.34 + 0.18 * sin(t * 0.77 + 3.3));

    // Radii: base + audio band + beat pulse
    float r0 = (0.22 + b0 * 0.20) * beat;
    float r1 = (0.21 + b1 * 0.19) * beat;
    float r2 = (0.19 + b2 * 0.17) * beat;
    float r3 = (0.20 + b3 * 0.18) * beat;
    float r4 = (0.18 + b4 * 0.16) * beat;
    float r5 = (0.17 + b5 * 0.15) * beat;
    float r6 = (0.16 + b6 * 0.14) * beat;

    // Blend all 7 spheres with smooth-min
    float k = uMerge * 2.5;   // slider 0→1 maps to k 0→2.5
    float d = sdSphere(p, c0, r0);
    d = smin(d, sdSphere(p, c1, r1), k);
    d = smin(d, sdSphere(p, c2, r2), k);
    d = smin(d, sdSphere(p, c3, r3), k);
    d = smin(d, sdSphere(p, c4, r4), k);
    d = smin(d, sdSphere(p, c5, r5), k);
    d = smin(d, sdSphere(p, c6, r6), k);
    return d;
  }

  // ── Normal via central differences ────────────────────────────────────────

  vec3 calcNormal(vec3 p) {
    const float e = 0.0015;
    return normalize(vec3(
      sceneSDF(p + vec3(e,0,0)) - sceneSDF(p - vec3(e,0,0)),
      sceneSDF(p + vec3(0,e,0)) - sceneSDF(p - vec3(0,e,0)),
      sceneSDF(p + vec3(0,0,e)) - sceneSDF(p - vec3(0,0,e))
    ));
  }

  // ── 5-tap ambient occlusion ───────────────────────────────────────────────

  float calcAO(vec3 p, vec3 n) {
    float occ = 0.0, sca = 1.0;
    for (int i = 0; i < 5; i++) {
      float h  = 0.01 + 0.14 * float(i) * 0.25;
      float d  = sceneSDF(p + h * n);
      occ     += (h - d) * sca;
      sca     *= 0.92;
    }
    return clamp(1.0 - 2.5 * occ, 0.0, 1.0);
  }

  // ── Soft shadow ───────────────────────────────────────────────────────────

  float calcShadow(vec3 ro, vec3 rd, float mint, float tmax) {
    float res = 1.0, t = mint;
    for (int i = 0; i < 20; i++) {
      float h = sceneSDF(ro + rd * t);
      float s = clamp(6.0 * h / t, 0.0, 1.0);
      res = min(res, s * s * (3.0 - 2.0 * s));
      t  += clamp(h, 0.015, 0.25);
      if (res < 0.004 || t > tmax) break;
    }
    return clamp(res, 0.0, 1.0);
  }

  // ── Subsurface warmth color per band ─────────────────────────────────────
  //
  // Each band contributes a tinted warm-amber inner glow.
  // Restrained palette: ivory base, warm amber light, single cool accent.

  vec3 bandGlow() {
    // Weighted mix: sub-bass → deep amber, brilliance → pale gold
    float lo  = (uBands[0] + uBands[1]) * 0.5;
    float mid = (uBands[2] + uBands[3] + uBands[4]) * 0.333;
    float hi  = (uBands[5] + uBands[6]) * 0.5;
    return vec3(1.0, 0.72 + hi * 0.15, 0.38 + lo * 0.20) * (lo * 0.6 + mid * 0.3 + hi * 0.1);
  }

  // ── Main ──────────────────────────────────────────────────────────────────

  void main() {
    // Screen-space UV → [-1, 1], corrected for aspect ratio
    vec2 uv = vUv * 2.0 - 1.0;
    uv.x *= uAspect;

    // Camera: slightly elevated, looking toward origin; slow orbit
    float camAngle = uTime * 0.08 * max(uDrift, 0.05);
    float cosA = cos(camAngle), sinA = sin(camAngle);

    // Eye position orbits on a tilted ellipse — avoids front-on symmetry
    vec3 ro = vec3(cosA * 2.2, 0.55, sinA * 2.2);
    vec3 target = vec3(0.0, -0.05, 0.0);

    // Camera basis
    vec3 fwd  = normalize(target - ro);
    vec3 rgt  = normalize(cross(vec3(0.0, 1.0, 0.0), fwd));
    vec3 up   = cross(fwd, rgt);

    // Ray direction (FOV ~52°)
    vec3 rd = normalize(fwd * 1.5 + uv.x * rgt + uv.y * up);

    // ── Raymarching ───────────────────────────────────────────────────────

    float t = 0.02;
    const float TMAX = 8.0;
    const float SURF = 0.001;
    bool hit = false;

    // Mobile: fewer steps for performance
    int STEPS = 72;

    for (int i = 0; i < 72; i++) {
      if (i >= STEPS) break;
      vec3  p = ro + rd * t;
      float d = sceneSDF(p);
      if (d < SURF * (1.0 + t * 0.2)) { hit = true; break; }
      if (t > TMAX) break;
      t += d;
    }

    // ── Background ────────────────────────────────────────────────────────

    // Dark warm charcoal — not pure black, has faint warmth
    vec3 bgTop = vec3(0.055, 0.048, 0.052);
    vec3 bgBot = vec3(0.035, 0.030, 0.032);
    vec3 col   = mix(bgBot, bgTop, vUv.y);

    // Subtle vignette
    float vig = 1.0 - dot(uv * 0.35, uv * 0.35);
    col *= vig;

    if (hit) {
      vec3  pos = ro + rd * t;
      vec3  nor = calcNormal(pos);
      float ao  = calcAO(pos, nor);

      // Key light: warm sidelight — reminiscent of Caravaggio studio lighting
      vec3 keyDir = normalize(vec3(1.8, 2.2, 1.0));
      float diff  = clamp(dot(nor, keyDir), 0.0, 1.0);
      float sha   = calcShadow(pos + nor * 0.004, keyDir, 0.02, 4.0);

      // Cool fill light from the opposite side — slight blue-grey
      vec3 fillDir = normalize(vec3(-1.0, 0.8, -1.2));
      float fillD  = clamp(dot(nor, fillDir), 0.0, 1.0) * 0.18;

      // Specular (Blinn-Phong)
      vec3  hal  = normalize(keyDir - rd);
      float spec = pow(clamp(dot(nor, hal), 0.0, 1.0), 80.0) * 0.55;

      // Back rim: thin highlight from below-back
      vec3 rimDir = normalize(vec3(-0.8, -1.0, -1.0));
      float rim   = pow(clamp(1.0 - dot(nor, -rd), 0.0, 1.0), 4.0) *
                    clamp(dot(nor, rimDir) + 0.6, 0.0, 1.0) * 0.25;

      // Material: warm alabaster, slight yellow-cream tint
      vec3 baseAlbedo = vec3(0.91, 0.87, 0.80);

      // Subsurface warmth driven by audio bands
      float warmFactor = uWarmth;
      vec3  ssGlow     = bandGlow() * warmFactor * 1.2;

      // Assemble shading
      vec3 ambient = baseAlbedo * 0.12 * ao;
      vec3 diffuse = baseAlbedo * diff * sha * 0.78;
      vec3 fill    = baseAlbedo * fillD * ao;
      vec3 rimCol  = vec3(0.82, 0.86, 0.92) * rim;  // cool blue rim

      col = ambient + diffuse + fill + rimCol
          + vec3(1.0, 0.95, 0.88) * spec   // warm specular highlight
          + ssGlow * ao;                   // audio-reactive inner warmth

      // Beat flash — brief pale overexposure
      col += vec3(1.0, 0.98, 0.92) * uBeatPulse * 0.18;
    }

    // ── Tone-map + gamma ──────────────────────────────────────────────────

    // Simple ACES-like filmic response
    col = col * (col * 2.51 + 0.03) / (col * (col * 2.43 + 0.59) + 0.14);
    col = pow(clamp(col, 0.0, 1.0), vec3(0.4545));

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

  // Use pixel ratio ≤1 on mobile — SDF raymarching is fragment-shader heavy
  const pixelRatio = isMobile ? Math.min(window.devicePixelRatio, 0.75) : Math.min(window.devicePixelRatio, 1.5);

  renderer = new THREE.WebGLRenderer({
    canvas: threeCanvas,
    antialias: false,  // no geometry to anti-alias — MSAA wastes bandwidth
    alpha: false,
  });
  renderer.setSize(w, h);
  renderer.setPixelRatio(pixelRatio);
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;  // gamma done in shader

  // Scene + orthographic camera — just a fullscreen pass
  scene  = new THREE.Scene();
  camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  // Fullscreen quad using a PlaneGeometry (two triangles)
  const geo = new THREE.PlaneGeometry(2, 2);

  uAspect.value = w / h;

  shaderMat = new THREE.ShaderMaterial({
    vertexShader:   VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    uniforms: {
      uTime:      uTime,
      uAspect:    uAspect,
      uBands:     uBands,
      uBeatPulse: uBeatPulse,
      uMerge:     uMerge,
      uDrift:     uDrift,
      uWarmth:    uWarmth,
    },
    depthTest:  false,
    depthWrite: false,
  });

  quadMesh = new THREE.Mesh(geo, shaderMat);
  scene.add(quadMesh);

  // Dispose on viz-mode switch to free GPU resources
  vizModeUnsub = store.on('vizModeChange', () => {
    disposeMelt();
  });

  // Handle window resize
  const onResize = () => {
    const nw = window.innerWidth;
    const nh = window.innerHeight;
    renderer?.setSize(nw, nh);
    uAspect.value = nw / nh;
  };
  window.addEventListener('resize', onResize);
  // Store so dispose can remove it
  (threeCanvas as HTMLCanvasElement & { _resizeHandler?: () => void })._resizeHandler = onResize;

  initialized = true;
}

// ── Draw ──────────────────────────────────────────────────────────────────────

export function drawMelt(_p: unknown, dt: number): void {
  if (!initialized) setup();
  if (!renderer || !scene || !camera || !shaderMat) return;

  time += dt * 0.016;

  const { amps } = getBandAverages(7);
  uBands.value   = amps.slice();
  uTime.value    = time;

  // Config sliders
  const cfg = store.config;
  uMerge.value  = cfg.meltMerge;
  uDrift.value  = cfg.meltDrift;
  uWarmth.value = cfg.meltWarmth;

  // Beat detection
  const { state } = store;
  if (state.beatIntervalSec > 0 && state.isPlaying) {
    const pos     = audioEngine.getPlaybackPosition();
    const beatIdx = pos >= 0 ? Math.floor((pos - state.beatOffset) / state.beatIntervalSec) : -1;
    if (beatIdx > lastBeatIndex) {
      lastBeatIndex = beatIdx;
      beatPulse     = 1.0;
    }
  }

  // Decay beat pulse
  beatPulse   *= Math.pow(0.82, dt);
  uBeatPulse.value = beatPulse;

  renderer.render(scene, camera);
}

// ── Reset ─────────────────────────────────────────────────────────────────────

export function resetMelt(): void {
  if (!initialized) return;
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer?.setSize(w, h);
  uAspect.value = w / h;
}

// ── Dispose ───────────────────────────────────────────────────────────────────

export function disposeMelt(): void {
  if (!initialized) return;

  vizModeUnsub?.();
  vizModeUnsub = null;

  // Remove resize listener
  const handler = (threeCanvas as HTMLCanvasElement & { _resizeHandler?: () => void })?._resizeHandler;
  if (handler) window.removeEventListener('resize', handler);

  // Dispose GPU resources
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

  // Reset animation state
  time          = 0;
  lastBeatIndex = -1;
  beatPulse     = 0;

  initialized = false;
}
