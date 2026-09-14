/**
 * Aggregation — audio-reactive diffusion-limited colony growth.
 *
 * Inspired by Andy Lomas "Aggregation" series (2005–ongoing,
 * https://andylomas.com/aggregation.html) — computer sculptures of coral,
 * crystal, and dendritic forms grown by DLA-based particle accretion.
 *
 * Seven growth colonies are seeded at heptagon positions on a coarse grid,
 * one colony per frequency band. Each frame, unclaimed cells adjacent to a
 * colony are claimed with probability proportional to that band's amplitude
 * and the Growth slider. Colonies compete at shared borders — louder bands
 * encroach faster, leaving vivid color boundaries. Old growth dims slowly
 * (Decay slider). Beat fires a brightness flash + hue palette shift. When the
 * canvas is ≥ 75 % filled, the image slowly dissolves and restarts.
 *
 * Rendering: persistent offscreen p5.Graphics trail buffer accumulates all
 * past claims; a translucent black overlay per frame creates the age-fade.
 *
 * Sliders
 *   Growth — colony expansion rate (slow creep → aggressive surge)
 *   Decay  — age-fade speed (long glow → rapid dimming)
 *   Glow   — bloom halo radius / brightness
 */
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { BAND_COUNT, isMobile } from '../utils/constants';

const PIXEL_SCALE = isMobile ? 7 : 5;

// HSB hues per band: sub=violet, bass=blue, lowMid=teal, mid=green, upperMid=yellow, presence=orange, brilliance=red
const BAND_HUES: readonly number[] = [280, 230, 180, 120, 60, 30, 0];

const MAX_FRONTIER = 50000;

// Grid (coarse): owner per cell (-1 = unclaimed, 0-6 = band index)
let gridOwner: Int8Array | null = null;
let gridW = 0, gridH = 0;

// Frontier: parallel packed arrays (indices 0..frontierLen-1, no gaps)
let frontier: Int32Array | null = null;     // grid cell indices
let frontierBand: Int8Array | null = null;  // which band each cell "grows toward"
let frontierLen = 0;
let inFrontier: Uint8Array | null = null;   // dedup bit per grid cell

// Rendering
let trailBuf: P5Graphics | null = null;
let trailW = 0, trailH = 0;

// Animation state
let hueShift = 0;
let lastBeatIndex = -1;
let ownedCount = 0;
let dissolveMode = false;
let dissolveAlpha = 0;
let initialized = false;

// ── Grid helpers ─────────────────────────────────────────────────────────────

function setupGrid(w: number, h: number): void {
  gridW = Math.ceil(w / PIXEL_SCALE);
  gridH = Math.ceil(h / PIXEL_SCALE);
  const total = gridW * gridH;

  gridOwner = new Int8Array(total).fill(-1);
  frontier = new Int32Array(MAX_FRONTIER);
  frontierBand = new Int8Array(MAX_FRONTIER);
  inFrontier = new Uint8Array(total);
  frontierLen = 0;
  ownedCount = 0;
  dissolveMode = false;
  dissolveAlpha = 0;

  // Seed 7 small (3×3) clusters at heptagon positions
  const cx = gridW * 0.5;
  const cy = gridH * 0.5;
  const r = Math.min(gridW, gridH) * 0.24;

  for (let band = 0; band < BAND_COUNT; band++) {
    const angle = (band / BAND_COUNT) * Math.PI * 2 - Math.PI / 2;
    const sx = Math.round(cx + r * Math.cos(angle));
    const sy = Math.round(cy + r * Math.sin(angle));
    seedCluster(sx, sy, band);
  }

  buildInitialFrontier();
  initialized = true;
}

function seedCluster(cx: number, cy: number, band: number): void {
  if (!gridOwner) return;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const gx = Math.max(0, Math.min(gridW - 1, cx + dx));
      const gy = Math.max(0, Math.min(gridH - 1, cy + dy));
      const idx = gy * gridW + gx;
      if (gridOwner[idx] < 0) {
        gridOwner[idx] = band;
        ownedCount++;
      }
    }
  }
}

/** Full O(n) rebuild — called once at init and after each dissolve restart. */
function buildInitialFrontier(): void {
  if (!gridOwner || !frontier || !frontierBand || !inFrontier) return;
  frontierLen = 0;
  inFrontier.fill(0);

  for (let gy = 0; gy < gridH; gy++) {
    for (let gx = 0; gx < gridW; gx++) {
      if (frontierLen >= MAX_FRONTIER - 4) break;
      const idx = gy * gridW + gx;
      if (gridOwner[idx] >= 0) continue;
      const band = getAdjacentBand(gx, gy);
      if (band < 0) continue;
      inFrontier[idx] = 1;
      frontier[frontierLen] = idx;
      frontierBand[frontierLen] = band;
      frontierLen++;
    }
  }
}

function getAdjacentBand(gx: number, gy: number): number {
  if (!gridOwner) return -1;
  if (gx > 0) { const b = gridOwner[gy * gridW + gx - 1]; if (b >= 0) return b; }
  if (gx < gridW - 1) { const b = gridOwner[gy * gridW + gx + 1]; if (b >= 0) return b; }
  if (gy > 0) { const b = gridOwner[(gy - 1) * gridW + gx]; if (b >= 0) return b; }
  if (gy < gridH - 1) { const b = gridOwner[(gy + 1) * gridW + gx]; if (b >= 0) return b; }
  return -1;
}

// ── Colony growth ─────────────────────────────────────────────────────────────

/**
 * Process up to maxIter frontier slots. Claims cells probabilistically based
 * on their colony's band amplitude. Uses back-to-front iteration with
 * swap-remove so the array stays compact after stale entries are purged.
 */
function growColonies(
  amps: readonly number[],
  growth: number,
  dt: number,
  buf: P5Graphics,
  p: P5Instance,
): void {
  if (!frontier || !frontierBand || !gridOwner || !inFrontier) return;
  if (frontierLen === 0) return;

  (buf as any).colorMode((buf as any)['HSB'], 360, 100, 100);
  buf.noStroke();

  const maxIter = Math.min(frontierLen, isMobile ? 600 : 1200);

  for (let pass = 0; pass < maxIter; pass++) {
    if (frontierLen === 0) break;

    // Process from the end so swap-remove doesn't skip entries
    const fi = frontierLen - 1 - (pass % frontierLen);
    if (fi < 0 || fi >= frontierLen) break;

    const cellIdx = frontier[fi];

    // Stale: already claimed
    if (gridOwner[cellIdx] >= 0) {
      inFrontier[cellIdx] = 0;
      frontier[fi] = frontier[frontierLen - 1];
      frontierBand[fi] = frontierBand[frontierLen - 1];
      frontierLen--;
      continue;
    }

    const band = frontierBand[fi] as number;
    const amp = Math.max(0, Math.min(1, amps[band] ?? 0));
    const prob = amp * growth * dt * 2.5;
    if (prob <= 0 || Math.random() > Math.min(1, prob)) continue;

    // ── Claim the cell ──────────────────────────────────────────────────────
    gridOwner[cellIdx] = band;
    inFrontier[cellIdx] = 0;
    ownedCount++;

    // Paint onto trail buffer
    const gx = cellIdx % gridW;
    const gy = Math.floor(cellIdx / gridW);
    const hue = (BAND_HUES[band] + hueShift + 360) % 360;
    const bri = 82 + Math.random() * 13;
    buf.fill(hue, 72, bri);
    buf.rect(gx * PIXEL_SCALE, gy * PIXEL_SCALE, PIXEL_SCALE, PIXEL_SCALE);

    // Swap-remove this frontier slot
    frontier[fi] = frontier[frontierLen - 1];
    frontierBand[fi] = frontierBand[frontierLen - 1];
    frontierLen--;

    // Expand frontier to unclaimed neighbors
    if (gx > 0)         addToFrontier(gy * gridW + gx - 1,       band);
    if (gx < gridW - 1) addToFrontier(gy * gridW + gx + 1,       band);
    if (gy > 0)         addToFrontier((gy - 1) * gridW + gx,     band);
    if (gy < gridH - 1) addToFrontier((gy + 1) * gridW + gx,     band);
  }

  // Unused parameter satisfies TypeScript — p used indirectly via colorMode constant above
  void p;
}

function addToFrontier(nIdx: number, band: number): void {
  if (!gridOwner || !frontier || !frontierBand || !inFrontier) return;
  if (gridOwner[nIdx] >= 0) return;
  if (inFrontier[nIdx]) return;
  if (frontierLen >= MAX_FRONTIER - 1) return;
  inFrontier[nIdx] = 1;
  frontier[frontierLen] = nIdx;
  frontierBand[frontierLen] = band;
  frontierLen++;
}

// ── Main draw ─────────────────────────────────────────────────────────────────

export function drawAggregation(p: P5Instance, dt: number): void {
  const { state: appState, config } = store;

  const { amps } = getBandAverages(BAND_COUNT);

  // ── Init / resize ─────────────────────────────────────────────────────────
  if (!initialized || trailW !== p.width || trailH !== p.height) {
    if (trailBuf) { trailBuf.remove(); trailBuf = null; }
    trailBuf = (p as any).createGraphics(p.width, p.height) as P5Graphics;
    trailBuf.background(0);
    trailW = p.width;
    trailH = p.height;
    setupGrid(p.width, p.height);
  }

  const buf = trailBuf!;
  const growth = config.aggregationGrowth ?? 1.0;
  const decay  = config.aggregationDecay  ?? 0.4;
  const glow   = config.aggregationGlow   ?? 0.5;

  // ── Beat detection ────────────────────────────────────────────────────────
  if (appState.detectedBPM > 0 && appState.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adjusted = pos - appState.beatOffset;
    const beatIdx = adjusted >= 0 ? Math.floor(adjusted / appState.beatIntervalSec) : -1;
    if (beatIdx >= 0 && beatIdx !== lastBeatIndex) {
      lastBeatIndex = beatIdx;
      hueShift = (hueShift + 51 + Math.floor(Math.random() * 17)) % 360;

      // Bright beat flash on the trail buffer
      (buf as any).colorMode((buf as any)['RGB'], 255, 255, 255, 255);
      buf.noStroke();
      buf.fill(255, 255, 255, 22);
      buf.rect(0, 0, buf.width, buf.height);
    }
  }

  // ── Dissolve sequence ─────────────────────────────────────────────────────
  if (dissolveMode) {
    dissolveAlpha = Math.min(255, dissolveAlpha + 2.5 * dt);
    (buf as any).colorMode((buf as any)['RGB'], 255, 255, 255, 255);
    buf.noStroke();
    buf.fill(0, 0, 0, Math.round(dissolveAlpha));
    buf.rect(0, 0, buf.width, buf.height);

    if (dissolveAlpha >= 254) {
      buf.background(0);
      setupGrid(p.width, p.height);
    }
  } else {
    // ── Age fade ──────────────────────────────────────────────────────────
    const fadeAmt = Math.round(decay * dt * 18);
    if (fadeAmt > 0) {
      (buf as any).colorMode((buf as any)['RGB'], 255, 255, 255, 255);
      buf.noStroke();
      buf.fill(0, 0, 0, fadeAmt);
      buf.rect(0, 0, buf.width, buf.height);
    }

    // ── Growth ────────────────────────────────────────────────────────────
    growColonies(amps, growth, dt, buf, p);

    // Trigger dissolve when canvas is nearly full
    if (ownedCount > gridW * gridH * 0.75) {
      dissolveMode = true;
      dissolveAlpha = 0;
    }
  }

  // ── Render with glow passes ───────────────────────────────────────────────
  p.background(0);

  const glowPx = Math.round(glow * 14 + 2);

  // Pass 1: wide soft halo
  p.push();
  p.drawingContext.filter = `blur(${glowPx * 2}px)`;
  p.tint(255, 55);
  p.image(buf as unknown as P5Image, 0, 0);
  p.pop();

  // Pass 2: medium halo
  p.push();
  p.drawingContext.filter = `blur(${glowPx}px)`;
  p.tint(255, 95);
  p.image(buf as unknown as P5Image, 0, 0);
  p.pop();

  // Pass 3: crisp core
  p.tint(255, 255);
  p.image(buf as unknown as P5Image, 0, 0);
  p.noTint();
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

export function resetAggregation(): void {
  if (trailBuf) {
    trailBuf.remove();
    trailBuf = null;
  }
  gridOwner = null;
  frontier = null;
  frontierBand = null;
  inFrontier = null;
  frontierLen = 0;
  ownedCount = 0;
  dissolveMode = false;
  dissolveAlpha = 0;
  lastBeatIndex = -1;
  hueShift = 0;
  initialized = false;
  trailW = 0;
  trailH = 0;
}
