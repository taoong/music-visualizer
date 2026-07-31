/**
 * Ferrofluid — Audio-reactive magnetic fluid spikes.
 *
 * Inspired by Sachiko Kodama's "Protrude, Flow" (2001, SIGGRAPH Art Gallery)
 * https://www.sachikokodama.com/en/protrude-flow/
 *
 * Kodama's installation fills a tray with ferrofluid — a colloidal suspension
 * of iron nanoparticles — fitted with electromagnets below. Sound from
 * visitors alters the magnetic field, triggering the Rosensweig instability:
 * the dark liquid defies gravity and erupts into spiky three-dimensional forms.
 * This visualizer recreates that phenomenon in 2D: 7 horizontal zones (one per
 * frequency band) contain spikes that rise from a dark metallic pool in sync
 * with the music. Sub-bass bands generate wide, powerful eruptions; brilliance
 * bands produce clusters of slender needles. A beat burst momentarily lifts all
 * spikes at once, replicating the electromagnetic surge of the original.
 *
 * Sliders
 *   Spikes   — spike density (1–12 spikes per band zone)
 *   Tension  — surface tension: 0 = wide soap-film domes, 1 = razor needles
 *   Shimmer  — iridescent metallic highlight intensity and reflection depth
 */

import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { BAND_COUNT, isMobile } from '../utils/constants';

const MAX_PER_BAND = isMobile ? 5 : 12;

type Spike = {
  normX: number;
  band: number;
  height: number;  // current height fraction [0,1], animated
};

let spikes: Spike[] = [];
let lastSpikeCount = -1;
let lastBeatIdx = -1;
let beatBurst = 0;
let hueBase = 210;  // blue-steel hue for metallic highlights

export function resetFerrofluid(): void {
  spikes = [];
  lastSpikeCount = -1;
  lastBeatIdx = -1;
  beatBurst = 0;
  hueBase = 210;
}

export function drawFerrofluid(p: P5Instance, dt: number): void {
  const { state, config, audioState } = store;
  const W = p.width;
  const H = p.height;

  // Slider-driven spike count per band zone
  const perBand = Math.max(1, Math.round(1 + config.ferrofluidSpikes * (MAX_PER_BAND - 1)));
  const total = perBand * BAND_COUNT;

  if (total !== lastSpikeCount) {
    spikes = [];
    for (let i = 0; i < total; i++) {
      spikes.push({
        normX: (i + 0.5) / total,
        band: Math.floor(i * BAND_COUNT / total),
        height: 0,
      });
    }
    lastSpikeCount = total;
  }

  // Beat detection (same pattern as disorders.ts)
  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adj = pos - state.beatOffset;
    const bi = adj >= 0 ? Math.floor(adj / state.beatIntervalSec) : -1;
    if (bi >= 0 && bi !== lastBeatIdx) {
      lastBeatIdx = bi;
      beatBurst = 1.0;
      hueBase = (hueBase + 47) % 360;  // shift metallic tint on each beat
    }
  }
  beatBurst *= Math.pow(0.82, dt * 2);

  // Audio data
  const { amps } = getBandAverages(BAND_COUNT);
  const tension = config.ferrofluidTension;   // 0-1
  const shimmer = config.ferrofluidShimmer;   // 0-1

  // Pool geometry
  const poolY = H * 0.60;   // fluid surface rest level
  const maxH = poolY * 0.82; // max spike height above surface

  // Update spike heights toward audio-driven targets
  const attackAlpha = 0.4 * dt;
  const releaseAlpha = 0.12 * dt;
  for (const spike of spikes) {
    const amp = amps[spike.band];
    const target = Math.min(1, amp * (1 + beatBurst * 0.55));
    const diff = target - spike.height;
    spike.height += diff * (diff > 0 ? attackAlpha : releaseAlpha);
  }

  // ── Rendering ──────────────────────────────────────────────────────────────
  const ctx = (p as any).drawingContext as CanvasRenderingContext2D;

  // Background: deep space gradient
  const bgGrad = ctx.createLinearGradient(0, 0, 0, H);
  bgGrad.addColorStop(0, '#020408');
  bgGrad.addColorStop(0.55, '#04060e');
  bgGrad.addColorStop(1, '#070a16');
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, W, H);

  // Fluid pool body
  const poolGrad = ctx.createLinearGradient(0, poolY, 0, H);
  poolGrad.addColorStop(0, '#0b0e1c');
  poolGrad.addColorStop(0.4, '#080b17');
  poolGrad.addColorStop(1, '#050811');
  ctx.fillStyle = poolGrad;
  ctx.fillRect(0, poolY, W, H - poolY);

  // Precompute per-spike geometry
  const spacing = W / total;

  // Determine base half-width from tension: 0 = wide dome, 1 = needle
  const relBase = 0.05 + (1 - tension) * 0.45;  // fraction of spacing

  // ── Spike rendering ────────────────────────────────────────────────────────

  // Pass 1: soft glow halos (wide, very transparent)
  if (shimmer > 0.05) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < total; i++) {
      const sp = spikes[i];
      if (sp.height < 0.02) continue;
      const x = sp.normX * W;
      const h = sp.height * maxH;
      const tipY = poolY - h;
      const bw = spacing * relBase * 2.5;  // wider for glow

      const bandHue = (hueBase + sp.band * 18) % 360;
      const glowAlpha = sp.height * shimmer * 0.12;
      const grd = ctx.createRadialGradient(x, tipY + h * 0.3, 0, x, tipY + h * 0.3, bw * 1.8);
      grd.addColorStop(0, `hsla(${bandHue}, 30%, 55%, ${glowAlpha})`);
      grd.addColorStop(0.5, `hsla(${bandHue + 10}, 20%, 35%, ${glowAlpha * 0.4})`);
      grd.addColorStop(1, `hsla(${bandHue}, 15%, 15%, 0)`);
      ctx.fillStyle = grd;
      ctx.beginPath();
      ctx.ellipse(x, tipY + h * 0.3, bw * 1.8, h * 0.7, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  // Pass 2: spike bodies with metallic gradient
  for (let i = 0; i < total; i++) {
    const sp = spikes[i];
    if (sp.height < 0.005) continue;

    const x = sp.normX * W;
    const h = sp.height * maxH;
    const tipY = poolY - h;
    const bw = spacing * relBase * (0.6 + sp.height * 0.4);  // wider base when taller

    // Bezier control points — left side then mirrored right side
    // Each side uses two bezier segments: base→midpoint, midpoint→tip
    const midY = tipY + h * 0.45;
    const midX = x - bw * 0.12;

    const bandHue = (hueBase + sp.band * 18) % 360;

    // Horizontal metallic gradient: dark left, highlight at 65%, dark right
    const metalGrad = ctx.createLinearGradient(x - bw, 0, x + bw, 0);
    metalGrad.addColorStop(0,    `hsl(${bandHue}, 12%, 7%)`);
    metalGrad.addColorStop(0.30, `hsl(${bandHue}, 14%, 13%)`);
    metalGrad.addColorStop(0.55, `hsl(${bandHue + 15}, 22%, ${12 + shimmer * 30}%)`);
    metalGrad.addColorStop(0.68, `hsl(${bandHue + 20}, 28%, ${18 + shimmer * 45}%)`);
    metalGrad.addColorStop(0.80, `hsl(${bandHue + 10}, 18%, ${10 + shimmer * 20}%)`);
    metalGrad.addColorStop(1,    `hsl(${bandHue}, 10%, 6%)`);

    ctx.beginPath();
    // Left base → left mid → tip
    ctx.moveTo(x - bw, poolY);
    ctx.bezierCurveTo(
      x - bw * 0.75, poolY - h * 0.25,
      x - midX,      midY,
      x, tipY
    );
    // Tip → right mid → right base (mirror)
    ctx.bezierCurveTo(
      x + (x - midX), midY,
      x + bw * 0.75,  poolY - h * 0.25,
      x + bw, poolY
    );
    ctx.closePath();
    ctx.fillStyle = metalGrad;
    ctx.fill();

    // Thin bright edge lines
    const edgeBrightness = 18 + shimmer * 30 + sp.height * 20;
    ctx.strokeStyle = `hsla(${bandHue + 15}, 25%, ${edgeBrightness}%, 0.45)`;
    ctx.lineWidth = 0.6;
    ctx.stroke();
  }

  // Pass 3: specular tip glow
  if (shimmer > 0.05) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < total; i++) {
      const sp = spikes[i];
      if (sp.height < 0.06) continue;
      const x = sp.normX * W;
      const h = sp.height * maxH;
      const tipY = poolY - h;
      const bandHue = (hueBase + sp.band * 18) % 360;

      const r = 1.5 + sp.height * 4 * shimmer + beatBurst * 3;
      const tipGrd = ctx.createRadialGradient(x, tipY, 0, x, tipY, r * 3);
      tipGrd.addColorStop(0, `hsla(${bandHue + 30}, 50%, 92%, ${shimmer * sp.height * 0.9})`);
      tipGrd.addColorStop(0.35, `hsla(${bandHue + 20}, 35%, 70%, ${shimmer * sp.height * 0.4})`);
      tipGrd.addColorStop(1, 'transparent');
      ctx.fillStyle = tipGrd;
      ctx.beginPath();
      ctx.arc(x, tipY, r * 3, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  // ── Pool surface: smooth profile line ─────────────────────────────────────
  // Sample the emergent surface height at fine resolution using Gaussian blending
  const surfaceRes = Math.min(W, 512);
  const surfaceX: number[] = [];
  const surfaceY: number[] = [];
  const sigma = W / total * 0.9;
  const invSigma2 = 1 / (2 * sigma * sigma);

  for (let s = 0; s <= surfaceRes; s++) {
    const sx = (s / surfaceRes) * W;
    let h = 0;
    for (const sp of spikes) {
      const dx = sx - sp.normX * W;
      h += sp.height * maxH * Math.exp(-dx * dx * invSigma2);
    }
    surfaceX.push(sx);
    surfaceY.push(poolY - Math.min(h * 0.08, maxH));
  }

  // Fill surface meniscus strip
  const surfaceOverlay = ctx.createLinearGradient(0, poolY - 6, 0, poolY + 12);
  surfaceOverlay.addColorStop(0, `rgba(${50 + shimmer * 50}, ${80 + shimmer * 60}, ${140 + shimmer * 60}, 0.3)`);
  surfaceOverlay.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = surfaceOverlay;
  ctx.beginPath();
  ctx.moveTo(0, poolY);
  for (let s = 0; s <= surfaceRes; s++) {
    ctx.lineTo(surfaceX[s], surfaceY[s]);
  }
  ctx.lineTo(W, poolY);
  ctx.closePath();
  ctx.fill();

  // Bright surface highlight line
  const lineAlpha = 0.3 + shimmer * 0.35 + beatBurst * 0.2;
  ctx.strokeStyle = `rgba(${80 + shimmer * 80}, ${130 + shimmer * 80}, ${200 + shimmer * 55}, ${lineAlpha})`;
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  for (let s = 0; s <= surfaceRes; s++) {
    if (s === 0) ctx.moveTo(surfaceX[s], surfaceY[s]);
    else ctx.lineTo(surfaceX[s], surfaceY[s]);
  }
  ctx.stroke();

  // ── Reflections: inverted ghost spikes in pool ────────────────────────────
  if (shimmer > 0.08) {
    ctx.save();
    ctx.globalAlpha = 0.18 + shimmer * 0.15;

    for (let i = 0; i < total; i++) {
      const sp = spikes[i];
      if (sp.height < 0.04) continue;

      const x = sp.normX * W;
      const reflH = sp.height * maxH * (0.25 + shimmer * 0.25);
      const reflTipY = poolY + reflH;
      const bw = spacing * relBase * (0.5 + sp.height * 0.3);
      const bandHue = (hueBase + sp.band * 18) % 360;

      const reflGrad = ctx.createLinearGradient(0, poolY, 0, reflTipY);
      reflGrad.addColorStop(0, `hsla(${bandHue + 10}, 25%, 28%, 0.9)`);
      reflGrad.addColorStop(0.5, `hsla(${bandHue}, 18%, 14%, 0.5)`);
      reflGrad.addColorStop(1, `hsla(${bandHue}, 12%, 5%, 0)`);

      ctx.beginPath();
      ctx.moveTo(x - bw, poolY);
      ctx.bezierCurveTo(
        x - bw * 0.7, poolY + reflH * 0.3,
        x - bw * 0.1, reflTipY - reflH * 0.1,
        x, reflTipY
      );
      ctx.bezierCurveTo(
        x + bw * 0.1, reflTipY - reflH * 0.1,
        x + bw * 0.7, poolY + reflH * 0.3,
        x + bw, poolY
      );
      ctx.closePath();
      ctx.fillStyle = reflGrad;
      ctx.fill();
    }
    ctx.restore();
  }

  // Beat flash overlay
  if (beatBurst > 0.05) {
    ctx.fillStyle = `rgba(${40 + hueBase % 40}, 50, 90, ${beatBurst * 0.06})`;
    ctx.fillRect(0, 0, W, H);
  }

  // Ambient audio state indicator
  const overallAmp = amps.reduce((a, b) => a + b, 0) / BAND_COUNT;
  if (overallAmp > 0.01 && audioState) {
    // Small sub-surface energy glow
    const glowR = W * 0.3 * overallAmp;
    const subGlow = ctx.createRadialGradient(W * 0.5, poolY + 8, 0, W * 0.5, poolY + 8, glowR);
    subGlow.addColorStop(0, `rgba(40, 80, 150, ${overallAmp * 0.12})`);
    subGlow.addColorStop(1, 'transparent');
    ctx.fillStyle = subGlow;
    ctx.fillRect(0, poolY, W, Math.min(H - poolY, glowR));
  }
}
