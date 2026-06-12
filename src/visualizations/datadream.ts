/**
 * Data Dream — a luminous field of audio-reactive data points that drifts
 * like fog and periodically coalesces into an organic "data sculpture"
 * silhouette before dissolving back into the flow.
 *
 * Inspired by Refik Anadol Studio's "Machine Hallucinations" practice and
 * Dataland — the world's first AI-art museum, opening June 20, 2026 in Los
 * Angeles, whose inaugural exhibition "Machine Dreams: Rainforest" renders
 * vast ecological datasets as evolving point-cloud "digital sculptures" that
 * continuously form and dissolve in real time.
 * https://refikanadol.com/
 *
 * Thousands of glowing points drift through a slow Perlin flow field, each
 * tinted by one of 7 frequency bands (cool data-blue for sub-bass sliding
 * through indigo, violet and magenta to warm gold for brilliance). On every
 * beat the field "dreams": points are pulled toward a freshly generated
 * organic polar-curve silhouette, hold there as a glowing data sculpture,
 * then ease back into free-flowing fog as the form decays.
 *
 * Sliders
 *   Density — number of data points in the field (sparse mist → dense fog)
 *   Flow    — speed and turbulence of the drifting flow field
 *   Form    — strength and persistence of the beat-triggered "dream" formation
 */
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { BAND_COUNT, isMobile } from '../utils/constants';

const TWO_PI = Math.PI * 2;

const MAX_PARTICLES = isMobile ? 800 : 2200;
const MIN_PARTICLES = isMobile ? 150 : 350;
const FIELD_RES = isMobile ? 80 : 56;

// Per-band hues: cool data-blue (sub-bass) -> indigo -> violet -> magenta -> warm gold (brilliance)
const BAND_HUES = [195, 208, 222, 248, 282, 318, 36];

// ── module-scoped particle state (structure-of-arrays) ───────────────────────
let _px = new Float32Array(0);
let _py = new Float32Array(0);
let _vx = new Float32Array(0);
let _vy = new Float32Array(0);
let _band = new Uint8Array(0);
let _depth = new Float32Array(0);
let _formT = new Float32Array(0);
let _jitter = new Float32Array(0);
let _count = 0;

// Offscreen glow/trail buffer
let pg: any = null;
let _pgW = 0;
let _pgH = 0;

// Flow field grid
let _flowField: Float32Array | null = null;
let _fieldCols = 0;
let _fieldRows = 0;

// Animation / beat state
let _time = 0;
let _lastBeatIdx = -1;
let _beatFlash = 0;
let _formPhase = 0;
let _formRotation = 0;

// "Dream" silhouette params (regenerated on each beat)
let _formK1 = 4;
let _formK2 = 6;
let _formA1 = 0.28;
let _formA2 = 0.1;
let _formPh1 = 0;
let _formPh2 = 0;

function silhouetteRadiusNorm(theta: number): number {
  return 1 + _formA1 * Math.sin(_formK1 * theta + _formPh1) + _formA2 * Math.sin(_formK2 * theta + _formPh2);
}

function regenerateForm(): void {
  _formK1 = 3 + Math.floor(Math.random() * 5); // 3-7 lobes
  _formK2 = 3 + Math.floor(Math.random() * 5);
  _formA1 = 0.18 + Math.random() * 0.24;
  _formA2 = 0.04 + Math.random() * 0.16;
  _formPh1 = Math.random() * TWO_PI;
  _formPh2 = Math.random() * TWO_PI;
  _formRotation += (Math.random() - 0.5) * 1.4;
}

function initParticle(i: number, w: number, h: number, count: number): void {
  _px[i] = Math.random() * w;
  _py[i] = Math.random() * h;
  _vx[i] = 0;
  _vy[i] = 0;
  _band[i] = Math.floor(Math.random() * BAND_COUNT);
  _depth[i] = Math.random();
  _formT[i] = i / count;
  _jitter[i] = (Math.random() - 0.5) * 2;
}

function allocParticles(count: number, w: number, h: number): void {
  _px = new Float32Array(count);
  _py = new Float32Array(count);
  _vx = new Float32Array(count);
  _vy = new Float32Array(count);
  _band = new Uint8Array(count);
  _depth = new Float32Array(count);
  _formT = new Float32Array(count);
  _jitter = new Float32Array(count);
  for (let i = 0; i < count; i++) initParticle(i, w, h, count);
  _count = count;
}

function resizeParticles(target: number, w: number, h: number): void {
  if (_count === target) return;

  const newPx = new Float32Array(target);
  const newPy = new Float32Array(target);
  const newVx = new Float32Array(target);
  const newVy = new Float32Array(target);
  const newBand = new Uint8Array(target);
  const newDepth = new Float32Array(target);
  const newFormT = new Float32Array(target);
  const newJitter = new Float32Array(target);

  const copy = Math.min(_count, target);
  newPx.set(_px.subarray(0, copy));
  newPy.set(_py.subarray(0, copy));
  newVx.set(_vx.subarray(0, copy));
  newVy.set(_vy.subarray(0, copy));
  newBand.set(_band.subarray(0, copy));
  newDepth.set(_depth.subarray(0, copy));
  newJitter.set(_jitter.subarray(0, copy));

  _px = newPx; _py = newPy; _vx = newVx; _vy = newVy;
  _band = newBand; _depth = newDepth; _formT = newFormT; _jitter = newJitter;

  for (let i = copy; i < target; i++) initParticle(i, w, h, target);
  // Re-spread the silhouette parameter evenly across the new population
  for (let i = 0; i < target; i++) _formT[i] = i / target;

  _count = target;
}

// ── reset ────────────────────────────────────────────────────────────────────
export function resetDataDream(): void {
  _px = new Float32Array(0);
  _py = new Float32Array(0);
  _vx = new Float32Array(0);
  _vy = new Float32Array(0);
  _band = new Uint8Array(0);
  _depth = new Float32Array(0);
  _formT = new Float32Array(0);
  _jitter = new Float32Array(0);
  _count = 0;

  pg?.remove();
  pg = null;
  _pgW = 0;
  _pgH = 0;

  _flowField = null;
  _fieldCols = 0;
  _fieldRows = 0;

  _time = 0;
  _lastBeatIdx = -1;
  _beatFlash = 0;
  _formPhase = 0;
  _formRotation = Math.random() * TWO_PI;
  regenerateForm();
}

// ── draw ─────────────────────────────────────────────────────────────────────
export function drawDataDream(p: P5Instance, dt: number): void {
  const { state, config } = store;
  const { amps } = getBandAverages(BAND_COUNT);

  const W = p.width;
  const H = p.height;

  const density = config.datadreamDensity; // 0-1
  const flow = config.datadreamFlow;       // 0-1
  const formAmt = config.datadreamForm;    // 0-1

  // ── particle population ───────────────────────────────────────────────────
  const target = Math.round(MIN_PARTICLES + density * (MAX_PARTICLES - MIN_PARTICLES));
  if (_count === 0) {
    allocParticles(target, W, H);
  } else if (_count !== target) {
    resizeParticles(target, W, H);
  }

  // ── offscreen glow buffer ─────────────────────────────────────────────────
  if (!pg || _pgW !== W || _pgH !== H) {
    pg?.remove();
    pg = (p as any).createGraphics(W, H);
    pg.pixelDensity(1);
    pg.background(3, 4, 14);
    _pgW = W;
    _pgH = H;
  }

  // ── flow field grid ───────────────────────────────────────────────────────
  const cols = Math.ceil(W / FIELD_RES) + 2;
  const rows = Math.ceil(H / FIELD_RES) + 2;
  if (!_flowField || _fieldCols !== cols || _fieldRows !== rows) {
    _fieldCols = cols;
    _fieldRows = rows;
    _flowField = new Float32Array(cols * rows);
  }
  const field = _flowField as Float32Array;

  // ── beat detection ────────────────────────────────────────────────────────
  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adj = pos - state.beatOffset;
    const bi = adj >= 0 ? Math.floor(adj / state.beatIntervalSec) : -1;
    if (bi >= 0 && bi !== _lastBeatIdx) {
      _lastBeatIdx = bi;
      _beatFlash = 1;
      _formPhase = 1;
      regenerateForm();
    }
  }

  _time += dt * (0.0012 + flow * 0.0035);
  _formRotation += dt * 0.0012;
  const formDecay = Math.pow(0.962 + formAmt * 0.034, dt); // higher Form -> dream holds longer
  _formPhase *= formDecay;
  _beatFlash *= Math.pow(0.9, dt);

  // ── recompute flow field (layered Perlin noise) ──────────────────────────
  const noiseScale = 0.0035 + flow * 0.009;
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const nx = col * noiseScale;
      const ny = row * noiseScale;
      const n1 = p.noise(nx, ny, _time) * 2 - 1;
      const n2 = (p.noise(nx * 2.3 + 11.7, ny * 2.3 + 5.1, _time * 1.6) * 2 - 1) * 0.5;
      field[row * cols + col] = (n1 + n2) * TWO_PI;
    }
  }

  // ── update particles ─────────────────────────────────────────────────────
  const baseAccel = 0.012 + flow * 0.05;
  const formPull = _formPhase * (0.01 + formAmt * 0.07);
  const cx = W * 0.5;
  const cy = H * 0.5;
  const rx = W * 0.30;
  const ry = H * 0.30;
  const damping = Math.pow(0.95, dt);

  for (let i = 0; i < _count; i++) {
    const band = _band[i];
    const amp = amps[band];
    const depth = _depth[i];

    const cellX = Math.max(0, Math.min(cols - 1, Math.floor(_px[i] / FIELD_RES)));
    const cellY = Math.max(0, Math.min(rows - 1, Math.floor(_py[i] / FIELD_RES)));
    const angle = field[cellY * cols + cellX];

    const accel = baseAccel * (0.4 + depth * 0.9) * (0.5 + amp * 1.3);
    _vx[i] += Math.cos(angle) * accel * dt;
    _vy[i] += Math.sin(angle) * accel * dt;

    if (formPull > 0.0006) {
      const theta = _formT[i] * TWO_PI + _formRotation;
      const rNorm = silhouetteRadiusNorm(theta) * (0.82 + _jitter[i] * 0.36);
      const tx = cx + Math.cos(theta) * rNorm * rx;
      const ty = cy + Math.sin(theta) * rNorm * ry;
      _vx[i] += (tx - _px[i]) * formPull;
      _vy[i] += (ty - _py[i]) * formPull;
      const settle = 1 - Math.min(0.92, formPull * 6);
      _vx[i] *= settle;
      _vy[i] *= settle;
    }

    _vx[i] *= damping;
    _vy[i] *= damping;

    const maxSpeed = (0.6 + depth * 1.5) * (0.7 + amp * 1.6) * (0.5 + flow);
    const spd = Math.sqrt(_vx[i] * _vx[i] + _vy[i] * _vy[i]);
    if (spd > maxSpeed) {
      const s = maxSpeed / spd;
      _vx[i] *= s;
      _vy[i] *= s;
    }

    _px[i] += _vx[i] * dt;
    _py[i] += _vy[i] * dt;

    const margin = 24;
    if (_px[i] < -margin) _px[i] += W + margin * 2;
    else if (_px[i] > W + margin) _px[i] -= W + margin * 2;
    if (_py[i] < -margin) _py[i] += H + margin * 2;
    else if (_py[i] > H + margin) _py[i] -= H + margin * 2;
  }

  // ── render into glow buffer ───────────────────────────────────────────────
  pg.colorMode(p['HSB'], 360, 100, 100, 100);
  pg.blendMode(pg['BLEND']);
  pg.noStroke();
  pg.fill(224, 55, 5, 13); // deep indigo-navy fog trail
  pg.rect(0, 0, W, H);

  pg.blendMode(pg['ADD']);

  // Central glow core that breathes as a "data sculpture" forms
  if (_formPhase > 0.06) {
    const coreHue = (((BAND_HUES[3] + _formRotation * 50) % 360) + 360) % 360;
    const passes: [number, number][] = [[0.85, 0.05], [0.5, 0.09], [0.24, 0.15]];
    for (const [rf, af] of passes) {
      const r = Math.min(W, H) * rf * (0.55 + _formPhase * 0.45);
      pg.fill(coreHue, 35, 35, af * _formPhase * 100);
      pg.circle(cx, cy, r);
    }
  }

  for (let i = 0; i < _count; i++) {
    const band = _band[i];
    const amp = amps[band];
    const hue = (((BAND_HUES[band] + _jitter[i] * 10) % 360) + 360) % 360;
    const sat = Math.min(100, 55 + amp * 35);
    const bri = Math.min(100, 28 + amp * 55 + _depth[i] * 14 + _beatFlash * 16 + _formPhase * 8);
    const alpha = Math.min(100, 42 + amp * 45 + _beatFlash * 12);
    const size = (0.7 + _depth[i] * 2.4) * (0.7 + amp * 1.1) * (1 + _formPhase * 0.35);

    pg.fill(hue, sat, bri, alpha);
    pg.circle(_px[i], _py[i], size);
  }

  pg.blendMode(pg['BLEND']);
  pg.colorMode(pg['RGB'], 255, 255, 255, 255);

  // ── composite onto main canvas ────────────────────────────────────────────
  p.background(3, 4, 14);
  p.blendMode(p['ADD']);
  p.image(pg, 0, 0);
  p.blendMode(p['BLEND']);
  (p as any).colorMode(p['RGB'], 255, 255, 255, 255);
}
