/**
 * Oscillograph — 3D Lissajous phase sculpture
 *
 * Seven Lissajous curves (one per frequency band) trace phosphor-lit paths
 * through a perspective 3D space. A ping-pong feedback buffer accumulates
 * the screen traces with configurable decay, building complex sculptural forms
 * over time as phases drift continuously. An orbital camera slowly reveals the
 * 3D depth of the sculpture. Beat fires a camera velocity impulse + warm flash.
 *
 * Restrained palette: pale amber→white→cool-blue phosphor gradient per band
 * on near-black — no rainbow, no neon glow, no centre-pulse.
 * All parameters ease continuously toward audio-driven targets (CHOP-style).
 *
 * Inspired by Jerobeam Fenderson & Hansi Raber "n-spheres" (2024):
 * https://oscilloscopemusic.com/
 * The most complex 3D Lissajous oscilloscope-music work to date — six years
 * in development, pure parametric curves encoded as stereo audio.
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { isMobile } from '../utils/constants';

// ── Module state ──────────────────────────────────────────────────────────────

let initialized = false;
let threeCanvas: HTMLCanvasElement | null = null;
let renderer: THREE.WebGLRenderer | null = null;
let frameIdx = 0;

// 3D Lissajous line scene
let curveScene: THREE.Scene | null = null;
let perspCamera: THREE.PerspectiveCamera | null = null;

// Feedback ping-pong (screen-space phosphor accumulation)
let fbScene: THREE.Scene | null = null;
let fbCamera: THREE.OrthographicCamera | null = null;
let fbQuad: THREE.Mesh | null = null;
let fbMat: THREE.ShaderMaterial | null = null;
let fboA: THREE.WebGLRenderTarget | null = null;
let fboB: THREE.WebGLRenderTarget | null = null;

// Display scene (accumulated FBO → bloom → screen)
let displayScene: THREE.Scene | null = null;
let displayCamera: THREE.OrthographicCamera | null = null;
let displayQuad: THREE.Mesh | null = null;
let displayMat: THREE.ShaderMaterial | null = null;
let composer: EffectComposer | null = null;

// Curve geometry
const BAND_COUNT = 7;
const POINTS_PER_CURVE = isMobile ? 256 : 512;

let curveLines: THREE.Line[] = [];
let curveGeos: THREE.BufferGeometry[] = [];
let curveMats: THREE.ShaderMaterial[] = [];

// Phase state — continuous drift, never snapped
const phases: [number, number, number][] = Array.from({ length: BAND_COUNT }, () => [
  Math.random() * Math.PI * 2,
  Math.random() * Math.PI * 2,
  Math.random() * Math.PI * 2,
]);

// Camera orbit
let cameraTheta = 0;
let cameraVelKick = 0;
const CAMERA_RADIUS = 3.0;
const CAMERA_PHI = 0.33 * Math.PI;

// Beat
let lastBeatIndex = -1;
let beatFlash = 0;

// Unsub
let vizModeUnsub: (() => void) | null = null;

// ── Lissajous frequency ratio tiers (5 structural complexity levels) ──────────

const RATIO_TIERS: [number, number, number][][] = [
  // Tier 1: simple — ellipses & figure-8s
  [[1,1,2],[2,1,1],[1,2,1],[1,2,2],[2,1,2],[2,2,1],[1,1,1]],
  // Tier 2: moderate
  [[1,2,3],[2,3,1],[3,1,2],[1,3,2],[2,1,3],[3,2,1],[2,3,2]],
  // Tier 3
  [[2,3,4],[3,4,2],[4,2,3],[1,3,4],[4,3,1],[2,4,3],[3,2,4]],
  // Tier 4
  [[3,4,5],[4,5,3],[5,3,4],[2,4,5],[5,4,2],[3,5,4],[4,3,5]],
  // Tier 5: complex — septimal harmonics
  [[3,5,7],[5,7,3],[7,3,5],[2,5,7],[7,5,2],[3,7,5],[5,2,7]],
];

// Subtle irrational-ish phase drift rates per band (varied for non-repeating forms)
const DRIFT_RATES: [number, number, number][] = [
  [0.00041, 0.00067, 0.00053],
  [0.00059, 0.00043, 0.00071],
  [0.00073, 0.00061, 0.00047],
  [0.00037, 0.00079, 0.00069],
  [0.00083, 0.00051, 0.00041],
  [0.00067, 0.00073, 0.00057],
  [0.00049, 0.00047, 0.00077],
];

// Phosphor warmth gradient: amber (bass) → neutral → cool blue-white (treble)
const BAND_COLORS = [
  new THREE.Vector3(1.00, 0.88, 0.60), // sub-bass: warm amber
  new THREE.Vector3(0.96, 0.90, 0.73),
  new THREE.Vector3(0.88, 0.92, 0.87),
  new THREE.Vector3(0.83, 0.91, 0.98), // mid: neutral
  new THREE.Vector3(0.72, 0.88, 1.00),
  new THREE.Vector3(0.66, 0.85, 1.00),
  new THREE.Vector3(0.62, 0.82, 1.00), // brilliance: cool blue
];

// Per-band uniforms (mutated in place each frame)
const uBandAmp:   THREE.IUniform<number>[]         = Array.from({ length: BAND_COUNT }, () => ({ value: 0 }));
const uBandColor: THREE.IUniform<THREE.Vector3>[]  = BAND_COLORS.map(c => ({ value: c.clone() }));

// Shared uniforms
const uPrevTex:    THREE.IUniform<THREE.Texture | null> = { value: null };
const uDecay:      THREE.IUniform<number>               = { value: 0.975 };
const uFlash:      THREE.IUniform<number>               = { value: 0 };
const uDisplayTex: THREE.IUniform<THREE.Texture | null> = { value: null };

// ── GLSL ──────────────────────────────────────────────────────────────────────

const QUAD_VS = /* glsl */`
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FEEDBACK_FS = /* glsl */`
  uniform sampler2D uPrevTex;
  uniform float     uDecay;
  uniform float     uFlash;
  varying vec2      vUv;
  void main() {
    vec3 col = texture2D(uPrevTex, vUv).rgb * uDecay;
    // warm beat flash added uniformly
    col += vec3(1.0, 0.93, 0.72) * uFlash * 0.07;
    gl_FragColor = vec4(col, 1.0);
  }
`;

const DISPLAY_FS = /* glsl */`
  uniform sampler2D uDisplayTex;
  varying vec2      vUv;
  void main() {
    vec3 col = texture2D(uDisplayTex, vUv).rgb;
    // subtle vignette for depth
    vec2 c = vUv * 2.0 - 1.0;
    float vig = 1.0 - dot(c * 0.42, c * 0.42);
    col *= clamp(vig, 0.0, 1.0);
    gl_FragColor = vec4(col, 1.0);
  }
`;

const CURVE_VS = /* glsl */`
  uniform vec3  uColor;
  uniform float uAmp;
  varying vec3  vColor;
  void main() {
    float brightness = 0.35 + uAmp * 2.2;
    vColor = uColor * brightness;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const CURVE_FS = /* glsl */`
  varying vec3 vColor;
  void main() {
    gl_FragColor = vec4(vColor, 1.0);
  }
`;

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeRT(w: number, h: number): THREE.WebGLRenderTarget {
  return new THREE.WebGLRenderTarget(w, h, {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    format: THREE.RGBAFormat,
    type: THREE.HalfFloatType,
    depthBuffer: false,
  });
}

function sampleCurve(
  ratios: [number, number, number],
  phase: [number, number, number],
  amp: number,
  out: Float32Array
): void {
  const [a, b, c] = ratios;
  const [px, py, pz] = phase;
  const scale = 1.0 + amp * 0.38;
  const step = (Math.PI * 12) / (POINTS_PER_CURVE - 1);
  for (let i = 0; i < POINTS_PER_CURVE; i++) {
    const t = i * step;
    out[i * 3]     = Math.sin(a * t + px) * scale;
    out[i * 3 + 1] = Math.sin(b * t + py) * scale;
    out[i * 3 + 2] = Math.sin(c * t + pz) * scale;
  }
}

function updateCameraPos(): void {
  if (!perspCamera) return;
  const x = Math.sin(cameraTheta) * Math.cos(CAMERA_PHI) * CAMERA_RADIUS;
  const y = Math.sin(CAMERA_PHI) * CAMERA_RADIUS;
  const z = Math.cos(cameraTheta) * Math.cos(CAMERA_PHI) * CAMERA_RADIUS;
  perspCamera.position.set(x, y, z);
  perspCamera.lookAt(0, 0, 0);
}

// ── Setup ─────────────────────────────────────────────────────────────────────

function setup(): void {
  const W  = window.innerWidth;
  const H  = window.innerHeight;
  const PR = Math.min(window.devicePixelRatio, isMobile ? 1.0 : 2.0);
  // Use half-res FBO on mobile for performance
  const RW = Math.floor(W  * (isMobile ? 0.5 : 1.0));
  const RH = Math.floor(H * (isMobile ? 0.5 : 1.0));

  // Overlay canvas
  threeCanvas = document.createElement('canvas');
  threeCanvas.style.cssText =
    'position:fixed;top:0;left:0;width:100%;height:100%;z-index:10;pointer-events:none;display:block';
  document.body.appendChild(threeCanvas);

  // Renderer — no antialiasing needed (lines are sub-pixel via blending)
  renderer = new THREE.WebGLRenderer({ canvas: threeCanvas, antialias: false, alpha: false });
  renderer.setSize(W, H);
  renderer.setPixelRatio(PR);
  renderer.autoClear = true;
  renderer.setClearColor(0x010208, 1);

  // ── Feedback ping-pong ────────────────────────────────────────────────────
  fboA = makeRT(RW, RH);
  fboB = makeRT(RW, RH);

  fbCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  fbScene  = new THREE.Scene();

  const quadGeo = new THREE.PlaneGeometry(2, 2);

  fbMat  = new THREE.ShaderMaterial({
    uniforms:       { uPrevTex, uDecay, uFlash },
    vertexShader:   QUAD_VS,
    fragmentShader: FEEDBACK_FS,
    depthWrite: false,
    depthTest:  false,
  });
  fbQuad = new THREE.Mesh(quadGeo, fbMat);
  fbScene.add(fbQuad);

  // ── Display scene (FBO → bloom → screen) ─────────────────────────────────
  displayCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  displayScene  = new THREE.Scene();

  displayMat  = new THREE.ShaderMaterial({
    uniforms:       { uDisplayTex },
    vertexShader:   QUAD_VS,
    fragmentShader: DISPLAY_FS,
    depthWrite: false,
    depthTest:  false,
  });
  displayQuad = new THREE.Mesh(quadGeo, displayMat);
  displayScene.add(displayQuad);

  // ── 3D curve scene ────────────────────────────────────────────────────────
  curveScene  = new THREE.Scene();
  const aspect = W / H;
  perspCamera = new THREE.PerspectiveCamera(50, aspect, 0.1, 100);
  updateCameraPos();

  const tierIdx = getTierIdx();
  const ratios  = RATIO_TIERS[tierIdx];

  for (let b = 0; b < BAND_COUNT; b++) {
    const positions = new Float32Array(POINTS_PER_CURVE * 3);
    sampleCurve(ratios[b], phases[b], 0, positions);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));

    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uColor: uBandColor[b],
        uAmp:   uBandAmp[b],
      },
      vertexShader:   CURVE_VS,
      fragmentShader: CURVE_FS,
      blending:    THREE.AdditiveBlending,
      depthWrite:  false,
      depthTest:   false,
      transparent: true,
    });

    const line = new THREE.Line(geo, mat);
    curveScene.add(line);
    curveLines.push(line);
    curveGeos.push(geo);
    curveMats.push(mat);
  }

  // ── EffectComposer with subtle bloom (desktop only) ───────────────────────
  if (!isMobile) {
    composer = new EffectComposer(renderer);
    const rp = new RenderPass(displayScene, displayCamera);
    rp.clearColor = new THREE.Color(0x010208);
    rp.clearAlpha = 1;
    composer.addPass(rp);
    const bp = new UnrealBloomPass(
      new THREE.Vector2(W * PR, H * PR),
      0.45,   // strength
      0.35,   // radius
      0.72    // threshold — only the brightest phosphor parts bloom
    );
    composer.addPass(bp);
    composer.addPass(new OutputPass());
  }

  window.addEventListener('resize', onResize);

  vizModeUnsub = store.on('vizModeChange', (mode: unknown) => {
    if (mode !== 'oscillograph') disposeOscillograph();
  });

  initialized = true;
}

function getTierIdx(): number {
  const c = store.config.oscillographComplexity ?? 3;
  return Math.max(0, Math.min(4, Math.round(c) - 1));
}

function onResize(): void {
  if (!renderer || !perspCamera || !fboA || !fboB) return;
  const W  = window.innerWidth;
  const H  = window.innerHeight;
  const PR = Math.min(window.devicePixelRatio, isMobile ? 1.0 : 2.0);
  const RW = Math.floor(W  * (isMobile ? 0.5 : 1.0));
  const RH = Math.floor(H * (isMobile ? 0.5 : 1.0));
  renderer.setSize(W, H);
  renderer.setPixelRatio(PR);
  perspCamera.aspect = W / H;
  perspCamera.updateProjectionMatrix();
  fboA.setSize(RW, RH);
  fboB.setSize(RW, RH);
  if (!isMobile && composer) {
    composer.setSize(W * PR, H * PR);
  }
}

// ── Draw ──────────────────────────────────────────────────────────────────────

export function drawOscillograph(_p: unknown, dt: number): void {
  if (!initialized) setup();
  if (
    !renderer || !curveScene || !perspCamera ||
    !fbScene || !fbCamera || !fboA || !fboB || !fbMat ||
    !displayScene || !displayCamera || !displayMat
  ) return;

  const { config, state } = store;
  const { amps: bandAmps } = getBandAverages(BAND_COUNT);

  // ── Beat detection (BPM-based) ────────────────────────────────────────────
  let isBeat = false;
  if (state.beatIntervalSec > 0 && state.isPlaying) {
    const pos      = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    const beatIdx  = adjusted >= 0 ? Math.floor(adjusted / state.beatIntervalSec) : -1;
    if (beatIdx > lastBeatIndex) {
      lastBeatIndex = beatIdx;
      isBeat = true;
    }
  }

  // ── Continuous param easing ───────────────────────────────────────────────
  const scale = config.oscillographScale ?? 0.5;
  const trace = config.oscillographTrace ?? 0.5;

  // trace → decay: 0=fast fade (0.90), 1=long persistence (0.995)
  const targetDecay = 0.90 + trace * 0.095;
  uDecay.value += (targetDecay - uDecay.value) * 0.05 * dt * 60;

  // Beat impulse (decays back naturally each frame)
  if (isBeat) {
    beatFlash    = 1.0;
    cameraVelKick = 0.016;
  }
  beatFlash     *= Math.pow(0.88, dt * 60);
  cameraVelKick *= Math.pow(0.94, dt * 60);
  uFlash.value   = beatFlash;

  // Camera orbit — continuous slow base + transient beat kick
  const baseSpeed = 0.0010;
  cameraTheta += (baseSpeed + cameraVelKick) * dt * 60;
  updateCameraPos();

  // Curve geometry refresh: phases drift + audio nudge
  const tierIdx = getTierIdx();
  const ratios  = RATIO_TIERS[tierIdx];

  for (let b = 0; b < BAND_COUNT; b++) {
    const amp = bandAmps[b] ?? 0;

    // Smooth amp toward audio value (continuous easing)
    uBandAmp[b].value += (amp - uBandAmp[b].value) * Math.min(1, 0.14 * dt * 60);

    // Phase drift: base rate + audio-driven nudge (more drift when band is loud)
    const dr    = DRIFT_RATES[b];
    const nudge = (1.0 + amp * scale * 2.5) * dt * 60;
    phases[b][0] += dr[0] * nudge;
    phases[b][1] += dr[1] * nudge;
    phases[b][2] += dr[2] * nudge;

    // Rebuild line positions
    const geo = curveGeos[b];
    const posAttr = geo.getAttribute('position') as THREE.BufferAttribute;
    const buf = posAttr.array as Float32Array;
    sampleCurve(ratios[b], phases[b], uBandAmp[b].value, buf);
    posAttr.needsUpdate = true;
  }

  // ── Ping-pong FBO ─────────────────────────────────────────────────────────
  const readFBO  = (frameIdx & 1) === 0 ? fboA : fboB;
  const writeFBO = (frameIdx & 1) === 0 ? fboB : fboA;
  frameIdx++;

  // Step 1: decay pass — blit readFBO → writeFBO with decay
  uPrevTex.value = readFBO.texture;
  renderer.setRenderTarget(writeFBO);
  renderer.clear();
  renderer.render(fbScene, fbCamera);

  // Step 2: render 3D curves on top of writeFBO (additive, no clear)
  renderer.autoClear = false;
  renderer.render(curveScene, perspCamera);
  renderer.autoClear = true;

  // Step 3: display writeFBO → bloom composer (or direct blit on mobile)
  uDisplayTex.value = writeFBO.texture;
  renderer.setRenderTarget(null);

  if (!isMobile && composer) {
    composer.render();
  } else {
    renderer.clear();
    renderer.render(displayScene, displayCamera);
  }
}

// ── Reset ─────────────────────────────────────────────────────────────────────

export function resetOscillograph(): void {
  if (!initialized || !renderer || !fboA || !fboB) return;
  renderer.setRenderTarget(fboA);
  renderer.clear();
  renderer.setRenderTarget(fboB);
  renderer.clear();
  renderer.setRenderTarget(null);
  for (let b = 0; b < BAND_COUNT; b++) {
    phases[b][0] = Math.random() * Math.PI * 2;
    phases[b][1] = Math.random() * Math.PI * 2;
    phases[b][2] = Math.random() * Math.PI * 2;
  }
  lastBeatIndex = -1;
  beatFlash     = 0;
  cameraVelKick = 0;
  cameraTheta   = 0;
  frameIdx      = 0;
}

// ── Dispose ───────────────────────────────────────────────────────────────────

export function disposeOscillograph(): void {
  if (!initialized) return;
  initialized = false;

  window.removeEventListener('resize', onResize);
  vizModeUnsub?.();
  vizModeUnsub = null;

  for (let i = 0; i < BAND_COUNT; i++) {
    curveScene?.remove(curveLines[i]);
    curveGeos[i]?.dispose();
    curveMats[i]?.dispose();
  }
  curveLines = [];
  curveGeos  = [];
  curveMats  = [];

  fbMat?.dispose();       fbMat     = null;
  fbQuad?.geometry.dispose(); fbQuad = null;
  displayMat?.dispose();  displayMat = null;
  displayQuad?.geometry.dispose(); displayQuad = null;

  fboA?.dispose(); fboA = null;
  fboB?.dispose(); fboB = null;

  composer?.dispose(); composer = null;

  renderer?.dispose(); renderer = null;
  threeCanvas?.remove(); threeCanvas = null;

  curveScene    = null;
  perspCamera   = null;
  fbScene       = null;
  fbCamera      = null;
  displayScene  = null;
  displayCamera = null;
  frameIdx      = 0;
  lastBeatIndex = -1;
  beatFlash     = 0;
  cameraVelKick = 0;
  cameraTheta   = 0;
}
