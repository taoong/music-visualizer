import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { store } from '../state/store';
import { getBandAverages } from './helpers';
import { audioEngine } from '../audio/engine';
import { isMobile } from '../utils/constants';

let initialized = false;
let threeCanvas: HTMLCanvasElement | null = null;
let renderer: THREE.WebGLRenderer | null = null;
let scene: THREE.Scene | null = null;
let camera: THREE.PerspectiveCamera | null = null;
let composer: EffectComposer | null = null;
let formMesh: THREE.Mesh | null = null;
let keyLight: THREE.DirectionalLight | null = null;
let vizModeUnsub: (() => void) | null = null;
let time = 0;
let cameraAngle = 0;
let beatKick = 0;
let lastBeatIndex = -1;
const currentInfluences: number[] = new Array(7).fill(0);

function buildMorphGeometry(rings: number, segs: number): THREE.BufferGeometry {
  const baseGeo = new THREE.SphereGeometry(2.5, rings, segs);
  const posAttr = baseGeo.attributes.position as THREE.BufferAttribute;
  const normAttr = baseGeo.attributes.normal as THREE.BufferAttribute;
  const count = posAttr.count;

  const morphAbsPos: Float32Array[] = Array.from({ length: 7 }, () => new Float32Array(count * 3));

  for (let i = 0; i < count; i++) {
    const x = posAttr.getX(i);
    const y = posAttr.getY(i);
    const z = posAttr.getZ(i);
    const r = Math.sqrt(x * x + y * y + z * z) + 1e-5;
    const theta = Math.acos(Math.max(-1, Math.min(1, y / r)));
    const phi = Math.atan2(z, x);
    const sinT = Math.sin(theta);

    // T0: Flatten into disc
    morphAbsPos[0][i * 3    ] = x * 1.4;
    morphAbsPos[0][i * 3 + 1] = y * 0.08;
    morphAbsPos[0][i * 3 + 2] = z * 1.4;

    // T1: Elongate into capsule
    morphAbsPos[1][i * 3    ] = x * 0.5;
    morphAbsPos[1][i * 3 + 1] = y * 2.1;
    morphAbsPos[1][i * 3 + 2] = z * 0.5;

    // T2: 3-lobed trefoil — lobes appear at equator
    const lobe = 1 + Math.max(0, Math.cos(3 * phi)) * sinT * 1.2;
    morphAbsPos[2][i * 3    ] = x * lobe;
    morphAbsPos[2][i * 3 + 1] = y * 0.9;
    morphAbsPos[2][i * 3 + 2] = z * lobe;

    // T3: Twist around Y axis
    const twistAngle = (y / r) * Math.PI * 1.2;
    const cosA = Math.cos(twistAngle);
    const sinA = Math.sin(twistAngle);
    morphAbsPos[3][i * 3    ] = x * cosA - z * sinA;
    morphAbsPos[3][i * 3 + 1] = y;
    morphAbsPos[3][i * 3 + 2] = x * sinA + z * cosA;

    // T4: Peanut — pinched at equator
    const pinch = 1 - sinT * 0.72;
    morphAbsPos[4][i * 3    ] = x * pinch;
    morphAbsPos[4][i * 3 + 1] = y * 1.3;
    morphAbsPos[4][i * 3 + 2] = z * pinch;

    // T5: Saddle surface (hyperbolic paraboloid)
    const sy = (y + (x * x - z * z) / (r * 1.2)) * 0.82;
    morphAbsPos[5][i * 3    ] = x * 0.85;
    morphAbsPos[5][i * 3 + 1] = sy;
    morphAbsPos[5][i * 3 + 2] = z * 0.85;

    // T6: Spiky starburst
    const spike = Math.max(0.3, 1 + Math.sin(5 * theta) * Math.sin(7 * phi) * 0.8);
    morphAbsPos[6][i * 3    ] = x * spike;
    morphAbsPos[6][i * 3 + 1] = y * spike;
    morphAbsPos[6][i * 3 + 2] = z * spike;
  }

  const basePosArr = posAttr.array as Float32Array;
  const baseNormArr = normAttr.array as Float32Array;
  baseGeo.morphAttributes.position = [];
  baseGeo.morphAttributes.normal   = [];

  for (let t = 0; t < 7; t++) {
    const posDelta = new Float32Array(count * 3);
    for (let j = 0; j < count * 3; j++) posDelta[j] = morphAbsPos[t][j] - basePosArr[j];

    const tempGeo = new THREE.BufferGeometry();
    tempGeo.setAttribute('position', new THREE.Float32BufferAttribute(morphAbsPos[t], 3));
    tempGeo.setIndex(baseGeo.index);
    tempGeo.computeVertexNormals();
    const morphNormArr = (tempGeo.attributes.normal as THREE.BufferAttribute).array as Float32Array;
    const normDelta = new Float32Array(count * 3);
    for (let j = 0; j < count * 3; j++) normDelta[j] = morphNormArr[j] - baseNormArr[j];

    baseGeo.morphAttributes.position.push(new THREE.Float32BufferAttribute(posDelta, 3));
    baseGeo.morphAttributes.normal.push(new THREE.Float32BufferAttribute(normDelta, 3));
    tempGeo.dispose();
  }

  return baseGeo;
}

function setup(): void {
  const rings = isMobile ? 24 : 48;
  const segs  = isMobile ? 12 : 24;

  threeCanvas = document.createElement('canvas');
  threeCanvas.style.cssText =
    'position:fixed;top:0;left:0;width:100%;height:100%;z-index:0;pointer-events:none;';
  document.body.appendChild(threeCanvas);

  renderer = new THREE.WebGLRenderer({ canvas: threeCanvas, antialias: !isMobile, alpha: false });
  renderer.setPixelRatio(isMobile ? 1 : Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  renderer.shadowMap.enabled = !isMobile;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0a090d);

  camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 100);
  camera.position.set(0, 1.5, 9);
  camera.lookAt(0, 0, 0);

  const ambient = new THREE.AmbientLight(0xffffff, 0.07);
  scene.add(ambient);

  keyLight = new THREE.DirectionalLight(0xffd080, 2.5);
  keyLight.position.set(5, 7, 4);
  if (!isMobile) {
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.set(1024, 1024);
    keyLight.shadow.camera.near = 1;
    keyLight.shadow.camera.far = 30;
    keyLight.shadow.bias = -0.001;
  }
  scene.add(keyLight);

  const fillLight = new THREE.DirectionalLight(0x607090, 1.0);
  fillLight.position.set(-5, -2, -4);
  scene.add(fillLight);

  const rimLight = new THREE.DirectionalLight(0x90b8c8, 0.6);
  rimLight.position.set(0, -4, -6);
  scene.add(rimLight);

  const geo = buildMorphGeometry(rings, segs);
  const mat = new THREE.MeshStandardMaterial({
    color: 0xd0a870,
    metalness: 0.75,
    roughness: 0.32,
  });
  formMesh = new THREE.Mesh(geo, mat);
  formMesh.castShadow = !isMobile;
  formMesh.receiveShadow = !isMobile;
  scene.add(formMesh);

  if (!isMobile) {
    const floorGeo = new THREE.PlaneGeometry(40, 40);
    const floorMat = new THREE.MeshStandardMaterial({ color: 0x0c0b10, roughness: 1, metalness: 0 });
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -4.5;
    floor.receiveShadow = true;
    scene.add(floor);
  }

  if (!isMobile) {
    composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    const bloom = new UnrealBloomPass(
      new THREE.Vector2(window.innerWidth, window.innerHeight),
      0.3, 0.6, 0.8
    );
    composer.addPass(bloom);
    composer.addPass(new OutputPass());
  }

  vizModeUnsub = store.on('vizModeChange', (data: unknown) => {
    if (threeCanvas) threeCanvas.style.display = (data === 'morphe') ? 'block' : 'none';
  });

  initialized = true;
}

export function drawMorphe(_p: unknown, dt: number): void {
  if (!initialized) setup();
  if (!renderer || !scene || !camera || !formMesh) return;

  time += dt * 0.016;

  const { amps } = getBandAverages(7);
  const { config, state } = store;
  const flowRate    = 0.04 + config.morpheFlow * 0.26;
  const sensitivity = config.morpheSensitivity;
  const infl = formMesh.morphTargetInfluences;

  if (infl) {
    for (let i = 0; i < 7 && i < infl.length; i++) {
      const target = Math.min(1, amps[i] * sensitivity * 2.0);
      currentInfluences[i] += (target - currentInfluences[i]) * flowRate * dt;
      infl[i] = Math.max(0, currentInfluences[i]);
    }
  }

  // beat detection — decaying kick impulse
  if (state.beatIntervalSec > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    const beatIdx = adjusted >= 0 ? Math.floor(adjusted / state.beatIntervalSec) : -1;
    if (beatIdx > lastBeatIndex) {
      lastBeatIndex = beatIdx;
      beatKick = 1.0;
    }
  }
  beatKick *= Math.pow(0.0001, (dt * 0.016) / 0.45);

  // camera orbit — slow sinusoidal with beat nudge
  const orbitSpeed = (0.006 + config.morpheFlow * 0.012) * dt;
  cameraAngle += orbitSpeed;
  const orbitR = 9.0 + beatKick * 0.9;
  camera.position.set(
    Math.sin(cameraAngle) * orbitR,
    1.4 + Math.sin(cameraAngle * 0.37) * 1.3,
    Math.cos(cameraAngle) * orbitR
  );
  camera.lookAt(0, 0, 0);

  // key light counter-orbits at half speed with beat flash
  if (keyLight) {
    keyLight.position.set(
      Math.cos(-cameraAngle * 0.5) * 7,
      6 + beatKick * 1.8,
      Math.sin(-cameraAngle * 0.5) * 5
    );
    keyLight.intensity = 2.5 + beatKick * 1.5;
  }

  // polish slider → roughness/metalness
  if (formMesh.material instanceof THREE.MeshStandardMaterial) {
    formMesh.material.roughness = 0.07 + (1 - config.morphePolish) * 0.68;
    formMesh.material.metalness = 0.52 + config.morphePolish * 0.42;
  }

  // subtle constant rotation for organic feel
  formMesh.rotation.y += 0.0014 * dt;

  if (composer) {
    composer.render();
  } else {
    renderer.render(scene, camera);
  }
}

export function resetMorphe(): void {
  if (!renderer || !camera || !composer) return;
  renderer.setSize(window.innerWidth, window.innerHeight);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  composer.setSize(window.innerWidth, window.innerHeight);
}

export function disposeMorphe(): void {
  if (vizModeUnsub) { vizModeUnsub(); vizModeUnsub = null; }
  if (formMesh) {
    formMesh.geometry.dispose();
    if (Array.isArray(formMesh.material)) {
      formMesh.material.forEach(m => m.dispose());
    } else {
      formMesh.material.dispose();
    }
    formMesh = null;
  }
  if (composer) { composer.dispose(); composer = null; }
  if (renderer) { renderer.dispose(); renderer = null; }
  if (threeCanvas?.parentNode) { threeCanvas.parentNode.removeChild(threeCanvas); threeCanvas = null; }
  scene = null;
  camera = null;
  keyLight = null;
  initialized = false;
  time = 0;
  cameraAngle = 0;
  beatKick = 0;
  lastBeatIndex = -1;
  currentInfluences.fill(0);
}
