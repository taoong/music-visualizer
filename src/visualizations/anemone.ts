/**
 * Anemone — Bioluminescent deep-sea tentacle organism.
 *
 * Seven groups of sinuous tentacles radiate from the canvas centre, one group
 * per audio frequency band.  Each tentacle is a chain of Perlin-noise-steered
 * segments rendered as smooth quadratic bezier curves with a 3-pass neon glow.
 * Band amplitude drives extension length and brightness.  A beat fires a radial
 * burst that temporarily elongates all arms, and each beat shifts the hue
 * palette so the creature cycles through its bioluminescent colours.
 *
 * Inspired by Refik Anadol "Machine Hallucinations — Nature Dreams"
 * (2026, KÖNIG GALERIE, Berlin) — flowing, organic, luminescent forms
 * derived from vast datasets of natural imagery.
 * https://refikanadol.com/works/machine-hallucinations-nature-dreams/
 *
 * Sliders:
 *   Arms (anemoneArms) — tentacles per frequency group; 2–10
 *   Wave (anemoneWave) — undulation speed and wander amplitude; 0=slow, 1=frantic
 *   Glow (anemoneGlow) — bloom halo size and trail persistence; 0=crisp, 1=lush
 */
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { BAND_COUNT, isMobile } from '../utils/constants';

// ── Constants ────────────────────────────────────────────────────────────────
const N_SEG     = isMobile ? 8 : 14;   // joints per tentacle
const MAX_ARMS  = 10;                   // absolute slider cap

// Bioluminescent hue per band: violet → blue → cyan → teal → chartreuse → gold → coral
const BASE_HUES = [270, 220, 185, 155, 95, 48, 340] as const;

// ── Module-scoped state ───────────────────────────────────────────────────────
let noiseT      = 0;
let hueOffset   = 0;
let beatHue     = 0;    // cumulative per-beat hue rotation
let beatBurst   = 0;    // [0,1] burst added on beat, decays over ~0.4 s
let lastBeatIdx = -1;
let cw          = 0;
let ch          = 0;
let initialized = false;

// Unique noise offsets per (band × arm), seeded once at init
let noiseOffsets: Float32Array;

// ── Lifecycle ─────────────────────────────────────────────────────────────────
export function resetAnemone(): void {
  noiseT      = 0;
  hueOffset   = 0;
  beatHue     = 0;
  beatBurst   = 0;
  lastBeatIdx = -1;
  initialized = false;
}

function init(w: number, h: number): void {
  noiseOffsets = new Float32Array(BAND_COUNT * MAX_ARMS);
  for (let i = 0; i < noiseOffsets.length; i++) {
    noiseOffsets[i] = Math.random() * 100;
  }
  cw = w;
  ch = h;
  initialized = true;
}

// ── Draw ──────────────────────────────────────────────────────────────────────
export function drawAnemone(p: P5Instance, dt: number): void {
  const { state, config } = store;
  const { amps } = getBandAverages(BAND_COUNT);

  const w = p.width;
  const h = p.height;
  if (!initialized || cw !== w || ch !== h) init(w, h);

  // Map sliders to working ranges
  const armsPerBand = Math.max(2, Math.round(2 + config.anemoneArms * 8));  // 2–10
  const waveSpeed   = 0.18 + config.anemoneWave * 1.82;                     // 0.18–2.0
  const glowScale   = 0.12 + config.anemoneGlow * 0.88;                     // 0.12–1.0

  // ── Beat detection ────────────────────────────────────────────────────────
  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adj = pos - state.beatOffset;
    const bi  = adj >= 0 ? Math.floor(adj / state.beatIntervalSec) : -1;
    if (bi >= 0 && bi !== lastBeatIdx) {
      lastBeatIdx = bi;
      beatBurst   = 1.0;
      beatHue     = (beatHue + 47 + Math.random() * 30) % 360;
    }
  }

  // Decay beat burst (half-life ~8 frames at dt=1)
  beatBurst  *= Math.pow(0.88, dt);
  hueOffset   = (hueOffset + 0.10 * dt) % 360;
  noiseT     += 0.007 * waveSpeed * dt;

  // ── Geometry setup ────────────────────────────────────────────────────────
  const minDim = Math.min(w, h);
  // Base segment length so a full tentacle (~N_SEG segs) fills ~50 % of minDim
  const segLen  = minDim / (N_SEG * 1.8);
  const cx      = w / 2;
  const cy      = h / 2;

  const ctx = (p as any).drawingContext as CanvasRenderingContext2D;

  // Trail overlay — semi-transparent dark fill replaces background clear
  const trailAlpha = 0.32 + (1 - glowScale) * 0.38; // 0.32–0.70
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = trailAlpha;
  ctx.fillStyle = 'rgb(1,2,8)';
  ctx.fillRect(0, 0, w, h);
  ctx.globalAlpha = 1.0;
  ctx.globalCompositeOperation = 'lighter';

  // ── Joint buffer (reused per arm) ─────────────────────────────────────────
  const jx = new Float32Array(N_SEG + 1);
  const jy = new Float32Array(N_SEG + 1);

  // ── Draw all tentacles ────────────────────────────────────────────────────
  for (let b = 0; b < BAND_COUNT; b++) {
    const amp = amps[b];
    const hue = (BASE_HUES[b] + hueOffset + beatHue) % 360;

    // Each band occupies a radial sector; arms fan out within it
    const sectorCentre = (b / BAND_COUNT) * Math.PI * 2 - Math.PI / 2;
    const sectorWidth  = (Math.PI * 2) / BAND_COUNT;

    for (let a = 0; a < armsPerBand; a++) {
      const spread  = armsPerBand > 1
        ? (a / (armsPerBand - 1) - 0.5) * sectorWidth * 0.82
        : 0;
      const baseAng = sectorCentre + spread;
      const noOff   = noiseOffsets[b * MAX_ARMS + a];

      // Extension: quiet → short (30 %), loud → full length, beat adds 50 %
      const lenScale  = 0.30 + amp * 0.70 + beatBurst * 0.50;
      // Wander increases toward the tip for a whip-like feel
      const maxWander = 0.55 + config.anemoneWave * 0.85;

      jx[0] = cx;
      jy[0] = cy;

      for (let k = 0; k < N_SEG; k++) {
        const t  = (k + 1) / N_SEG;
        const nx = noOff        + k * 0.17 + noiseT;
        const ny = noOff * 0.61 + b * 0.29 + a * 0.53 + noiseT * 0.71;
        const n  = (p as any).noise(nx, ny);

        // Wander envelope: peaks at 70 % along the tentacle (not at the very tip)
        const envelope  = Math.sin(t * Math.PI * 0.9);
        const segAngle  = baseAng + (n - 0.5) * 2 * maxWander * envelope;
        const sl        = segLen * lenScale;

        jx[k + 1] = jx[k] + Math.cos(segAngle) * sl;
        jy[k + 1] = jy[k] + Math.sin(segAngle) * sl;
      }

      // 3-pass glow: outer halo → mid → crisp core
      const bright = 38 + amp * 58 + beatBurst * 18;
      const sat    = 65 + amp * 35;
      const baseW  = segLen * 0.28;  // scales with canvas size

      const passes: Array<[number, number]> = [
        [baseW * (6 + glowScale * 16), 0.08 + amp * 0.07],
        [baseW * (2.5 + glowScale * 6), 0.20 + amp * 0.18],
        [baseW * (0.8 + glowScale * 1.6), 0.55 + amp * 0.40],
      ];

      for (const [lw, alpha] of passes) {
        ctx.beginPath();
        ctx.moveTo(jx[0], jy[0]);

        // Smooth quadratic bezier chain through midpoints of consecutive joints
        for (let k = 0; k < N_SEG - 1; k++) {
          const mx = (jx[k + 1] + jx[k + 2]) / 2;
          const my = (jy[k + 1] + jy[k + 2]) / 2;
          ctx.quadraticCurveTo(jx[k + 1], jy[k + 1], mx, my);
        }
        ctx.lineTo(jx[N_SEG], jy[N_SEG]);

        ctx.strokeStyle = `hsl(${hue},${sat}%,${bright}%)`;
        ctx.lineWidth   = lw;
        ctx.lineCap     = 'round';
        ctx.globalAlpha = alpha;
        ctx.stroke();
      }
      ctx.globalAlpha = 1.0;
    }
  }

  // ── Central body glow ─────────────────────────────────────────────────────
  const overallAmp = amps.reduce((s, a) => s + a, 0) / BAND_COUNT;
  if (overallAmp > 0.03 || beatBurst > 0.05) {
    const r = minDim * 0.055 * (1 + overallAmp * 0.8 + beatBurst * 0.6);
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    g.addColorStop(0, `rgba(255,255,255,${Math.min(0.9, overallAmp * 0.7 + beatBurst * 0.4)})`);
    g.addColorStop(0.4, `rgba(200,210,255,${overallAmp * 0.25})`);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1.0;
}
