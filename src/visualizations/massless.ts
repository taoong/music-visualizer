/**
 * Massless Suns — Three.js WebGL overlay visualization
 * 20–40 large volumetric light spheres (and shadow-void anti-spheres) drift in
 * a darkened void. Near-monochrome warm-amber palette. Each sphere is assigned to
 * a frequency band; amplitude drives halo radius. A ripple chain-reaction races
 * between neighbouring suns on every beat. "Dark suns" are SubtractiveBlending
 * anti-spheres that hollow out patches of the glow field.
 *
 * Inspired by teamLab "Massless Suns and Dark Suns" (2025, teamLab Biovortex
 * Kyoto / teamLab Phenomena Abu Dhabi)
 * https://www.teamlab.art/w/masslesssuns/
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

// ── Constants ─────────────────────────────────────────────────────────────────

const DESKTOP_MAX = 36;
const MOBILE_MAX  = 14;
const MAX_SUNS    = isMobile ? MOBILE_MAX : DESKTOP_MAX;
const VOLUME_HALF = 22;    // half-size of the cube in which suns are scattered
const SPHERE_SEGS = isMobile ? 12 : 22;

// Warm amber/gold palette per band (hex): sub-bass deep amber → brilliance near-white
const BAND_HEX_WARM = [
  0xff7300,  // sub-bass  – deep amber-orange
  0xff9918,  // bass      – amber
  0xffb833,  // low-mid   – golden amber
  0xffd25a,  // mid       – warm gold
  0xffe580,  // upper-mid – pale gold
  0xf2f2b3,  // presence  – cream gold
  0xffffe5,  // brilliance – near-white warm
] as const;

// Dark sun base color (cool, faint blue-violet)
const DARK_SUN_HEX = 0x0d1a4d;

// ── Module state ──────────────────────────────────────────────────────────────

let initialized    = false;
let threeCanvas    : HTMLCanvasElement | null = null;
let renderer       : THREE.WebGLRenderer | null = null;
let scene          : THREE.Scene | null = null;
let camera         : THREE.PerspectiveCamera | null = null;
let composer       : EffectComposer | null = null;
let bloomPass      : UnrealBloomPass | null = null;
let vizModeUnsub   : (() => void) | null = null;

// Per-sun state arrays (populated in setup, resized on slider change)
const sunMeshes   : THREE.Mesh[] = [];
const sunMats     : THREE.ShaderMaterial[] = [];
const sunPos      : THREE.Vector3[] = [];
const sunVel      : THREE.Vector3[] = [];
const sunBand     : number[] = [];
const sunIsDark   : boolean[] = [];
const sunBaseR    : number[] = [];
const sunRipple   : number[] = [];   // 0–1, decays each frame, set by chain ripple

// Camera drift
let camAngle  = 0;
let camHeight = 0;
let camR      = 14;    // radial distance from the cloud centre
let camTarget : THREE.Vector3 | null = null;

let time           = 0;
let lastBeatIndex  = -1;

// ── GLSL: volumetric glow billboard ──────────────────────────────────────────

const VERT_SHADER = /* glsl */`
  uniform float uRadius;
  varying vec2  vUv;

  void main() {
    vUv = uv;
    // Billboard: expand the sphere by a halo factor so the glow extends
    // well beyond the nominal radius.
    vec3 pos = position * uRadius * 2.2;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
  }
`;

const FRAG_SHADER = /* glsl */`
  uniform vec3  uColor;
  uniform float uRadius;
  uniform float uAlpha;
  varying vec2  vUv;

  void main() {
    // Distance from billboard centre in UV space (remapped to -1..1)
    vec2 d = vUv * 2.0 - 1.0;
    float dist = length(d);

    // Two-term Gaussian: tight bright core + wider soft halo
    float core = exp(-dist * dist * 12.0);
    float halo = exp(-dist * dist * 2.4) * 0.45;
    float glow = core + halo;

    // Clip at the outer edge of the billboard quad
    if (dist > 1.0) discard;

    gl_FragColor = vec4(uColor * glow, glow * uAlpha);
  }
`;

const FRAG_DARK = /* glsl */`
  uniform vec3  uColor;
  uniform float uRadius;
  uniform float uAlpha;
  varying vec2  vUv;

  void main() {
    vec2 d = vUv * 2.0 - 1.0;
    float dist = length(d);
    if (dist > 1.0) discard;

    // Dark sun: stronger core absorption, gentler rim
    float core = exp(-dist * dist * 10.0);
    float rim  = exp(-dist * dist * 2.0) * 0.3;
    float absorb = core + rim;

    gl_FragColor = vec4(uColor * absorb, absorb * uAlpha);
  }
`;

// ── Helpers ───────────────────────────────────────────────────────────────────

function randRange(a: number, b: number): number {
  return a + Math.random() * (b - a);
}

function buildSun(isDark: boolean, bandIdx: number): void {
  const geo = new THREE.SphereGeometry(1.0, SPHERE_SEGS, SPHERE_SEGS);

  // Uniform handles (mutated per-frame via material.uniforms)
  const uRadius: THREE.IUniform<number> = { value: randRange(1.6, 3.2) };
  const uColor : THREE.IUniform<THREE.Color> = {
    value: isDark
      ? new THREE.Color(DARK_SUN_HEX)
      : new THREE.Color(BAND_HEX_WARM[bandIdx % 7]),
  };
  const uAlpha : THREE.IUniform<number> = { value: 0.9 };

  const mat = new THREE.ShaderMaterial({
    uniforms:      { uRadius, uColor, uAlpha },
    vertexShader:  VERT_SHADER,
    fragmentShader: isDark ? FRAG_DARK : FRAG_SHADER,
    blending:      isDark ? THREE.SubtractiveBlending : THREE.AdditiveBlending,
    transparent:   true,
    depthWrite:    false,
    side:          THREE.FrontSide,
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(
    randRange(-VOLUME_HALF, VOLUME_HALF),
    randRange(-VOLUME_HALF * 0.6, VOLUME_HALF * 0.6),
    randRange(-VOLUME_HALF, VOLUME_HALF),
  );

  // Gentle drift velocity
  const speed = randRange(0.01, 0.06);
  const vel = new THREE.Vector3(
    randRange(-1, 1),
    randRange(-0.4, 0.4),
    randRange(-1, 1),
  ).normalize().multiplyScalar(speed);

  sunMeshes.push(mesh);
  sunMats.push(mat);
  sunPos.push(mesh.position);
  sunVel.push(vel);
  sunBand.push(bandIdx);
  sunIsDark.push(isDark);
  sunBaseR.push(uRadius.value);
  sunRipple.push(0);

  scene!.add(mesh);
}

function clearSuns(): void {
  for (let i = 0; i < sunMeshes.length; i++) {
    sunMeshes[i].geometry.dispose();
    sunMats[i].dispose();
    scene?.remove(sunMeshes[i]);
  }
  sunMeshes.length = 0;
  sunMats.length = 0;
  sunPos.length = 0;
  sunVel.length = 0;
  sunBand.length = 0;
  sunIsDark.length = 0;
  sunBaseR.length = 0;
  sunRipple.length = 0;
}

function rebuildSuns(count: number, darkFrac: number): void {
  clearSuns();
  const darkCount = Math.round(count * darkFrac);
  for (let i = 0; i < count; i++) {
    const isDark = i < darkCount;
    const bandIdx = i % 7;
    buildSun(isDark, bandIdx);
  }
}

// ── Setup ─────────────────────────────────────────────────────────────────────

function setup(): void {
  threeCanvas = document.createElement('canvas');
  threeCanvas.style.cssText =
    'position:fixed;top:0;left:0;width:100%;height:100%;z-index:10;pointer-events:none;display:block';
  document.body.appendChild(threeCanvas);

  renderer = new THREE.WebGLRenderer({ canvas: threeCanvas, antialias: false, alpha: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, isMobile ? 1 : 1.5));
  renderer.setClearColor(0x000000, 0);

  scene = new THREE.Scene();
  // Near-black warm background (deep sepia space)
  scene.background = new THREE.Color(0x05030a);

  {
    const aspect = window.innerWidth / window.innerHeight;
    camera = new THREE.PerspectiveCamera(fovForAspect(55, aspect), aspect, 0.1, 300);
  }
  camera.position.set(0, 0, camR);

  // Post-processing: UnrealBloom creates the luminous halos
  const renderPass = new RenderPass(scene, camera);
  const w = window.innerWidth;
  const h = window.innerHeight;
  bloomPass = new UnrealBloomPass(new THREE.Vector2(w, h), 1.4, 0.8, 0.0);
  const outputPass = new OutputPass();

  composer = new EffectComposer(renderer);
  composer.addPass(renderPass);
  composer.addPass(bloomPass);
  composer.addPass(outputPass);

  // Build initial suns from current config
  const cfg = store.config;
  const count = Math.round(cfg.masslessSuns * (MAX_SUNS - 8) + 8);
  const darkFrac = cfg.masslessVoid;
  rebuildSuns(count, darkFrac);

  camTarget = new THREE.Vector3();

  vizModeUnsub = store.on('vizModeChange', (data) => {
    if (!threeCanvas) return;
    threeCanvas.style.display = data === 'massless' ? 'block' : 'none';
  });

  initialized = true;
}

// ── Draw ──────────────────────────────────────────────────────────────────────

export function drawMassless(_p: unknown, dt: number): void {
  if (!initialized) setup();
  if (!renderer || !scene || !camera || !composer) return;

  const cfg = store.config;
  const { amps } = getBandAverages(7);
  const overallAmp = amps.reduce((s, b) => s + b, 0) / amps.length;

  // Recount-check: if slider changed sun count rebuild
  const targetCount = Math.round(cfg.masslessSuns * (MAX_SUNS - 8) + 8);
  if (Math.abs(targetCount - sunMeshes.length) > 1) {
    rebuildSuns(targetCount, cfg.masslessVoid);
  }

  // Beat detection
  const { state } = store;
  let beatFired = false;
  if (state.isPlaying && state.beatIntervalSec > 0) {
    const pos = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    const beatIdx = adjusted >= 0 ? Math.floor(adjusted / state.beatIntervalSec) : -1;
    if (beatIdx > lastBeatIndex) {
      lastBeatIndex = beatIdx;
      beatFired = true;
    }
  }

  // On beat: fire a ripple from the loudest band's sun
  if (beatFired) {
    let loudestBand = 0;
    let loudestAmp = 0;
    for (let b = 0; b < 7; b++) {
      if (amps[b] > loudestAmp) { loudestAmp = amps[b]; loudestBand = b; }
    }
    let epicIdx = 0;
    for (let i = 0; i < sunBand.length; i++) {
      if (sunBand[i] === loudestBand && !sunIsDark[i]) { epicIdx = i; break; }
    }
    sunRipple[epicIdx] = 1.0;
  }

  time += 0.016 * dt;

  const driftSpeed = cfg.masslessDrift;
  const glowMult   = cfg.masslessGlow;

  if (bloomPass) {
    bloomPass.strength = 1.0 + glowMult * 0.8;
    bloomPass.radius   = 0.5 + glowMult * 0.5;
  }

  for (let i = 0; i < sunMeshes.length; i++) {
    const mesh   = sunMeshes[i];
    const mat    = sunMats[i];
    const vel    = sunVel[i];
    const band   = sunBand[i];
    const isDark = sunIsDark[i];

    // Drift
    mesh.position.x += vel.x * driftSpeed * dt;
    mesh.position.y += vel.y * driftSpeed * dt;
    mesh.position.z += vel.z * driftSpeed * dt;

    // Torus-wrap within the volume
    const H  = VOLUME_HALF + 4;
    const HY = VOLUME_HALF * 0.7;
    if (mesh.position.x >  H) mesh.position.x = -H;
    if (mesh.position.x < -H) mesh.position.x =  H;
    if (mesh.position.y >  HY) mesh.position.y = -HY;
    if (mesh.position.y < -HY) mesh.position.y =  HY;
    if (mesh.position.z >  H) mesh.position.z = -H;
    if (mesh.position.z < -H) mesh.position.z =  H;

    // Ripple propagation: receive from nearby glowing suns
    let maxNear = 0;
    for (let j = 0; j < sunMeshes.length; j++) {
      if (i === j) continue;
      if (sunRipple[j] > 0.05) {
        const dist = mesh.position.distanceTo(sunMeshes[j].position);
        const reach = (sunBaseR[i] + sunBaseR[j]) * 5.0 + 4.0;
        if (dist < reach) {
          maxNear = Math.max(maxNear, sunRipple[j] * 0.7);
        }
      }
    }
    if (maxNear > sunRipple[i]) sunRipple[i] = maxNear;
    sunRipple[i] *= 0.93;

    const bandAmp    = isDark ? (1.0 - amps[band] * 0.5) : amps[band];
    const rippleBoost = sunRipple[i] * 0.9;
    const targetR    = sunBaseR[i] * (0.55 + bandAmp * 0.9 + rippleBoost);

    (mat.uniforms['uRadius'] as THREE.IUniform<number>).value +=
      (targetR - (mat.uniforms['uRadius'] as THREE.IUniform<number>).value) * 0.12 * dt;

    if (isDark) {
      (mat.uniforms['uAlpha'] as THREE.IUniform<number>).value = 0.45 + (1.0 - overallAmp) * 0.45;
    } else {
      (mat.uniforms['uAlpha'] as THREE.IUniform<number>).value = 0.3 + bandAmp * 0.65 + glowMult * 0.1;
    }

    mesh.rotation.y += 0.003 * dt;
    mesh.rotation.x += 0.0015 * dt;
  }

  // Camera: slow sinusoidal orbit through the void
  camAngle  += 0.0006 * driftSpeed * dt;
  camHeight += 0.0003 * driftSpeed * dt;
  const beatPush = beatFired ? overallAmp * 3.5 : 0;
  const targetCamR  = camR + Math.sin(time * 0.15) * 6.0;
  const cx = Math.cos(camAngle) * (targetCamR + beatPush);
  const cz = Math.sin(camAngle) * (targetCamR + beatPush);
  const cy = Math.sin(camHeight) * 7.0 + overallAmp * 2.0;

  camera.position.lerp(new THREE.Vector3(cx, cy, cz), 0.025 * dt);

  const tx = Math.sin(time * 0.08) * 3.0;
  const ty = Math.cos(time * 0.11) * 2.0;
  if (camTarget) {
    camTarget.lerp(new THREE.Vector3(tx, ty, 0), 0.01 * dt);
    camera.lookAt(camTarget);
  }

  composer.render();
}

// ── Reset (window resize) ─────────────────────────────────────────────────────

export function resetMassless(): void {
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
  bloomPass?.setSize(w, h);
}

// ── Dispose ───────────────────────────────────────────────────────────────────

export function disposeMassless(): void {
  if (!initialized) return;
  vizModeUnsub?.();
  vizModeUnsub = null;
  clearSuns();
  composer?.dispose();
  renderer?.dispose();
  threeCanvas?.remove();
  threeCanvas = null; renderer = null; scene = null; camera = null;
  composer = null; bloomPass = null;
  camAngle = 0; camHeight = 0; time = 0; lastBeatIndex = -1;
  camTarget = null;
  initialized = false;
}
