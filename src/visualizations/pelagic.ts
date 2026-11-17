/**
 * Pelagic — underwater view looking up through a disturbed water surface
 *
 * Camera sits in the water column below the surface looking upward.
 * The surface is displaced by 7 sinusoidal wave modes driven by the
 * frequency bands; looking through the glass-like surface you see
 * Snell's window — the compressed circular portal to the sky where
 * the total-internal-reflection critical angle (~48.5° in water) creates
 * a sharp boundary between a bright sky-disc overhead and a dark,
 * mirror-like surface at oblique angles.
 *
 * The seafloor below the camera catches approximate analytical caustic
 * patterns generated from the same wave field. Small luminous particles
 * drift in the water column.
 *
 * Palette: deep navy water, pale cyan-blue Snell's window, warm-white sun
 * highlight, cool steel-blue caustics. No rainbow hue-per-band.
 * Beat fires a pressure kick from a random sub-surface position (not a
 * radial ring from centre).
 *
 * Inspired by Andreas Franke's underwater photography "The Sinking World"
 * series (2010–, https://andreasfranke.com/) and the Snell's window /
 * total-internal-reflection optics that give underwater photography its
 * distinctive circular sky portal; also Marshmallow Laser Feast
 * "We Live in an Ocean of Air" (Saatchi Gallery London, 2019,
 * https://www.marshmallowlaserfeast.com/experiences/ocean-of-air/).
 *
 * Sliders
 *   Depth   — structural: camera depth below surface (0=just beneath→1=deep)
 *   Chop    — wave amplitude / surface turbulence (0=glassy→1=stormy)
 *   Clarity — water turbidity (0=murky dark→1=crystal clear bright floor)
 */

import * as THREE from 'three';
import { EffectComposer }   from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass }       from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass }  from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass }       from 'three/addons/postprocessing/OutputPass.js';
import { store }            from '../state/store';
import { getBandAverages }  from './helpers';
import { audioEngine }      from '../audio/engine';
import { isMobile }         from '../utils/constants';

// ── Module state ──────────────────────────────────────────────────────────────

let initialized    = false;
let threeCanvas:   HTMLCanvasElement | null = null;
let renderer:      THREE.WebGLRenderer   | null = null;
let scene:         THREE.Scene           | null = null;
let camera:        THREE.PerspectiveCamera | null = null;
let composer:      EffectComposer        | null = null;
let surfaceMesh:   THREE.Mesh            | null = null;
let floorMesh:     THREE.Mesh            | null = null;
let particles:     THREE.Points          | null = null;
let surfaceMat:    THREE.ShaderMaterial  | null = null;
let floorMat:      THREE.ShaderMaterial  | null = null;
let particleMat:   THREE.ShaderMaterial  | null = null;
let resizeHandler: (() => void)          | null = null;
let vizUnsub:      (() => void)          | null = null;

let time          = 0;
let lastBeatIndex = -1;
let beatKick      = 0;      // decaying kick amplitude
let beatKickX     = 0;      // random X position of kick
let beatKickZ     = 0;      // random Z position of kick
let cameraAngle   = 0;      // slow horizontal orbit

// ── Uniforms ──────────────────────────────────────────────────────────────────

const uTime:      THREE.IUniform<number>   = { value: 0 };
const uBands:     THREE.IUniform<number[]> = { value: new Array(7).fill(0) };
const uBeatKick:  THREE.IUniform<number>   = { value: 0 };
const uBeatKickX: THREE.IUniform<number>   = { value: 0 };
const uBeatKickZ: THREE.IUniform<number>   = { value: 0 };
const uChop:      THREE.IUniform<number>   = { value: 0.5 };
const uClarity:   THREE.IUniform<number>   = { value: 0.5 };
const uCamY:      THREE.IUniform<number>   = { value: -6 };

// ── Shaders ───────────────────────────────────────────────────────────────────

// Shared wave displacement function used in both surface and floor shaders.
// 7 band-driven sinusoidal modes at increasing spatial frequencies.
const WAVE_GLSL = /* glsl */`
float waveHeight(vec2 xz, float bands[7], float t, float chop) {
  float h = 0.0;
  // Sub-bass: large lazy swells
  h += bands[0] * 4.0 * sin(xz.x * 0.013 + xz.y * 0.011 + t * 0.38);
  h += bands[0] * 2.5 * sin(xz.x * 0.009 - xz.y * 0.015 + t * 0.27);
  // Bass: medium waves
  h += bands[1] * 2.2 * sin(xz.x * 0.022 + xz.y * 0.019 + t * 0.65);
  h += bands[1] * 1.8 * sin(-xz.x * 0.018 + xz.y * 0.026 + t * 0.78);
  // Low-mid: medium ripples
  h += bands[2] * 1.3 * sin(xz.x * 0.045 + xz.y * 0.038 + t * 1.15);
  h += bands[2] * 1.0 * sin(-xz.x * 0.034 + xz.y * 0.042 + t * 0.95);
  // Mid: small ripples
  h += bands[3] * 0.8 * sin(xz.x * 0.078 + xz.y * 0.065 + t * 1.70);
  h += bands[3] * 0.6 * sin(-xz.x * 0.062 + xz.y * 0.082 + t * 1.45);
  // Upper-mid: fast small ripples
  h += bands[4] * 0.45 * sin(xz.x * 0.130 + xz.y * 0.110 + t * 2.40);
  // Presence: micro ripples
  h += bands[5] * 0.28 * sin(xz.x * 0.200 + xz.y * 0.165 + t * 3.20);
  // Brilliance: fine shimmer
  h += bands[6] * 0.18 * sin(xz.x * 0.300 + xz.y * 0.260 + t * 4.80);
  return h * (chop * 1.8 + 0.15);
}
`;

// Water surface vertex shader — displaces the plane in Y
const SURFACE_VERT = /* glsl */`
uniform float uTime;
uniform float uBands[7];
uniform float uBeatKick;
uniform float uBeatKickX;
uniform float uBeatKickZ;
uniform float uChop;

varying vec3  vWorldPos;
varying vec3  vNormal;
varying vec2  vUV;

${WAVE_GLSL}

void main() {
  float h = waveHeight(position.xz, uBands, uTime, uChop);

  // Pressure wave from beat kick (Gaussian bump at random position)
  vec2  toKick  = position.xz - vec2(uBeatKickX, uBeatKickZ);
  float kickDist = length(toKick);
  h += uBeatKick * 3.5 * exp(-kickDist * kickDist * 0.0025);

  vec3 displaced = vec3(position.x, h, position.z);

  // Approximate normal via finite differences on wave function
  float eps = 0.5;
  float hx = waveHeight(position.xz + vec2(eps, 0.0), uBands, uTime, uChop);
  float hz = waveHeight(position.xz + vec2(0.0, eps), uBands, uTime, uChop);
  vNormal = normalize(vec3(h - hx, eps, h - hz));

  vWorldPos = displaced;
  vUV       = uv;

  gl_Position = projectionMatrix * modelViewMatrix * vec4(displaced, 1.0);
}
`;

// Water surface fragment shader — Snell's window effect from below
// Inside the critical angle (~48.5° in water): transparent portal to sky
// Outside: total internal reflection, mirror-dark
const SURFACE_FRAG = /* glsl */`
uniform float uTime;
uniform float uBands[7];
uniform float uCamY;
uniform float uChop;

varying vec3  vWorldPos;
varying vec3  vNormal;
varying vec2  vUV;

void main() {
  // Vector from surface point to camera (we are below, looking up)
  vec3  surfToCamera = normalize(cameraPosition - vWorldPos);

  // The surface normal points upward (away from water bulk, into air)
  // We render from below, so we use the downward-facing normal
  vec3  n = normalize(vNormal);
  if (n.y > 0.0) n = -n;   // ensure it points downward (into camera view)

  // cos(angle from vertical) — 1=straight up, 0=horizontal
  float cosTheta = max(0.0, dot(-surfToCamera, n));

  // Snell's window: critical angle in water is ~48.5° → cos(48.5°) ≈ 0.661
  // Inside window: view through to sky; outside: total internal reflection
  float snellCrit = 0.661;
  float window = smoothstep(snellCrit - 0.06, snellCrit + 0.06, cosTheta);

  // ── Sky inside Snell's window ──────────────────────────────────────────
  // Sun position: fixed upper-left of sky
  vec3 sunDir = normalize(vec3(-0.4, 0.85, 0.3));
  float sunDot = max(0.0, dot(surfToCamera, sunDir));
  float sunGlow   = pow(sunDot, 32.0);
  float sunCorona = pow(sunDot, 6.0) * 0.4;

  vec3 skyDeep  = vec3(0.08, 0.28, 0.65);  // deep sky blue
  vec3 skyHoriz = vec3(0.45, 0.72, 0.95);  // horizon blue-white
  vec3 skyColor = mix(skyHoriz, skyDeep, cosTheta);
  skyColor += vec3(1.0, 0.98, 0.9) * (sunGlow + sunCorona);

  // Caustic shimmer visible through the window
  float causticShimmer =
    sin(vWorldPos.x * 0.6 + uTime * 1.8) *
    sin(vWorldPos.z * 0.55 + uTime * 1.4);
  causticShimmer = pow(abs(causticShimmer), 2.0) * 0.18;
  skyColor += vec3(0.7, 0.9, 1.0) * causticShimmer;

  // ── Mirror outside Snell's window ─────────────────────────────────────
  // Dark mirror reflection — reflects deep water / seafloor colours
  vec3 mirrorColor = vec3(0.012, 0.028, 0.065);
  // Faint structural colour from bands: subtle band-driven tint
  float bandSum = 0.0;
  for (int i = 0; i < 7; i++) bandSum += uBands[i];
  mirrorColor += vec3(0.02, 0.06, 0.12) * (bandSum * 0.08);

  // Specular highlight on the mirror part from the sun
  float mirrorSpec = pow(max(0.0, dot(reflect(surfToCamera, n), sunDir)), 24.0);
  mirrorColor += vec3(0.5, 0.65, 0.85) * mirrorSpec * 0.5;

  // ── Compose ───────────────────────────────────────────────────────────
  vec3  finalColor = mix(mirrorColor, skyColor, window);
  float alpha      = mix(0.92, 0.55, window * uChop * 0.3 + 0.1);

  gl_FragColor = vec4(finalColor, alpha);
}
`;

// Seafloor fragment shader — caustic light patterns from above
const FLOOR_FRAG = /* glsl */`
uniform float uTime;
uniform float uBands[7];
uniform float uClarity;
uniform float uBeatKick;
uniform float uBeatKickX;
uniform float uBeatKickZ;
uniform float uChop;

varying vec3 vWorldPos;
varying vec2 vUV;

void main() {
  // Base floor colour: dark wet sand / stone
  vec3 sandColor = vec3(0.055, 0.075, 0.11);

  // Caustic light — sum of overlapping sine waves creating bright lines
  // where constructive interference occurs (simulates real caustic physics)
  float c = 0.0;
  c += sin(vWorldPos.x * (0.28 + uBands[0] * 0.12) + uTime * 0.42) *
       sin(vWorldPos.z * (0.25 + uBands[0] * 0.10) + uTime * 0.35);
  c += sin(vWorldPos.x * (0.46 + uBands[1] * 0.15) + uTime * 0.68) *
       sin(vWorldPos.z * (0.42 + uBands[1] * 0.14) + uTime * 0.55);
  c += sin(vWorldPos.x * (0.75 + uBands[2] * 0.20) + uTime * 1.10) *
       sin(vWorldPos.z * (0.70 + uBands[2] * 0.18) + uTime * 0.90);
  c += sin(vWorldPos.x * (1.20 + uBands[3] * 0.25) + uTime * 1.75) *
       sin(vWorldPos.z * (1.10 + uBands[3] * 0.22) + uTime * 1.50);

  // Sharpen into bright focal lines (caustics are narrow bright bands)
  c = pow(c * 0.5 + 0.5, 5.0);

  // Caustic colour: warm sun-gold to cool steel-blue
  float bandBalance = (uBands[0] + uBands[1]) * 0.5 - (uBands[5] + uBands[6]) * 0.5;
  vec3 causticColor = mix(
    vec3(0.35, 0.65, 1.00),  // cool blue
    vec3(0.90, 0.85, 0.65),  // warm gold
    clamp(bandBalance * 1.5 + 0.5, 0.0, 1.0)
  );

  // Beat kick pressure shadow (darkening in impact zone)
  vec2  toKick  = vWorldPos.xz - vec2(uBeatKickX, uBeatKickZ);
  float kickRad = length(toKick);
  float kickShadow = uBeatKick * 0.4 * exp(-kickRad * kickRad * 0.001);

  // Compose: floor + caustic + beat shadow
  vec3 lit = sandColor + causticColor * c * uClarity * 0.65;
  lit -= vec3(kickShadow);
  lit = clamp(lit, 0.0, 1.0);

  // Distance fade (further = darker, simulates underwater light absorption)
  float distFromCam = length(vWorldPos - cameraPosition);
  float fade = exp(-distFromCam * (0.03 + (1.0 - uClarity) * 0.06));
  lit *= fade;

  gl_FragColor = vec4(lit, 1.0);
}
`;

const FLOOR_VERT = /* glsl */`
varying vec3 vWorldPos;
varying vec2 vUV;

void main() {
  vWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;
  vUV = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

// Particle vertex shader — luminous motes drifting in the water column
const PARTICLE_VERT = /* glsl */`
attribute float aPhase;
attribute float aBand;

uniform float uTime;
uniform float uBands[7];
uniform float uClarity;

varying float vAlpha;
varying float vBand;

void main() {
  // Gentle upward drift with sine wobble
  vec3 pos = position;
  float speed = 0.012 + aBand * 0.006;
  float drift = mod(pos.y + uTime * speed, 28.0) - 14.0;
  pos.y = drift;

  // Side wobble
  pos.x += sin(uTime * 0.6 + aPhase * 6.28) * 0.4;
  pos.z += cos(uTime * 0.5 + aPhase * 4.71) * 0.4;

  // Fade near floor and near surface
  float yNorm = (pos.y + 14.0) / 28.0; // 0=floor, 1=surface
  float edge  = smoothstep(0.0, 0.1, yNorm) * smoothstep(1.0, 0.85, yNorm);

  // Brightness from corresponding band
  int bi = clamp(int(aBand * 6.99), 0, 6);
  float bandVal = uBands[bi];
  vAlpha = edge * (0.15 + bandVal * 0.55) * uClarity;
  vBand  = aBand;

  vec4 mvPos = modelViewMatrix * vec4(pos, 1.0);
  gl_PointSize = max(1.0, (2.5 + bandVal * 2.0) / -mvPos.z * 400.0);
  gl_Position  = projectionMatrix * mvPos;
}
`;

const PARTICLE_FRAG = /* glsl */`
varying float vAlpha;
varying float vBand;

void main() {
  // Soft circular point
  vec2 uv = gl_PointCoord * 2.0 - 1.0;
  float r = dot(uv, uv);
  if (r > 1.0) discard;
  float soft = 1.0 - r;

  // Colour by band: blue (sub-bass) → cyan (mids) → pale white (highs)
  vec3 col = mix(
    vec3(0.3, 0.6, 1.0),   // sub-bass blue
    vec3(0.8, 0.95, 1.0),  // brilliance pale white
    vBand
  );

  gl_FragColor = vec4(col, vAlpha * soft);
}
`;

// ── Setup ─────────────────────────────────────────────────────────────────────

function buildParticles(count: number): THREE.Points {
  const positions = new Float32Array(count * 3);
  const phases    = new Float32Array(count);
  const bands     = new Float32Array(count);

  for (let i = 0; i < count; i++) {
    // Distribute in a wide column spanning the water depth
    positions[i * 3 + 0] = (Math.random() - 0.5) * 60;
    positions[i * 3 + 1] = (Math.random() - 0.5) * 28;
    positions[i * 3 + 2] = (Math.random() - 0.5) * 60;
    phases[i] = Math.random();
    bands[i]  = Math.random();
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('aPhase',   new THREE.BufferAttribute(phases,    1));
  geo.setAttribute('aBand',    new THREE.BufferAttribute(bands,     1));

  const mat = new THREE.ShaderMaterial({
    vertexShader:   PARTICLE_VERT,
    fragmentShader: PARTICLE_FRAG,
    uniforms: {
      uTime:    uTime,
      uBands:   uBands,
      uClarity: uClarity,
    },
    transparent: true,
    depthWrite:  false,
    blending:    THREE.AdditiveBlending,
  });
  particleMat = mat;

  return new THREE.Points(geo, mat);
}

function setup(): void {
  threeCanvas = document.createElement('canvas');
  threeCanvas.style.cssText =
    'position:fixed;top:0;left:0;width:100%;height:100%;z-index:10;pointer-events:none;display:block';
  document.body.appendChild(threeCanvas);

  // ── Renderer ──────────────────────────────────────────────────────────
  renderer = new THREE.WebGLRenderer({ canvas: threeCanvas, antialias: !isMobile, alpha: false });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, isMobile ? 1 : 2));
  renderer.toneMapping    = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  // ── Scene ─────────────────────────────────────────────────────────────
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x010812); // deep underwater dark
  scene.fog = new THREE.FogExp2(0x010812, 0.012);

  // ── Camera — positioned below surface, looking upward and forward ─────
  camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 300);
  camera.position.set(8, -6, 8);
  camera.lookAt(0, 2, 0);

  // ── Water surface geometry ────────────────────────────────────────────
  const surfSegs = isMobile ? 64 : 128;
  const surfGeo  = new THREE.PlaneGeometry(140, 140, surfSegs, surfSegs);
  surfGeo.rotateX(0); // already in XZ plane via PlaneGeometry defaults → no, PlaneGeometry is XY

  // PlaneGeometry is in XY plane; rotate to XZ so it's a horizontal surface
  surfGeo.rotateX(-Math.PI / 2);

  const sharedUniforms = {
    uTime:      uTime,
    uBands:     uBands,
    uBeatKick:  uBeatKick,
    uBeatKickX: uBeatKickX,
    uBeatKickZ: uBeatKickZ,
    uChop:      uChop,
    uClarity:   uClarity,
    uCamY:      uCamY,
  };

  surfaceMat = new THREE.ShaderMaterial({
    vertexShader:   SURFACE_VERT,
    fragmentShader: SURFACE_FRAG,
    uniforms:       sharedUniforms,
    transparent:    true,
    depthWrite:     false,
    side:           THREE.DoubleSide,
    blending:       THREE.NormalBlending,
  });

  surfaceMesh = new THREE.Mesh(surfGeo, surfaceMat);
  surfaceMesh.position.y = 0;
  scene.add(surfaceMesh);

  // ── Seafloor ──────────────────────────────────────────────────────────
  const floorGeo = new THREE.PlaneGeometry(200, 200, 2, 2);
  floorGeo.rotateX(-Math.PI / 2);

  floorMat = new THREE.ShaderMaterial({
    vertexShader:   FLOOR_VERT,
    fragmentShader: FLOOR_FRAG,
    uniforms: {
      uTime:      uTime,
      uBands:     uBands,
      uClarity:   uClarity,
      uBeatKick:  uBeatKick,
      uBeatKickX: uBeatKickX,
      uBeatKickZ: uBeatKickZ,
      uChop:      uChop,
    },
  });

  floorMesh = new THREE.Mesh(floorGeo, floorMat);
  floorMesh.position.y = -22;
  scene.add(floorMesh);

  // ── Ambient & directional lights (supplementary — shaders do most work) ──
  scene.add(new THREE.AmbientLight(0x060e1e, 1.0));

  const sunLight = new THREE.DirectionalLight(0xd8eaff, 0.4);
  sunLight.position.set(-10, 20, 5);
  scene.add(sunLight);

  // ── Particles ─────────────────────────────────────────────────────────
  const particleCount = isMobile ? 400 : 1800;
  particles = buildParticles(particleCount);
  scene.add(particles);

  // ── Post-processing ───────────────────────────────────────────────────
  const res = new THREE.Vector2(window.innerWidth, window.innerHeight);
  composer  = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  if (!isMobile) {
    composer.addPass(new UnrealBloomPass(res, 0.6, 0.4, 0.8));
  }
  composer.addPass(new OutputPass());

  // ── Resize handling ───────────────────────────────────────────────────
  resizeHandler = () => {
    if (!camera || !renderer || !composer) return;
    const w = window.innerWidth;
    const h = window.innerHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    composer.setSize(w, h);
  };
  window.addEventListener('resize', resizeHandler);

  // ── Hide canvas when switching away ──────────────────────────────────
  vizUnsub = store.on('vizModeChange', (mode) => {
    if (!threeCanvas) return;
    threeCanvas.style.display = mode === 'pelagic' ? 'block' : 'none';
  });

  initialized = true;
}

// ── Draw ──────────────────────────────────────────────────────────────────────

export function drawPelagic(_p: unknown, dt: number): void {
  if (!initialized) setup();

  time       += dt * 0.016;
  cameraAngle += dt * 0.0012; // very slow orbit

  const { amps }   = getBandAverages(7);
  const { config } = store;

  // Slider values
  const depthT   = config.pelagicDepth;   // 0–1
  const chopVal  = config.pelagicChop;    // 0–1
  const clarity  = config.pelagicClarity; // 0–1

  // Camera depth below surface: 3 (just below) → 20 (deep)
  const camDepth = depthT * 17 + 3;

  // ── Beat detection ────────────────────────────────────────────────────
  const { state } = store;
  if (state.beatIntervalSec > 0 && state.isPlaying) {
    const pos      = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    const beatIdx  = adjusted >= 0 ? Math.floor(adjusted / state.beatIntervalSec) : -1;
    if (beatIdx > lastBeatIndex) {
      lastBeatIndex = beatIdx;
      beatKick      = 1.0;
      // Random off-centre kick position
      beatKickX = (Math.random() - 0.5) * 30;
      beatKickZ = (Math.random() - 0.5) * 30;
    }
  }

  // Continuous kick decay (CHOP-style)
  beatKick *= Math.pow(0.88, dt);

  // ── Update uniforms ───────────────────────────────────────────────────
  uTime.value      = time;
  uBands.value     = amps.slice();
  uBeatKick.value  = beatKick;
  uBeatKickX.value = beatKickX;
  uBeatKickZ.value = beatKickZ;
  uChop.value      = chopVal;
  uClarity.value   = clarity;
  uCamY.value      = -camDepth;

  // ── Camera orbit ──────────────────────────────────────────────────────
  if (camera) {
    const orbitR = 8 + depthT * 4; // slightly wider orbit when deep
    const camX   = Math.sin(cameraAngle) * orbitR;
    const camZ   = Math.cos(cameraAngle) * orbitR;

    // Gentle handheld float driven by bass + sub
    const bassFloat = amps[0] * 0.3 + amps[1] * 0.15;

    camera.position.set(camX, -camDepth + bassFloat, camZ);

    // Look toward the surface centre, slightly into the water ahead
    const lookX = camX * 0.15;
    const lookZ = camZ * 0.15 - 4;
    camera.lookAt(lookX, 1.5, lookZ);
  }

  // ── Render ────────────────────────────────────────────────────────────
  if (composer) composer.render();
}

// ── Reset ─────────────────────────────────────────────────────────────────────

export function resetPelagic(): void {
  time          = 0;
  cameraAngle   = 0;
  beatKick      = 0;
  lastBeatIndex = -1;
}

// ── Dispose ───────────────────────────────────────────────────────────────────

export function disposePelagic(): void {
  if (vizUnsub)      { vizUnsub();      vizUnsub = null;      }
  if (resizeHandler) {
    window.removeEventListener('resize', resizeHandler);
    resizeHandler = null;
  }

  // Dispose geometries and materials
  if (surfaceMesh) {
    surfaceMesh.geometry.dispose();
    surfaceMesh = null;
  }
  if (floorMesh) {
    floorMesh.geometry.dispose();
    floorMesh = null;
  }
  if (particles) {
    particles.geometry.dispose();
    particles = null;
  }
  surfaceMat?.dispose();  surfaceMat  = null;
  floorMat?.dispose();    floorMat    = null;
  particleMat?.dispose(); particleMat = null;

  // Dispose composer render targets
  composer?.dispose();
  composer = null;

  // Dispose renderer and remove canvas
  renderer?.dispose();
  renderer = null;

  if (threeCanvas?.parentNode) {
    threeCanvas.parentNode.removeChild(threeCanvas);
  }
  threeCanvas = null;

  scene         = null;
  camera        = null;
  initialized   = false;
  time          = 0;
  cameraAngle   = 0;
  beatKick      = 0;
  lastBeatIndex = -1;
}
