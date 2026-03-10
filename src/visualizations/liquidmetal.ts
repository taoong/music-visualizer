/**
 * Liquid Metal Sphere — Three.js WebGL overlay visualization
 * Dark industrial aesthetic: bass-driven vertex displacement + glitch post-processing
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GlitchPass } from 'three/addons/postprocessing/GlitchPass.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { store } from '../state/store';
import { getBandAverages } from './helpers';

// ── Module state ──────────────────────────────────────────────────────────────

let threeCanvas: HTMLCanvasElement | null = null;
let renderer: THREE.WebGLRenderer | null = null;
let scene: THREE.Scene | null = null;
let camera: THREE.PerspectiveCamera | null = null;
let composer: EffectComposer | null = null;
let glitchPass: GlitchPass | null = null;
let sphereMesh: THREE.Mesh | null = null;
let envTexture: THREE.Texture | null = null;
let vizModeUnsub: (() => void) | null = null;
let initialized = false;
let glitchCooldown = 0;

// Uniform objects — mutated in place each frame, Three.js reads by reference
const uTime: THREE.IUniform<number> = { value: 0.0 };
const uBassAmp: THREE.IUniform<number> = { value: 0.0 };
const uTransient: THREE.IUniform<number> = { value: 0.0 };

// ── GLSL ──────────────────────────────────────────────────────────────────────

const GLSL_UNIFORMS = /* glsl */`
  uniform float uTime;
  uniform float uBassAmp;
  uniform float uTransient;
`;

const GLSL_NOISE = /* glsl */`
  float hash(vec3 p) {
    p = fract(p * vec3(443.8975, 397.2973, 491.1871));
    p += dot(p.zxy, p.yxz + 19.19);
    return fract(p.x * p.y * p.z);
  }

  float valueNoise(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    vec3 u = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(mix(hash(i),              hash(i+vec3(1,0,0)), u.x),
          mix(hash(i+vec3(0,1,0)),  hash(i+vec3(1,1,0)), u.x), u.y),
      mix(mix(hash(i+vec3(0,0,1)), hash(i+vec3(1,0,1)), u.x),
          mix(hash(i+vec3(0,1,1)), hash(i+vec3(1,1,1)), u.x), u.y),
      u.z
    );
  }

  float fbm(vec3 p) {
    float val = 0.0;
    float amp = 0.5;
    float freq = 1.0;
    for (int i = 0; i < 5; i++) {
      val += amp * (valueNoise(p * freq) * 2.0 - 1.0);
      amp  *= 0.5;
      freq *= 2.1;
    }
    return val;
  }
`;

const GLSL_DISPLACEMENT = /* glsl */`
  vec3 transformed = vec3(position);
  float n = fbm(position * 2.0 + uTime * 0.5);
  float disp = uBassAmp * 0.4 * n + uTransient * 0.15;
  transformed += normal * disp;
`;

// ── Setup ─────────────────────────────────────────────────────────────────────

function setup(): void {
  // Overlay canvas
  threeCanvas = document.createElement('canvas');
  threeCanvas.style.cssText =
    'position:fixed;top:0;left:0;width:100%;height:100%;z-index:10;pointer-events:none;display:block';
  document.body.appendChild(threeCanvas);

  // Renderer
  renderer = new THREE.WebGLRenderer({ canvas: threeCanvas, antialias: true, alpha: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.2;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  // Scene + camera
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 100);
  camera.position.set(0, 0, 3.5);

  // Environment map (interior HDR, no file needed)
  const pmrem = new THREE.PMREMGenerator(renderer);
  const roomEnv = new RoomEnvironment();
  envTexture = pmrem.fromScene(roomEnv, 0.04).texture;
  scene.environment = envTexture;
  pmrem.dispose();
  roomEnv.dispose();

  // Industrial lighting
  const keyLight = new THREE.DirectionalLight(0xadd8ff, 3.0); // blue-white top-left
  keyLight.position.set(-2, 3, 2);
  scene.add(keyLight);

  const fillLight = new THREE.DirectionalLight(0xff4422, 1.5); // orange-red fill
  fillLight.position.set(3, -2, -1);
  scene.add(fillLight);

  scene.add(new THREE.AmbientLight(0x111111, 0.8));

  // High-poly icosahedron: detail 5 = 20,480 triangles (smooth displacement)
  const geometry = new THREE.IcosahedronGeometry(1.0, 5);

  // PBR material + custom vertex displacement via onBeforeCompile
  const material = new THREE.MeshStandardMaterial({
    color: 0xcccccc,
    metalness: 1.0,
    roughness: 0.08,
    envMapIntensity: 1.5,
  });

  material.onBeforeCompile = (shader) => {
    shader.uniforms['uTime'] = uTime;
    shader.uniforms['uBassAmp'] = uBassAmp;
    shader.uniforms['uTransient'] = uTransient;
    // Prepend uniform + noise declarations
    shader.vertexShader = GLSL_UNIFORMS + '\n' + GLSL_NOISE + '\n' + shader.vertexShader;
    // Replace begin_vertex to add displacement
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', GLSL_DISPLACEMENT);
  };

  sphereMesh = new THREE.Mesh(geometry, material);
  scene.add(sphereMesh);

  // Post-processing: RenderPass → GlitchPass
  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));

  glitchPass = new GlitchPass();
  glitchPass.goWild = false;
  glitchPass.enabled = false;
  composer.addPass(glitchPass);

  // Hide canvas when switching away from this viz
  vizModeUnsub = store.on('vizModeChange', (data) => {
    if (!threeCanvas) return;
    threeCanvas.style.display = data === 'liquidmetal' ? 'block' : 'none';
  });

  initialized = true;
}

// ── Draw (called by p5 draw loop at ~60fps) ───────────────────────────────────

export function drawLiquidMetal(_p: unknown, dt: number): void {
  if (!initialized) setup();

  // Audio data: bass (band 1: 60-250Hz) + kick transients (bands 0-1)
  const { amps, transients } = getBandAverages(7);
  const bassAmp = amps[1] ?? 0;
  const rawTransient = Math.max(transients[0] ?? 1.0, transients[1] ?? 1.0);
  const transientNorm = Math.max(0.0, rawTransient - 1.0); // 0 at rest, >0 on kick

  // Update uniforms
  uTime.value += 0.016 * dt;
  uBassAmp.value = bassAmp;
  uTransient.value = transientNorm;

  // Sphere idle rotation + scale pump on kick
  if (sphereMesh) {
    sphereMesh.rotation.y += 0.003 * dt;
    sphereMesh.rotation.x += 0.001 * dt;
    sphereMesh.scale.setScalar(1.0 + transientNorm * 0.12);
  }

  // Glitch: brief burst on strong transient, cooldown prevents sustained glitch
  if (glitchPass) {
    if (transientNorm > 0.4 && glitchCooldown <= 0) {
      glitchPass.enabled = true;
      glitchPass.goWild = transientNorm > 0.8;
      glitchCooldown = 8;
    } else {
      glitchCooldown--;
      if (glitchCooldown <= 0) {
        glitchPass.enabled = false;
        glitchPass.goWild = false;
      }
    }
  }

  if (composer) composer.render();
}

// ── Reset (called on window resize) ──────────────────────────────────────────

export function resetLiquidMetal(): void {
  if (!initialized) return;
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer?.setSize(w, h);
  if (camera) { camera.aspect = w / h; camera.updateProjectionMatrix(); }
  composer?.setSize(w, h);
}

// ── Dispose (called on page unload) ──────────────────────────────────────────

export function disposeLiquidMetal(): void {
  if (!initialized) return;
  vizModeUnsub?.();
  vizModeUnsub = null;
  (sphereMesh?.geometry)?.dispose();
  (sphereMesh?.material as THREE.Material | undefined)?.dispose();
  envTexture?.dispose();
  composer?.dispose();
  renderer?.dispose();
  threeCanvas?.remove();
  threeCanvas = null; renderer = null; scene = null; camera = null;
  composer = null; glitchPass = null; sphereMesh = null; envTexture = null;
  initialized = false;
}
