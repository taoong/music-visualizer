/**
 * Platter — audio-reactive brushed-metal disc stack
 *
 * Seven thin CylinderGeometry platters (one per audio frequency band) float
 * in a dark studio space lit by two slowly orbiting studio spots. A custom
 * ShaderMaterial renders concentric groove rings — like hard-drive platters or
 * vinyl records — using Blinn-Phong specular and a Fresnel rim. Each disc
 * continuously tilts (X/Z axis) proportional to its band amplitude and slowly
 * spins around Y. At silence the stack is near-horizontal; at full volume
 * individual discs lean dramatically to reveal depth as edge-on slivers. Beat
 * fires a brief spin impulse and scatter that decays exponentially — no state
 * cuts, no hue jumps.
 *
 * Palette: near-monochrome; warmth derived from the live bass/treble ratio
 * (bass-heavy → warm bronze, treble-heavy → cool platinum) — no per-band
 * rainbow, no neon additive glow.
 * Camera: slow 360° orbit at 35° elevation, steady with a gentle handheld
 * Y sway that plays against the disc tilt.
 *
 * Inspired by Wolfgang Tillmans' "Freischwimmer" (2003) dark-room luminographs
 * where photographic paper exposed to a light pen produces flowing translucent
 * surface forms — and by the material VJ craft of Pfadfinderei (Berlin,
 * https://xlr8r.com/features/pfadfinderei-graphic-troopers/) whose blocky
 * reductionist live visuals turned light on physical objects into an instrument.
 *
 * Sliders:
 *   Spread — vertical disc separation (structural: tight stack ↔ spread column)
 *   Tilt   — audio tilt amplitude (structural: flat ↔ dramatic 3D lean)
 *   Glow   — inner emissive warmth + bloom intensity
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages, fovForAspect } from './helpers';
import { isMobile } from '../utils/constants';

const N_DISCS = 7;

// Each disc tilts "outward" in a different horizontal direction
const TILT_DX = Array.from({ length: N_DISCS }, (_, i) => Math.sin((i / N_DISCS) * Math.PI * 2));
const TILT_DZ = Array.from({ length: N_DISCS }, (_, i) => Math.cos((i / N_DISCS) * Math.PI * 2));

// Independent base Y spin rates (rad/frame at dt=1)
const BASE_SPIN = [0.011, 0.015, 0.009, 0.013, 0.017, 0.010, 0.014] as const;

// ── Module state ──────────────────────────────────────────────────────────────

let initialized = false;
let threeCanvas: HTMLCanvasElement | null = null;
let renderer:   THREE.WebGLRenderer | null = null;
let scene:      THREE.Scene | null = null;
let camera:     THREE.PerspectiveCamera | null = null;
let composer:   EffectComposer | null = null;
let bloomPass:  UnrealBloomPass | null = null;

let discMeshes:   THREE.Mesh[] = [];
let discMats:     THREE.ShaderMaterial[] = [];
let light0Mesh:   THREE.Mesh | null = null;
let light1Mesh:   THREE.Mesh | null = null;
let sharedGeo:    THREE.CylinderGeometry | null = null;

// Per-disc eased state
const eTiltX   = new Float32Array(N_DISCS);
const eTiltZ   = new Float32Array(N_DISCS);
const eHeight  = new Float32Array(N_DISCS);
const eSpins   = new Float32Array(N_DISCS);
const eAmps    = new Float32Array(N_DISCS);

// Shared uniforms (all discs share the same references)
const uTime:      THREE.IUniform<number>       = { value: 0 };
const uWarmth:    THREE.IUniform<number>       = { value: 0.5 };
const uGlow:      THREE.IUniform<number>       = { value: 0.4 };
const uLightPos0: THREE.IUniform<THREE.Vector3> = { value: new THREE.Vector3(4, 2.5, 3) };
const uLightPos1: THREE.IUniform<THREE.Vector3> = { value: new THREE.Vector3(-3, -1.5, 4) };

// Per-disc amplitude uniforms (one separate object per disc)
let ampUniforms: Array<THREE.IUniform<number>> = [];

let camAngle    = 0;
let beatKick    = 0;
let lastBeat    = -1;
let simTime     = 0;
let vizUnsub:   (() => void) | null = null;

// ── GLSL ──────────────────────────────────────────────────────────────────────

const VERT = /* glsl */`
  varying vec3  vN;
  varying vec3  vW;
  varying vec2  vUv;
  varying float vFace;

  void main() {
    vN    = normalize(normalMatrix * normal);
    vUv   = uv;
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vW    = wp.xyz;
    // CylinderGeometry: caps have normals ≈ (0,±1,0); side is radial
    vFace = step(0.9, abs(normal.y));
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const FRAG = /* glsl */`
  uniform float uTime;
  uniform vec3  uLightPos0;
  uniform vec3  uLightPos1;
  uniform float uAmp;
  uniform float uWarmth;
  uniform float uGlow;

  varying vec3  vN;
  varying vec3  vW;
  varying vec2  vUv;
  varying float vFace;

  const float PI    = 3.14159265;
  const float RINGS = 22.0;

  void main() {
    vec3 N = normalize(vN);
    vec3 V = normalize(cameraPosition - vW);
    vec3 L0 = normalize(uLightPos0 - vW);
    vec3 L1 = normalize(uLightPos1 - vW);

    float NdL0 = max(0.0, dot(N, L0));
    float NdL1 = max(0.0, dot(N, L1));

    // Blinn-Phong specular
    float sp0 = pow(max(0.0, dot(normalize(L0 + V), N)), 128.0);
    float sp1 = pow(max(0.0, dot(normalize(L1 + V), N)),  64.0);

    // Fresnel rim
    float fr = pow(1.0 - max(0.0, dot(N, V)), 3.5);

    // Concentric groove rings (face only; side is smooth)
    float r     = length(vUv - 0.5) * 2.0;           // 0=center, 1=rim
    float wave  = 0.5 + 0.5 * sin(r * RINGS * PI * 2.0);
    float groove = mix(0.5, wave, vFace);

    // Base color: warm bronze <-> cool platinum
    vec3 warm = vec3(0.73, 0.61, 0.42);
    vec3 cool = vec3(0.57, 0.63, 0.73);
    vec3 base = mix(cool, warm, uWarmth) * (0.40 + 0.60 * groove);

    // Diffuse lighting
    vec3 key  = vec3(1.00, 0.94, 0.82) * 1.6;
    vec3 fill = vec3(0.68, 0.80, 1.00) * 0.8;
    vec3 col  = base * (0.05 + NdL0 * key + NdL1 * fill);

    // Specular highlight (near-white, warm-tinted)
    vec3 sc = mix(vec3(0.85, 0.90, 1.00), vec3(1.00, 0.96, 0.82), uWarmth);
    col += sc * (sp0 * 0.85 + sp1 * 0.40);

    // Cool rim highlight
    col += vec3(0.60, 0.72, 1.00) * fr * 0.28;

    // Inner emissive glow (face only, weighted toward center)
    float gMask = max(0.0, 1.0 - r * 1.35) * vFace;
    vec3  gHue  = mix(vec3(0.28, 0.42, 0.90), vec3(0.95, 0.65, 0.28), uWarmth);
    col += gHue * gMask * uAmp * uGlow * 2.5;

    gl_FragColor = vec4(col, 1.0);
  }
`;

// ── Setup ─────────────────────────────────────────────────────────────────────

function setup(): void {
  const w = window.innerWidth;
  const h = window.innerHeight;

  threeCanvas = document.createElement('canvas');
  threeCanvas.style.cssText =
    'position:fixed;top:0;left:0;width:100%;height:100%;z-index:10;pointer-events:none;display:block';
  document.body.appendChild(threeCanvas);

  renderer = new THREE.WebGLRenderer({ canvas: threeCanvas, antialias: !isMobile, alpha: true });
  renderer.setSize(w, h);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, isMobile ? 1.0 : 2.0));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;

  scene = new THREE.Scene();

  const aspect = w / h;
  camera = new THREE.PerspectiveCamera(fovForAspect(50, aspect), aspect, 0.1, 100);
  camera.position.set(0, 4.5, 9.5);
  camera.lookAt(0, -0.3, 0);

  // Shared geometry (all 7 discs)
  sharedGeo = new THREE.CylinderGeometry(1.2, 1.2, 0.07, isMobile ? 64 : 128, 1, false);

  ampUniforms = [];
  discMeshes  = [];
  discMats    = [];

  for (let i = 0; i < N_DISCS; i++) {
    const ampU: THREE.IUniform<number> = { value: 0 };
    ampUniforms.push(ampU);

    const mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uTime:      uTime,
        uLightPos0: uLightPos0,
        uLightPos1: uLightPos1,
        uWarmth:    uWarmth,
        uGlow:      uGlow,
        uAmp:       ampU,
      },
    });
    discMats.push(mat);

    const mesh = new THREE.Mesh(sharedGeo, mat);
    const restY = (i - (N_DISCS - 1) * 0.5) * 0.8;
    mesh.position.y = restY;
    eHeight[i]      = restY;
    scene.add(mesh);
    discMeshes.push(mesh);
  }

  // Small emissive dots marking the two orbiting light positions
  const dotGeo = new THREE.SphereGeometry(0.05, 8, 8);
  light0Mesh = new THREE.Mesh(dotGeo, new THREE.MeshBasicMaterial({ color: 0xfff0d0 }));
  light1Mesh = new THREE.Mesh(dotGeo, new THREE.MeshBasicMaterial({ color: 0xd0e8ff }));
  scene.add(light0Mesh);
  scene.add(light1Mesh);

  // Post-processing
  const rp = new RenderPass(scene, camera);
  bloomPass  = new UnrealBloomPass(new THREE.Vector2(w, h), isMobile ? 0.15 : 0.35, 0.5, 0.70);
  const op   = new OutputPass();
  composer   = new EffectComposer(renderer);
  composer.addPass(rp);
  if (!isMobile) composer.addPass(bloomPass);
  composer.addPass(op);

  // Dispose when the user switches away
  vizUnsub = store.on('vizModeChange', () => {
    disposePlatter();
  });

  initialized = true;
}

// ── Draw ──────────────────────────────────────────────────────────────────────

export function drawPlatter(_p: unknown, dt: number): void {
  if (!initialized) setup();

  const dtN = Math.min(dt, 3.0);   // guard against large pauses
  simTime  += dtN * 0.016;          // real-time accumulator (seconds)

  const { amps } = getBandAverages(N_DISCS);
  const cfg = store.config;

  // ── Beat detection ──────────────────────────────────────────────────────────
  const state  = store.state;
  const bInt   = state.beatIntervalSec > 0 ? state.beatIntervalSec : 0.5;
  const playPos = audioEngine.getPlaybackPosition();
  const beatIdx = Math.floor(playPos / bInt);
  if (beatIdx !== lastBeat && beatIdx >= 0) {
    lastBeat  = beatIdx;
    beatKick  = 1.0;
  }
  beatKick *= Math.pow(0.87, dtN);

  // ── Shared uniforms ─────────────────────────────────────────────────────────

  // Warmth: eased from live bass/treble balance
  const bassE   = ((amps[0] ?? 0) + (amps[1] ?? 0)) * 0.5;
  const trebleE = ((amps[5] ?? 0) + (amps[6] ?? 0)) * 0.5;
  const wTarget = 0.15 + 0.75 * Math.min(1, bassE / (trebleE + 0.05));
  uWarmth.value += (wTarget - uWarmth.value) * 0.025 * dtN;

  uGlow.value  = cfg.platterGlow;
  uTime.value  = simTime;

  // Update bloom strength from Glow slider
  if (bloomPass) bloomPass.strength = cfg.platterGlow * 0.6;

  // ── Orbiting studio lights ──────────────────────────────────────────────────
  const lt0 = uLightPos0.value;
  lt0.set(
    Math.cos(simTime * 0.31)  * 5.2,
     2.5 + Math.sin(simTime * 0.18) * 0.9,
    Math.sin(simTime * 0.31)  * 5.2,
  );
  const lt1 = uLightPos1.value;
  lt1.set(
    Math.cos(simTime * -0.23 + Math.PI) * 3.8,
    -1.5 + Math.sin(simTime * 0.27) * 0.6,
    Math.sin(simTime * -0.23 + Math.PI) * 3.8,
  );
  if (light0Mesh) light0Mesh.position.copy(lt0);
  if (light1Mesh) light1Mesh.position.copy(lt1);

  // ── Per-disc update ─────────────────────────────────────────────────────────
  const spread   = cfg.platterSpread;
  const maxTilt  = cfg.platterTilt * Math.PI * 0.55; // up to ~99°

  for (let i = 0; i < N_DISCS; i++) {
    const amp = amps[i] ?? 0;

    // Ease amp (CHOP-style: continuous lerp)
    eAmps[i] += (amp - eAmps[i]) * 0.09 * dtN;
    ampUniforms[i].value = eAmps[i];

    // Tilt outward in disc-assigned direction
    const targetTX =  eAmps[i] * maxTilt * TILT_DZ[i];
    const targetTZ = -eAmps[i] * maxTilt * TILT_DX[i];
    eTiltX[i] += (targetTX - eTiltX[i]) * 0.06 * dtN;
    eTiltZ[i] += (targetTZ - eTiltZ[i]) * 0.06 * dtN;

    // Y position: rest + slight amplitude float + beat scatter
    const restY     = (i - (N_DISCS - 1) * 0.5) * spread;
    const targetH   = restY + eAmps[i] * 0.18 + beatKick * 0.10 * TILT_DX[i];
    eHeight[i] += (targetH - eHeight[i]) * 0.05 * dtN;

    // Spin: continuous, faster when band is loud, brief kick on beat
    eSpins[i] += (BASE_SPIN[i] * (1.0 + eAmps[i] * 2.0) + beatKick * 0.022) * dtN;

    const mesh = discMeshes[i];
    if (!mesh) continue;
    mesh.position.y = eHeight[i];
    mesh.rotation.set(eTiltX[i], eSpins[i], eTiltZ[i]);
  }

  // ── Camera orbit (slow, no beat snaps) ─────────────────────────────────────
  camAngle += 0.0022 * dtN;
  const swayY  = Math.sin(simTime * 0.19) * 0.22;
  const camR   = 9.5;
  const camH   = 4.5;
  if (camera) {
    camera.position.set(
      Math.sin(camAngle) * camR,
      camH + swayY,
      Math.cos(camAngle) * camR,
    );
    camera.lookAt(0, -0.3, 0);
  }

  if (composer) composer.render();
}

// ── Reset (resize) ────────────────────────────────────────────────────────────

export function resetPlatter(): void {
  if (!initialized) return;
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer?.setSize(w, h);
  composer?.setSize(w, h);
  bloomPass?.setSize(w, h);
  if (camera) {
    camera.aspect = w / h;
    camera.fov    = fovForAspect(50, camera.aspect);
    camera.updateProjectionMatrix();
  }
}

// ── Dispose (viz switch / page unload) ────────────────────────────────────────

export function disposePlatter(): void {
  if (!initialized) return;
  vizUnsub?.();
  vizUnsub = null;
  sharedGeo?.dispose();
  for (const mat of discMats) mat.dispose();
  if (light0Mesh) {
    light0Mesh.geometry.dispose();
    (light0Mesh.material as THREE.Material).dispose();
  }
  if (light1Mesh) {
    light1Mesh.geometry.dispose();
    (light1Mesh.material as THREE.Material).dispose();
  }
  composer?.dispose();
  renderer?.dispose();
  threeCanvas?.remove();

  threeCanvas = null;
  renderer    = null;
  scene       = null;
  camera      = null;
  composer    = null;
  bloomPass   = null;
  sharedGeo   = null;
  discMeshes  = [];
  discMats    = [];
  light0Mesh  = null;
  light1Mesh  = null;
  ampUniforms = [];
  initialized = false;
}
