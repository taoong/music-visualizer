/**
 * Turing — Gray-Scott reaction-diffusion on a torus
 *
 * Two virtual "chemicals" (A and B) react and diffuse on the surface of a 3D
 * torus following Gray-Scott kinetics.  The simulation runs on a 512×512 (mobile:
 * 256×256) ping-pong render-target pair; because a torus is topologically
 * identical to a periodic rectangle, the flat texture maps seamlessly onto the
 * torus mesh with zero visible seams.
 *
 * The Gray-Scott feed/kill parameter space sweeps through dramatic visual regimes:
 *   low feed  → coral / mitosis spots
 *   mid feed  → fingerprint / labyrinthine stripes
 *   high feed → worm / hole patterns
 * Audio drags f and k through these regimes continuously.  Beats inject a localised
 * burst of B chemical that seeds new pattern growth, keeping the simulation dynamic.
 *
 * Material and lighting: a single warm directional light from above-left and a
 * cool steel-blue fill keep the torus sculptural; the chemical-B concentration
 * is used both as albedo and a subtle emissive to give the bright regions a slight
 * inner glow without needing bloom passes.  Near-monochrome warm-amber↔cool-steel
 * palette; no rainbow, no neon.
 *
 * Camera: slow elliptical orbit at 25° elevation, continuous CHOP-style motion;
 * beats add a brief decaying angular-velocity kick.
 *
 * Inspired by Alan Turing "The Chemical Basis of Morphogenesis" (1952) and
 * Nobutaka Kitahara's audio-reactive TouchDesigner reaction-diffusion patch
 * (Vimeo Staff Pick, featured by Vice as "Virtual 3D Chemicals Transform
 * Geometric Patterns", https://www.vice.com/en/article/gvwe8j/virtual-3d-chemicals-transform-geometric-patterns)
 * which first demonstrated that Gray-Scott rates driven by musical frequencies
 * produce mesmerizing living-organism-like transformations.
 *
 * Sliders
 *   Feed     — structural: base feed rate → 0=coral spots, 0.5=labyrinth stripes, 1=worm holes
 *   Speed    — simulation iterations per frame (0=slow gentle drift, 1=fast agitated)
 *   Palette  — colour temperature: 0=cool silver-blue, 1=warm amber-gold
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass }     from 'three/addons/postprocessing/RenderPass.js';
import { OutputPass }     from 'three/addons/postprocessing/OutputPass.js';
import { store }          from '../state/store';
import { getBandAverages, fovForAspect } from './helpers';
import { audioEngine }    from '../audio/engine';
import { isMobile }       from '../utils/constants';

// ── Constants ─────────────────────────────────────────────────────────────────

const SIM_SIZE    = isMobile ? 256 : 512;
const TORUS_R     = 2.0;    // radius of torus ring
const TORUS_TUBE  = 0.75;   // radius of torus tube
const TORUS_RSEG  = isMobile ? 80  : 160;  // tubular segments
const TORUS_TSEG  = isMobile ? 60  : 120;  // radial segments
const STEPS_MIN   = 2;
const STEPS_MAX   = isMobile ? 10 : 18;
const CAM_DIST    = 6.5;
const BASE_ORBIT  = 0.0022;  // rad per frame at dt=1

// ── Module state ──────────────────────────────────────────────────────────────

let initialized    = false;
let threeCanvas    : HTMLCanvasElement       | null = null;
let renderer       : THREE.WebGLRenderer     | null = null;
let scene          : THREE.Scene             | null = null;
let camera         : THREE.PerspectiveCamera | null = null;
let composer       : EffectComposer          | null = null;
let vizModeUnsub   : (() => void)            | null = null;

// Reaction-diffusion simulation resources
let rtA            : THREE.WebGLRenderTarget | null = null;  // current state
let rtB            : THREE.WebGLRenderTarget | null = null;  // next state
let rdScene        : THREE.Scene             | null = null;  // orthographic quad scene
let rdCamera       : THREE.OrthographicCamera| null = null;
let rdMesh         : THREE.Mesh             | null = null;
let rdMat          : THREE.ShaderMaterial   | null = null;
let injectMat      : THREE.ShaderMaterial   | null = null;
let injectMesh     : THREE.Mesh             | null = null;

// Display torus
let torus          : THREE.Mesh             | null = null;
let torusMat       : THREE.ShaderMaterial   | null = null;

// Camera animation
let camAngle       = 0;
let camOrbitSpeed  = 0;    // accumulated beat kick
let lastBeatIndex  = -1;
let time           = 0;

// Beat injection queue: UV coordinates to inject
const injectQueue: Array<{ u: number; v: number }> = [];

// ── RD update vertex (passthrough) ───────────────────────────────────────────

const QUAD_VERT = /* glsl */`
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

// ── Gray-Scott RD step shader ─────────────────────────────────────────────────

const RD_FRAG = /* glsl */`
  precision highp float;
  uniform sampler2D uState;
  uniform float uFeed;
  uniform float uKill;
  uniform float uDeltaT;   // simulation time-step (0.5–1.5)
  varying vec2 vUv;

  void main() {
    vec2 texel = 1.0 / vec2(${SIM_SIZE}.0);

    // 9-point Laplacian (periodic wrapping handled by texture repeat)
    vec4 c   = texture2D(uState, vUv);
    vec4 n   = texture2D(uState, vUv + vec2( 0.0,  texel.y));
    vec4 s   = texture2D(uState, vUv + vec2( 0.0, -texel.y));
    vec4 e   = texture2D(uState, vUv + vec2( texel.x,  0.0));
    vec4 w   = texture2D(uState, vUv + vec2(-texel.x,  0.0));
    vec4 ne  = texture2D(uState, vUv + vec2( texel.x,  texel.y));
    vec4 nw  = texture2D(uState, vUv + vec2(-texel.x,  texel.y));
    vec4 se  = texture2D(uState, vUv + vec2( texel.x, -texel.y));
    vec4 sw  = texture2D(uState, vUv + vec2(-texel.x, -texel.y));

    vec4 lap = (n + s + e + w) * 0.2 + (ne + nw + se + sw) * 0.05 - c;

    float A    = c.r;
    float B    = c.g;
    float ABB  = A * B * B;

    float newA = A + uDeltaT * (0.90 * lap.r - ABB + uFeed * (1.0 - A));
    float newB = B + uDeltaT * (0.46 * lap.g + ABB - (uKill + uFeed) * B);

    gl_FragColor = vec4(clamp(newA, 0.0, 1.0), clamp(newB, 0.0, 1.0), 0.0, 1.0);
  }
`;

// ── Beat injection shader — drops a Gaussian blob of B at (uUV) ───────────────

const INJECT_FRAG = /* glsl */`
  precision highp float;
  uniform sampler2D uState;
  uniform vec2 uUV;      // injection center in [0,1]
  uniform float uRadius; // Gaussian sigma in UV space
  varying vec2 vUv;

  void main() {
    vec2 d    = vUv - uUV;
    // toroidal wrap: take shortest path
    d = d - floor(d + 0.5);
    float dist2 = dot(d, d);
    float blob  = exp(-dist2 / (2.0 * uRadius * uRadius));

    vec4 state  = texture2D(uState, vUv);
    float newB  = clamp(state.g + blob * 0.9, 0.0, 1.0);
    float newA  = clamp(state.r - blob * 0.6, 0.0, 1.0);
    gl_FragColor = vec4(newA, newB, 0.0, 1.0);
  }
`;

// ── Torus display vertex shader — standard MeshStandardMaterial-compatible ───

const TORUS_VERT = /* glsl */`
  uniform float uBands[7];
  uniform float uTime;
  varying vec2  vUv;
  varying vec3  vNormal;
  varying vec3  vWorldPos;

  void main() {
    vUv      = uv;
    vNormal  = normalize(normalMatrix * normal);
    vec4 wp  = modelMatrix * vec4(position, 1.0);
    vWorldPos = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

// ── Torus display fragment shader ────────────────────────────────────────────

const TORUS_FRAG = /* glsl */`
  precision highp float;
  uniform sampler2D uRDTex;   // reaction-diffusion state texture
  uniform float     uPalette; // 0=cool silver-blue, 1=warm amber-gold
  uniform float     uTime;
  uniform float     uBands[7];
  varying vec2      vUv;
  varying vec3      vNormal;
  varying vec3      vWorldPos;

  // Warm vs. cool two-tone palette
  vec3 rdColor(float B) {
    vec3 dark   = mix(vec3(0.02, 0.03, 0.08), vec3(0.06, 0.03, 0.01), uPalette);
    vec3 bright = mix(vec3(0.55, 0.78, 1.00), vec3(1.00, 0.72, 0.30), uPalette);
    // Slight emissive boost in bright areas
    return mix(dark, bright, B * B * 1.2);
  }

  void main() {
    float B = texture2D(uRDTex, vUv).g;

    vec3 baseColor = rdColor(B);

    // Simple two-light Blinn-Phong over the torus normal
    vec3 N   = normalize(vNormal);
    vec3 L1  = normalize(vec3( 1.2, 2.0, 1.0));   // warm key
    vec3 L2  = normalize(vec3(-1.0,-0.8,-1.5));   // cool fill
    vec3 V   = normalize(cameraPosition - vWorldPos);

    float diff1 = max(dot(N, L1), 0.0);
    float diff2 = max(dot(N, L2), 0.0) * 0.35;

    vec3 key  = mix(vec3(1.00, 0.88, 0.70), vec3(0.65, 0.78, 1.00), 1.0 - uPalette);
    vec3 fill = mix(vec3(0.40, 0.55, 0.90), vec3(0.80, 0.55, 0.30), uPalette);

    vec3 H1    = normalize(L1 + V);
    float spec = pow(max(dot(N, H1), 0.0), 40.0) * (0.3 + B * 0.5);

    // Emissive glow proportional to B
    float emissive = B * B * (0.4 + 0.3 * uPalette);

    vec3 finalColor = baseColor * (diff1 * key + diff2 * fill + 0.08)
                    + spec * key
                    + baseColor * emissive;

    gl_FragColor = vec4(finalColor, 1.0);
  }
`;

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeRT(): THREE.WebGLRenderTarget {
  const rt = new THREE.WebGLRenderTarget(SIM_SIZE, SIM_SIZE, {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    format:    THREE.RGBAFormat,
    type:      THREE.FloatType,
    wrapS:     THREE.RepeatWrapping,
    wrapT:     THREE.RepeatWrapping,
    depthBuffer: false,
  });
  return rt;
}

/** Seed the first render-target with A=1, random Gaussian blobs of B. */
function seedRenderTarget(r: THREE.WebGLRenderer, rt: THREE.WebGLRenderTarget): void {
  // Build initial data: A=1, B=0 with ~30 random seed blobs
  const data = new Float32Array(SIM_SIZE * SIM_SIZE * 4);
  for (let i = 0; i < SIM_SIZE * SIM_SIZE; i++) {
    data[i * 4 + 0] = 1.0; // A
    data[i * 4 + 1] = 0.0; // B
    data[i * 4 + 2] = 0.0;
    data[i * 4 + 3] = 1.0;
  }
  // Seed ~25 blobs
  const seeds = isMobile ? 15 : 25;
  for (let s = 0; s < seeds; s++) {
    const cx = Math.floor(Math.random() * SIM_SIZE);
    const cy = Math.floor(Math.random() * SIM_SIZE);
    const rBlob = Math.floor(SIM_SIZE * (0.015 + Math.random() * 0.025));
    for (let dy = -rBlob; dy <= rBlob; dy++) {
      for (let dx = -rBlob; dx <= rBlob; dx++) {
        if (dx * dx + dy * dy <= rBlob * rBlob) {
          const px = ((cx + dx + SIM_SIZE) % SIM_SIZE);
          const py = ((cy + dy + SIM_SIZE) % SIM_SIZE);
          const idx = (py * SIM_SIZE + px) * 4;
          data[idx + 0] = 0.0; // A
          data[idx + 1] = 1.0; // B
        }
      }
    }
  }
  const tex = new THREE.DataTexture(data, SIM_SIZE, SIM_SIZE,
    THREE.RGBAFormat, THREE.FloatType);
  tex.needsUpdate = true;
  // Blit the seed texture into the render target using a simple copy pass
  const copyMat = new THREE.MeshBasicMaterial({ map: tex });
  const copyMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), copyMat);
  const tmpScene = new THREE.Scene();
  tmpScene.add(copyMesh);
  const ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  r.setRenderTarget(rt);
  r.render(tmpScene, ortho);
  r.setRenderTarget(null);
  copyMesh.geometry.dispose();
  copyMat.dispose();
  tex.dispose();
}

// ── Setup ─────────────────────────────────────────────────────────────────────

function setup(): void {
  const w = window.innerWidth;
  const h = window.innerHeight;

  // --- Three.js renderer on a layered canvas ---
  threeCanvas = document.createElement('canvas');
  threeCanvas.style.cssText = `
    position:fixed; inset:0; width:100%; height:100%;
    pointer-events:none; z-index:0;
  `;
  document.body.appendChild(threeCanvas);

  renderer = new THREE.WebGLRenderer({
    canvas: threeCanvas,
    antialias: !isMobile,
    alpha: false,
  });
  renderer.setPixelRatio(isMobile ? 1 : Math.min(window.devicePixelRatio, 2));
  renderer.setSize(w, h);
  renderer.setClearColor(0x000000, 1);

  // Ortho scene for simulation passes
  rdScene  = new THREE.Scene();
  rdCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const quadGeo = new THREE.PlaneGeometry(2, 2);

  // RD step material
  rdMat = new THREE.ShaderMaterial({
    vertexShader:   QUAD_VERT,
    fragmentShader: RD_FRAG,
    uniforms: {
      uState:  { value: null as THREE.Texture | null },
      uFeed:   { value: 0.037 },
      uKill:   { value: 0.063 },
      uDeltaT: { value: 1.0 },
    },
    depthTest: false,
    depthWrite: false,
  });
  rdMesh = new THREE.Mesh(quadGeo, rdMat);
  rdScene.add(rdMesh);

  // Inject material (beat injection)
  injectMat = new THREE.ShaderMaterial({
    vertexShader:   QUAD_VERT,
    fragmentShader: INJECT_FRAG,
    uniforms: {
      uState:  { value: null as THREE.Texture | null },
      uUV:     { value: new THREE.Vector2(0.5, 0.5) },
      uRadius: { value: 0.04 },
    },
    depthTest: false,
    depthWrite: false,
  });
  injectMesh = new THREE.Mesh(quadGeo, injectMat);
  // We'll swap it in/out of rdScene as needed

  // Ping-pong render targets
  rtA = makeRT();
  rtB = makeRT();

  // Seed initial pattern
  seedRenderTarget(renderer, rtA);

  // --- Main 3D scene ---
  scene  = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(
    fovForAspect(50, w / h),
    w / h,
    0.1,
    100,
  );
  camera.position.set(0, CAM_DIST * Math.sin(0.44), CAM_DIST * Math.cos(0.44));
  camera.lookAt(0, 0, 0);

  // Torus
  const torusGeo = new THREE.TorusGeometry(TORUS_R, TORUS_TUBE, TORUS_TSEG, TORUS_RSEG);
  torusMat = new THREE.ShaderMaterial({
    vertexShader:   TORUS_VERT,
    fragmentShader: TORUS_FRAG,
    uniforms: {
      uRDTex:   { value: rtA.texture },
      uPalette: { value: 0.4 },
      uTime:    { value: 0.0 },
      uBands:   { value: new Array(7).fill(0) },
    },
  });
  torus = new THREE.Mesh(torusGeo, torusMat);
  scene.add(torus);

  // Post-processing (render + output only, no bloom — emissive provides glow)
  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  composer.addPass(new OutputPass());

  // Hide canvas when switching away
  vizModeUnsub = store.on('vizModeChange', (mode) => {
    if (threeCanvas) threeCanvas.style.display = mode === 'turing' ? 'block' : 'none';
  });

  initialized = true;
}

// ── Draw ──────────────────────────────────────────────────────────────────────

export function drawTuring(_p: unknown, dt: number): void {
  if (!initialized) setup();
  if (!renderer || !scene || !camera || !composer || !rdScene || !rdCamera ||
      !rdMat || !rdMesh || !injectMat || !injectMesh ||
      !rtA || !rtB || !torus || !torusMat) return;

  time += dt * 0.016;

  const { amps } = getBandAverages(7);
  const cfg   = store.config;

  // ── Beat detection ───────────────────────────────────────────────────────
  const { state } = store;
  if (state.beatIntervalSec > 0 && state.isPlaying) {
    const pos      = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    const beatIdx  = adjusted >= 0 ? Math.floor(adjusted / state.beatIntervalSec) : -1;
    if (beatIdx > lastBeatIndex) {
      lastBeatIndex = beatIdx;
      // Queue a beat injection at a random UV position
      injectQueue.push({ u: Math.random(), v: Math.random() });
      // Kick camera orbit speed
      camOrbitSpeed += 0.005 + (amps[0] ?? 0) * 0.008;
    }
  }

  // ── Compute RD parameters ────────────────────────────────────────────────
  // Feed slider (0–1) maps to f range 0.028–0.062
  const feedBase  = 0.028 + cfg.turingFeed * 0.034;
  // Kill stays near 0.063 for most regimes (sweet-spot)
  const killBase  = 0.058 + cfg.turingFeed * 0.008;

  // Audio modulation: sub-bass nudges feed, brilliance nudges kill
  const fAudio = feedBase + (amps[0] ?? 0) * 0.006 - (amps[6] ?? 0) * 0.003;
  const kAudio = killBase + (amps[6] ?? 0) * 0.004 - (amps[0] ?? 0) * 0.002;

  // Speed slider → iterations per frame
  const steps = Math.round(STEPS_MIN + cfg.turingSpeed * (STEPS_MAX - STEPS_MIN));

  // Amplitude-driven time-step scaling
  const totalAmp   = amps.reduce((a, b) => a + b, 0) / 7;
  const deltaT     = 0.8 + totalAmp * 0.5;

  // ── RD simulation steps ──────────────────────────────────────────────────
  rdMat.uniforms['uFeed'].value   = fAudio;
  rdMat.uniforms['uKill'].value   = kAudio;
  rdMat.uniforms['uDeltaT'].value = deltaT;

  // Use local non-null references for ping-pong (module vars stay in sync below)
  let curA: THREE.WebGLRenderTarget = rtA;
  let curB: THREE.WebGLRenderTarget = rtB;

  // Replace the rdScene mesh temporarily when injecting
  for (let step = 0; step < steps; step++) {
    // Check if this is an injection step (first step of a beat)
    const isInjectStep = step === 0 && injectQueue.length > 0;

    if (isInjectStep) {
      const injection = injectQueue.shift()!;
      injectMat.uniforms['uState'].value  = curA.texture;
      injectMat.uniforms['uUV'].value.set(injection.u, injection.v);
      injectMat.uniforms['uRadius'].value = 0.025 + totalAmp * 0.02;

      rdScene.remove(rdMesh);
      rdScene.add(injectMesh);
      renderer.setRenderTarget(curB);
      renderer.render(rdScene, rdCamera);
      rdScene.remove(injectMesh);
      rdScene.add(rdMesh);
    } else {
      rdMat.uniforms['uState'].value = curA.texture;
      renderer.setRenderTarget(curB);
      renderer.render(rdScene, rdCamera);
    }

    // Ping-pong
    const tmp: THREE.WebGLRenderTarget = curA;
    curA = curB;
    curB = tmp;
  }
  renderer.setRenderTarget(null);

  // Sync module state with local ping-pong result
  rtA = curA;
  rtB = curB;

  // Update torus texture
  torusMat.uniforms['uRDTex'].value  = rtA.texture;
  torusMat.uniforms['uPalette'].value = cfg.turingPalette;
  torusMat.uniforms['uTime'].value   = time;
  torusMat.uniforms['uBands'].value  = amps.slice(0, 7);

  // ── Camera motion ────────────────────────────────────────────────────────
  // Continuous orbit with gentle elevation bob
  camOrbitSpeed  *= Math.pow(0.94, dt); // decay kick
  camAngle       += (BASE_ORBIT + camOrbitSpeed) * dt;

  const elevAngle = 0.44 + Math.sin(camAngle * 0.17) * 0.14;
  const camRadius = CAM_DIST + Math.sin(camAngle * 0.31) * 0.4;
  camera.position.set(
    Math.cos(camAngle) * camRadius * Math.cos(elevAngle),
    camRadius * Math.sin(elevAngle),
    Math.sin(camAngle) * camRadius * Math.cos(elevAngle),
  );
  camera.lookAt(0, 0, 0);

  // Torus slow self-rotation (orthogonal axis to camera orbit — always showing new surface)
  torus.rotation.z += 0.0003 * dt;
  torus.rotation.x += 0.00015 * dt;

  composer.render();
}

// ── Reset (resize) ────────────────────────────────────────────────────────────

export function resetTuring(): void {
  if (!initialized) return;
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer?.setSize(w, h);
  if (camera) {
    camera.aspect = w / h;
    camera.fov    = fovForAspect(50, camera.aspect);
    camera.updateProjectionMatrix();
  }
  composer?.setSize(w, h);
}

// ── Dispose ───────────────────────────────────────────────────────────────────

export function disposeTuring(): void {
  if (!initialized) return;
  vizModeUnsub?.();
  vizModeUnsub = null;

  // Dispose simulation resources
  rdMat?.dispose();
  injectMat?.dispose();
  rdMesh?.geometry.dispose();
  rtA?.dispose();
  rtB?.dispose();

  // Dispose display resources
  torus?.geometry.dispose();
  torusMat?.dispose();

  // Composer and renderer
  composer?.dispose();
  renderer?.dispose();
  threeCanvas?.remove();

  threeCanvas = null;
  renderer    = null;
  scene       = null;
  camera      = null;
  composer    = null;
  rdScene     = null;
  rdCamera    = null;
  rdMesh      = null;
  rdMat       = null;
  injectMat   = null;
  injectMesh  = null;
  rtA         = null;
  rtB         = null;
  torus       = null;
  torusMat    = null;

  time = 0; camAngle = 0; camOrbitSpeed = 0; lastBeatIndex = -1;
  injectQueue.length = 0;
  initialized = false;
}
