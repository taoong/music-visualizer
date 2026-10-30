/**
 * Dune — audio-reactive desert sand surface
 *
 * A vast wind-sculpted sand plane lit by a single raking directional light.
 * Seven frequency bands drive seven sinusoidal height modes at different
 * spatial frequencies and directions: sub-bass makes long lazy dune crests,
 * brilliance makes fine surface ripples. Drama comes entirely from shadow
 * cast by the displaced surface — no glow, no emissive, no rainbow.
 *
 * Technique is close to TouchDesigner real-time displacement patches:
 * every band is a continuous CHOP-style signal feeding directly into the
 * vertex shader; beats add a transient kick to an already-flowing surface.
 *
 * Inspired by Lita Albuquerque "Stellar Axis: Antarctica" (2006), the
 * architectural light installations of Olafur Eliasson, and the sand-grain
 * displacement patches published by Elekktronaut in the TouchDesigner
 * community showcasing raking-light audio reactivity.
 * https://olafureliasson.net/artwork/stellar-axis/
 */
import * as THREE from 'three';
import { EffectComposer }   from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass }       from 'three/addons/postprocessing/RenderPass.js';
import { OutputPass }       from 'three/addons/postprocessing/OutputPass.js';
import { store }            from '../state/store';
import { getBandAverages }  from './helpers';
import { audioEngine }      from '../audio/engine';
import { isMobile }         from '../utils/constants';

// ── Module state ──────────────────────────────────────────────────────────────

let initialized   = false;
let threeCanvas   : HTMLCanvasElement | null = null;
let renderer      : THREE.WebGLRenderer | null = null;
let scene         : THREE.Scene | null = null;
let camera        : THREE.PerspectiveCamera | null = null;
let composer      : EffectComposer | null = null;
let sandMesh      : THREE.Mesh | null = null;
let sandMat       : THREE.ShaderMaterial | null = null;
let sandGeo       : THREE.BufferGeometry | null = null;
let vizModeUnsub  : (() => void) | null = null;

let time          = 0;
let cameraTheta   = 0;
let beatKick      = 0;   // transient added on beat
let lastBeatIndex = -1;

// cached slider to detect structural change
let cachedDunes   = -1;

// ── Uniforms ──────────────────────────────────────────────────────────────────

const uTime  : THREE.IUniform<number>   = { value: 0 };
const uBands : THREE.IUniform<number[]> = { value: new Array(7).fill(0) };
const uBeat  : THREE.IUniform<number>   = { value: 0 };
const uDunes : THREE.IUniform<number>   = { value: 0.4 }; // spatial freq (structural)
const uDepth : THREE.IUniform<number>   = { value: 0.5 }; // amplitude scale
const uSun   : THREE.IUniform<number>   = { value: 0.2 }; // sun elevation 0–1

// ── GLSL shaders ─────────────────────────────────────────────────────────────

const VERT = /* glsl */`
precision highp float;

uniform float uTime;
uniform float uBands[7];
uniform float uBeat;
uniform float uDunes;  // 0=long desert dunes, 1=fine beach ripples
uniform float uDepth;  // amplitude sensitivity

varying vec3  vWorldPos;
varying float vHeight;     // raw world Y, for shading
varying float vNormX;      // 0..1 across surface width

// Wave direction for band i, evenly spread around the compass
vec2 waveDir(int i) {
  float a = float(i) * 0.8975979; // 2π/7
  return vec2(cos(a), sin(a));
}

// Spatial frequency: Dunes slider 0→1 maps range 0.04→0.22.
// Higher bands multiply by 1+0.3*i so brilliance is always finer than bass.
float waveK(int i) {
  float base = mix(0.038, 0.22, uDunes);
  return base * (1.0 + 0.30 * float(i));
}

// Temporal frequency: bass moves slowly, highs move faster
float waveW(int i) {
  return 0.25 + float(i) * 0.09;
}

// Height field at (x,z): superposition of 7 band-driven sinusoids.
float heightAt(float x, float z) {
  float h = 0.0;
  float depthScale = mix(0.6, 4.5, uDepth);
  for (int i = 0; i < 7; i++) {
    float amp  = uBands[i] + 0.02;          // small residual so it always moves
    float k    = waveK(i);
    float w    = waveW(i);
    vec2  d    = waveDir(i);
    float ph   = (d.x * x + d.y * z) * k + uTime * w;
    // Higher bands use steeper wave shape (sharper ripples)
    float wave = (i < 3) ? sin(ph) : sin(ph) * abs(sin(ph));
    h += amp * wave * depthScale;
  }
  // Beat adds a fast central "drop" impulse that decays outward
  float r = sqrt(x * x + z * z);
  h += uBeat * 3.0 * exp(-r * 0.04) * sin(r * 0.25 - uTime * 5.0);
  return h;
}

void main() {
  vec3 pos = position;

  pos.y = heightAt(pos.x, pos.z);

  // Normals are computed in the fragment shader via dFdx/dFdy of vWorldPos
  // instead (see below) — no need to compute them here too.
  vWorldPos  = pos;
  vHeight    = pos.y;
  vNormX     = (pos.x + 90.0) / 180.0;  // 0..1 for subtle cross-slope colour

  gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
}
`;

// We pass the computed normal through an attribute via a hack: since we
// compute it in the vertex shader, we smuggle it as vWorldPos.w ... but
// there's no vec4 varying for that.  Instead we'll use dFdx/dFdy in the
// fragment shader for normals (screen-space derivatives).

const FRAG = /* glsl */`
precision highp float;

uniform float uSun;     // 0=near horizon, 1=overhead
uniform float uTime;
uniform float uBeat;

varying vec3  vWorldPos;
varying float vHeight;
varying float vNormX;

// The vNormal isn't a varying here — we compute N in the FS.
// We have vWorldPos so we can get screen-space normals via ddx/ddy of height.

void main() {
  // ── Reconstruct normal from screen-space height derivatives ───────────────
  vec3 dPdx = dFdx(vWorldPos);
  vec3 dPdy = dFdy(vWorldPos);
  vec3 N    = normalize(cross(dPdx, dPdy));
  // dFdy may flip sign depending on gl convention; ensure N points up
  if (N.y < 0.0) N = -N;

  // ── Sun direction — elevation controlled by uSun slider ───────────────────
  // uSun 0 → 5° above horizon (max drama)
  // uSun 1 → 70° above horizon (overhead, flat)
  float elev   = mix(0.087, 1.22, uSun);   // radians: ~5° to ~70°
  float azimuth = 0.62;                     // fixed azimuth ~35° for consistent shadows
  vec3 L = normalize(vec3(cos(elev) * cos(azimuth),
                          sin(elev),
                          cos(elev) * sin(azimuth)));

  // ── Sand material ─────────────────────────────────────────────────────────
  // Base sand: warm ochre gradient; peaks lighter (wind-polished), troughs darker
  float heightNorm = clamp(vHeight * 0.08 + 0.5, 0.0, 1.0);
  // Sand tones: dark shadowed (#3d2009) → mid ochre (#c4873a) → pale crest (#e8cfa0)
  vec3 shadowTone = vec3(0.235, 0.125, 0.035);
  vec3 midTone    = vec3(0.769, 0.529, 0.228);
  vec3 crestTone  = vec3(0.910, 0.815, 0.627);
  vec3 sandColor  = mix(mix(shadowTone, midTone, heightNorm), crestTone, heightNorm * heightNorm);

  // Slight warm tint toward the dune's windward side (left→right colour shift)
  sandColor = mix(sandColor, sandColor * vec3(1.05, 0.98, 0.88), vNormX * 0.25);

  // ── Lighting — matte diffuse (roughness≈0.95), no specular ───────────────
  float diff    = max(0.0, dot(N, L));
  // Soften self-shadowing: ambient fills troughs a little
  float ambient = 0.14;
  float light   = ambient + diff * (1.0 - ambient);

  // Subtle sub-surface: peaks scatter warm light slightly
  float sss = pow(max(0.0, dot(N, -L)), 2.0) * 0.08;  // back-scatter tint

  vec3 color = sandColor * light
             + sandColor * vec3(1.0, 0.8, 0.5) * sss;

  // Beat flash: brief warm brightness surge from below
  color += vec3(0.12, 0.06, 0.02) * uBeat * (1.0 - heightNorm);

  // ── Horizon fog: gentle depth-fade to warm dusty haze ─────────────────────
  float dist = length(vWorldPos.xz);
  float fog  = 1.0 - exp(-dist * 0.009);
  vec3 hazeColor = vec3(0.28, 0.20, 0.12);
  color = mix(color, hazeColor, fog * 0.6);

  gl_FragColor = vec4(color, 1.0);
}
`;

// ── Geometry builder ──────────────────────────────────────────────────────────

function buildSandGeo(segments: number): THREE.BufferGeometry {
  const geo = new THREE.PlaneGeometry(180, 180, segments, segments);
  geo.rotateX(-Math.PI / 2);  // make it horizontal (XZ plane)
  return geo;
}

// ── Setup / dispose ───────────────────────────────────────────────────────────

function setup(): void {
  const segments = isMobile ? 50 : 110;

  // Overlay canvas
  threeCanvas = document.createElement('canvas');
  threeCanvas.style.cssText =
    'position:fixed;top:0;left:0;width:100%;height:100%;z-index:10;pointer-events:none;display:block';
  document.body.appendChild(threeCanvas);

  // Renderer — no tone mapping (the sand shader handles its own range)
  renderer = new THREE.WebGLRenderer({
    canvas: threeCanvas,
    antialias: !isMobile,
    alpha: true,
  });
  renderer.setPixelRatio(isMobile ? 1.0 : Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.95;

  // Scene — warm dusty sky
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1a0e06);

  // Camera — low angle looking across the dunes
  camera = new THREE.PerspectiveCamera(52, window.innerWidth / window.innerHeight, 0.2, 400);

  // Sand mesh
  sandGeo = buildSandGeo(segments);
  sandMat = new THREE.ShaderMaterial({
    uniforms: {
      uTime:  uTime,
      uBands: uBands,
      uBeat:  uBeat,
      uDunes: uDunes,
      uDepth: uDepth,
      uSun:   uSun,
    },
    vertexShader:   VERT,
    fragmentShader: FRAG,
    side: THREE.FrontSide,
    extensions: { derivatives: true } as never,
  });
  sandMesh = new THREE.Mesh(sandGeo, sandMat);
  scene.add(sandMesh);

  // Very dim ambient (sky light from above, almost all light comes from shader)
  scene.add(new THREE.AmbientLight(0x0a0704, 0.5));

  // Minimal EffectComposer — just OutputPass for sRGB correction, no bloom
  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
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

export function disposeDune(): void {
  if (!initialized) return;

  sandGeo?.dispose();
  sandMat?.dispose();
  composer?.dispose();
  renderer?.dispose();
  threeCanvas?.remove();

  sandMesh      = null;
  sandGeo       = null;
  sandMat       = null;
  composer      = null;
  renderer      = null;
  scene         = null;
  camera        = null;
  threeCanvas   = null;

  vizModeUnsub?.();
  vizModeUnsub = null;

  time          = 0;
  cameraTheta   = 0;
  beatKick      = 0;
  lastBeatIndex = -1;
  cachedDunes   = -1;

  initialized = false;
}

export function resetDune(): void {
  time          = 0;
  cameraTheta   = 0;
  beatKick      = 0;
  lastBeatIndex = -1;
}

// ── Draw ──────────────────────────────────────────────────────────────────────

export function drawDune(_p: unknown, dt: number): void {
  if (!initialized) setup();
  if (!renderer || !scene || !camera || !composer || !sandMat) return;

  if (threeCanvas) threeCanvas.style.display = 'block';

  const dtSec = dt * 0.016667;
  time += dtSec;
  uTime.value = time;

  const { state, config } = store;
  const { amps }          = getBandAverages(7);

  // ── Detect structural slider change (rebuild geometry) ──────────────────
  const newDunes = config.duneDunes;
  if (newDunes !== cachedDunes) {
    uDunes.value = newDunes;
    cachedDunes  = newDunes;
  }

  // ── Other uniforms ────────────────────────────────────────────────────────
  uDepth.value = config.duneDepth;
  uSun.value   = config.duneSun;

  for (let i = 0; i < 7; i++) {
    uBands.value[i] = amps[i] ?? 0;
  }

  // ── Beat detection ────────────────────────────────────────────────────────
  if (state.beatIntervalSec > 0 && state.isPlaying) {
    const pos     = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    const beatIdx  = adjusted >= 0
      ? Math.floor(adjusted / state.beatIntervalSec)
      : -1;
    if (beatIdx > lastBeatIndex) {
      lastBeatIndex = beatIdx;
      beatKick      = 1.0;
    }
  }
  beatKick *= Math.pow(0.88, dt);
  uBeat.value = beatKick;

  // ── Camera — low angle orbit, continuous gentle drift ─────────────────────
  // Slow orbit so the viewer sees different dune profiles as the angle changes
  cameraTheta += dtSec * 0.035;

  // Overall amplitude for gentle vertical drift
  const overallAmp = (amps.reduce((a, b) => a + b, 0) / 7);
  const camR  = 55;
  const camY  = 5.5 + overallAmp * 2.5 + beatKick * 1.5;
  // Camera sits quite low — sun angle slider also changes the effective height feel

  // Tilted slightly off-axis so we see the dune ridges in perspective
  const offset = 0.35;   // slight lateral offset to avoid dead-on symmetry
  camera.position.set(
    Math.sin(cameraTheta) * camR + offset,
    camY,
    Math.cos(cameraTheta) * camR,
  );
  // Look at a point slightly ahead (not dead center) for asymmetric composition
  camera.lookAt(Math.sin(cameraTheta + 0.4) * 8, 0, Math.cos(cameraTheta + 0.4) * 8);

  composer.render();
}
