/**
 * Field Lines — 3D magnetic dipole field lines
 *
 * 7 L-shells of closed magnetic field lines orbit a central dipole (one shell
 * per frequency band). Sub-bass (band 0) drives the outermost wide-arcing
 * field lines; brilliance (band 6) drives the tight inner loops near the poles.
 * Band amplitude controls per-shell brightness. Camera orbits the dipole axis
 * with a slow tilt drift. Near-monochrome cold palette: midnight-navy background,
 * steel-blue → pure-white lines. Beat fires a brief radial camera pull-back.
 *
 * Inspired by Semiconductor (Ruth Jarman & Joe Gerhardt) "20hz" (2011) —
 * a recording of Earth's electromagnetic field rendered as cascading white lines
 * against black space, with audio derived from the electromagnetic data itself.
 * https://semiconductor-films.com/work/20hz/
 *
 * No rainbow per-band hues; no neon additive glow rings; no concentric
 * shockwave pulses. Restrained cold palette, physical camera orbit.
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { store } from '../state/store';
import { getBandAverages } from './helpers';
import { audioEngine } from '../audio/engine';
import { isMobile } from '../utils/constants';

// ── Module state ──────────────────────────────────────────────────────────────

let initialized = false;
let threeCanvas: HTMLCanvasElement | null = null;
let renderer: THREE.WebGLRenderer | null = null;
let scene: THREE.Scene | null = null;
let camera: THREE.PerspectiveCamera | null = null;
let composer: EffectComposer | null = null;
let bloomPass: UnrealBloomPass | null = null;
let shellGroup: THREE.Group | null = null;
// Per-shell line arrays; shell 0 = outermost (sub-bass), shell 6 = innermost (brilliance)
let shellLines: THREE.Line[][] = [];
let shellMaterials: THREE.LineBasicMaterial[] = [];
let vizModeUnsub: (() => void) | null = null;

// Camera state — continuous easing (CHOP style, never snaps)
let cameraTheta = 0;
let beatKick = 0;
let time = 0;
let lastBeatIndex = -1;

// Smoothed per-shell energy (eased toward band amplitude each frame)
const shellEnergy = new Float32Array(7).fill(0);

// L-shell equatorial crossing radii — outermost (sub-bass) to innermost (brilliance)
const L_RADII = [5.0, 4.1, 3.4, 2.8, 2.3, 1.9, 1.55];

// Cold palette: one color per L-shell — near-identical so the piece feels monochrome
// Outermost lines are slightly warmer blue; innermost are brighter and cooler
const SHELL_COLORS = [
  0x3a5fa8, // steel-blue outer
  0x4a72c0,
  0x5580d8,
  0x6090e8,
  0x74a8f5,
  0x90c0ff,
  0xb8d8ff, // near-white inner
];

const POINTS_PER_LINE = isMobile ? 50 : 110;

// ── Field line geometry ───────────────────────────────────────────────────────

/**
 * Parametric magnetic dipole field line:
 *   r = L · cos²(λ),  λ = magnetic latitude [-π/2 + ε … π/2 - ε]
 *   x = r·cos(λ)·cos(φ),  y = r·sin(λ),  z = r·cos(λ)·sin(φ)
 * where φ is azimuthal angle (lines of longitude around dipole axis).
 */
function buildFieldLine(L: number, phi: number): THREE.BufferGeometry {
  const pts: number[] = [];
  const N = POINTS_PER_LINE;
  const eps = 0.025;
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const lam = -Math.PI / 2 + eps + (Math.PI - 2 * eps) * t;
    const r = L * Math.cos(lam) * Math.cos(lam);
    pts.push(
      r * Math.cos(lam) * Math.cos(phi),
      r * Math.sin(lam),
      r * Math.cos(lam) * Math.sin(phi),
    );
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  return geo;
}

// ── Shell construction ────────────────────────────────────────────────────────

function buildShells(linesPerShell: number): void {
  if (!scene) return;

  // Dispose previous geometry
  if (shellGroup) {
    shellGroup.traverse((obj) => {
      if (obj instanceof THREE.Line) obj.geometry.dispose();
    });
    scene.remove(shellGroup);
    shellGroup = null;
  }
  shellLines = [];

  shellGroup = new THREE.Group();
  scene.add(shellGroup);

  for (let s = 0; s < 7; s++) {
    shellLines[s] = [];
    for (let l = 0; l < linesPerShell; l++) {
      const phi = (l / linesPerShell) * Math.PI * 2;
      const geo = buildFieldLine(L_RADII[s], phi);
      const line = new THREE.Line(geo, shellMaterials[s]);
      shellLines[s].push(line);
      shellGroup.add(line);
    }
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────

function init(p5Canvas: HTMLCanvasElement): void {
  if (initialized) return;

  threeCanvas = document.createElement('canvas');
  threeCanvas.style.cssText =
    'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:1;';
  p5Canvas.parentElement!.appendChild(threeCanvas);

  renderer = new THREE.WebGLRenderer({
    canvas: threeCanvas,
    alpha: false,
    antialias: !isMobile,
  });
  renderer.setPixelRatio(isMobile ? 1 : Math.min(window.devicePixelRatio, 2));
  const w = p5Canvas.offsetWidth;
  const h = p5Canvas.offsetHeight;
  renderer.setSize(w, h);

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x010408);

  camera = new THREE.PerspectiveCamera(52, w / h, 0.1, 100);
  camera.position.set(0, 1.5, 12);
  camera.lookAt(0, 0, 0);

  // One LineBasicMaterial per shell; color intensity updated each frame
  shellMaterials = SHELL_COLORS.map(
    (c) => new THREE.LineBasicMaterial({ color: c, transparent: true, opacity: 0.15 })
  );

  const cfg = store.config;
  buildShells(linesCount(cfg.fieldlinesLines));

  // Post-processing: bloom only on desktop
  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  if (!isMobile) {
    bloomPass = new UnrealBloomPass(new THREE.Vector2(w, h), 0.7, 0.5, 0.1);
    composer.addPass(bloomPass);
  }
  composer.addPass(new OutputPass());

  // Unsubscribe / hide when a different viz is selected
  vizModeUnsub = store.on('vizModeChange', (data) => {
    if (data !== 'fieldlines') {
      if (threeCanvas) threeCanvas.style.display = 'none';
    } else {
      if (threeCanvas) threeCanvas.style.display = 'block';
    }
  });

  const ro = new ResizeObserver(() => {
    if (!renderer || !camera || !p5Canvas) return;
    const nw = p5Canvas.offsetWidth;
    const nh = p5Canvas.offsetHeight;
    renderer.setSize(nw, nh);
    camera.aspect = nw / nh;
    camera.updateProjectionMatrix();
    bloomPass?.setSize(nw, nh);
    composer?.setSize(nw, nh);
  });
  ro.observe(p5Canvas);

  initialized = true;
}

function linesCount(t: number): number {
  return Math.max(2, Math.round(2 + t * 8)); // 2–10
}

// ── Draw ──────────────────────────────────────────────────────────────────────

export function drawFieldlines(p: unknown, dt: number): void {
  const p5Canvas = (p as { canvas: HTMLCanvasElement }).canvas;
  if (!initialized) init(p5Canvas);
  if (!renderer || !scene || !camera || !composer) return;

  time += dt;
  const cfg = store.config;
  const { amps } = getBandAverages(7);

  // Smooth shell energies — fast attack, slow release (CHOP-style)
  for (let s = 0; s < 7; s++) {
    const tgt = amps[s] ?? 0;
    const k = tgt > shellEnergy[s] ? 0.30 : 0.07;
    shellEnergy[s] += (tgt - shellEnergy[s]) * k;
  }

  // Beat detection
  const { state } = store;
  if (state.beatIntervalSec > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adj = pos - state.beatOffset;
    const bi  = adj >= 0 ? Math.floor(adj / state.beatIntervalSec) : -1;
    if (bi > lastBeatIndex) {
      lastBeatIndex = bi;
      beatKick = 1.0;
    }
  }
  beatKick *= Math.pow(0.90, dt);

  // Camera orbit — slow continuous drift around Y axis
  const driftSpeed = 0.0012 + cfg.fieldlinesDrift * 0.008;
  cameraTheta += driftSpeed * dt;
  // Gentle tilt that oscillates over time (no snapping)
  const phi = 0.28 + Math.sin(time * 0.00012 + 1.2) * 0.16;
  const baseR = isMobile ? 14 : 12;
  const radius = baseR + beatKick * 2.0;
  camera.position.set(
    Math.cos(cameraTheta) * radius * Math.cos(phi),
    radius * Math.sin(phi),
    Math.sin(cameraTheta) * radius * Math.cos(phi),
  );
  camera.lookAt(0, 0, 0);

  // Update per-shell material brightness from audio + glow setting
  const glowScale = 0.3 + cfg.fieldlinesGlow * 0.9;
  for (let s = 0; s < 7; s++) {
    const e = shellEnergy[s];
    // Opacity: dim at silence, bright at loud — shells nearer inside stay
    // slightly brighter so the inner structure is always visible
    const innerBoost = (6 - s) / 6 * 0.08;
    const base = 0.06 + innerBoost + e * 0.80 + beatKick * 0.25;
    shellMaterials[s].opacity = Math.min(1, base * glowScale);
  }

  // Rebuild field line geometry when Lines slider changes (structural)
  const targetN = linesCount(cfg.fieldlinesLines);
  const currentN = shellLines[0]?.length ?? 0;
  if (targetN !== currentN) buildShells(targetN);

  // Slowly rotate the whole field group for variety
  if (shellGroup) {
    shellGroup.rotation.y += driftSpeed * 0.25 * dt;
  }

  // Bloom strength tracks audio energy + glow setting
  if (bloomPass) {
    const overall = shellEnergy.reduce((a, b) => a + b, 0) / 7;
    bloomPass.strength = 0.4 + cfg.fieldlinesGlow * 1.0 + overall * 0.8;
    bloomPass.threshold = 0.05;
  }

  composer.render();
}

// ── Reset / Dispose ───────────────────────────────────────────────────────────

export function resetFieldlines(): void {
  time = 0;
  cameraTheta = 0;
  beatKick = 0;
  lastBeatIndex = -1;
  shellEnergy.fill(0);
}

function disposeSelf(): void {
  if (!initialized) return;
  initialized = false;

  vizModeUnsub?.();
  vizModeUnsub = null;

  shellMaterials.forEach((m) => m.dispose());
  shellMaterials = [];

  if (shellGroup) {
    shellGroup.traverse((obj) => {
      if (obj instanceof THREE.Line) obj.geometry.dispose();
    });
    scene?.remove(shellGroup);
    shellGroup = null;
  }
  shellLines = [];

  composer?.dispose();
  renderer?.dispose();
  composer = null;
  bloomPass = null;
  renderer = null;
  scene = null;
  camera = null;

  threeCanvas?.parentElement?.removeChild(threeCanvas);
  threeCanvas = null;
}

export function disposeFieldlines(): void {
  disposeSelf();
}
