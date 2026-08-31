/**
 * Homage — Audio-reactive tribute to Josef Albers' "Homage to the Square" series.
 *
 * A grid of nested-square compositions in Albers' signature "bottom-heavy"
 * layout: each inner square is offset toward the bottom of its enclosing
 * square rather than perfectly centred. Every nesting level is painted a
 * flat solid colour drawn from a fixed palette. Nesting levels map evenly
 * across the seven frequency bands (outer = sub-bass, inner = brilliance)
 * so each band lights up its own layer with saturation and brightness.
 * Beats snap all squares outward through the palette one step — the
 * innermost colour rotates to the outermost — creating a slow chromatic
 * pulse across the layered field.
 *
 * The Grid slider tiles the canvas with N×N miniature Homages (N = 1, 2, 3,
 * or 4 on desktop; capped at 3 on mobile) — from a single meditative central
 * composition to a mosaic of simultaneous colour studies. Palette morphs
 * between Albers' warm solar series (terracotta / ochre / cream) and his
 * cool ascension series (slate blue / teal / lavender).
 *
 * Inspired by Josef Albers "Homage to the Square" (1949–1976, Solomon R.
 * Guggenheim Museum and MoMA), notably "Homage to the Square: Apparition"
 * (1959) — https://www.guggenheim.org/artwork/106 — and his teaching text
 * "Interaction of Color" (1963, Yale University Press).
 *
 * Audio reactivity
 *   Band[i] amplitude → saturation / brightness of nesting level i
 *   Overall energy    → subtle scale-breathing across all tiles
 *   Beat              → palette rotation (outward step) + hue nudge + flash
 *
 * Sliders
 *   Grid    — tile count (1×1, 2×2, 3×3, or 4×4 compositions)
 *   Nesting — squares per composition (3–9 levels deep)
 *   Palette — warm Albers solar palette → cool ascension palette
 */
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { BAND_COUNT, isMobile } from '../utils/constants';

// ── Palettes ───────────────────────────────────────────────────────────────
// 9-stop palettes, indexed inner→outer. Values are [H, S, L] in HSL space.
// Warm: dark warm brown → terracotta → ochre → cream → gold (Albers "Solar" mood)
const WARM_PALETTE: readonly [number, number, number][] = [
  [ 26, 58, 22], // deep espresso brown
  [ 18, 62, 34], // burnt sienna
  [ 22, 65, 46], // russet
  [ 28, 68, 55], // terracotta
  [ 34, 70, 62], // ochre
  [ 42, 72, 70], // mustard-cream
  [ 46, 60, 80], // pale gold
  [ 40, 45, 88], // sand
  [ 36, 30, 92], // ivory
];
// Cool: deep navy → teal → seafoam → slate → lavender (Albers "Ascension" mood)
const COOL_PALETTE: readonly [number, number, number][] = [
  [220, 55, 16], // midnight navy
  [210, 55, 26], // slate
  [200, 55, 36], // deep teal
  [190, 55, 46], // teal
  [175, 50, 58], // seafoam
  [200, 40, 70], // pale steel
  [230, 38, 78], // lavender fog
  [250, 30, 84], // wisteria
  [260, 25, 90], // pearl mauve
];

const N_LEVELS_MAX = 9;
// On mobile keep total tile count modest so per-tile rectangle draws stay cheap
const GRID_MAX = isMobile ? 3 : 4;

// ── Module-scoped state ────────────────────────────────────────────────────
let paletteRotation = 0;   // integer offset applied to every layer's palette index
let beatPulse = 0;
let hueNudge = 0;          // degrees, drifts +11 per beat
let breathing = 0;         // slow oscillator for scale breathing
let lastBeatIndex = -1;

export function resetHomage(): void {
  paletteRotation = 0;
  beatPulse = 0;
  hueNudge = 0;
  breathing = 0;
  lastBeatIndex = -1;
}

export function drawHomage(p: P5Instance, dt: number): void {
  const { state, config } = store;
  const { amps } = getBandAverages(BAND_COUNT);

  const W = p.width;
  const H = p.height;

  // Slider values
  //   Grid    ∈ [1, GRID_MAX] integer  — N×N compositions
  //   Nesting ∈ [3, 9]        integer  — squares per composition
  //   Palette ∈ [0, 1]                 — warm ↔ cool morph
  const gridN   = Math.max(1, Math.min(GRID_MAX, Math.round(config.homageGrid)));
  const levels  = Math.max(3, Math.min(N_LEVELS_MAX, Math.round(config.homageNesting)));
  const palMix  = Math.max(0, Math.min(1, config.homagePalette));

  // ── Beat detection ───────────────────────────────────────────────────────
  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    const bi = adjusted >= 0 ? Math.floor(adjusted / state.beatIntervalSec) : -1;
    if (bi >= 0 && bi !== lastBeatIndex) {
      lastBeatIndex = bi;
      paletteRotation = (paletteRotation + 1) % N_LEVELS_MAX;
      beatPulse = 1.0;
      hueNudge = (hueNudge + 11) % 360;
    }
  }
  beatPulse *= Math.pow(0.86, dt);
  if (beatPulse < 0.001) beatPulse = 0;

  breathing += dt * 0.014;

  // ── Overall energy for gentle breathing scale ────────────────────────────
  let energy = 0;
  for (let i = 0; i < BAND_COUNT; i++) energy += amps[i];
  energy /= BAND_COUNT;

  const ctx = (p as any).drawingContext as CanvasRenderingContext2D;

  // Deep off-black canvas ground — Albers often mounted works on dark museum walls
  ctx.fillStyle = 'rgb(10,10,12)';
  ctx.fillRect(0, 0, W, H);

  // Compute tile geometry
  const tileMargin = Math.min(W, H) * 0.02;
  const tileW = (W - tileMargin * (gridN + 1)) / gridN;
  const tileH = (H - tileMargin * (gridN + 1)) / gridN;
  const tileSize = Math.min(tileW, tileH);
  const gridW = gridN * tileSize + (gridN + 1) * tileMargin;
  const gridH = gridN * tileSize + (gridN + 1) * tileMargin;
  const originX = (W - gridW) / 2 + tileMargin;
  const originY = (H - gridH) / 2 + tileMargin;

  for (let ty = 0; ty < gridN; ty++) {
    for (let tx = 0; tx < gridN; tx++) {
      const tileIdx = ty * gridN + tx;
      // Per-tile phase offset so no two tiles pulse in lock-step.
      const tilePhase = (tileIdx * 3) % N_LEVELS_MAX;

      const ax = originX + tx * (tileSize + tileMargin);
      const ay = originY + ty * (tileSize + tileMargin);

      // Gentle breathing: individual per-tile phase so the mosaic feels alive
      const breatheScale = 1 + Math.sin(breathing + tileIdx * 0.6) * 0.008 + energy * 0.014;
      const scaledSize = tileSize * breatheScale;
      const centrePad = (tileSize - scaledSize) / 2;

      drawHomageTile(
        ctx,
        ax + centrePad,
        ay + centrePad,
        scaledSize,
        levels,
        palMix,
        amps,
        tilePhase,
      );
    }
  }

  // Beat flash — soft off-white wash tinted by the accumulated hue nudge
  if (beatPulse > 0.05) {
    const flashHue = (30 + hueNudge) % 360;
    ctx.fillStyle = `hsla(${flashHue.toFixed(1)}, 18%, ${palMix < 0.5 ? 80 : 90}%, ${(beatPulse * 0.06).toFixed(3)})`;
    ctx.fillRect(0, 0, W, H);
  }

  // Reset fill so subsequent p5 operations don't inherit a stray hsla string
  ctx.fillStyle = '#000000';
}

/**
 * Draw one Homage composition into a square region of the canvas.
 *
 *   ctx      canvas 2D context
 *   x0, y0   top-left corner of the square
 *   size     side length
 *   levels   number of nested squares (3–9)
 *   palMix   0=warm → 1=cool palette morph
 *   amps     per-band amplitude array
 *   phase    per-tile palette rotation offset
 */
function drawHomageTile(
  ctx: CanvasRenderingContext2D,
  x0: number,
  y0: number,
  size: number,
  levels: number,
  palMix: number,
  amps: number[],
  phase: number,
): void {
  // Linear shrinkage per level so bands appear roughly equal in width, as
  // in Albers' actual paintings: over all levels the innermost square ends
  // at ~28% of the outer side length; each level shrinks the previous
  // square by the same absolute number of pixels.
  const totalShrinkFrac = 0.72; // outer→inner reduction (side length)
  const bandFrac = totalShrinkFrac / Math.max(1, levels - 1); // per-level shrink
  const shrinkAbsPerLevel = size * bandFrac * 0.5; // amount per side

  let curX = x0;
  let curY = y0;
  let curSize = size;

  for (let i = 0; i < levels; i++) {
    // Layer 0 = outermost (sub-bass); Layer levels-1 = innermost (brilliance).
    const bandIdx = Math.floor((i / Math.max(1, levels - 1)) * (BAND_COUNT - 1));
    const amp = amps[bandIdx] ?? 0;

    // Palette index: rotated by paletteRotation + per-tile phase.
    // Sample the whole 9-entry palette regardless of visible level count so
    // 3- and 9-layer compositions both span its full chromatic range.
    const palIdxRaw = Math.floor((i / Math.max(1, levels - 1)) * (N_LEVELS_MAX - 1))
                    + paletteRotation
                    + phase;
    const palIdx = ((palIdxRaw % N_LEVELS_MAX) + N_LEVELS_MAX) % N_LEVELS_MAX;

    const warm = WARM_PALETTE[palIdx];
    const cool = COOL_PALETTE[palIdx];

    // Morph warm ↔ cool along the shorter hue arc so the transition
    // does not flash through a jarring opposite hue at the mid-point.
    const hue = lerpHue(warm[0], cool[0], palMix);
    const sat = warm[1] + (cool[1] - warm[1]) * palMix;
    const lig = warm[2] + (cool[2] - warm[2]) * palMix;

    // Amp modulates saturation up and lightness up: quiet → matte study,
    // loud → vivid enamel. Bounds keep Albers colour relationships legible.
    const satOut = Math.max(0, Math.min(100, sat * (0.78 + amp * 0.44)));
    const ligOut = Math.max(0, Math.min(100, lig + amp * 8 + beatPulse * 3));
    const hueOut = (hue + hueNudge * 0.05) % 360;

    ctx.fillStyle = `hsl(${hueOut.toFixed(1)}, ${satOut.toFixed(1)}%, ${ligOut.toFixed(1)}%)`;
    ctx.fillRect(curX, curY, curSize, curSize);

    // Next inner square — linear shrinkage with Albers' bottom-heavy offset:
    // top margin ≈ 0.5·shrink, bottom margin ≈ 1.5·shrink of each level's
    // total per-side shrinkage. Horizontal margins stay equal (centred).
    curX = curX + shrinkAbsPerLevel;
    curY = curY + shrinkAbsPerLevel * 0.5;
    curSize = curSize - 2 * shrinkAbsPerLevel;

    if (curSize < 2) break;
  }
}

/**
 * Interpolate two hues along the shorter arc of the colour wheel.
 * a, b in [0, 360); t in [0, 1]; result in [0, 360).
 */
function lerpHue(a: number, b: number, t: number): number {
  let diff = b - a;
  if (diff > 180) diff -= 360;
  else if (diff < -180) diff += 360;
  return (a + diff * t + 360) % 360;
}
