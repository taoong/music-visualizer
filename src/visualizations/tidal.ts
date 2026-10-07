/**
 * Tidal — three-dimensional audio-reactive liquid surface
 *
 * A dark ocean viewed from just above the waterline; a single warm overhead
 * light plays across seven standing waves — one per audio band — creating
 * shifting specular bands and foam-bright wave crests. All seven bands drive
 * continuous vertex displacement (CHOP-signal style); beats add only a brief
 * camera swell, perturbing an already-flowing system rather than triggering
 * a discrete event. Restrained palette: deep indigo water, warm white sun,
 * cool silver Fresnel rim — no rainbow, no per-band hue.
 *
 * Inspired by Doug Aitken's "SONG 1" (Hirshhorn Museum, Washington D.C., 2012)
 * — projected light on curved architecture forming liquid-like bands of colour
 * and movement — and by the TouchDesigner ocean-simulation community patches
 * that feed audio bands as continuous CHOP signals into wave generators.
 * https://www.hirshhorn.si.edu/collection/song-1/
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass }    from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass }    from 'three/addons/postprocessing/OutputPass.js';
import { store }          from '../state/store';
import { getBandAverages } from './helpers';
import { audioEngine }    from '../audio/engine';
import { isMobile }       from '../utils/constants';

// ── Module state ──────────────────────────────────────────────────────────────

let initialized    = false;
let threeCanvas    : HTMLCanvasElement | null = null;
let renderer       : THREE.WebGLRenderer | null = null;
let scene          : THREE.Scene | null = null;
let camera         : THREE.PerspectiveCamera | null = null;
let composer       : EffectComposer | null = null;
let waterMesh      : THREE.Mesh | null = null;
let waterMat       : THREE.ShaderMaterial | null = null;
let waterGeo       : THREE.BufferGeometry | null = null;
let sunLight       : THREE.PointLight | null = null;
let vizModeUnsub   : (() => void) | null = null;

// Animation state
let time           = 0;
let cameraTheta    = 0;    // horizontal orbit angle
// (camera elevation is fixed — no phi variable needed)
let beatDecay      = 0;    // camera swell on beat
let lastBeatIndex  = -1;

// Camera orbital radius & height
const CAM_RADIUS  = 14;
const CAM_BASE_Y  = 2.2;

// Cached config values
let cachedSwell    = -1;

// ── Uniforms ──────────────────────────────────────────────────────────────────

const uTime    : THREE.IUniform<number>   = { value: 0 };
const uBands   : THREE.IUniform<number[]> = { value: new Array(7).fill(0) };
const uBeat    : THREE.IUniform<number>   = { value: 0 };
const uSwell   : THREE.IUniform<number>   = { value: 0.5 };
const uScale   : THREE.IUniform<number>   = { value: 0.5 };
const uShimmer : THREE.IUniform<number>   = { value: 0.5 };
const uSunPos  : THREE.IUniform<THREE.Vector3> = { value: new THREE.Vector3(6, 14, 4) };
const uCamPos  : THREE.IUniform<THREE.Vector3> = { value: new THREE.Vector3() };

// ── GLSL ──────────────────────────────────────────────────────────────────────

const VERT = /* glsl */`
precision highp float;

uniform float uTime;
uniform float uBands[7];
uniform float uBeat;
uniform float uSwell;    // 0=long deep swells  1=short choppy
uniform float uScale;    // overall height amplitude

varying vec3  vNormal;
varying vec3  vWorldPos;
varying float vHeight;   // normalised -1..1 for foam

// Seven wave directions evenly spread around 2π
vec2 waveDir(int i) {
  float a = float(i) * 0.8975979; // 2π/7
  return vec2(cos(a), sin(a));
}

// Spatial frequency for each band: swell slider 0→1 maps base 0.6→2.8
// Higher bands get progressively shorter wavelengths (1.0 + 0.25*i multiplier).
float waveSpatialFreq(int i) {
  float base = mix(0.55, 2.6, uSwell);
  return base * (1.0 + 0.22 * float(i));
}

// Temporal frequency: slower for bass, faster for highs
float waveTempFreq(int i) {
  return 0.35 + float(i) * 0.10;
}

// Evaluate the height field at a given xz position.
// We use this for both the vertex position AND finite-difference normals.
float heightAt(vec2 xz) {
  float h = 0.0;
  for (int i = 0; i < 7; i++) {
    float amp = uBands[i] * 1.4 + 0.04; // small residual so surface always moves
    float k   = waveSpatialFreq(i);
    float w   = waveTempFreq(i);
    vec2  d   = waveDir(i);
    float ph  = dot(d, xz) * k + uTime * w;
    h += amp * sin(ph);
  }
  return h * uScale;
}

void main() {
  vec3 pos = position;
  vec2 xz  = pos.xz;

  float h = heightAt(xz);
  pos.y = h;

  // Finite-difference normal — eps chosen to be ~1/8 tile width
  float eps = 0.18;
  float hx = heightAt(xz + vec2(eps, 0.0));
  float hz = heightAt(xz + vec2(0.0, eps));
  vec3 rawNorm = normalize(vec3(-(hx - h) / eps, 1.0, -(hz - h) / eps));

  vNormal   = normalize(mat3(modelMatrix) * rawNorm); // world-space normal
  vWorldPos = (modelMatrix * vec4(pos, 1.0)).xyz;
  vHeight   = h / (uScale * 1.4 + 0.001);            // normalised height

  gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
}
`;

const FRAG = /* glsl */`
precision highp float;

uniform vec3  uSunPos;
uniform vec3  uCamPos;
uniform float uShimmer;  // 0=matte  1=mirror
uniform float uBeat;
uniform float uScale;

varying vec3  vNormal;
varying vec3  vWorldPos;
varying float vHeight;

void main() {
  vec3 N = normalize(vNormal);

  // Ensure normal points toward camera hemisphere (double-sided lighting)
  vec3 viewDir = normalize(uCamPos - vWorldPos);
  if (dot(N, viewDir) < 0.0) N = -N;

  vec3 L = normalize(uSunPos - vWorldPos);
  vec3 R = reflect(-L, N);

  // ── Base deep-water colour ──────────────────────────────────────────────────
  // Deep indigo at troughs, slightly lighter at crests
  float heightNorm = clamp(vHeight * 0.5 + 0.5, 0.0, 1.0);
  vec3 deepColor  = vec3(0.018, 0.032, 0.060);
  vec3 crestColor = vec3(0.040, 0.075, 0.130);
  vec3 baseColor  = mix(deepColor, crestColor, heightNorm);

  // ── Diffuse (very subtle — surface is mostly dark) ──────────────────────────
  float diff = max(0.0, dot(N, L)) * 0.18;

  // ── Specular — shininess driven by shimmer slider ──────────────────────────
  float shininess = mix(24.0, 512.0, uShimmer * uShimmer);
  float spec = pow(max(0.0, dot(R, viewDir)), shininess);
  spec *= mix(0.4, 3.0, uShimmer);
  vec3 sunColor = vec3(1.0, 0.92, 0.75); // warm white/gold

  // ── Fresnel rim — cool silver at grazing angles ────────────────────────────
  float cosTheta = max(0.0, dot(N, viewDir));
  float fresnel  = pow(1.0 - cosTheta, 4.0) * 0.6;
  vec3 fresnelColor = vec3(0.55, 0.65, 0.85);

  // ── Foam — bright peaks bloom under the bloom pass ────────────────────────
  // Threshold at ~70% of max wave height
  float foamMask  = smoothstep(0.45, 0.9, vHeight);
  float foamBeat  = uBeat * 0.3;                      // beat brightens foam
  vec3 foamColor  = vec3(0.80, 0.88, 1.00) * (foamMask + foamBeat) * uShimmer;

  // ── Assemble ──────────────────────────────────────────────────────────────
  vec3 color = baseColor
    + diff * sunColor
    + spec  * sunColor
    + fresnel * fresnelColor
    + foamColor;

  gl_FragColor = vec4(color, 1.0);
}
`;

// ── Geometry builder ──────────────────────────────────────────────────────────

function buildWaterGeometry(segments: number): THREE.BufferGeometry {
  // PlaneGeometry in XZ (rotate -90° on X later via mesh rotation)
  // We build it manually to keep it on the XZ plane from the start.
  const size = 110;
  const geo  = new THREE.PlaneGeometry(size, size, segments, segments);
  // Rotate so the plane lies in XZ (Three.js PlaneGeometry defaults to XY)
  geo.rotateX(-Math.PI / 2);
  return geo;
}

// ── Setup / dispose ───────────────────────────────────────────────────────────

function setup(): void {
  const segments = isMobile ? 48 : 96;

  // Overlay canvas
  threeCanvas = document.createElement('canvas');
  threeCanvas.style.cssText =
    'position:fixed;top:0;left:0;width:100%;height:100%;z-index:10;pointer-events:none;display:block';
  document.body.appendChild(threeCanvas);

  // Renderer
  renderer = new THREE.WebGLRenderer({
    canvas: threeCanvas,
    antialias: !isMobile,
    alpha: true,
  });
  renderer.setPixelRatio(isMobile ? 1.0 : Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  // Scene
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x030710);
  scene.fog = new THREE.FogExp2(0x030710, 0.012);

  // Camera — low angle, just above the waterline
  camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 300);

  // Water mesh
  waterGeo = buildWaterGeometry(segments);
  waterMat = new THREE.ShaderMaterial({
    uniforms: {
      uTime:    uTime,
      uBands:   uBands,
      uBeat:    uBeat,
      uSwell:   uSwell,
      uScale:   uScale,
      uShimmer: uShimmer,
      uSunPos:  uSunPos,
      uCamPos:  uCamPos,
    },
    vertexShader:   VERT,
    fragmentShader: FRAG,
    side: THREE.FrontSide,
  });
  waterMesh = new THREE.Mesh(waterGeo, waterMat);
  scene.add(waterMesh);

  // Warm overhead point light — slightly off-center for asymmetric highlights
  sunLight = new THREE.PointLight(0xfff5e0, 80, 60, 1.5);
  sunLight.position.set(6, 14, 4);
  scene.add(sunLight);

  // Dim ambient so underwater sides aren't pitch-black
  scene.add(new THREE.AmbientLight(0x0a1a30, 1.0));

  // EffectComposer — bloom for foam peaks and specular
  const res = new THREE.Vector2(window.innerWidth, window.innerHeight);
  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(res, 0.4, 0.5, 0.72);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  // Resize handler
  const onResize = () => {
    if (!renderer || !camera || !composer) return;
    renderer.setSize(window.innerWidth, window.innerHeight);
    composer.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
  };
  window.addEventListener('resize', onResize);

  // Hide when switching away
  vizModeUnsub = store.on('vizModeChange', () => {
    if (threeCanvas) threeCanvas.style.display = 'none';
  });

  initialized = true;
}

export function disposeTidal(): void {
  if (!initialized) return;

  waterGeo?.dispose();
  waterMat?.dispose();
  composer?.dispose();
  renderer?.dispose();

  threeCanvas?.remove();

  waterMesh      = null;
  waterGeo       = null;
  waterMat       = null;
  composer       = null;
  renderer       = null;
  scene          = null;
  camera         = null;
  sunLight       = null;
  threeCanvas    = null;

  vizModeUnsub?.();
  vizModeUnsub = null;

  time         = 0;
  cameraTheta  = 0;
  beatDecay    = 0;
  lastBeatIndex = -1;
  cachedSwell  = -1;

  initialized = false;
}

// ── Reset ─────────────────────────────────────────────────────────────────────

export function resetTidal(): void {
  time          = 0;
  cameraTheta   = 0;
  beatDecay     = 0;
  lastBeatIndex = -1;
}

// ── Draw ──────────────────────────────────────────────────────────────────────

export function drawTidal(_p: unknown, dt: number): void {
  if (!initialized) setup();
  if (!renderer || !scene || !camera || !composer || !waterMat) return;

  if (threeCanvas) threeCanvas.style.display = 'block';

  const { state, config } = store;
  const { amps } = getBandAverages(7);

  // ── Config uniforms ──────────────────────────────────────────────────────
  const newSwell = config.tidalSwell;
  if (newSwell !== cachedSwell) {
    uSwell.value = newSwell;
    cachedSwell  = newSwell;
  }
  uScale.value   = 0.5 + config.tidalScale * 2.5;  // 0.5 .. 3.0
  uShimmer.value = config.tidalShimmer;

  // ── Audio band uniforms ──────────────────────────────────────────────────
  for (let i = 0; i < 7; i++) {
    uBands.value[i] = amps[i] ?? 0;
  }

  // ── Beat detection ───────────────────────────────────────────────────────
  if (state.beatIntervalSec > 0 && state.isPlaying) {
    const pos     = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    const beatIdx  = adjusted >= 0
      ? Math.floor(adjusted / state.beatIntervalSec)
      : -1;
    if (beatIdx > lastBeatIndex) {
      lastBeatIndex = beatIdx;
      beatDecay     = 1.0;
    }
  }
  beatDecay *= Math.pow(0.92, dt);
  uBeat.value = beatDecay;

  // ── Time ─────────────────────────────────────────────────────────────────
  const dtSec = dt * 0.016667; // dt is in units of ~16ms frames
  time += dtSec;
  uTime.value = time;

  // ── Camera orbit ─────────────────────────────────────────────────────────
  // Very slow continuous orbit; beat adds a gentle vertical swell
  cameraTheta += dtSec * 0.04;

  // Overall amplitude for camera height variation
  const overallAmp = (amps.reduce((a, b) => a + b, 0) / 7) * 0.3;
  const swellLift  = beatDecay * 0.8;    // brief lift on beat
  const camY       = CAM_BASE_Y + overallAmp + swellLift;
  const camX       = Math.sin(cameraTheta) * CAM_RADIUS;
  const camZ       = Math.cos(cameraTheta) * CAM_RADIUS;

  camera.position.set(camX, camY, camZ);
  camera.lookAt(0, 0, 0);

  // Pass camera world position to fragment shader for specular
  uCamPos.value.copy(camera.position);

  // Animate sun position slightly for moving highlights
  uSunPos.value.set(
    6 + Math.sin(time * 0.07) * 3,
    14,
    4 + Math.cos(time * 0.05) * 2,
  );
  if (sunLight) {
    sunLight.position.copy(uSunPos.value);
    // Bloom strength driven by overall amplitude
    sunLight.intensity = 70 + overallAmp * 80 + beatDecay * 40;
  }

  composer.render();
}
