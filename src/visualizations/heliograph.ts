/**
 * Heliograph — Seven large chrome panels arc through a dark void; each
 * panel's surface is audio-deformed in a custom GLSL vertex shader via
 * multi-octave FBM displacement; a tight warm-key / cool-fill / rim
 * 3-point rig sweeps specular bands across the rippled chrome as the
 * camera slowly orbits; no rainbow palette — matte aluminium to perfect
 * mirror controlled by the Polish slider.
 *
 * Inspired by United Visual Artists "Momentum" (2015, Pace Gallery London)
 * — 24 rotating polished-steel blades whose shifting reflections repaint
 * the gallery walls — and Daniel Rozin's motorised mirror sculptures
 * (bitforms gallery, https://www.bitforms.art/artist/daniel-rozin).
 * The key VJ technique is audio driving PER-VERTEX surface deformation,
 * not brightness or hue, so the FORM of the chrome bends with the music.
 * https://www.uva.co.uk/features/momentum
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

const BAND_COUNT = 7;
const PANEL_W    = 2.2;
const PANEL_H    = 3.4;
const ARC_RADIUS = 4.8;

let initialized   = false;
let threeCanvas   : HTMLCanvasElement | null = null;
let renderer      : THREE.WebGLRenderer | null = null;
let scene         : THREE.Scene | null = null;
let camera        : THREE.PerspectiveCamera | null = null;
let composer      : EffectComposer | null = null;
let panelMeshes   : THREE.Mesh[] = [];
let panelMaterials: THREE.ShaderMaterial[] = [];
let vizModeUnsub  : (() => void) | null = null;

let time       = 0;
let beatDecay  = 0;
let lastSpread = -1; // detect spread change to rebuild positions

// ── GLSL — vertex shader ──────────────────────────────────────────────────────

const VERT = /* glsl */`
  precision highp float;

  uniform float uTime;
  uniform float uAmp;
  uniform float uBeat;
  uniform float uDepth;

  varying vec3 vNormal;
  varying vec3 vWorldPos;

  // ── Value noise ──
  float hash2(vec2 p) {
    p = fract(p * vec2(443.898, 397.297));
    p += dot(p, p.yx + 19.19);
    return fract(p.x * p.y);
  }

  float vnoise2(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(hash2(i),              hash2(i + vec2(1.0, 0.0)), u.x),
      mix(hash2(i + vec2(0.0, 1.0)), hash2(i + vec2(1.0, 1.0)), u.x),
      u.y);
  }

  float fbm(vec2 p) {
    float v = 0.0, a = 0.5;
    v += a * (vnoise2(p) * 2.0 - 1.0); p = p * 2.07 + vec2(1.73, 2.31); a *= 0.5;
    v += a * (vnoise2(p) * 2.0 - 1.0); p = p * 2.07 + vec2(1.73, 2.31); a *= 0.5;
    v += a * (vnoise2(p) * 2.0 - 1.0); p = p * 2.07 + vec2(1.73, 2.31); a *= 0.5;
    v += a * (vnoise2(p) * 2.0 - 1.0); p = p * 2.07 + vec2(1.73, 2.31); a *= 0.5;
    v += a * (vnoise2(p) * 2.0 - 1.0);
    return v;
  }

  void main() {
    // ── Displacement along panel normal (local +Z) ──
    float dispScale = uAmp * uDepth * 0.70 + uBeat * 0.20;
    float eps = 0.035;

    vec2 p0 = position.xy * 0.55 + uTime * vec2(0.115, 0.087);
    float d   = fbm(p0);
    float dX  = fbm(p0 + vec2(eps,  0.0));
    float dY  = fbm(p0 + vec2(0.0,  eps));

    float disp  = d  * dispScale;
    float dispX = dX * dispScale;
    float dispY = dY * dispScale;

    vec3 displaced = position + vec3(0.0, 0.0, disp);

    // ── Perturbed normal via finite differences of displacement ──
    vec3 tanX = normalize(vec3(eps, 0.0, dispX - disp));
    vec3 tanY = normalize(vec3(0.0, eps, dispY - disp));
    vec3 localN = normalize(cross(tanX, tanY));

    // ── World space (no non-uniform scale → mat3(modelMatrix) is valid) ──
    vNormal   = normalize(mat3(modelMatrix) * localN);
    vec4 wp   = modelMatrix * vec4(displaced, 1.0);
    vWorldPos = wp.xyz;

    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

// ── GLSL — fragment shader ────────────────────────────────────────────────────

const FRAG = /* glsl */`
  precision highp float;

  uniform vec3  uCameraPos;
  uniform float uPolish;   // 0 = matte brushed metal, 1 = perfect mirror
  uniform float uAmp;

  varying vec3 vNormal;
  varying vec3 vWorldPos;

  void main() {
    vec3 N = normalize(vNormal);
    vec3 V = normalize(uCameraPos - vWorldPos);

    // ── 3-point rig in world space (fixed, not per-band) ──
    // Warm key: upper-right-front
    vec3 L1 = normalize(vec3( 1.4,  1.9,  1.6));
    // Cool fill: lower-left-back (50 % of key)
    vec3 L2 = normalize(vec3(-1.1, -0.5, -0.9));
    // Rim: rear-right
    vec3 L3 = normalize(vec3( 1.8,  0.2, -1.8));

    float diff1 = max(dot(N, L1), 0.0);
    float diff2 = max(dot(N, L2), 0.0) * 0.38;

    // Specular — wide exponent range to distinguish matte from mirror
    float specExp = mix(10.0, 480.0, uPolish);

    vec3  H1    = normalize(L1 + V);
    float spec1 = pow(max(dot(N, H1), 0.0), specExp) * uPolish * 3.2;

    vec3  H3    = normalize(L3 + V);
    float spec3 = pow(max(dot(N, H3), 0.0), specExp * 0.4) * uPolish * 1.1;

    // Fresnel rim glow (stronger at grazing angles)
    float fresnel = pow(1.0 - max(dot(N, V), 0.0), 3.2) * 0.55;

    // ── Palette: no hue — brushed aluminium grey ──
    vec3 base     = vec3(0.64, 0.65, 0.67);
    vec3 warmKey  = vec3(1.00, 0.93, 0.80);   // warm 3200K key
    vec3 coolFill = vec3(0.68, 0.82, 1.00);   // cool 8000K fill
    vec3 rimCol   = vec3(0.88, 0.93, 1.00);   // blue-white rim

    // As polish → 1, diffuse yields to specular (metallic behaviour)
    float metalBlend = uPolish * 0.70;
    vec3 diffuse  = base * (diff1 * warmKey + diff2 * coolFill) * (1.0 - metalBlend);
    vec3 specular = warmKey * spec1 + rimCol * spec3;
    vec3 rimLight = rimCol * fresnel * 0.45;
    vec3 ambient  = base * 0.035;

    // Subtle amplitude beat pulse (very faint emissive on peaks)
    vec3 emissive = base * max(uAmp - 0.6, 0.0) * 0.12;

    vec3 color = ambient + diffuse + specular + rimLight + emissive;

    // Output linear HDR — OutputPass / renderer handles sRGB conversion
    gl_FragColor = vec4(color, 1.0);
  }
`;

// ── Panel layout builder ──────────────────────────────────────────────────────

function buildPanels(spread: number): void {
  // Remove old
  for (const m of panelMeshes) {
    scene!.remove(m);
    m.geometry.dispose();
  }
  for (const m of panelMaterials) m.dispose();
  panelMeshes.length = 0;
  panelMaterials.length = 0;

  const arcDeg   = 28.0 + spread * 116.0;          // 28° (tight) → 144° (wide arc)
  const arcRad   = (arcDeg * Math.PI) / 180.0;
  const halfArc  = arcRad * 0.5;
  const step     = BAND_COUNT > 1 ? arcRad / (BAND_COUNT - 1) : 0;
  const subdiv   = isMobile ? 16 : 32;

  const polish = store.config.heliographPolish;
  const depth  = store.config.heliographDepth;

  for (let k = 0; k < BAND_COUNT; k++) {
    const theta = -halfArc + k * step;              // angle in XZ plane
    const px    =  Math.sin(theta) * ARC_RADIUS;
    const pz    = -Math.cos(theta) * ARC_RADIUS;    // panels face +Z side (camera)

    const geo = new THREE.PlaneGeometry(PANEL_W, PANEL_H, subdiv, subdiv);

    const mat = new THREE.ShaderMaterial({
      vertexShader:   VERT,
      fragmentShader: FRAG,
      uniforms: {
        uTime:      { value: 0 },
        uAmp:       { value: 0 },
        uBeat:      { value: 0 },
        uDepth:     { value: depth },
        uPolish:    { value: polish },
        uCameraPos: { value: new THREE.Vector3() },
      },
      side: THREE.DoubleSide,
    });

    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(px, 0, pz);
    // Rotate panel to face the arc centre (origin).
    // PlaneGeometry normal = local +Z; after Ry(-theta), normal → (-sin θ, 0, cos θ)
    // which points from panel position toward origin. ✓
    mesh.rotation.y = -theta;

    scene!.add(mesh);
    panelMeshes.push(mesh);
    panelMaterials.push(mat);
  }

  lastSpread = spread;
}

// ── Setup ─────────────────────────────────────────────────────────────────────

function setup(): void {
  threeCanvas = document.createElement('canvas');
  threeCanvas.style.cssText =
    'position:fixed;top:0;left:0;width:100%;height:100%;z-index:10;pointer-events:none;display:block';
  document.body.appendChild(threeCanvas);

  renderer = new THREE.WebGLRenderer({ canvas: threeCanvas, antialias: !isMobile, alpha: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, isMobile ? 1.0 : 2.0));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x060606);

  {
    const aspect = window.innerWidth / window.innerHeight;
    camera = new THREE.PerspectiveCamera(fovForAspect(52, aspect), aspect, 0.1, 60);
  }
  camera.position.set(0, 1.5, 9.5);
  camera.lookAt(0, 0.5, 0);

  // EffectComposer: RenderPass → UnrealBloomPass → OutputPass
  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));

  const bloom = new UnrealBloomPass(
    new THREE.Vector2(window.innerWidth, window.innerHeight),
    isMobile ? 0.25 : 0.45,  // strength
    0.55,                     // radius
    0.82,                     // luminance threshold (bright specular highlights)
  );
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  buildPanels(store.config.heliographSpread);

  // Hide canvas when switching away
  vizModeUnsub = store.on('vizModeChange', (data) => {
    if (!threeCanvas) return;
    threeCanvas.style.display = data === 'heliograph' ? 'block' : 'none';
  });

  initialized = true;
}

// ── Draw ──────────────────────────────────────────────────────────────────────

export function drawHeliograph(_p: unknown, dt: number): void {
  if (!initialized) setup();
  if (!scene || !camera || !composer || !renderer) return;

  const { amps, transients } = getBandAverages(BAND_COUNT);

  // Beat detection via transients
  const maxTransient = Math.max(...transients);
  if (maxTransient > 1.35) {
    beatDecay = Math.min(1.0, beatDecay + (maxTransient - 1.0) * 0.65);
  }
  beatDecay *= Math.pow(0.86, dt);

  time += 0.016 * dt;

  // ── Smooth camera orbit — gentle sinusoidal sweep to show reflections ──
  const camAngle    = Math.sin(time * 0.038) * 0.90;   // ±52° sweep
  const camElevLow  = 0.8 + Math.sin(time * 0.019) * 0.4;
  const camDist     = 9.5 + Math.sin(time * 0.027) * 1.2;
  camera.position.set(
    Math.sin(camAngle) * camDist,
    camElevLow,
    Math.cos(camAngle) * camDist,
  );
  camera.lookAt(0, 0.5, 0);

  // ── Rebuild panel positions if Spread slider changed ──
  const spread = store.config.heliographSpread;
  if (Math.abs(spread - lastSpread) > 0.005) {
    // Update positions without full rebuild (positions only, not geometry)
    const arcDeg  = 28.0 + spread * 116.0;
    const arcRad  = (arcDeg * Math.PI) / 180.0;
    const halfArc = arcRad * 0.5;
    const step    = BAND_COUNT > 1 ? arcRad / (BAND_COUNT - 1) : 0;

    for (let k = 0; k < panelMeshes.length; k++) {
      const theta = -halfArc + k * step;
      const px    =  Math.sin(theta) * ARC_RADIUS;
      const pz    = -Math.cos(theta) * ARC_RADIUS;
      panelMeshes[k].position.set(px, 0, pz);
      panelMeshes[k].rotation.y = -theta;
    }
    lastSpread = spread;
  }

  // ── Update per-panel uniforms ──
  const polish = store.config.heliographPolish;
  const depth  = store.config.heliographDepth;
  const camPos = camera.position;

  for (let k = 0; k < panelMaterials.length; k++) {
    const u = panelMaterials[k].uniforms;
    // Offset time per panel so adjacent panels don't ripple in sync
    u['uTime'].value    = time + k * 1.618;
    u['uAmp'].value     = amps[k] ?? 0;
    u['uBeat'].value    = beatDecay;
    u['uDepth'].value   = depth;
    u['uPolish'].value  = polish;
    (u['uCameraPos'].value as THREE.Vector3).copy(camPos);
  }

  composer.render();
}

// ── Reset ─────────────────────────────────────────────────────────────────────

export function resetHeliograph(): void {
  if (!initialized) return;
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer?.setSize(w, h);
  if (camera) {
    camera.aspect = w / h;
    camera.fov    = fovForAspect(52, camera.aspect);
    camera.updateProjectionMatrix();
  }
  composer?.setSize(w, h);
}

// ── Dispose ───────────────────────────────────────────────────────────────────

export function disposeHeliograph(): void {
  if (!initialized) return;
  vizModeUnsub?.();
  vizModeUnsub = null;
  for (const m of panelMeshes) {
    scene?.remove(m);
    m.geometry.dispose();
  }
  for (const m of panelMaterials) m.dispose();
  panelMeshes.length = 0;
  panelMaterials.length = 0;
  composer?.dispose();
  renderer?.dispose();
  threeCanvas?.remove();
  threeCanvas  = null;
  renderer     = null;
  scene        = null;
  camera       = null;
  composer     = null;
  initialized  = false;
  lastSpread   = -1;
  time         = 0;
  beatDecay    = 0;
}
