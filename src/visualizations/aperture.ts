/**
 * Aperture: perforated metallic sphere that breathes with music.
 *
 * A large metallic shell covered in a hexagonal grid of holes; each latitude
 * band maps to one of the 7 frequency bands. The holes dilate with audio
 * amplitude, revealing warm inner glow from an emissive core sphere.
 *
 * Inspired by SANAA's perforated aluminium-mesh facades and
 * Herzog & de Meuron's "Prada Aoyama" Tokyo flagship (2003,
 * https://www.herzogdemeuron.com/projects/129-prada-aoyama/).
 *
 * Near-monochrome warm-brass palette — no per-band rainbow, no neon glow,
 * no centre-pulse on beat. Audio drives hole geometry continuously.
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { store } from '../state/store';
import { getBandAverages, fovForAspect } from './helpers';
import { isMobile } from '../utils/constants';

// ── Module state ──────────────────────────────────────────────────────────────

let initialized = false;
let threeCanvas: HTMLCanvasElement | null = null;
let renderer: THREE.WebGLRenderer | null = null;
let scene: THREE.Scene | null = null;
let camera: THREE.PerspectiveCamera | null = null;
let composer: EffectComposer | null = null;
let shellMesh: THREE.Mesh | null = null;
let coreMesh: THREE.Mesh | null = null;
let shellMat: THREE.ShaderMaterial | null = null;
let coreMat: THREE.MeshStandardMaterial | null = null;
let shellGeo: THREE.SphereGeometry | null = null;
let coreGeo: THREE.SphereGeometry | null = null;
let vizModeUnsub: (() => void) | null = null;

// Orbit state
let orbitTheta = 0;   // azimuth angle
let coreGlow = 0;     // smoothed inner-sphere emissive intensity

// ── Uniforms ──────────────────────────────────────────────────────────────────

const uTime: THREE.IUniform<number>     = { value: 0 };
const uBands: THREE.IUniform<number[]>  = { value: new Array(7).fill(0) };
const uDensity: THREE.IUniform<number>  = { value: 0.5 };
const uBreathing: THREE.IUniform<number>= { value: 0.5 };

// ── Shell ShaderMaterial ──────────────────────────────────────────────────────

const VERT = /* glsl */`
  varying vec2 vUv;
  varying vec3 vNormal;
  varying vec3 vViewPos;

  void main() {
    vUv      = uv;
    vNormal  = normalize(normalMatrix * normal);
    vec4 mvp = modelViewMatrix * vec4(position, 1.0);
    vViewPos = -mvp.xyz;
    gl_Position = projectionMatrix * mvp;
  }
`;

const FRAG = /* glsl */`
  precision highp float;

  uniform float uTime;
  uniform float uBands[7];
  uniform float uDensity;   // 0–1 → grid coarse to fine
  uniform float uBreathing; // 0–1 → hole dilation sensitivity

  varying vec2 vUv;
  varying vec3 vNormal;
  varying vec3 vViewPos;

  // Blinn-Phong: warm key + cool fill
  vec3 shade(vec3 albedo, vec3 N, vec3 V) {
    // key: warm tungsten from upper-right
    vec3 keyDir  = normalize(vec3(1.2, 1.4, 1.0));
    vec3 keyCol  = vec3(1.0, 0.82, 0.60) * 1.4;
    // fill: cool blueish from lower-left
    vec3 fillDir = normalize(vec3(-1.0, -0.5, 0.6));
    vec3 fillCol = vec3(0.50, 0.62, 0.80) * 0.35;
    // rim:  cool from behind
    vec3 rimDir  = normalize(vec3(-0.4, 0.6, -1.0));
    vec3 rimCol  = vec3(0.40, 0.52, 0.70) * 0.25;

    vec3 ambient = albedo * 0.04;
    vec3 diff    = albedo * (
      keyCol  * max(dot(N, keyDir),  0.0) +
      fillCol * max(dot(N, fillDir), 0.0) +
      rimCol  * max(dot(N, rimDir),  0.0)
    );

    // Blinn-Phong specular (warm glint)
    vec3 H   = normalize(keyDir + normalize(vViewPos));
    float sp = pow(max(dot(N, H), 0.0), 64.0);
    vec3 spec = vec3(1.0, 0.90, 0.70) * sp * 0.6;

    return ambient + diff + spec;
  }

  void main() {
    // ── Hex grid in UV space ────────────────────────────────────────────────
    // Density 0→1 maps grid scale 3→18 (holes per quarter-sphere)
    float gridScale = mix(3.0, 18.0, uDensity);

    // Hex grid — axial coordinates
    // Compensate for sphere UV stretch (columns become denser toward poles)
    float sinLat  = sin(vUv.y * 3.14159);
    float colScale = max(sinLat, 0.12); // avoid div-by-zero at poles

    vec2 gridUV = vec2(vUv.x * gridScale / colScale,
                        vUv.y * gridScale * 0.866);

    // Alternate-row offset for hex close packing
    float row     = floor(gridUV.y);
    float colOff  = mod(row, 2.0) * 0.5;
    vec2  cellUV  = vec2(gridUV.x + colOff, gridUV.y);
    vec2  cell    = floor(cellUV);
    vec2  local   = fract(cellUV) - 0.5;

    float dist = length(local);

    // ── Band assignment by latitude ─────────────────────────────────────────
    // sub-bass (0) at equator (vUv.y ≈ 0.5), brilliance (6) toward poles.
    // Map latitude to a band index, symmetric about equator.
    float normLat = abs(vUv.y - 0.5) * 2.0; // 0 at equator, 1 at poles
    int bandIdx   = int(normLat * 6.999);
    bandIdx       = clamp(bandIdx, 0, 6);
    float amp     = uBands[bandIdx];

    // ── Hole radius ─────────────────────────────────────────────────────────
    // Base radius 0.32 of the cell half-size; amplitude opens it further.
    float baseR   = 0.25;
    float maxOpen = 0.46;   // maximum hole radius (cells start to merge)
    float holeR   = baseR + uBreathing * amp * (maxOpen - baseR);

    // Discard pixels inside the hole
    if (dist < holeR) discard;

    // ── Surface color: warm dark brass with shading ─────────────────────────
    // Slightly brighter where holes are smaller (thicker material)
    float thickness = 1.0 - smoothstep(baseR - 0.05, holeR, dist);
    vec3 brassAlbedo = mix(
      vec3(0.25, 0.18, 0.10),  // dark gun-metal
      vec3(0.60, 0.44, 0.22),  // warm brass highlight
      thickness * 0.6
    );

    vec3 N = normalize(vNormal);
    vec3 V = normalize(vViewPos);

    gl_FragColor = vec4(shade(brassAlbedo, N, V), 1.0);
  }
`;

// ── Setup ─────────────────────────────────────────────────────────────────────

function setup(): void {
  threeCanvas = document.createElement('canvas');
  threeCanvas.style.cssText =
    'position:fixed;top:0;left:0;width:100%;height:100%;z-index:10;pointer-events:none;display:block';
  document.body.appendChild(threeCanvas);

  renderer = new THREE.WebGLRenderer({ canvas: threeCanvas, antialias: !isMobile, alpha: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, isMobile ? 1 : 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  scene = new THREE.Scene();

  const aspect = window.innerWidth / window.innerHeight;
  camera = new THREE.PerspectiveCamera(fovForAspect(42, aspect), aspect, 0.1, 100);
  camera.position.set(0, 0.6, 3.8);
  camera.lookAt(0, 0, 0);

  // ── Shell sphere (outer, perforated) ──────────────────────────────────────
  const segH = isMobile ? 128 : 256;
  const segV = isMobile ? 64  : 128;
  shellGeo = new THREE.SphereGeometry(1.0, segH, segV);
  shellMat = new THREE.ShaderMaterial({
    vertexShader:   VERT,
    fragmentShader: FRAG,
    uniforms:       { uTime, uBands, uDensity, uBreathing },
    side:           THREE.FrontSide,
  });
  shellMesh = new THREE.Mesh(shellGeo, shellMat);
  scene.add(shellMesh);

  // ── Core sphere (inner, emissive warm glow) ───────────────────────────────
  coreGeo = new THREE.SphereGeometry(0.82, 32, 24);
  coreMat = new THREE.MeshStandardMaterial({
    color:             0x000000,
    emissive:          new THREE.Color(1.0, 0.52, 0.12),
    emissiveIntensity: 0.0,
    roughness:         1.0,
    metalness:         0.0,
  });
  coreMesh = new THREE.Mesh(coreGeo, coreMat);
  scene.add(coreMesh);

  // ── Subtle ambient environment (non-env-map, just plain hemi) ────────────
  const hemi = new THREE.HemisphereLight(0x221510, 0x081020, 0.3);
  scene.add(hemi);

  // ── Bloom (captures inner glow through holes) ─────────────────────────────
  const renderPass = new RenderPass(scene, camera);
  const bloomPass  = new UnrealBloomPass(
    new THREE.Vector2(window.innerWidth, window.innerHeight),
    isMobile ? 0.5 : 0.7,  // strength
    0.4,                    // radius
    0.85,                   // threshold
  );
  const outputPass = new OutputPass();
  composer = new EffectComposer(renderer);
  composer.addPass(renderPass);
  composer.addPass(bloomPass);
  composer.addPass(outputPass);

  vizModeUnsub = store.on('vizModeChange', (data) => {
    if (!threeCanvas) return;
    threeCanvas.style.display = data === 'aperture' ? 'block' : 'none';
  });

  initialized = true;
}

// ── Draw ─────────────────────────────────────────────────────────────────────

export function drawAperture(_p: unknown, dt: number): void {
  if (!initialized) setup();
  if (!renderer || !scene || !camera || !composer) return;

  const { amps } = getBandAverages(7);

  // Update band uniforms — smooth toward target each frame
  const smoothFactor = 1.0 - Math.pow(0.15, dt);
  for (let i = 0; i < 7; i++) {
    uBands.value[i] = uBands.value[i] + (amps[i]! - uBands.value[i]) * smoothFactor;
  }

  // Overall amplitude (loudness) drives inner glow
  const avgAmp = amps.reduce((s, v) => s + v, 0) / 7;
  const targetGlow = avgAmp * 2.0 * store.config.apertureWarmth;
  coreGlow = coreGlow + (targetGlow - coreGlow) * (1.0 - Math.pow(0.2, dt));
  if (coreMat) coreMat.emissiveIntensity = coreGlow;

  // Sync slider uniforms
  uDensity.value   = store.config.apertureDensity;
  uBreathing.value = store.config.apertureBreathing;

  // Advance time
  uTime.value += 0.01 * dt;

  // Slow sphere rotation around Y
  if (shellMesh) shellMesh.rotation.y += 0.003 * dt;
  if (coreMesh)  coreMesh.rotation.y  += 0.002 * dt;

  // Camera orbit: slow elliptical path at slight elevation
  orbitTheta += 0.004 * dt;
  const radius = 3.8;
  const elevY  = 0.55;
  camera.position.set(
    Math.sin(orbitTheta) * radius,
    elevY + Math.sin(orbitTheta * 0.37) * 0.25,
    Math.cos(orbitTheta) * radius,
  );
  camera.lookAt(0, 0, 0);

  composer.render();
}

// ── Reset (window resize) ─────────────────────────────────────────────────────

export function resetAperture(): void {
  if (!initialized) return;
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer?.setSize(w, h);
  if (camera) {
    camera.aspect = w / h;
    camera.fov    = fovForAspect(42, camera.aspect);
    camera.updateProjectionMatrix();
  }
  composer?.setSize(w, h);
}

// ── Dispose ──────────────────────────────────────────────────────────────────

export function disposeAperture(): void {
  if (!initialized) return;
  vizModeUnsub?.();
  vizModeUnsub = null;
  shellGeo?.dispose();
  shellMat?.dispose();
  coreGeo?.dispose();
  coreMat?.dispose();
  composer?.dispose();
  renderer?.dispose();
  threeCanvas?.remove();
  threeCanvas = null;
  renderer = null; scene = null; camera = null; composer = null;
  shellMesh = null; coreMesh = null;
  shellGeo = null; shellMat = null;
  coreGeo = null;  coreMat  = null;
  uBands.value = new Array(7).fill(0);
  coreGlow = 0;
  initialized = false;
}
