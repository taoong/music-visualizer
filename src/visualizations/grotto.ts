/**
 * Grotto — GLSL-raymarched stone cave with audio-reactive water caustics
 *
 * A dark stone grotto interior viewed from within. 7 water-wave sources
 * ripple across a submerged ceiling, casting caustic light interference
 * patterns on walls and floor. Sub-bass creates large, slow amber waves;
 * brilliance produces fine, cool blue-white shimmer. The camera drifts
 * through the space with handheld sinusoidal motion.
 *
 * Caustic technique: each of 7 sources produces abs(sin(d·freq − t·speed))^8
 * — the high power exponent sharpens smooth sinusoids into sharp bright
 * streaks and dark gaps, the hallmark of real water-lens focusing.
 *
 * Inspired by Marshmallow Laser Feast "Deeper than Light" (2015,
 * https://marshmallowlaserfeast.com) — first-person immersion in a
 * luminous natural interior — and the GPU Gems Ch. 2 procedural
 * caustic pixel-shader technique (NVIDIA, 2004).
 * No rainbow palette, no additive neon — warm amber to cool steel-blue
 * on dark wet stone.
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

let initialized    = false;
let threeCanvas    : HTMLCanvasElement | null = null;
let renderer       : THREE.WebGLRenderer | null = null;
let scene          : THREE.Scene | null = null;
let orthoCamera    : THREE.OrthographicCamera | null = null;
let quadMesh       : THREE.Mesh | null = null;
let shaderMat      : THREE.ShaderMaterial | null = null;
let composer       : EffectComposer | null = null;
let vizModeUnsub   : (() => void) | null = null;

let time           = 0;
let lastBeatIndex  = -1;
let beatKick       = 0.0;    // decays from 1 to 0 over ~20 frames

// Per-frame smoothed bands (continuous CHOP-style signal)
const smoothBands = new Float32Array(7);

// ── Uniforms (mutated in-place each frame) ────────────────────────────────────

const uTime      : THREE.IUniform<number>   = { value: 0.0 };
const uAspect    : THREE.IUniform<number>   = { value: 1.0 };
const uBands     : THREE.IUniform<number[]> = { value: new Array(7).fill(0) };
const uBeatKick  : THREE.IUniform<number>   = { value: 0.0 };
const uTunnel    : THREE.IUniform<number>   = { value: 0.5 };  // 0=narrow, 1=wide
const uFlux      : THREE.IUniform<number>   = { value: 0.5 };  // caustic wave speed
const uLuminance : THREE.IUniform<number>   = { value: 0.5 };  // light brightness

// ── GLSL ──────────────────────────────────────────────────────────────────────

const VERT = /* glsl */`
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

function buildFrag(maxSteps: number): string {
  return /* glsl */`
precision highp float;

uniform float uTime;
uniform float uAspect;
uniform float uBands[7];
uniform float uBeatKick;
uniform float uTunnel;
uniform float uFlux;
uniform float uLuminance;

varying vec2 vUv;

// ── Value noise & FBM ─────────────────────────────────────────────────────────

float h3(vec3 p) {
  p = fract(p * vec3(443.8975, 397.2973, 491.1871));
  p += dot(p.zxy, p.yxz + 19.19);
  return fract(p.x * p.y * p.z);
}

float vnoise(vec3 p) {
  vec3 i = floor(p); vec3 f = fract(p);
  vec3 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(h3(i), h3(i+vec3(1,0,0)), u.x),
        mix(h3(i+vec3(0,1,0)), h3(i+vec3(1,1,0)), u.x), u.y),
    mix(mix(h3(i+vec3(0,0,1)), h3(i+vec3(1,0,1)), u.x),
        mix(h3(i+vec3(0,1,1)), h3(i+vec3(1,1,1)), u.x), u.y),
    u.z
  ) * 2.0 - 1.0;
}

float fbm(vec3 p) {
  float v = 0.0; float a = 0.5;
  for (int i = 0; i < 3; i++) {
    v += a * vnoise(p);
    p = p * 2.07 + vec3(5.2, 1.3, 7.1);
    a *= 0.5;
  }
  return v;
}

// ── SDF: stone cave tunnel along Z ────────────────────────────────────────────

float sdCave(vec3 p) {
  float r = mix(1.4, 2.8, uTunnel);

  // Circular tube — exact SDF, gradient magnitude 1 in XY
  float tube = r - length(p.xy);

  // Organic rock surface via low-frequency FBM (displacement ≤ 0.28)
  float noise = fbm(p * 0.45 + vec3(0.0, 0.0, 0.1)) * 0.28;

  // Flat floor: flattens the lower portion of the tube
  float floorPlane = p.y + r * 0.62;

  // Inside the tube = positive; at the wall = 0; outside = negative
  return min(tube + noise, floorPlane);
}

// Faster version (1 octave) used inside the march loop
float sdCaveFast(vec3 p) {
  float r = mix(1.4, 2.8, uTunnel);
  float tube = r - length(p.xy);
  float noise = vnoise(p * 0.5) * 0.22;
  float floorPlane = p.y + r * 0.62;
  return min(tube + noise, floorPlane);
}

vec3 caveNormal(vec3 p) {
  const float e = 0.006;
  return normalize(vec3(
    sdCave(p + vec3(e,0,0)) - sdCave(p - vec3(e,0,0)),
    sdCave(p + vec3(0,e,0)) - sdCave(p - vec3(0,e,0)),
    sdCave(p + vec3(0,0,e)) - sdCave(p - vec3(0,0,e))
  ));
}

// ── Caustic light ─────────────────────────────────────────────────────────────
//
// 7 wave sources above the cave — simulating sunlight filtered through a
// moving water surface. Classic GPU Gems approach: abs(sin(d·freq − t))^power
// High power (8) sharpens sinusoids into sharp caustic lines.

vec3 causticLight(vec3 p) {
  float r     = mix(1.4, 2.8, uTunnel);
  float waterY = r * 0.9;  // water surface near tunnel ceiling
  float fluxSpeed = mix(0.6, 3.5, uFlux * uFlux);

  vec3 totalLight = vec3(0.0);

  for (int b = 0; b < 7; b++) {
    float fb   = float(b);
    float band = uBands[b];
    if (band < 0.005) continue;

    // Source drifts slowly: golden-angle spread + slow XZ drift
    float ang  = fb * 0.8975 + uTime * 0.12;
    float rad  = r * mix(0.3, 0.6, fb / 6.0);
    float sx   = cos(ang) * rad;
    float sz   = sin(ang * 0.7) * 2.5 + fb * 1.73;  // static Z offset per band
    vec3  src  = vec3(sx, waterY, sz);

    // Horizontal distance from hit point to source
    float d = length(p.xz - src.xz);

    // Caustic frequency: bass=low spatial freq (large blobs), treble=fine shimmer
    float freq  = mix(1.8, 11.0, fb / 6.0);
    float speed = mix(0.9, 3.2, fb / 6.0);

    float wave   = abs(sin(d * freq - uTime * speed * fluxSpeed));
    float sharp  = wave * wave * wave * wave * wave * wave * wave * wave; // ^8
    float atten  = exp(-d * d * 0.18);           // Gaussian falloff from source
    float caustic = sharp * atten * band;

    // Two-tone palette: bass (b=0) → warm amber, treble (b=6) → cool blue-white
    float t   = fb / 6.0;
    vec3  col = mix(vec3(1.0, 0.72, 0.28), vec3(0.60, 0.85, 1.0), t * t);

    totalLight += col * caustic;
  }

  // Beat: warm white flash
  totalLight += vec3(1.0, 0.88, 0.62) * uBeatKick * 0.6;

  return totalLight * mix(0.6, 2.8, uLuminance * uLuminance);
}

// ── Main ──────────────────────────────────────────────────────────────────────

void main() {
  // Screen-space UV in [-aspect, aspect] × [-1, 1]
  vec2 uv = vUv * 2.0 - 1.0;
  uv.x *= uAspect;

  // ── Camera ─────────────────────────────────────────────────────────────────
  // Gentle handheld drift + beat lurch

  float driftX = sin(uTime * 0.19) * 0.09 + cos(uTime * 0.31) * 0.04;
  float driftY = 0.08 + sin(uTime * 0.14) * 0.04;    // slightly above floor centre
  float driftZ = sin(uTime * 0.09) * 0.2;             // slight fore-aft sway

  // Beat pushes camera slightly forward then springs back
  float beatPushZ = uBeatKick * 0.35;

  vec3 ro = vec3(driftX, driftY, driftZ + beatPushZ);

  // Look direction: forward (+Z) with slight upward tilt to see ceiling caustics
  vec3 target = vec3(
    sin(uTime * 0.11) * 0.08,   // very slow pan
    0.45 + sin(uTime * 0.07) * 0.08,  // look upward at caustic ceiling
    8.0
  );
  vec3 fwd   = normalize(target - ro);
  vec3 right = normalize(cross(fwd, vec3(0.0, 1.0, 0.0)));
  vec3 up    = cross(right, fwd);

  // Field of view: ~65° horizontal
  float fov = 1.4;
  vec3 rd = normalize(uv.x * right + (uv.y / uAspect) * up + fov * fwd);

  // ── Sphere-march ────────────────────────────────────────────────────────────

  float t = 0.0;
  bool  hit = false;
  vec3  hp  = ro;
  float maxDist = ${isMobile ? '14.0' : '20.0'};

  for (int i = 0; i < ${maxSteps}; i++) {
    hp = ro + rd * t;
    float d = sdCaveFast(hp);

    if (d < 0.006) { hit = true; break; }

    // Step conservatively: fast SDF slightly underestimates true distance
    t += d * 0.6;
    if (t > maxDist) break;
  }

  if (!hit) {
    // Ray escaped: deep dark background
    gl_FragColor = vec4(0.025, 0.018, 0.012, 1.0);
    return;
  }

  // ── Surface shading ─────────────────────────────────────────────────────────

  vec3 N = caveNormal(hp);

  // Stone base colour: dark warm brown with subtle high-frequency variation
  float stoneDetail = vnoise(hp * 3.5) * 0.08 + vnoise(hp * 7.0) * 0.04;
  float stoneLow    = fbm(hp * 0.9) * 0.12;
  vec3  stoneBase   = vec3(0.11, 0.08, 0.06) + stoneLow + stoneDetail;

  // Fake ambient occlusion: darker in crevices (smaller SDF at hit = more occluded)
  float aoSample = smoothstep(0.0, 0.5, sdCave(hp + N * 0.25));
  float ao        = mix(0.4, 1.0, aoSample);

  // Diffuse: single warm fill light at top of tunnel
  vec3 fillDir = normalize(vec3(0.1, 1.0, 0.3));
  float diff    = max(0.0, dot(N, fillDir)) * 0.15;

  // Caustic light from water sources
  vec3 caustic = causticLight(hp);

  // Surface-normal modulation: caustics strongest where surface faces upward
  // (ceiling and upper walls) — just like real caustics landing on a pool floor
  float facingUp = max(0.0, dot(N, vec3(0.0, 1.0, 0.0)));
  float causticMask = mix(0.35, 1.0, facingUp); // some caustics on all surfaces

  // ── Atmospheric depth fog ───────────────────────────────────────────────────
  float dist      = length(hp - ro);
  float fogFactor = exp(-dist * 0.10);
  vec3  fogColour = vec3(0.025, 0.018, 0.012);

  // Compose
  vec3 col  = stoneBase * ao;
  col       += vec3(diff);
  col       += caustic * causticMask;
  col        = mix(fogColour, col, fogFactor * fogFactor);

  // Slight gamma lift so dark areas stay visible
  col = pow(max(col, vec3(0.0)), vec3(0.88));

  gl_FragColor = vec4(col, 1.0);
}
  `;
}

// ── Setup ─────────────────────────────────────────────────────────────────────

function setup(): void {
  threeCanvas = document.createElement('canvas');
  threeCanvas.style.cssText =
    'position:fixed;top:0;left:0;width:100%;height:100%;z-index:10;pointer-events:none;display:block';
  document.body.appendChild(threeCanvas);

  const w = window.innerWidth;
  const h = window.innerHeight;

  renderer = new THREE.WebGLRenderer({ canvas: threeCanvas, antialias: false });
  renderer.setPixelRatio(isMobile ? 1.0 : Math.min(window.devicePixelRatio, 1.5));
  renderer.setSize(w, h);
  renderer.toneMapping    = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.4;

  scene      = new THREE.Scene();
  orthoCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  const steps = isMobile ? 42 : 68;
  shaderMat = new THREE.ShaderMaterial({
    vertexShader:   VERT,
    fragmentShader: buildFrag(steps),
    uniforms: {
      uTime:     uTime,
      uAspect:   uAspect,
      uBands:    uBands,
      uBeatKick: uBeatKick,
      uTunnel:   uTunnel,
      uFlux:     uFlux,
      uLuminance:uLuminance,
    },
    depthTest: false,
    depthWrite: false,
  });

  const geo  = new THREE.PlaneGeometry(2, 2);
  quadMesh   = new THREE.Mesh(geo, shaderMat);
  scene.add(quadMesh);

  // EffectComposer: subtle bloom on the caustic hot-spots (desktop only)
  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, orthoCamera));

  if (!isMobile) {
    const bloom = new UnrealBloomPass(
      new THREE.Vector2(w, h),
      0.35,   // strength
      0.5,    // radius
      0.82,   // threshold (only bright caustic lines bloom)
    );
    composer.addPass(bloom);
  }

  composer.addPass(new OutputPass());

  uAspect.value = w / h;

  // Dispose on viz switch
  vizModeUnsub = store.on('vizModeChange', () => {
    disposeGrotto();
  });

  initialized = true;
}

// ── Draw ──────────────────────────────────────────────────────────────────────

export function drawGrotto(_p: unknown, dt: number): void {
  if (!initialized) setup();

  const { amps, transients } = getBandAverages(7);

  // Smooth bands (continuous CHOP-style)
  for (let i = 0; i < 7; i++) {
    const a = amps[i] ?? 0;
    const attack  = 0.25 * dt;
    const release = 0.07 * dt;
    smoothBands[i] = a > smoothBands[i]
      ? smoothBands[i] + (a - smoothBands[i]) * Math.min(attack, 1)
      : smoothBands[i] + (a - smoothBands[i]) * Math.min(release, 1);
  }
  uBands.value = Array.from(smoothBands);

  // Beat detection: kick impulse that decays over ~20 frames
  const { state } = store;
  if (state.beatIntervalSec > 0 && state.isPlaying) {
    const pos      = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    const beatIdx  = adjusted >= 0 ? Math.floor(adjusted / state.beatIntervalSec) : -1;
    if (beatIdx > lastBeatIndex) {
      lastBeatIndex = beatIdx;
      const rawTrans = Math.max(transients[0] ?? 1, transients[1] ?? 1);
      beatKick = Math.min(1.0, (rawTrans - 0.8) * 1.5);
    }
  }
  beatKick *= Math.pow(0.88, dt); // exponential decay, frame-rate independent
  uBeatKick.value = beatKick;

  // Advance time
  time += 0.016 * dt;
  uTime.value = time;

  // Sync uniforms from slider config
  uTunnel.value    = store.config.grottoTunnel;
  uFlux.value      = store.config.grottoFlux;
  uLuminance.value = store.config.grottoLuminance;

  if (composer) composer.render();
}

// ── Reset (resize) ────────────────────────────────────────────────────────────

export function resetGrotto(): void {
  if (!initialized) return;
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer?.setSize(w, h);
  composer?.setSize(w, h);
  uAspect.value = w / h;
}

// ── Dispose ───────────────────────────────────────────────────────────────────

export function disposeGrotto(): void {
  if (!initialized) return;
  vizModeUnsub?.();
  vizModeUnsub = null;
  (quadMesh?.geometry)?.dispose();
  shaderMat?.dispose();
  composer?.dispose();
  renderer?.dispose();
  threeCanvas?.remove();
  threeCanvas = null; renderer = null; scene = null; orthoCamera = null;
  quadMesh = null; shaderMat = null; composer = null;
  initialized = false;
  time = 0; lastBeatIndex = -1; beatKick = 0;
  smoothBands.fill(0);
}
