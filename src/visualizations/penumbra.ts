/**
 * Penumbra — GLSL raymarched sculpture-and-shadow installation.
 *
 * Seven abstract SDF forms (a blend of sphere, box and torus whose character
 * shifts by band index) drift in a slow orbit above a matte stone floor.
 * A single warm overhead key light rakes across the surfaces and casts
 * soft penumbra shadows on the floor below each form; amplitude drives
 * each form's size, so loud passages raise large round silhouettes while
 * silence shrinks the shapes to faint specks.  The whole camera drifts in
 * a slow downward-tilting orbit so both the forms and their shadows are
 * readable in the same frame.
 *
 * The visual language owes to:
 *   - Christian Boltanski "Reserve: Detective III" (1987) — enlarged shadows
 *     of found objects becoming eerie presences on the gallery wall.
 *   - Anish Kapoor "Adam" (1988–89) — irregular stone forms grouped on a
 *     floor, drama entirely from directional light and cast shadow.
 *   - Ryoji Ikeda "test pattern [nº1]" (2008, YCAM,
 *     https://special.ycam.jp/datamatics/en/testpattern.html) — extreme
 *     tonal contrast, high data density, no decorative colour.
 *
 * Technique: fullscreen ShaderMaterial quad; camera matrix sent as vec3
 * uniforms from JS; sphere-march against a 7-form + floor SDF; penumbra
 * shadow term via Inigo Quilez's soft-shadow formula; ambient occlusion
 * via 5-sample cone march.  No rainbow palette, no additive neon glow —
 * near-monochrome warm stone / cool shadow.
 */

import * as THREE from 'three';
import { store } from '../state/store';
import { getBandAverages } from './helpers';
import { audioEngine } from '../audio/engine';
import { isMobile } from '../utils/constants';

// ── Module state ──────────────────────────────────────────────────────────────

let initialized     = false;
let threeCanvas     : HTMLCanvasElement | null = null;
let renderer        : THREE.WebGLRenderer | null = null;
let scene           : THREE.Scene | null = null;
let orthoCamera     : THREE.OrthographicCamera | null = null;
let quadMesh        : THREE.Mesh | null = null;
let shaderMat       : THREE.ShaderMaterial | null = null;
let vizModeUnsub    : (() => void) | null = null;

let time            = 0;
let camTheta        = 0;      // slow horizontal orbit
let lastBeatIndex   = -1;
let beatKick        = 0;      // decays 0→1 impulse

const smoothedBands = new Float32Array(7);

// ── Uniforms ──────────────────────────────────────────────────────────────────

const uTime          : THREE.IUniform<number>        = { value: 0 };
const uAspect        : THREE.IUniform<number>        = { value: 1 };
const uBands         : THREE.IUniform<number[]>      = { value: new Array(7).fill(0) };
const uBeatKick      : THREE.IUniform<number>        = { value: 0 };
const uCamPos        : THREE.IUniform<THREE.Vector3> = { value: new THREE.Vector3() };
const uCamFwd        : THREE.IUniform<THREE.Vector3> = { value: new THREE.Vector3() };
const uCamRight      : THREE.IUniform<THREE.Vector3> = { value: new THREE.Vector3() };
const uCamUp         : THREE.IUniform<THREE.Vector3> = { value: new THREE.Vector3() };
const uForms         : THREE.IUniform<number>        = { value: 7 };
const uSoftness      : THREE.IUniform<number>        = { value: 0.5 };
const uDrift         : THREE.IUniform<number>        = { value: 0.3 };
const uWarmth        : THREE.IUniform<number>        = { value: 0.6 };

// ── GLSL ──────────────────────────────────────────────────────────────────────

const VERT = /* glsl */`
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

function buildFrag(maxSteps: number, shadowSteps: number): string { return /* glsl */`
  precision highp float;

  uniform float     uTime;
  uniform float     uAspect;
  uniform float     uBands[7];
  uniform float     uBeatKick;
  uniform vec3      uCamPos;
  uniform vec3      uCamFwd;
  uniform vec3      uCamRight;
  uniform vec3      uCamUp;
  uniform float     uForms;    // 1–7 active shapes
  uniform float     uSoftness; // 0=hard shadow, 1=very soft
  uniform float     uDrift;    // orbital speed
  uniform float     uWarmth;   // 0=cool, 1=warm amber

  varying vec2 vUv;

  #define PI  3.14159265359
  #define TAU 6.28318530718
  #define MAX_DIST 60.0
  #define SURF_EPS 0.002

  // ── Primitive SDFs ────────────────────────────────────────────────────────

  float sdSphere(vec3 p, float r) {
    return length(p) - r;
  }

  float sdBox(vec3 p, vec3 b) {
    vec3 q = abs(p) - b;
    return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0);
  }

  float sdTorus(vec3 p, float R, float r) {
    return length(vec2(length(p.xz) - R, p.y)) - r;
  }

  float sdCapsule(vec3 p, float h, float r) {
    p.y -= clamp(p.y, 0.0, h);
    return length(p) - r;
  }

  float smin(float a, float b, float k) {
    float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
    return mix(b, a, h) - k * h * (1.0 - h);
  }

  // ── Per-form SDF ──────────────────────────────────────────────────────────
  // band 0→sphere  band 2→capsule  band 4→torus  band 6→box
  // intermediate bands smoothly blend between adjacent shapes

  float formSDF(vec3 p, int idx) {
    float t       = float(idx) / 6.0;            // 0..1 across bands
    float amp     = uBands[idx];
    float r       = 0.25 + amp * 0.55;           // radius 0.25..0.80
    float beatR   = r + uBeatKick * 0.18;

    // Four canonical shapes
    float sphere  = sdSphere(p, beatR);
    float box     = sdBox(p, vec3(beatR * 0.82));
    float capsule = sdCapsule(p, beatR * 1.4, beatR * 0.55);
    float torus   = sdTorus(p, beatR * 0.9, beatR * 0.28);

    // Blend by t: 0=sphere, 0.33=capsule, 0.67=torus, 1.0=box
    float s1 = mix(sphere,  capsule, smoothstep(0.0, 0.33, t));
    float s2 = mix(capsule, torus,   smoothstep(0.33, 0.67, t));
    float s3 = mix(torus,   box,     smoothstep(0.67, 1.0,  t));
    return mix(s1, mix(s2, s3, smoothstep(0.33, 1.0, t)), smoothstep(0.0, 0.67, t));
  }

  // ── Scene SDF ─────────────────────────────────────────────────────────────

  float sceneSDF(vec3 p) {
    // Floor at y = 0
    float d = p.y;

    int count = int(clamp(uForms, 1.0, 7.0));

    for (int i = 0; i < 7; i++) {
      if (i >= count) break;

      float fi    = float(i);
      float phase = fi * TAU / 7.0 + uTime * uDrift * 0.4;
      float orb   = 2.2 + fi * 0.12;            // slight radial spread

      // Gentle Y bob at slightly different frequencies
      float yBase = 1.3 + fi * 0.1 + uBands[i] * 1.4;
      float yBob  = 0.18 * sin(uTime * (0.7 + fi * 0.11) + fi);

      vec3 center = vec3(orb * cos(phase),
                         yBase + yBob,
                         orb * sin(phase));

      // Slow self-rotation — different axis per form
      float rx = uTime * (0.23 + fi * 0.07);
      float ry = uTime * (0.19 + fi * 0.05);
      vec3 q = p - center;
      // Rodrigues rotation around Y
      float cy = cos(ry); float sy = sin(ry);
      q = vec3(cy*q.x + sy*q.z, q.y, -sy*q.x + cy*q.z);
      // Rodrigues rotation around X
      float cx = cos(rx); float sx = sin(rx);
      q = vec3(q.x, cx*q.y - sx*q.z, sx*q.y + cx*q.z);

      d = smin(d, formSDF(q, i), 0.04);
    }

    return d;
  }

  // ── Surface normal (gradient) ─────────────────────────────────────────────

  vec3 calcNormal(vec3 p) {
    const float h = 0.002;
    const vec2 k = vec2(1.0, -1.0);
    return normalize(
      k.xyy * sceneSDF(p + k.xyy * h) +
      k.yyx * sceneSDF(p + k.yyx * h) +
      k.yxy * sceneSDF(p + k.yxy * h) +
      k.xxx * sceneSDF(p + k.xxx * h)
    );
  }

  // ── Penumbra soft shadow (Inigo Quilez) ───────────────────────────────────

  float softShadow(vec3 ro, vec3 rd, float mint, float maxt) {
    float k   = mix(24.0, 4.0, uSoftness);  // higher k = harder shadow
    float res = 1.0;
    float t   = mint;
    for (int i = 0; i < ${shadowSteps}; i++) {
      float h = sceneSDF(ro + rd * t);
      res = min(res, k * h / t);
      t  += clamp(h, 0.01, 0.3);
      if (res < 0.001 || t > maxt) break;
    }
    return clamp(res, 0.0, 1.0);
  }

  // ── Ambient occlusion (5-step cone march) ─────────────────────────────────

  float calcAO(vec3 p, vec3 n) {
    float occ = 0.0;
    float sca = 1.0;
    for (int i = 0; i < 5; i++) {
      float h  = 0.01 + float(i) * 0.12;
      float d  = sceneSDF(p + n * h);
      occ     += (h - d) * sca;
      sca     *= 0.85;
    }
    return clamp(1.0 - 2.0 * occ, 0.0, 1.0);
  }

  // ── Lighting ──────────────────────────────────────────────────────────────
  // Warm overhead key light + cool bounce fill from floor level

  vec3 shade(vec3 pos, vec3 nor, int mat) {
    // Key light: warm amber, slightly to the side and above
    vec3 keyDir   = normalize(vec3(1.8, 4.5, -2.5));
    float soft    = softShadow(pos + nor * 0.01, keyDir, 0.05, 18.0);
    float diffKey = max(dot(nor, keyDir), 0.0) * soft;

    // Fill light: cool, from below and opposite side
    vec3 fillDir  = normalize(vec3(-1.0, 0.6, 1.4));
    float diffFill = max(dot(nor, fillDir), 0.0) * 0.18;

    // Rim light: cool blue from behind
    vec3 rimDir   = normalize(vec3(-0.5, 0.8, 2.0));
    float rimFac  = pow(clamp(1.0 - dot(nor, -rimDir), 0.0, 1.0), 3.0);
    float diffRim = rimFac * 0.12;

    float ao      = calcAO(pos, nor);

    // Material colours
    vec3 matCol;
    if (mat == 0) {
      // Floor: dark warm stone
      float checkerU = fract(pos.x * 0.25) > 0.5 ? 1.0 : 0.0;
      float checkerV = fract(pos.z * 0.25) > 0.5 ? 1.0 : 0.0;
      float chk = (checkerU + checkerV - 2.0 * checkerU * checkerV) * 0.03;
      matCol = vec3(0.10 + chk, 0.09 + chk, 0.07 + chk);
    } else {
      // Form: cool near-white concrete, warming slightly toward higher bands
      float fi   = float(mat - 1) / 6.0;
      vec3 cool  = vec3(0.72, 0.73, 0.75);
      vec3 warm  = vec3(0.82, 0.75, 0.62);
      matCol     = mix(cool, warm, fi * uWarmth);
    }

    // Warm key
    vec3 keyCol    = mix(vec3(1.0, 0.85, 0.55), vec3(0.7, 0.82, 1.0), 1.0 - uWarmth);
    vec3 fillCol   = vec3(0.55, 0.65, 0.80);
    vec3 rimCol    = vec3(0.50, 0.60, 0.78);
    vec3 ambCol    = mix(vec3(0.08, 0.08, 0.10), vec3(0.12, 0.10, 0.07), uWarmth);

    vec3 col = matCol * (
        ambCol  * ao
      + keyCol  * diffKey
      + fillCol * diffFill
      + rimCol  * diffRim
    );

    return col;
  }

  // ── Ray-march ─────────────────────────────────────────────────────────────

  void main() {
    // Construct camera ray from fullscreen UV
    vec2 ndc = (vUv - 0.5) * vec2(uAspect, 1.0);
    float fovScale = 0.9;          // ~83° diagonal
    vec3 rd = normalize(uCamFwd + fovScale * (ndc.x * uCamRight + ndc.y * uCamUp));
    vec3 ro = uCamPos;

    // Sphere-march
    float t = 0.1;
    int   hitMat = -1;
    float prevFloorD = 1e10;

    for (int i = 0; i < ${maxSteps}; i++) {
      vec3 p   = ro + rd * t;
      float d  = sceneSDF(p);
      if (d < SURF_EPS) {
        // Identify hit material: floor (mat=0) or a form (mat=1..7)
        hitMat = (p.y < 0.02 + SURF_EPS) ? 0 : 1;
        // If floor, quick re-identify by checking individual form distances
        if (hitMat == 1) {
          // find nearest form for colour
          float best = 1e10;
          int count  = int(clamp(uForms, 1.0, 7.0));
          for (int j = 0; j < 7; j++) {
            if (j >= count) break;
            float fi   = float(j);
            float ph   = fi * 6.28318 / 7.0 + uTime * uDrift * 0.4;
            float orb  = 2.2 + fi * 0.12;
            float yB   = 1.3 + fi * 0.1 + uBands[j] * 1.4;
            float yBob = 0.18 * sin(uTime * (0.7 + fi * 0.11) + fi);
            vec3 c = vec3(orb * cos(ph), yB + yBob, orb * sin(ph));
            float fj = length(p - c);
            if (fj < best) { best = fj; hitMat = j + 1; }
          }
        }
        break;
      }
      t += d;
      if (t > MAX_DIST) break;
    }

    vec3 col;
    if (hitMat < 0) {
      // Sky / background: very dark warm-tinted void
      float hor = pow(max(0.0, 1.0 - abs(rd.y) * 2.5), 2.0);
      col = mix(vec3(0.01, 0.01, 0.02), vec3(0.06, 0.05, 0.04), hor * uWarmth);
    } else {
      vec3 pos = ro + rd * t;
      vec3 nor = calcNormal(pos);
      col = shade(pos, nor, hitMat);

      // Depth fog
      float fog = 1.0 - exp(-t * 0.028);
      vec3 fogCol = vec3(0.01, 0.01, 0.015);
      col = mix(col, fogCol, fog);
    }

    // Beat flash: brief white surge over whole frame
    col += uBeatKick * 0.08;

    // Subtle vignette
    vec2 vgn = (vUv - 0.5) * 2.0;
    col *= 1.0 - dot(vgn, vgn) * 0.22;

    gl_FragColor = vec4(col, 1.0);
  }
`; }

// ── Camera orbit ──────────────────────────────────────────────────────────────
// Camera drifts on a slow horizontal circle, tilted downward ~25° so both
// the floating forms AND their floor shadows are always visible.

function updateCamera(theta: number): void {
  if (!uCamPos.value || !uCamFwd.value || !uCamRight.value || !uCamUp.value) return;
  const dist   = 9.5;
  const height = 3.8;
  const lookAt = new THREE.Vector3(0, 1.1, 0);

  const cx = dist * Math.cos(theta);
  const cz = dist * Math.sin(theta);
  const pos = new THREE.Vector3(cx, height, cz);

  const fwd = lookAt.clone().sub(pos).normalize();
  const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize();
  const up    = new THREE.Vector3().crossVectors(right, fwd).normalize();

  uCamPos.value.copy(pos);
  uCamFwd.value.copy(fwd);
  uCamRight.value.copy(right);
  uCamUp.value.copy(up);
}

// ── Setup ─────────────────────────────────────────────────────────────────────

function setup(): void {
  const mobile = isMobile;
  const maxSteps    = mobile ? 36 : 60;
  const shadowSteps = mobile ? 10 : 18;

  threeCanvas = document.createElement('canvas');
  threeCanvas.style.cssText =
    'position:fixed;top:0;left:0;width:100%;height:100%;z-index:10;pointer-events:none;display:block';
  document.body.appendChild(threeCanvas);

  renderer = new THREE.WebGLRenderer({ canvas: threeCanvas, antialias: false });
  renderer.setPixelRatio(mobile ? Math.min(window.devicePixelRatio, 1.2) : Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);

  scene      = new THREE.Scene();
  orthoCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  uAspect.value = window.innerWidth / window.innerHeight;

  shaderMat = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: buildFrag(maxSteps, shadowSteps),
    uniforms: {
      uTime:     uTime,
      uAspect:   uAspect,
      uBands:    uBands,
      uBeatKick: uBeatKick,
      uCamPos:   uCamPos,
      uCamFwd:   uCamFwd,
      uCamRight: uCamRight,
      uCamUp:    uCamUp,
      uForms:    uForms,
      uSoftness: uSoftness,
      uDrift:    uDrift,
      uWarmth:   uWarmth,
    },
    depthTest:  false,
    depthWrite: false,
  });

  quadMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), shaderMat);
  scene.add(quadMesh);

  updateCamera(0);

  vizModeUnsub = store.on('vizModeChange', () => { disposePenumbra(); });

  const onResize = (): void => {
    const nw = window.innerWidth;
    const nh = window.innerHeight;
    renderer?.setSize(nw, nh);
    uAspect.value = nw / nh;
  };
  window.addEventListener('resize', onResize);
  (threeCanvas as HTMLCanvasElement & { _onResize?: () => void })._onResize = onResize;

  initialized = true;
}

// ── Draw ──────────────────────────────────────────────────────────────────────

export function drawPenumbra(_p: unknown, dt: number): void {
  if (!initialized) setup();
  if (!renderer || !scene || !orthoCamera) return;

  time     += dt * 0.016;
  camTheta += 0.00035 * dt;   // very slow orbit — full circle ~3 minutes

  const { amps } = getBandAverages(7);
  const lerpA = 1.0 - Math.pow(0.04, dt / 60.0);
  for (let i = 0; i < 7; i++) {
    smoothedBands[i] += (amps[i] - smoothedBands[i]) * lerpA;
  }
  uBands.value = Array.from(smoothedBands);
  uTime.value  = time;

  const cfg = store.config;
  uForms.value    = Math.round(cfg.penumbraForms);
  uSoftness.value = cfg.penumbraSoftness;
  uDrift.value    = cfg.penumbraDrift;
  uWarmth.value   = cfg.penumbraWarmth;

  // Beat detection
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
  beatKick         *= Math.pow(0.86, dt);
  uBeatKick.value   = beatKick;

  updateCamera(camTheta);
  renderer.render(scene, orthoCamera);
}

// ── Reset ─────────────────────────────────────────────────────────────────────

export function resetPenumbra(): void {
  if (!initialized) return;
  renderer?.setSize(window.innerWidth, window.innerHeight);
  uAspect.value = window.innerWidth / window.innerHeight;
}

// ── Dispose ───────────────────────────────────────────────────────────────────

export function disposePenumbra(): void {
  if (!initialized) return;

  vizModeUnsub?.();
  vizModeUnsub = null;

  const canvas = threeCanvas as (HTMLCanvasElement & { _onResize?: () => void }) | null;
  if (canvas?._onResize) window.removeEventListener('resize', canvas._onResize);

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
  vizModeUnsub = null;
  initialized  = false;
  time         = 0;
  camTheta     = 0;
  lastBeatIndex = -1;
  beatKick      = 0;
  smoothedBands.fill(0);
}
