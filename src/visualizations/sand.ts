/**
 * Sand Art: audio-reactive falling sand painting.
 *
 * Inspired by sand animation artist Kseniya Simonova, whose live performances
 * ("War. A Story One", Ukraine's Got Talent 2009; ongoing touring productions)
 * create and dissolve figurative images in real time through sweeping, gestural
 * sand manipulation on a backlit glass table. Here the music takes the role of
 * the artist's hands, pouring and scattering grains that accumulate into dunes
 * and strata.
 *
 * Implementation: a cellular-automaton falling-sand simulation at ¼ resolution
 * (⅙ mobile). Seven frequency bands pour fresh grains into horizontal zones at
 * the top of the frame; each grain carries its origin band as color, so the
 * accumulated sand stratifies into visible layers of frequency content — like
 * the layered colored-sand-bottle art tradition. Grains fall under gravity,
 * stack on slopes, and slide diagonally on steep faces. Beats trigger an
 * explosive upward scatter that reshuffles the landscape.
 *
 * Rendering: pixel buffer at ¼ res (⅙ mobile). Per-grain brightness is
 * perturbed by a hash of (x, y) to mimic the sparkle of individual grains.
 * Grains with a neighbor above them are slightly shaded to suggest depth.
 *
 * Sliders
 *   Grain — pour rate (volume of sand each band deposits per frame)
 *   Flow  — gravity strength / fall speed (cellular-automaton steps per frame)
 *   Hue   — palette shift: warm desert amber → sunset rose → cosmic indigo
 *
 * Inspiration: Kseniya Simonova — https://www.ksenya-simonova.com/
 */

import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { BAND_COUNT, isMobile } from '../utils/constants';

const PIXEL_SCALE = isMobile ? 6 : 4;

// Base HSB hue per band for warm-desert palette
// sub=rust, bass=amber, lowMid=gold, mid=pale-sand, upperMid=teal, presence=violet, brilliance=magenta
const BAND_BASE_HUE: readonly number[] = [10, 32, 44, 54, 170, 258, 302];
const BAND_SAT_BASE: readonly number[] = [80, 75, 68, 45, 70, 72, 78];

let grid: Uint8Array | null = null; // 0 = empty; 1–7 = band index + 1
let gW = 0;
let gH = 0;
let buf: P5Graphics | null = null;
let lastBeatIndex = -1;
let hueShift = 0;
let frame = 0;

// Integer hash → [0, 1) for per-grain sparkle variation
function cellHash(x: number, y: number): number {
  let v = ((x * 1619 + y * 31337) ^ (x * 6271)) & 0xFFFF;
  v = ((v ^ (v >> 7)) * 2747) & 0xFFFF;
  return (v & 0xFF) / 255;
}

function hsbToRgb(h: number, s: number, b: number): [number, number, number] {
  s /= 100; b /= 100;
  const k = (n: number) => (n + h / 60) % 6;
  const f = (n: number) => b * (1 - s * Math.max(0, Math.min(1, Math.min(k(n), 4 - k(n)))));
  return [Math.round(f(5) * 255), Math.round(f(3) * 255), Math.round(f(1) * 255)];
}

export function resetSand(): void {
  grid = null;
  gW = 0; gH = 0;
  buf?.remove();
  buf = null;
  lastBeatIndex = -1;
  hueShift = 0;
  frame = 0;
}

export function drawSand(p: P5Instance, dt: number): void {
  const { state, config, audioState } = store;
  const { amps } = getBandAverages(BAND_COUNT);

  const newGW = Math.ceil(p.width / PIXEL_SCALE);
  const newGH = Math.ceil(p.height / PIXEL_SCALE);

  if (!grid || !buf || gW !== newGW || gH !== newGH) {
    gW = newGW; gH = newGH;
    grid = new Uint8Array(gW * gH);
    buf?.remove();
    buf = p.createGraphics(gW, gH);
    buf.noSmooth();
    lastBeatIndex = -1;
  }

  frame++;

  // ── Beat detection ──────────────────────────────────────────────
  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    const beatIdx = adjusted >= 0 ? Math.floor(adjusted / state.beatIntervalSec) : -1;
    if (beatIdx >= 0 && beatIdx !== lastBeatIndex) {
      lastBeatIndex = beatIdx;
      hueShift = (hueShift + 53) % 360;
      // Explosive scatter: lift grains from the lower half into the upper quarter
      for (let y = Math.floor(gH * 0.4); y < gH; y++) {
        for (let x = 0; x < gW; x++) {
          const v = grid[y * gW + x];
          if (v === 0) continue;
          grid[y * gW + x] = 0;
          const ty = Math.floor(Math.random() * (gH * 0.3));
          const tx = Math.min(gW - 1, Math.max(0, x + Math.floor(Math.random() * 15) - 7));
          if (grid[ty * gW + tx] === 0) grid[ty * gW + tx] = v;
        }
      }
    }
  } else if (audioState.transientValues[0] > 1.4 && frame % 8 === 0) {
    // Mic / interactive mode: use transient as beat proxy
    hueShift = (hueShift + 37) % 360;
  }

  const grain = config.sandGrain;
  const flow = config.sandFlow;

  // ── Deposit sand from audio bands ──────────────────────────────
  const bandWidth = gW / BAND_COUNT;
  for (let b = 0; b < BAND_COUNT; b++) {
    const amp = amps[b];
    if (amp < 0.015) continue;
    // Scale by dt for frame-rate independence
    const count = Math.ceil(amp * grain * 7 * dt + 0.3);
    const x0 = Math.floor(b * bandWidth);
    const xSpan = Math.max(1, Math.floor(bandWidth));
    const bVal = (b + 1) as number;
    for (let g = 0; g < count; g++) {
      const x = x0 + Math.floor(Math.random() * xSpan);
      const y = Math.floor(Math.random() * 2);
      if (x < gW && grid[y * gW + x] === 0) grid[y * gW + x] = bVal;
    }
  }

  // ── Cellular automaton: falling sand ───────────────────────────
  // Scan bottom-to-top so grains don't cascade multiple cells in one frame.
  // Alternate L→R vs R→L scan each frame to remove horizontal drift bias.
  const steps = Math.max(1, Math.round(flow * 5));
  const leftFirst = frame % 2 === 0;

  for (let step = 0; step < steps; step++) {
    for (let y = gH - 2; y >= 0; y--) {
      if (leftFirst) {
        for (let x = 0; x < gW; x++) stepCell(x, y);
      } else {
        for (let x = gW - 1; x >= 0; x--) stepCell(x, y);
      }
    }
  }

  function stepCell(x: number, y: number): void {
    const v = grid![y * gW + x];
    if (v === 0) return;
    const below = (y + 1) * gW + x;
    // Fall straight down
    if (grid![below] === 0) {
      grid![y * gW + x] = 0;
      grid![below] = v;
      return;
    }
    // Slide diagonally on a slope
    const canL = x > 0    && grid![(y + 1) * gW + x - 1] === 0;
    const canR = x < gW-1 && grid![(y + 1) * gW + x + 1] === 0;
    if (canL && canR) {
      const dx = leftFirst ? -1 : 1;
      grid![y * gW + x] = 0;
      grid![(y + 1) * gW + x + dx] = v;
    } else if (canL) {
      grid![y * gW + x] = 0;
      grid![(y + 1) * gW + x - 1] = v;
    } else if (canR) {
      grid![y * gW + x] = 0;
      grid![(y + 1) * gW + x + 1] = v;
    }
  }

  // ── Render ─────────────────────────────────────────────────────
  const hue = config.sandHue; // 0 = warm desert, 1 = cosmic indigo
  buf.loadPixels();
  const px = buf.pixels;

  for (let y = 0; y < gH; y++) {
    for (let x = 0; x < gW; x++) {
      const idx = (y * gW + x) * 4;
      const v = grid[y * gW + x];

      if (v === 0) {
        // Empty — near-black background with faint warm tint
        px[idx] = 6; px[idx + 1] = 4; px[idx + 2] = 9; px[idx + 3] = 255;
      } else {
        const b = v - 1; // band index 0–6

        // Grain sparkle and shadow
        const sparkle = 0.80 + cellHash(x, y) * 0.20;
        const shadowed = y > 0 && grid[(y - 1) * gW + x] !== 0;
        const shade = shadowed ? 0.65 : 1.0;

        // Color: base hue shifted by slider and beat-driven hueShift
        const h = (BAND_BASE_HUE[b] + hue * 268 + hueShift) % 360;
        // Saturation decreases as hue shifts toward cosmic palette
        const s = BAND_SAT_BASE[b] * (1 - hue * 0.45);
        // Brightness: base + audio amplitude boost
        const bri = sparkle * shade * (52 + amps[b] * 48);

        const [r, g, bv] = hsbToRgb(h, s, bri);
        px[idx] = r; px[idx + 1] = g; px[idx + 2] = bv; px[idx + 3] = 255;
      }
    }
  }

  buf.updatePixels();
  p.image(buf as unknown as P5Image, 0, 0, p.width, p.height);
}
