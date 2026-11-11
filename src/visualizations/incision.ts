/**
 * Incision — audio-reactive slashed monolith
 *
 * A dark rectangular monolith floats in a void. Seven audio-driven blades
 * cut through it at different angles; as a band grows louder its blade
 * slices deeper, revealing a warm glowing interior. At silence the form is
 * almost whole; at peak amplitude the wounds are wide open, spilling light.
 *
 * Rendered entirely in GLSL via SDF raymarching on a fullscreen quad.
 * The slab exterior is matte warm-grey concrete; cut faces glow with an
 * amber-to-ice palette that the Warmth slider controls. No rainbow per band,
 * no central radial pulse: drama comes from depth, shadow, and material.
 *
 * Camera orbits slowly around the slab. Beat fires a brief push-in impulse
 * that decays continuously rather than snapping to a new state.
 *
 * Inspired by Lucio Fontana "Concetto Spaziale, Attese" (1959-68, Tate
 * Modern) — his famous slashed canvases in which a single gesture tears
 * through the painting surface to reveal void/light beyond the canvas skin.
 * https://www.tate.org.uk/art/artists/lucio-fontana-1092
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
let camera        : THREE.OrthographicCamera | null = null;
let composer      : EffectComposer | null = null;
let quadMesh      : THREE.Mesh | null = null;
let quadMat       : THREE.ShaderMaterial | null = null;
let vizModeUnsub  : (() => void) | null = null;

let time          = 0;
let orbitTheta    = 0;
let orbitPhi      = 0;      // gentle vertical tilt
let beatKick      = 0;      // push-in impulse, decays each frame
let lastBeatIndex = -1;

// ── Uniforms ──────────────────────────────────────────────────────────────────

const uTime      : THREE.IUniform<number>   = { value: 0 };
const uResolution: THREE.IUniform<THREE.Vector2> = { value: new THREE.Vector2(1, 1) };
const uBands     : THREE.IUniform<number[]> = { value: new Array(7).fill(0) };
const uBeat      : THREE.IUniform<number>   = { value: 0 };
const uBlades    : THREE.IUniform<number>   = { value: 7 }; // structural: 1–7 active blades
const uWarmth    : THREE.IUniform<number>   = { value: 0.6 }; // 0=ice, 1=ember
const uGlow      : THREE.IUniform<number>   = { value: 0.5 }; // inner glow brightness
// Camera pos/dir (vec3 each — updated each frame)
const uCamPos    : THREE.IUniform<THREE.Vector3> = { value: new THREE.Vector3(0, 0, 4) };
const uCamFwd    : THREE.IUniform<THREE.Vector3> = { value: new THREE.Vector3(0, 0, -1) };
const uCamRight  : THREE.IUniform<THREE.Vector3> = { value: new THREE.Vector3(1, 0, 0) };
const uCamUp     : THREE.IUniform<THREE.Vector3> = { value: new THREE.Vector3(0, 1, 0) };

// ── GLSL ──────────────────────────────────────────────────────────────────────

const VERT = /* glsl */`
precision highp float;
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const FRAG = /* glsl */`
precision highp float;
varying vec2 vUv;

uniform float uTime;
uniform vec2  uResolution;
uniform float uBands[7];
uniform float uBeat;
uniform float uBlades;    // 1–7 active blades
uniform float uWarmth;    // 0=ice-blue glow, 1=amber ember glow
uniform float uGlow;      // inner emission brightness
uniform vec3  uCamPos;
uniform vec3  uCamFwd;
uniform vec3  uCamRight;
uniform vec3  uCamUp;

// ── Utility ───────────────────────────────────────────────────────────────────

float sdBox(vec3 p, vec3 b) {
  vec3 q = abs(p) - b;
  return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0);
}

// SDF of an infinite plane: dot(p, n) - offset.
// We use an axis-aligned oriented slab of thickness eps.
float sdSlabCut(vec3 p, vec3 n, float offset, float thickness) {
  float d = dot(p, n) - offset;
  return abs(d) - thickness;
}

// ── Blade definitions — 7 planes at distinct angles ───────────────────────────
// Each blade is defined by its normal (precomputed) and an audio-driven depth.
// Deeper amplitude = wider cut (larger depth offset within the slab).

vec3 bladeNormal(int i) {
  // Normals spread across different orientations so cuts look non-parallel
  float a = float(i) * 1.0995574;  // π * 7/20 — irrationally spaced
  float b = float(i) * 0.6283185 + 0.4;
  return normalize(vec3(sin(a) * cos(b), cos(a), sin(a) * sin(b)));
}

// Smooth union (Inigo Quilez)
float smin(float a, float b, float k) {
  float h = max(k - abs(a - b), 0.0) / k;
  return min(a, b) - h * h * h * k / 6.0;
}

// ── Scene SDF ─────────────────────────────────────────────────────────────────

struct Hit {
  float d;         // distance
  int   matID;     // 0=exterior slab, 1=cut-interior, 2=nothing
  int   blade;     // which blade (for per-band color), -1 if slab exterior
  float depth;     // how far inside the cut (for brightness gradient)
};

Hit sceneHit(vec3 p) {
  // Slab: 1.2 wide × 2.0 tall × 0.3 deep, slightly tilted for interest
  vec3 slabP = p;
  float slabD = sdBox(slabP, vec3(1.2, 1.9, 0.28));

  // "Inside the slab" region (eroded core)
  float innerD = sdBox(slabP, vec3(0.95, 1.65, 0.20));

  // We compute the minimum cut distance (most aggressive cut wins)
  float bestCutD = 1e9;
  int   bestBlade = -1;
  float bestDepth = 0.0;

  int activeBlades = int(clamp(uBlades, 1.0, 7.0));

  for (int i = 0; i < 7; i++) {
    if (i >= activeBlades) break;

    // Animate normal slightly over time for organic feel
    vec3 n = bladeNormal(i);
    // A slow gentle rotation makes the cut edge shimmer
    float nt = uTime * (0.03 + float(i) * 0.007);
    vec3 nb = vec3(cos(nt), 0.0, sin(nt)) * 0.08;
    n = normalize(n + nb);

    // Audio-driven cut depth: quiet → almost closed, loud → wide open
    // "Closed" = cut line sits outside the slab boundary → no cut visible
    // "Open"   = cut line sits at slab centre → deep wound
    float amp     = uBands[i] * (0.6 + uGlow * 0.8);
    float cutPos  = mix(-0.5, 0.0, amp);    // negative = outside slab
    float thick   = mix(0.015, 0.09, amp);  // cut thickness grows with amp
    float cutD    = sdSlabCut(slabP, n, cutPos, thick);

    if (cutD < bestCutD) {
      bestCutD   = cutD;
      bestBlade  = i;
      bestDepth  = amp;
    }
  }

  Hit h;
  // Cuts are subtracted from the slab (SDF subtraction = max(slab, -cut))
  // Result: regions where both slab is solid AND cut plane is thin
  float carvingD = max(innerD, -bestCutD);

  if (carvingD < slabD && bestCutD < 0.08) {
    // We are inside the carved region — show cut interior
    h.d     = carvingD;
    h.matID = 1;
    h.blade = bestBlade;
    h.depth = bestDepth;
  } else {
    h.d     = slabD;
    h.matID = 0;
    h.blade = -1;
    h.depth = 0.0;
  }
  return h;
}

float sceneDist(vec3 p) {
  return sceneHit(p).d;
}

// ── Raymarcher ────────────────────────────────────────────────────────────────

#define MAX_STEPS 80
#define MAX_DIST  12.0
#define SURF_EPS  0.002

Hit march(vec3 ro, vec3 rd) {
  float t = 0.02;
  Hit closest;
  closest.d     = MAX_DIST;
  closest.matID = 2;
  closest.blade = -1;
  closest.depth = 0.0;

  for (int i = 0; i < MAX_STEPS; i++) {
    vec3 p  = ro + rd * t;
    Hit  h  = sceneHit(p);
    if (h.d < SURF_EPS) {
      h.d     = t;
      closest = h;
      return closest;
    }
    if (t > MAX_DIST) break;
    t += max(h.d * 0.9, 0.001);
  }
  return closest;
}

// ── Normals via central differences ──────────────────────────────────────────

vec3 calcNormal(vec3 p) {
  vec2 e = vec2(0.001, 0.0);
  return normalize(vec3(
    sceneDist(p + e.xyy) - sceneDist(p - e.xyy),
    sceneDist(p + e.yxy) - sceneDist(p - e.yxy),
    sceneDist(p + e.yyx) - sceneDist(p - e.yyx)
  ));
}

// ── Soft shadow ───────────────────────────────────────────────────────────────

float softShadow(vec3 ro, vec3 rd, float mint, float maxt, float k) {
  float res = 1.0;
  float t   = mint;
  for (int i = 0; i < 20; i++) {
    float h = sceneDist(ro + rd * t);
    if (h < 0.001) return 0.0;
    res  = min(res, k * h / t);
    t   += clamp(h, 0.02, 0.2);
    if (t > maxt) break;
  }
  return clamp(res, 0.0, 1.0);
}

// ── Material / shading ────────────────────────────────────────────────────────

// Inner glow color: warmth=0 → ice blue, warmth=1 → deep amber
vec3 glowColor(int blade, float depth) {
  // Per-blade tint based on a subtle complementary palette
  float hueShift = float(blade) * 0.08;
  // Warm: amber/gold tones; Cool: steel-blue/ice tones
  vec3 warmColor = vec3(1.0, 0.65, 0.2) + vec3(hueShift * 0.2, -hueShift * 0.1, 0.0);
  vec3 coolColor = vec3(0.4, 0.7, 1.0) + vec3(-hueShift * 0.05, 0.0, hueShift * 0.1);
  vec3 baseGlow  = mix(coolColor, warmColor, uWarmth);
  // Brighter toward the edge of the cut (surface-emission glow)
  float rim = 1.0 - clamp(depth * 2.0, 0.0, 1.0);
  return baseGlow * (0.6 + rim * 1.4) * (0.5 + uGlow * 1.5);
}

void main() {
  // ── Set up ray from camera uniforms ─────────────────────────────────────────
  vec2 uv = (vUv * 2.0 - 1.0);
  uv.x *= uResolution.x / uResolution.y;

  vec3 ro = uCamPos;
  float fov = 0.75 + uBeat * 0.08;  // slight FOV kick on beat
  vec3 rd = normalize(uCamFwd + uv.x * uCamRight * fov + uv.y * uCamUp * fov);

  // ── March ──────────────────────────────────────────────────────────────────
  Hit hit = march(ro, rd);

  // ── Background ─────────────────────────────────────────────────────────────
  if (hit.matID == 2) {
    // Dark space — very subtle warm-to-cool gradient
    float vy     = vUv.y;
    vec3  bgTop  = vec3(0.03, 0.025, 0.04);  // deep violet-black above
    vec3  bgBot  = vec3(0.02, 0.016, 0.012); // near-black below
    vec3  bg     = mix(bgBot, bgTop, vy);
    // Faint ambient from the glowing cuts illuminating surroundings
    float gTotal = 0.0;
    for (int b = 0; b < 7; b++) gTotal += uBands[b];
    vec3 warmAmb = mix(vec3(0.3, 0.6, 1.0), vec3(1.0, 0.5, 0.1), uWarmth);
    bg += warmAmb * gTotal * 0.012;
    gl_FragColor = vec4(bg, 1.0);
    return;
  }

  vec3 p = ro + rd * hit.d;
  vec3 N = calcNormal(p);

  // ── Lighting setup: two-point studio rig ──────────────────────────────────
  // Key: warm-amber from upper-right; Fill: cool steel from lower-left
  vec3 keyDir  = normalize(vec3( 1.6, 2.0,  1.0));
  vec3 fillDir = normalize(vec3(-1.2, -0.5, 0.8));

  float keyDiff  = max(0.0, dot(N, keyDir));
  float fillDiff = max(0.0, dot(N, fillDir)) * 0.3;
  float ambOcc   = 0.15;

  float sha = softShadow(p + N * 0.01, keyDir, 0.02, 4.0, 8.0);

  if (hit.matID == 0) {
    // ── Exterior slab — matte warm-grey concrete ───────────────────────────
    // Slight warm gradient from lit top to shadowed bottom
    float yFrac  = clamp(p.y / 1.9 * 0.5 + 0.5, 0.0, 1.0);
    vec3 concrete = mix(vec3(0.14, 0.12, 0.11), vec3(0.22, 0.20, 0.19), yFrac);
    // Add a very faint warmth tint from the inner glow (light seeping through)
    float gTotal = 0.0;
    for (int b = 0; b < 7; b++) gTotal += uBands[b];
    vec3 warmAmb = mix(vec3(0.4, 0.6, 1.0), vec3(1.0, 0.65, 0.3), uWarmth);
    concrete += warmAmb * gTotal * 0.025 * uGlow;

    vec3 keyColor  = vec3(1.0,  0.88, 0.70) * keyDiff * sha;
    vec3 fillColor = vec3(0.55, 0.65, 0.80) * fillDiff;
    vec3 color     = concrete * (keyColor + fillColor + ambOcc);

    // Specular: faint micro-facet glint (not polished, so very low)
    vec3 H         = normalize(keyDir - rd);
    float spec     = pow(max(0.0, dot(N, H)), 24.0) * 0.04 * sha;
    color += vec3(1.0, 0.95, 0.85) * spec;

    // Depth fog
    float fog = 1.0 - exp(-hit.d * 0.08);
    color = mix(color, vec3(0.02, 0.016, 0.012), fog * 0.4);

    gl_FragColor = vec4(color, 1.0);
  } else {
    // ── Cut interior — warm/cool emission ─────────────────────────────────
    vec3 gCol = glowColor(hit.blade, hit.depth);

    // The cut face has a slight diffuse component (it's a solid cross-section)
    // but mostly it emits: the deeper you peer into the wound, the brighter
    float innerDiff = max(0.0, dot(N, keyDir)) * 0.15;
    float innerFill = max(0.0, dot(N, fillDir)) * 0.08;

    // Beat briefly brightens the cut flash
    float beatFlash = uBeat * 0.4;
    float glowStr   = (0.7 + innerDiff + innerFill) * (1.0 + beatFlash);

    vec3 color = gCol * glowStr;

    // Thin bright rim at the cut edge (the "knife edge" of the wound)
    float fresnel = pow(1.0 - abs(dot(N, -rd)), 3.0);
    color += gCol * fresnel * 1.2;

    gl_FragColor = vec4(color, 1.0);
  }
}
`;

// ── Setup / dispose ───────────────────────────────────────────────────────────

function setup(): void {
  threeCanvas = document.createElement('canvas');
  threeCanvas.style.cssText =
    'position:fixed;top:0;left:0;width:100%;height:100%;z-index:10;pointer-events:none;display:block';
  document.body.appendChild(threeCanvas);

  renderer = new THREE.WebGLRenderer({
    canvas:   threeCanvas,
    antialias: !isMobile,
    alpha:    true,
  });
  renderer.setPixelRatio(isMobile ? 1.0 : Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;

  scene = new THREE.Scene();

  // We use an OrthographicCamera just to drive the renderer — the actual
  // perspective is computed manually in the GLSL raymarcher.
  camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  uResolution.value.set(window.innerWidth, window.innerHeight);

  // Fullscreen quad
  const geo = new THREE.PlaneGeometry(2, 2);
  quadMat = new THREE.ShaderMaterial({
    uniforms: {
      uTime:       uTime,
      uResolution: uResolution,
      uBands:      uBands,
      uBeat:       uBeat,
      uBlades:     uBlades,
      uWarmth:     uWarmth,
      uGlow:       uGlow,
      uCamPos:     uCamPos,
      uCamFwd:     uCamFwd,
      uCamRight:   uCamRight,
      uCamUp:      uCamUp,
    },
    vertexShader:   VERT,
    fragmentShader: FRAG,
    depthTest:      false,
  });
  quadMesh = new THREE.Mesh(geo, quadMat);
  scene.add(quadMesh);

  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  composer.addPass(new OutputPass());

  const onResize = () => {
    if (!renderer || !composer) return;
    renderer.setSize(window.innerWidth, window.innerHeight);
    composer.setSize(window.innerWidth, window.innerHeight);
    uResolution.value.set(window.innerWidth, window.innerHeight);
  };
  window.addEventListener('resize', onResize);

  vizModeUnsub = store.on('vizModeChange', () => {
    if (threeCanvas) threeCanvas.style.display = 'none';
  });

  initialized = true;
}

export function disposeIncision(): void {
  if (!initialized) return;

  quadMat?.dispose();
  (quadMesh?.geometry as THREE.BufferGeometry | undefined)?.dispose();
  composer?.dispose();
  renderer?.dispose();
  threeCanvas?.remove();

  quadMesh    = null;
  quadMat     = null;
  composer    = null;
  renderer    = null;
  scene       = null;
  camera      = null;
  threeCanvas = null;

  vizModeUnsub?.();
  vizModeUnsub = null;

  time          = 0;
  orbitTheta    = 0;
  orbitPhi      = 0;
  beatKick      = 0;
  lastBeatIndex = -1;

  initialized = false;
}

export function resetIncision(): void {
  time          = 0;
  orbitTheta    = 0;
  orbitPhi      = 0;
  beatKick      = 0;
  lastBeatIndex = -1;
}

// ── Draw ──────────────────────────────────────────────────────────────────────

export function drawIncision(_p: unknown, dt: number): void {
  if (!initialized) setup();
  if (!renderer || !scene || !camera || !composer || !quadMat) return;

  if (threeCanvas) threeCanvas.style.display = 'block';

  const dtSec = dt * 0.016667;
  time += dtSec;
  uTime.value = time;

  const { state, config } = store;
  const { amps }          = getBandAverages(7);

  // ── Update uniforms from sliders ────────────────────────────────────────
  uBlades.value  = Math.round(1 + config.incisionBlades * 6); // 1–7 (structural)
  uWarmth.value  = config.incisionWarmth;
  uGlow.value    = config.incisionGlow;

  for (let i = 0; i < 7; i++) {
    uBands.value[i] = amps[i] ?? 0;
  }

  // ── Beat detection ────────────────────────────────────────────────────────
  if (state.beatIntervalSec > 0 && state.isPlaying) {
    const pos      = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    const beatIdx  = adjusted >= 0
      ? Math.floor(adjusted / state.beatIntervalSec)
      : -1;
    if (beatIdx > lastBeatIndex) {
      lastBeatIndex = beatIdx;
      beatKick      = 1.0;  // adds brief push-in impulse
    }
  }
  beatKick *= Math.pow(0.82, dt);
  uBeat.value = beatKick;

  // ── Camera orbit — slow continuous rotation around the slab ──────────────
  const overallAmp = amps.reduce((a, b) => a + b, 0) / 7;

  // Theta drifts slowly, amplitude nudges the speed
  orbitTheta += dtSec * (0.08 + overallAmp * 0.04);
  // Phi (vertical tilt) oscillates gently with a long period
  orbitPhi    = Math.sin(time * 0.11) * 0.22;

  // Camera sits at ~4–5 units out; beat pushes it in momentarily
  const camDist = 4.2 - beatKick * 0.9 + overallAmp * 0.3;

  const cx = Math.sin(orbitTheta) * Math.cos(orbitPhi) * camDist;
  const cy = Math.sin(orbitPhi)   * camDist * 0.6 + 0.1;   // slight vertical offset
  const cz = Math.cos(orbitTheta) * Math.cos(orbitPhi) * camDist;

  const camPos = new THREE.Vector3(cx, cy, cz);
  // Look slightly above centre so the full slab is in frame
  const target = new THREE.Vector3(0.0, 0.1, 0.0);

  const fwd   = target.clone().sub(camPos).normalize();
  const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize();
  const up    = new THREE.Vector3().crossVectors(right, fwd).normalize();

  uCamPos.value.copy(camPos);
  uCamFwd.value.copy(fwd);
  uCamRight.value.copy(right);
  uCamUp.value.copy(up);

  composer.render();
}
