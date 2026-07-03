/**
 * Noctiluca — Bioluminescent sea sparkle cascade.
 *
 * N particles drift through a Perlin noise current, representing
 * Noctiluca scintillans (sea sparkle) dinoflagellates. Beat-triggered
 * circular shockwaves propagate outward; each particle illuminates as
 * the wavefront passes — recreating the "blue fire" ocean phenomenon
 * visible in bioluminescent bays at night.
 *
 * Inspired by Studio DRIFT's "Franchise Freedom" (2017) — 300 LED
 * drones forming a cohesive bioluminescent organism — and the real
 * Noctiluca scintillans blue-sea-sparkle phenomenon.
 * https://www.studiodrift.com/work/franchise-freedom/
 *
 * Sliders:
 *   Drift (noctilucaDrift)  — Perlin noise current speed; 0=still, 1=fast swirling
 *   Bloom (noctilucaBloom)  — glow halo radius and trail persistence; 0=pinpoints, 1=diffuse halos
 *   Wake  (noctilucaWake)   — wave brightness and reach; 0=subtle, 1=dramatic cascade
 */
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { BAND_COUNT, isMobile } from '../utils/constants';

// ── Constants ────────────────────────────────────────────────────────────────
const PARTICLE_COUNT = isMobile ? 700 : 1800;
const MAX_WAVES = 5;
// Bioluminescent hue per band: deep indigo → blue → cyan → teal → seafoam → chartreuse
const BAND_HUES = [252, 228, 200, 180, 162, 145, 125] as const;
const NOISE_SCALE = 0.0022;

// ── SoA particle arrays ──────────────────────────────────────────────────────
let px: Float32Array;
let py: Float32Array;
let pvx: Float32Array;
let pvy: Float32Array;
let pglow: Float32Array;  // per-particle wake glow [0,1], decays each frame
// particle i belongs to band (i % BAND_COUNT)

// ── Wave system ──────────────────────────────────────────────────────────────
interface Wave { cx: number; cy: number; r: number; maxR: number; intensity: number }
const waves: Wave[] = [];

// ── Precomputed CSS color strings (avoid string allocation in hot loop) ──────
const OUTER_COLORS: string[] = BAND_HUES.map(h => `hsl(${h},100%,60%)`);
const CORE_COLORS: string[]  = BAND_HUES.map(h => `hsl(${h},85%,90%)`);

// ── Module state ─────────────────────────────────────────────────────────────
let initialized = false;
let cw = 0;
let ch = 0;
let noiseT = 0;
let lastBeatIndex = -1;
let masterGlow = 0;   // ambient glow from overall amplitude

// ── Init ─────────────────────────────────────────────────────────────────────
function init(w: number, h: number): void {
  px   = new Float32Array(PARTICLE_COUNT);
  py   = new Float32Array(PARTICLE_COUNT);
  pvx  = new Float32Array(PARTICLE_COUNT);
  pvy  = new Float32Array(PARTICLE_COUNT);
  pglow = new Float32Array(PARTICLE_COUNT);

  for (let i = 0; i < PARTICLE_COUNT; i++) {
    px[i]  = Math.random() * w;
    py[i]  = Math.random() * h;
    pvx[i] = 0;
    pvy[i] = 0;
  }
  cw = w;
  ch = h;
  initialized = true;
}

export function resetNoctiluca(): void {
  initialized  = false;
  waves.length = 0;
  lastBeatIndex = -1;
  noiseT = 0;
  masterGlow = 0;
}

// ── Draw ─────────────────────────────────────────────────────────────────────
export function drawNoctiluca(p: P5Instance, dt: number): void {
  const { state, config } = store;
  const { amps } = getBandAverages(BAND_COUNT);

  const w = p.width;
  const h = p.height;

  if (!initialized || cw !== w || ch !== h) init(w, h);

  // Map sliders → usable ranges
  const driftSpeed = 0.25 + config.noctilucaDrift * 2.75;  // 0.25–3.0
  const bloomScale  = 0.15 + config.noctilucaBloom * 0.85; // 0.15–1.0
  const wakeStr     = 0.35 + config.noctilucaWake  * 1.65; // 0.35–2.0

  // ── Beat detection ──────────────────────────────────────────────────────
  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    const bi = adjusted >= 0 ? Math.floor(adjusted / state.beatIntervalSec) : -1;
    if (bi >= 0 && bi !== lastBeatIndex) {
      lastBeatIndex = bi;
      if (waves.length < MAX_WAVES) {
        const edge = Math.floor(Math.random() * 4);
        let cx: number, cy: number;
        switch (edge) {
          case 0: cx = Math.random() * w; cy = 0;          break;
          case 1: cx = w;                cy = Math.random() * h; break;
          case 2: cx = Math.random() * w; cy = h;          break;
          default: cx = 0;              cy = Math.random() * h; break;
        }
        waves.push({ cx, cy, r: 0, maxR: Math.hypot(w, h) * 1.15, intensity: wakeStr });
      }
    }
  }

  // ── Ambient glow from overall amplitude ─────────────────────────────────
  const overallAmp = (amps[0] + amps[1] + amps[2] + amps[3] + amps[4] + amps[5] + amps[6]) / 7;
  masterGlow = masterGlow * 0.92 + overallAmp * 0.08;

  // ── Update waves ────────────────────────────────────────────────────────
  // Speed: diagonal at ~1.5 seconds per wave at dt=1 (60fps)
  const waveSpeed = (Math.hypot(w, h) / 90) * dt;
  for (let wi = waves.length - 1; wi >= 0; wi--) {
    const wave = waves[wi];
    const prevR = wave.r;
    wave.r += waveSpeed;
    if (wave.r > wave.maxR) { waves.splice(wi, 1); continue; }

    // Activate particles in the annular wavefront
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      const dist = Math.hypot(px[i] - wave.cx, py[i] - wave.cy);
      if (dist >= prevR && dist < wave.r) {
        const band = i % BAND_COUNT;
        const boost = amps[band] * 0.4;
        pglow[i] = Math.max(pglow[i], wave.intensity * (0.55 + boost));
      }
    }
  }

  // ── Update particles (Perlin noise drift) ───────────────────────────────
  noiseT += 0.0035 * dt * driftSpeed;
  const maxSpd = 1.5 * driftSpeed;
  const glowDecay = Math.pow(0.87, dt);

  for (let i = 0; i < PARTICLE_COUNT; i++) {
    // Curl-like noise force: sample noise at offset to get perpendicular
    const nx  = px[i] * NOISE_SCALE + noiseT;
    const ny  = py[i] * NOISE_SCALE + noiseT * 0.73;
    const ang = ((p as any).noise(nx, ny) - 0.5) * Math.PI * 4;
    pvx[i] += Math.cos(ang) * 0.09 * driftSpeed * dt;
    pvy[i] += Math.sin(ang) * 0.09 * driftSpeed * dt;

    // Speed clamp + damping
    const spd = Math.hypot(pvx[i], pvy[i]);
    if (spd > maxSpd) { const inv = maxSpd / spd; pvx[i] *= inv; pvy[i] *= inv; }
    pvx[i] *= 0.965;
    pvy[i] *= 0.965;

    px[i] += pvx[i] * dt;
    py[i] += pvy[i] * dt;

    // Toroidal wrap
    if (px[i] < 0) px[i] += w; else if (px[i] >= w) px[i] -= w;
    if (py[i] < 0) py[i] += h; else if (py[i] >= h) py[i] -= h;

    // Decay wake glow
    pglow[i] *= glowDecay;
  }

  // ── Render ──────────────────────────────────────────────────────────────
  const ctx = (p as any).drawingContext as CanvasRenderingContext2D;

  // Trail: semi-transparent dark overlay instead of hard clear
  // Higher bloom → slower trail fade (longer afterglow)
  const trailAlpha = 0.55 + (1 - bloomScale) * 0.35; // 0.55–0.90
  const prevComp = ctx.globalCompositeOperation;
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = trailAlpha;
  ctx.fillStyle = 'rgb(0,2,8)';
  ctx.fillRect(0, 0, w, h);
  ctx.globalAlpha = 1.0;

  // Use additive blending for luminescent particles
  ctx.globalCompositeOperation = 'lighter';

  // ── Wave rings (faint expanding circles) ────────────────────────────────
  for (const wave of waves) {
    const fade  = 1 - wave.r / wave.maxR;
    const alpha = wave.intensity * fade * 0.04;
    if (alpha < 0.004) continue;
    ctx.save();
    ctx.strokeStyle = `rgba(80,210,255,${alpha})`;
    ctx.lineWidth   = 2 + bloomScale * 12;
    ctx.shadowColor = `rgba(80,210,255,${alpha * 4})`;
    ctx.shadowBlur  = 20;
    ctx.beginPath();
    ctx.arc(wave.cx, wave.cy, wave.r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
  ctx.shadowBlur = 0;

  // ── Particles: outer bloom pass (active particles only) ─────────────────
  for (let b = 0; b < BAND_COUNT; b++) {
    ctx.fillStyle = OUTER_COLORS[b];
    for (let i = b; i < PARTICLE_COUNT; i += BAND_COUNT) {
      const glow = pglow[i];
      if (glow < 0.04) continue;
      const r = (4 + bloomScale * 24) * (0.4 + glow * 0.6);
      ctx.globalAlpha = glow * 0.17;
      ctx.beginPath();
      ctx.arc(px[i], py[i], r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // ── Particles: core dot pass (all with any visible glow) ────────────────
  for (let b = 0; b < BAND_COUNT; b++) {
    const bandAmp = amps[b];
    const ambient  = masterGlow * 0.07 + bandAmp * 0.11;
    ctx.fillStyle  = CORE_COLORS[b];
    for (let i = b; i < PARTICLE_COUNT; i += BAND_COUNT) {
      const glow       = pglow[i];
      const totalAlpha = Math.min(1, ambient + glow);
      if (totalAlpha < 0.008) continue;
      ctx.globalAlpha = totalAlpha;
      ctx.beginPath();
      ctx.arc(px[i], py[i], 1.1 + glow * 2.8, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  ctx.globalAlpha = 1.0;
  ctx.globalCompositeOperation = prevComp;
}
