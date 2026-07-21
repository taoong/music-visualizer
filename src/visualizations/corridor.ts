/**
 * Corridor — Infinite data-mirror tunnel.
 *
 * Inspired by Ryoji Ikeda's "the critical paths" (2024) at the Estonian
 * National Museum, Tartu (European Capital of Culture, Nov 2024 – Mar 2025,
 * https://vimeo.com/1035453913). The installation fills a 25-metre corridor
 * with ceiling LED screens cascading DNA sequences from 100,000 Estonian
 * genomes; full-length mirror walls extend the data stream to infinite depth.
 *
 * N receding rectangular rings form a first-person corridor perspective.
 * Ceiling and floor strips carry scrolling genomic/binary characters (ATCG +
 * 0/1) mapped to 7 horizontal band zones: sub-bass on the left (violet) →
 * brilliance on the right (magenta). Each zone's brightness tracks its
 * frequency band's amplitude; near rings scroll faster than far ones
 * (parallax). Four neon "pillar" lines connect adjacent rings, implying
 * mirror walls. A radial glow at the vanishing point intensifies with overall
 * amplitude. Beat fires a "step forward" zoom burst that pushes all rings
 * outward, plus a white flash and hue-palette shift.
 *
 * Sliders
 *   corridorSpeed   — data scroll rate (0–1.5; 0 = static)
 *   corridorDepth   — ring count (4–16)
 *   corridorPalette — 0 = Ikeda monochrome, 1 = full band colours
 */
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { BAND_COUNT, isMobile } from '../utils/constants';

// Hue per band: sub=violet, bass=blue, lowMid=teal, mid=green,
//               upperMid=yellow, presence=orange, brilliance=magenta
const BAND_HUES: readonly number[] = [275, 230, 180, 120, 60, 25, 300];

// Character pool: DNA bases + binary (Ikeda aesthetic)
const CHARS = 'ATCGATCG01010101CATGCATGATCG10100101';
const CHARS_LEN = CHARS.length;

const MAX_RINGS = isMobile ? 7 : 12;
const MAX_SCALE = 0.97; // nearest ring fills 97% of canvas
const MIN_SCALE = 0.03; // furthest ring at 3% (near vanishing point)
const MAX_FONT = 14;
const MIN_FONT = 6;

// ── Module state ────────────────────────────────────────────────────────────
let scrollTopOffsets = new Float64Array(MAX_RINGS);
let scrollBotOffsets = new Float64Array(MAX_RINGS);
let lastBeatIndex = -1;
let zoomPush = 0;
let hueShift = 0;
let beatFlash = 0;

export function resetCorridor(): void {
  scrollTopOffsets = new Float64Array(MAX_RINGS);
  scrollBotOffsets = new Float64Array(MAX_RINGS);
  lastBeatIndex = -1;
  zoomPush = 0;
  hueShift = 0;
  beatFlash = 0;
}

// ── Colour helpers ──────────────────────────────────────────────────────────
function hsbToRgb(h: number, s: number, b: number): [number, number, number] {
  s /= 100; b /= 100;
  const k = (n: number): number => (n + h / 60) % 6;
  const f = (n: number): number =>
    b * (1 - s * Math.max(0, Math.min(1, Math.min(k(n), 4 - k(n)))));
  return [Math.round(f(5) * 255), Math.round(f(3) * 255), Math.round(f(1) * 255)];
}

// Pre-compute RGBA strings for each band at a given palette and amplitude
function bandRgba(
  band: number,
  amp: number,
  palette: number,
  extraBrightness: number,
  alpha: number,
): string {
  const hue = (BAND_HUES[band] + hueShift) % 360;
  const sat = palette * 100;
  const bri = Math.min(100, amp * 80 + extraBrightness);
  const [r, g, b] = hsbToRgb(hue, sat, bri);
  return `rgba(${r},${g},${b},${alpha.toFixed(3)})`;
}

// ── Draw ────────────────────────────────────────────────────────────────────
export function drawCorridor(p: P5Instance, dt: number): void {
  const { state, config } = store;
  const { amps } = getBandAverages(BAND_COUNT);

  const w = p.width;
  const h = p.height;
  const cx = w / 2;
  const cy = h / 2;

  const numRings = Math.max(4, Math.min(MAX_RINGS, Math.round(config.corridorDepth)));
  const speed = config.corridorSpeed; // 0–1.5
  const palette = config.corridorPalette; // 0–1

  // ── Beat detection ────────────────────────────────────────────────────────
  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    const beatIdx = adjusted >= 0 ? Math.floor(adjusted / state.beatIntervalSec) : -1;
    if (beatIdx >= 0 && beatIdx !== lastBeatIndex) {
      lastBeatIndex = beatIdx;
      zoomPush = 0.14;
      beatFlash = 1.0;
      hueShift = (hueShift + 47) % 360;
    }
  }
  zoomPush *= Math.pow(0.87, dt);
  beatFlash *= Math.pow(0.82, dt);

  // Average amplitude for global glow
  let avgAmp = 0;
  for (let b = 0; b < BAND_COUNT; b++) avgAmp += amps[b];
  avgAmp /= BAND_COUNT;

  // ── Background ────────────────────────────────────────────────────────────
  // Slight trail via semi-transparent black overlay
  const gctx = (p as any).drawingContext as CanvasRenderingContext2D;
  gctx.fillStyle = 'rgba(0,0,0,0.88)';
  gctx.fillRect(0, 0, w, h);

  // ── Vanishing-point radial glow ────────────────────────────────────────────
  const glowR = Math.max(20, (0.04 + avgAmp * 0.14 + beatFlash * 0.06) * Math.min(w, h));
  const grad = gctx.createRadialGradient(cx, cy, 0, cx, cy, glowR);
  const fb = Math.round(beatFlash * 200);
  const br = Math.round(20 + avgAmp * 60);
  grad.addColorStop(0, `rgba(${fb + br},${fb + br},255,0.95)`);
  grad.addColorStop(0.35, `rgba(${br},${br},${160 + Math.round(avgAmp * 60)},0.55)`);
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  gctx.fillStyle = grad;
  gctx.beginPath();
  gctx.arc(cx, cy, glowR, 0, Math.PI * 2);
  gctx.fill();

  // ── Update scroll offsets (before ring drawing) ────────────────────────────
  for (let k = 0; k < numRings; k++) {
    // Nearest rings (k=0) scroll fastest (parallax)
    const nearness = 1 - k / Math.max(1, numRings - 1); // 1 near, 0 far
    const baseSpeed = speed * (0.25 + nearness * 0.75);
    const ampBoost = amps[Math.min(k % BAND_COUNT, BAND_COUNT - 1)] * 0.4;
    scrollTopOffsets[k] += baseSpeed * (1 + ampBoost) * dt;
    scrollBotOffsets[k] -= baseSpeed * (0.8 + ampBoost) * dt; // opposite for floor mirror
  }

  // ── Setup text rendering ──────────────────────────────────────────────────
  const pAny = p as any;
  pAny.textFont('monospace');
  pAny.textAlign(pAny['LEFT'], pAny['TOP']);
  p.noStroke();

  // Pre-compute ring geometry (far-to-near for painter's algorithm)
  type RingGeom = { rl: number; rt: number; rr: number; rb: number; scale: number };
  const rings: RingGeom[] = [];
  for (let k = 0; k < numRings; k++) {
    const distance = k / Math.max(1, numRings - 1); // 0=near, 1=far
    const baseScale = MAX_SCALE * (1 - distance) + MIN_SCALE * distance;
    const effectiveScale = baseScale * (1 + zoomPush * (1 - distance));
    const rw = w * effectiveScale;
    const rh = h * effectiveScale;
    rings.push({
      rl: cx - rw / 2,
      rt: cy - rh / 2,
      rr: cx + rw / 2,
      rb: cy + rh / 2,
      scale: effectiveScale,
    });
  }

  // ── Draw rings (far→near) ─────────────────────────────────────────────────
  for (let kOuter = numRings - 1; kOuter >= 0; kOuter--) {
    const { rl, rt, rr, rb } = rings[kOuter];
    const distance = kOuter / Math.max(1, numRings - 1);
    const fontSize = Math.max(MIN_FONT, MAX_FONT * (1 - distance) + MIN_FONT * distance);
    const charW = fontSize * 0.62;
    const alphaFade = 1 - distance * 0.65; // far rings are dimmer

    // Draw pillar lines connecting this ring to the next inner ring (if exists)
    if (kOuter > 0) {
      const inner = rings[kOuter - 1];
      const lineAlpha = (0.12 + avgAmp * 0.2 + beatFlash * 0.08) * alphaFade;
      if (lineAlpha > 0.02) {
        const pillarHue = (200 + hueShift) % 360;
        const sat = palette * 35;
        const [pr, pg, pb] = hsbToRgb(pillarHue, sat, 70);
        gctx.strokeStyle = `rgba(${pr},${pg},${pb},${lineAlpha.toFixed(3)})`;
        gctx.lineWidth = Math.max(0.5, 1.5 - distance);
        gctx.beginPath();
        // 4 corner pillar lines
        gctx.moveTo(rl, rt); gctx.lineTo(inner.rl, inner.rt);
        gctx.moveTo(rr, rt); gctx.lineTo(inner.rr, inner.rt);
        gctx.moveTo(rl, rb); gctx.lineTo(inner.rl, inner.rb);
        gctx.moveTo(rr, rb); gctx.lineTo(inner.rr, inner.rb);
        gctx.stroke();
      }
    }

    // ── Draw ring frame outline ─────────────────────────────────────────────
    {
      const frameAlpha = (0.08 + avgAmp * 0.12 + beatFlash * 0.05) * alphaFade;
      if (frameAlpha > 0.02) {
        const fHue = (210 + hueShift) % 360;
        const [fr, fg, fb] = hsbToRgb(fHue, palette * 50, 60);
        gctx.strokeStyle = `rgba(${fr},${fg},${fb},${frameAlpha.toFixed(3)})`;
        gctx.lineWidth = Math.max(0.3, 1.2 - distance);
        gctx.strokeRect(rl, rt, rr - rl, rb - rt);
      }
    }

    pAny.textSize(fontSize);

    // ── Ceiling strip (top edge) ────────────────────────────────────────────
    {
      const stripH = fontSize + 2;
      const numChars = Math.ceil((rr - rl) / charW) + 1;
      const scrollOffset = Math.floor(scrollTopOffsets[kOuter]);
      for (let col = 0; col < numChars; col++) {
        const x = rl + col * charW;
        if (x > rr + charW) break;
        const normX = (x - rl) / Math.max(1, rr - rl);
        const band = Math.min(BAND_COUNT - 1, Math.floor(normX * BAND_COUNT));
        const amp = amps[band];
        const ambientBri = 0.08; // dim ambient glow even at silence
        const totalBri = ambientBri + amp;
        if (totalBri < 0.05) continue;

        const alpha = totalBri * alphaFade;
        const extraBri = beatFlash * 35;
        const colorStr = bandRgba(band, amp, palette, extraBri, alpha);
        const charIdx = ((col + scrollOffset) % CHARS_LEN + CHARS_LEN) % CHARS_LEN;

        gctx.fillStyle = colorStr;
        // Use native canvas fillText for better performance
        gctx.font = `${Math.round(fontSize)}px monospace`;
        gctx.fillText(CHARS[charIdx], x, rt + (stripH - fontSize) / 2);
      }
    }

    // ── Floor strip (bottom edge) — mirror of ceiling ───────────────────────
    // Skip extremely far rings for performance
    if (kOuter < numRings - 2) {
      const numChars = Math.ceil((rr - rl) / charW) + 1;
      const scrollOffset = Math.floor(scrollBotOffsets[kOuter]);
      for (let col = 0; col < numChars; col++) {
        const x = rl + col * charW;
        if (x > rr + charW) break;
        const normX = (x - rl) / Math.max(1, rr - rl);
        const band = Math.min(BAND_COUNT - 1, Math.floor(normX * BAND_COUNT));
        const amp = amps[band];
        const ambientBri = 0.05;
        const totalBri = ambientBri + amp * 0.8;
        if (totalBri < 0.04) continue;

        const alpha = totalBri * alphaFade * 0.85;
        const extraBri = beatFlash * 25;
        // Slightly different hue offset for floor (feels like a reflection)
        const floorBand = (BAND_COUNT - 1 - band); // reversed band order for floor
        const colorStr = bandRgba(floorBand, amp * 0.8, palette, extraBri, alpha);
        const charIdx = ((col + scrollOffset) % CHARS_LEN + CHARS_LEN) % CHARS_LEN;

        gctx.font = `${Math.round(fontSize)}px monospace`;
        gctx.fillStyle = colorStr;
        gctx.fillText(CHARS[charIdx], x, rb - fontSize - 1);
      }
    }
  }

  // ── Beat flash overlay ─────────────────────────────────────────────────────
  if (beatFlash > 0.04) {
    gctx.fillStyle = `rgba(255,255,255,${(beatFlash * 0.22).toFixed(3)})`;
    gctx.fillRect(0, 0, w, h);
  }
}
