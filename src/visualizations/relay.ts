/**
 * Relay — audio-reactive video feedback synthesis
 *
 * Inspired by Andrei Jay's WAAAVE_POOL (github.com/ex-zee-ex/waaaave_pool),
 * a framebuffer-delay / feedback synthesis engine that creates emergent depth
 * by cascading the previous rendered frame back into the next.
 *
 * 7 glowing emissive nodes orbit in a true 3D formation inside a large dark sphere.
 * Each frame the scene renders to a ping-pong FBO; the feedback shader zooms slightly
 * toward the camera's vanishing point, applies configurable chromatic RGB-channel offset,
 * and decays the result. The accumulated signal becomes a "signal atmosphere" painted
 * on the sphere interior — analog video synthesis rendered in 3D perspective.
 *
 * Palette: near-monochrome — warm amber/copper for bass nodes, cool silver-white
 * for treble — no per-band rainbow, no neon glow, no concentric ring pulses.
 *
 * Camera: slow elliptical orbit around the node cluster, giving genuine 3D parallax
 * as the sphere interior curves around it.
 *
 * Inspiration: Andrei Jay "WAAAVE_POOL" (2019–present, video feedback synthesizer,
 * https://github.com/ex-zee-ex/waaaave_pool) — a Raspberry Pi + desktop patch that
 * builds fractal spatial depth entirely from iterated framebuffer self-reference.
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { store } from '../state/store';
import { getBandAverages, fovForAspect } from './helpers';
import { audioEngine } from '../audio/engine';
import { isMobile } from '../utils/constants';

// ── Module state ──────────────────────────────────────────────────────────────

let initialized = false;
let threeCanvas: HTMLCanvasElement | null = null;
let renderer: THREE.WebGLRenderer | null = null;

// Main 3D scene with nodes + sphere backdrop
let scene: THREE.Scene | null = null;
let camera: THREE.PerspectiveCamera | null = null;
let composer: EffectComposer | null = null;

// Background sphere (BackSide, shows feedback texture)
let bgSphere: THREE.Mesh | null = null;
let bgMat: THREE.MeshBasicMaterial | null = null;

// 7 audio-reactive nodes
let nodeMeshes: THREE.Mesh[] = [];
let nodeMats: THREE.MeshStandardMaterial[] = [];

// Ping-pong framebuffers for feedback
let fboA: THREE.WebGLRenderTarget | null = null;
let fboB: THREE.WebGLRenderTarget | null = null;
let fbScene: THREE.Scene | null = null;
let fbCamera: THREE.OrthographicCamera | null = null;
let fbQuad: THREE.Mesh | null = null;
let fbMat: THREE.ShaderMaterial | null = null;

// Point lights (one per node, illuminates interior of sphere)
let pointLights: THREE.PointLight[] = [];

let vizModeUnsub: (() => void) | null = null;

let time = 0;
let cameraTheta = 0;
let cameraPhi = Math.PI * 0.35;
let lastBeatIndex = -1;
let beatKick = 0;   // decays: sudden zoom boost on beat
let pingIsA = true; // which FBO is the "write" target

// Node positions on a 3D dodecahedron-inspired formation (7 of 20 vertices)
// These are fixed layout positions, Formation slider scales them.
const NODE_BASE_POSITIONS: [number, number, number][] = [
  [  0.0,  1.0,  0.0 ],
  [  0.9, -0.4,  0.3 ],
  [ -0.9, -0.4,  0.3 ],
  [  0.6,  0.5, -0.7 ],
  [ -0.6,  0.5, -0.7 ],
  [  0.0, -0.4, -1.0 ],
  [  0.0, -1.0,  0.0 ],
];

// Per-node orbit velocities (Perlin-style slow drift)
const NODE_ORBIT_SPEEDS = [0.23, 0.17, 0.31, 0.19, 0.27, 0.13, 0.21];
const NODE_ORBIT_PHASES = NODE_BASE_POSITIONS.map((_, i) => i * 0.9 * Math.PI);

// Warm-to-cool palette: bass = deep amber, treble = silver-white (no rainbow)
function nodeColor(bandIdx: number): THREE.Color {
  const t = bandIdx / 6.0;
  // amber (1.0, 0.52, 0.08) → silver-white (0.85, 0.90, 1.0)
  const r = 1.0 * (1.0 - t) + 0.85 * t;
  const g = 0.52 * (1.0 - t) + 0.90 * t;
  const b = 0.08 * (1.0 - t) + 1.00 * t;
  return new THREE.Color(r, g, b);
}

// ── Feedback GLSL ─────────────────────────────────────────────────────────────

const FB_VERT = /* glsl */`
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

// Each frame: zoom toward center, rotate slightly, aberrate channels, decay.
// The zoom + rotation cascade creates infinite-regress depth from flat 2D frames.
const FB_FRAG = /* glsl */`
  uniform sampler2D uPrev;
  uniform float     uDecay;       // 0.92–0.99
  uniform float     uZoom;        // per-frame zoom toward center (feedback depth)
  uniform float     uAberration;  // chromatic channel separation
  uniform float     uRotate;      // per-frame rotation in radians
  uniform float     uBeatKick;    // extra zoom on beat

  varying vec2 vUv;

  vec3 sampleAberrated(vec2 uv, float amount) {
    vec2 d = (uv - 0.5) * amount;
    float r = texture2D(uPrev, uv - d).r;
    float g = texture2D(uPrev, uv      ).g;
    float b = texture2D(uPrev, uv + d).b;
    return vec3(r, g, b);
  }

  void main() {
    float totalZoom = uZoom + uBeatKick * 0.04;

    // Zoom UV toward canvas center
    vec2 centered = vUv - 0.5;

    // Slight rotation
    float c = cos(uRotate);
    float s = sin(uRotate);
    centered = vec2(c * centered.x - s * centered.y,
                    s * centered.x + c * centered.y);

    // Pull inward: zoom > 0 means UV moves toward center each frame
    centered *= (1.0 - totalZoom);
    vec2 sampledUv = centered + 0.5;

    // Clamp with soft edge fade (avoids sharp borders in the feedback)
    float edgeFade = 1.0 - smoothstep(0.45, 0.50, max(abs(centered.x), abs(centered.y)));

    vec3 prev = sampleAberrated(sampledUv, uAberration * 0.012) * uDecay * edgeFade;

    gl_FragColor = vec4(prev, 1.0);
  }
`;

// ── Feedback uniforms ─────────────────────────────────────────────────────────

const uPrev:      THREE.IUniform<THREE.Texture | null> = { value: null };
const uDecay:     THREE.IUniform<number>               = { value: 0.97 };
const uZoom:      THREE.IUniform<number>               = { value: 0.008 };
const uAberration:THREE.IUniform<number>               = { value: 0.0 };
const uRotate:    THREE.IUniform<number>               = { value: 0.0005 };
const uBeatKick:  THREE.IUniform<number>               = { value: 0.0 };

// ── Setup ─────────────────────────────────────────────────────────────────────

function makeFBO(w: number, h: number): THREE.WebGLRenderTarget {
  return new THREE.WebGLRenderTarget(w, h, {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    format: THREE.RGBAFormat,
    type: THREE.HalfFloatType,
  });
}

function setup(): void {
  initialized = true;

  // Overlay canvas
  threeCanvas = document.createElement('canvas');
  threeCanvas.style.cssText =
    'position:fixed;top:0;left:0;width:100%;height:100%;z-index:10;pointer-events:none;display:block';
  document.body.appendChild(threeCanvas);

  const w = window.innerWidth;
  const h = window.innerHeight;
  const dpr = isMobile ? 1.0 : Math.min(window.devicePixelRatio, 2);

  renderer = new THREE.WebGLRenderer({
    canvas: threeCanvas,
    antialias: !isMobile,
    alpha: true,
  });
  renderer.setPixelRatio(dpr);
  renderer.setSize(w, h);
  renderer.setRenderTarget(null);

  // ── Ping-pong FBOs ──
  const fw = Math.floor(w * dpr * (isMobile ? 0.5 : 1.0));
  const fh = Math.floor(h * dpr * (isMobile ? 0.5 : 1.0));
  fboA = makeFBO(fw, fh);
  fboB = makeFBO(fw, fh);

  // ── Feedback pass scene (orthographic fullscreen quad) ──
  fbCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  fbScene = new THREE.Scene();
  const fbGeo = new THREE.PlaneGeometry(2, 2);
  fbMat = new THREE.ShaderMaterial({
    uniforms: { uPrev, uDecay, uZoom, uAberration, uRotate, uBeatKick },
    vertexShader: FB_VERT,
    fragmentShader: FB_FRAG,
    depthTest: false,
    depthWrite: false,
  });
  fbQuad = new THREE.Mesh(fbGeo, fbMat);
  fbScene.add(fbQuad);

  // ── Main 3D scene ──
  scene = new THREE.Scene();
  scene.background = null;  // transparent — THREE will clear to black

  camera = new THREE.PerspectiveCamera(fovForAspect(55, w / h), w / h, 0.1, 100);
  camera.position.set(0, 0, 3.5);

  // Large BackSide sphere — we sit inside and see the feedback texture on its interior
  const sphereGeo = new THREE.SphereGeometry(12, 48, 32);
  bgMat = new THREE.MeshBasicMaterial({
    side: THREE.BackSide,
    map: null,   // assigned from FBO each frame
    fog: false,
  });
  bgSphere = new THREE.Mesh(sphereGeo, bgMat);
  scene.add(bgSphere);

  // Ambient fill (very dim — nodes provide most light)
  const ambient = new THREE.AmbientLight(0x0a0810, 0.3);
  scene.add(ambient);

  // 7 nodes + point lights
  const nodeGeo = new THREE.SphereGeometry(0.15, isMobile ? 10 : 20, isMobile ? 8 : 14);

  for (let i = 0; i < 7; i++) {
    const col = nodeColor(i);
    const mat = new THREE.MeshStandardMaterial({
      color: col,
      emissive: col,
      emissiveIntensity: 2.0,
      roughness: 0.3,
      metalness: 0.7,
    });
    const mesh = new THREE.Mesh(nodeGeo, mat);
    scene.add(mesh);
    nodeMeshes.push(mesh);
    nodeMats.push(mat);

    const light = new THREE.PointLight(col.clone(), 1.2, 10, 2);
    scene.add(light);
    pointLights.push(light);
  }

  // ── EffectComposer ──
  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  if (!isMobile) {
    const bloom = new UnrealBloomPass(new THREE.Vector2(w, h), 0.4, 0.4, 0.7);
    composer.addPass(bloom);
  }
  composer.addPass(new OutputPass());

  // Hide backdrop by default — feedback builds over first few frames
  vizModeUnsub = store.on('vizModeChange', () => {
    // Reset feedback accumulation when switching away and back
    resetFeedback();
  });
}

function resetFeedback(): void {
  if (!renderer || !fboA || !fboB) return;
  renderer.setRenderTarget(fboA);
  renderer.clear();
  renderer.setRenderTarget(fboB);
  renderer.clear();
  renderer.setRenderTarget(null);
  pingIsA = true;
  beatKick = 0;
  time = 0;
}

// ── Node positions ────────────────────────────────────────────────────────────

function updateNodePositions(formation: number): void {
  // Each node drifts on a slow sinusoidal path around its base position
  const spread = 0.4 + formation * 2.8; // 0.4 (tight) → 3.2 (wide constellation)
  for (let i = 0; i < 7; i++) {
    const [bx, by, bz] = NODE_BASE_POSITIONS[i];
    const phase = NODE_ORBIT_PHASES[i] + time * NODE_ORBIT_SPEEDS[i];
    // Each node gently orbits its base position
    const dx = Math.sin(phase * 0.7) * 0.3;
    const dy = Math.cos(phase * 0.5) * 0.2;
    const dz = Math.sin(phase * 0.6 + 1.0) * 0.3;
    const mesh = nodeMeshes[i];
    const light = pointLights[i];
    if (mesh && light) {
      const x = (bx + dx) * spread;
      const y = (by + dy) * spread;
      const z = (bz + dz) * spread;
      mesh.position.set(x, y, z);
      light.position.set(x, y, z);
    }
  }
}

// ── Draw ──────────────────────────────────────────────────────────────────────

export function drawRelay(_p: unknown, dt: number): void {
  if (!initialized) setup();
  if (!renderer || !scene || !camera || !composer || !fboA || !fboB ||
      !fbScene || !fbCamera || !fbMat || !bgMat) return;

  const { amps, transients } = getBandAverages(7);
  const { state, config } = store;

  // Beat detection
  const beatIntervalSec = state.beatIntervalSec > 0 ? state.beatIntervalSec : 0.5;
  const playPos = audioEngine.getPlaybackPosition();
  const beatIndex = Math.floor(playPos / beatIntervalSec);
  const isBeat = beatIndex !== lastBeatIndex;
  if (isBeat) {
    lastBeatIndex = beatIndex;
    beatKick = 1.0;
  }
  beatKick *= Math.pow(0.85, dt); // fast decay

  time += 0.016 * dt;

  // Slider values
  const formation  = config.relayFormation;  // 0–1: structural cluster vs. wide
  const cascade    = config.relayCascade;    // 0–1: feedback depth (decay rate)
  const aberration = config.relayAberration; // 0–1: chromatic RGB shift

  // Map cascade → decay (0=quick fade 0.88, 1=deep cascade 0.985)
  const decay = 0.88 + cascade * 0.105;

  // Map cascade → zoom (deeper cascade = slightly faster tunnel convergence)
  const zoom = 0.004 + cascade * 0.010;

  // Update feedback uniforms
  uDecay.value     = decay;
  uZoom.value      = zoom;
  uAberration.value = aberration;
  uRotate.value    = 0.0003 + cascade * 0.0004;
  uBeatKick.value  = beatKick;

  // Update node positions
  updateNodePositions(formation);

  // Update node sizes and light intensities from audio
  for (let i = 0; i < 7; i++) {
    const amp = amps[i] ?? 0;
    const transient = Math.max(0, (transients[i] ?? 1) - 1);
    const nodeMesh = nodeMeshes[i];
    const mat = nodeMats[i];
    const light = pointLights[i];
    if (nodeMesh && mat && light) {
      const scale = 1.0 + amp * 0.8 + transient * 0.4;
      nodeMesh.scale.setScalar(scale * (0.7 + formation * 0.5));
      mat.emissiveIntensity = 1.5 + amp * 3.0;
      light.intensity = 0.6 + amp * 2.5 + transient * 1.5;
      light.distance = 3 + formation * 5 + amp * 3;
    }
  }

  // Camera orbit — slow elliptical path around node cluster
  const orbitSpeed = 0.008 * dt;
  cameraTheta += orbitSpeed;
  cameraPhi = Math.PI * 0.35 + Math.sin(time * 0.07) * 0.18;

  const camR = 3.2 + Math.sin(time * 0.11) * 0.4;
  camera.position.set(
    camR * Math.sin(cameraTheta) * Math.sin(cameraPhi),
    camR * Math.cos(cameraPhi),
    camR * Math.cos(cameraTheta) * Math.sin(cameraPhi),
  );
  camera.lookAt(0, Math.sin(time * 0.05) * 0.3, 0);

  // ── Step 1: Feedback pass — read prev FBO, write to current ──
  const readFbo  = pingIsA ? fboA : fboB;
  const writeFbo = pingIsA ? fboB : fboA;
  pingIsA = !pingIsA;

  uPrev.value = readFbo.texture;
  renderer.setRenderTarget(writeFbo);
  renderer.render(fbScene, fbCamera);

  // ── Step 2: Map the feedback accumulation onto the sphere backdrop ──
  bgMat.map = writeFbo.texture;
  bgMat.needsUpdate = false; // map already points to correct texture

  // ── Step 3: Render main 3D scene to screen via EffectComposer ──
  // EffectComposer renders scene to its own internal buffer then to screen
  renderer.setRenderTarget(null);
  composer.render();

  // ── Step 4: Also render a "fresh" frame of the scene into the write FBO ──
  // This injects the current node glow INTO the feedback accumulation.
  // We additively blend the current scene on top of the feedback texture.
  renderer.setRenderTarget(writeFbo);
  renderer.autoClear = false;
  renderer.render(scene, camera);
  renderer.autoClear = true;
  renderer.setRenderTarget(null);
}

// ── Reset (resize) ────────────────────────────────────────────────────────────

export function resetRelay(): void {
  if (!initialized) return;
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer?.setSize(w, h);
  if (camera) {
    camera.aspect = w / h;
    camera.fov    = fovForAspect(55, camera.aspect);
    camera.updateProjectionMatrix();
  }
  composer?.setSize(w, h);
  // Rebuild FBOs at new resolution
  const dpr = isMobile ? 1.0 : Math.min(window.devicePixelRatio, 2);
  const fw = Math.floor(w * dpr * (isMobile ? 0.5 : 1.0));
  const fh = Math.floor(h * dpr * (isMobile ? 0.5 : 1.0));
  fboA?.dispose();
  fboB?.dispose();
  fboA = makeFBO(fw, fh);
  fboB = makeFBO(fw, fh);
  pingIsA = true;
}

// ── Dispose (viz switch / page unload) ────────────────────────────────────────

export function disposeRelay(): void {
  if (!initialized) return;
  vizModeUnsub?.();
  vizModeUnsub = null;

  // Nodes
  for (const m of nodeMeshes) { scene?.remove(m); m.geometry.dispose(); }
  for (const mat of nodeMats) mat.dispose();
  for (const l of pointLights) scene?.remove(l);
  nodeMeshes = [];
  nodeMats = [];
  pointLights = [];

  bgSphere?.geometry.dispose();
  bgMat?.dispose();
  (fbQuad?.geometry)?.dispose();
  fbMat?.dispose();
  fboA?.dispose();
  fboB?.dispose();
  composer?.dispose();
  renderer?.dispose();
  threeCanvas?.remove();

  threeCanvas = null; renderer = null;
  scene = null; camera = null; composer = null;
  bgSphere = null; bgMat = null;
  fbScene = null; fbCamera = null; fbQuad = null; fbMat = null;
  fboA = null; fboB = null;

  initialized = false;
  time = 0;
  cameraTheta = 0;
  lastBeatIndex = -1;
  beatKick = 0;
  pingIsA = true;
}
