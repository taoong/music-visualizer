/**
 * Halftone: three-layer CMY halftone dot field.
 *
 * Inspired by Roy Lichtenstein's "Drowning Girl" (Museum of Modern Art, 1963) and
 * the Ben-Day dot process used in 1950s–60s US comic books and advertising —
 * mechanical colour printing via three rotated dot-screens (cyan at 15°, magenta at 45°,
 * yellow at 75°) composited with MULTIPLY blend on a white ground. Where screens
 * overlap, inks combine: C+M → indigo, M+Y → scarlet, C+Y → olive, all three → near-black,
 * replicating offset-press colour mixing in the browser.
 *
 * Each dot's radius is driven by the frequency band whose horizontal screen-zone
 * the dot falls in (sub-bass at left → brilliance at right), so the canvas reads like
 * a living graphic-novel panel: bass swells the left, treble sparkles the right.
 * Beat fires an expanding ring-pulse of swollen dots that travels centre → edge.
 *
 * Sliders
 *   Grid    — dot spacing: 0 = coarse (few large dots), 1 = fine (dense small dots)
 *   Spread  — amplitude→radius sensitivity: 0 = dots barely move, 1 = full size range
 *   Palette — ink colour set: 0 = CMYK press, 0.5 = warm sunset, 1 = day-glo pop
 */
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { BAND_COUNT, isMobile } from '../utils/constants';

// Classic process-colour halftone screen angles (degrees)
const ANGLES_DEG = [15, 45, 75] as const;

// Palette presets [CMYK, sunset, pop] × [cyan-layer, magenta-layer, yellow-layer]
const PALETTES: ReadonlyArray<ReadonlyArray<readonly [number, number, number]>> = [
  // CMYK press
  [[0, 188, 228], [234, 0, 140], [255, 238, 0]],
  // Warm sunset
  [[255, 110, 0], [220, 0, 75], [255, 210, 20]],
  // Day-glo pop
  [[0, 200, 255], [200, 0, 255], [180, 255, 0]],
] as const;

let beatPulse = 0;
let lastBeatIndex = -1;

export function resetHalftone(): void {
  beatPulse = 0;
  lastBeatIndex = -1;
}

export function drawHalftone(p: P5Instance, dt: number): void {
  const { state, config } = store;
  const { amps } = getBandAverages(BAND_COUNT);

  const W = p.width;
  const H = p.height;
  const cx = W * 0.5;
  const cy = H * 0.5;

  // Beat detection
  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    const beatIdx = adjusted >= 0 ? Math.floor(adjusted / state.beatIntervalSec) : -1;
    if (beatIdx >= 0 && beatIdx !== lastBeatIndex) {
      lastBeatIndex = beatIdx;
      beatPulse = 1.0;
    }
  }
  beatPulse *= Math.pow(0.88, dt);

  // Dot spacing: halftoneGrid [0,1] → [coarse, fine]
  const minSpacing = isMobile ? 28 : 15;
  const maxSpacing = isMobile ? 58 : 60;
  const spacing = minSpacing + (1 - config.halftoneGrid) * (maxSpacing - minSpacing);
  const spread = config.halftoneSpread;

  // Palette: interpolate across 3 presets (0→CMYK, 0.5→sunset, 1→pop)
  const palT = config.halftonePalette * 2; // [0,1] → [0,2]
  const palI = Math.min(1, Math.floor(palT));
  const palFrac = palT - palI;

  const getLayerColor = (layer: number): [number, number, number] => {
    const a = PALETTES[palI][layer];
    const b = PALETTES[Math.min(palI + 1, 2)][layer];
    return [
      Math.round(a[0] + (b[0] - a[0]) * palFrac),
      Math.round(a[1] + (b[1] - a[1]) * palFrac),
      Math.round(a[2] + (b[2] - a[2]) * palFrac),
    ];
  };

  // White ground — MULTIPLY compositing shows ink colours correctly on white
  p.background(255);
  p.noStroke();
  (p as any).blendMode((p as any).MULTIPLY);

  const diagonal = Math.sqrt(W * W + H * H) * 0.5;

  for (let layerIdx = 0; layerIdx < 3; layerIdx++) {
    const theta = ANGLES_DEG[layerIdx] * (Math.PI / 180);
    const cosT = Math.cos(theta);
    const sinT = Math.sin(theta);
    const cosAbs = Math.abs(cosT);
    const sinAbs = Math.abs(sinT);

    // Grid bounds tight enough to cover the canvas at this rotation angle
    const iMax = Math.ceil((W * 0.5 * cosAbs + H * 0.5 * sinAbs) / spacing) + 2;
    const jMax = Math.ceil((W * 0.5 * sinAbs + H * 0.5 * cosAbs) / spacing) + 2;

    const [lr, lg, lb] = getLayerColor(layerIdx);
    p.fill(lr, lg, lb);

    for (let i = -iMax; i <= iMax; i++) {
      for (let j = -jMax; j <= jMax; j++) {
        const dotX = cx + i * spacing * cosT - j * spacing * sinT;
        const dotY = cy + i * spacing * sinT + j * spacing * cosT;

        // Skip dots clearly outside canvas
        if (dotX < -spacing || dotX > W + spacing || dotY < -spacing || dotY > H + spacing) continue;

        // Frequency band from horizontal position (sub-bass left → brilliance right)
        const xFrac = Math.max(0, Math.min(1, dotX / W));
        const bandIdx = Math.min(Math.floor(xFrac * BAND_COUNT), BAND_COUNT - 1);
        const amp = amps[bandIdx];

        // Beat pulse: ring expanding outward from canvas centre
        const dist = Math.sqrt((dotX - cx) * (dotX - cx) + (dotY - cy) * (dotY - cy));
        const ringR = (1 - beatPulse) * diagonal;
        const ringHit = Math.max(0, 1 - Math.abs(dist - ringR) / (spacing * 2.5));
        const pulse = beatPulse * ringHit * 0.4;

        // Dot radius driven by amplitude; max fills grid square, min leaves white space
        const maxR = spacing * 0.48;
        const radius = Math.max(0.8, Math.min(maxR, maxR * (0.08 + 0.92 * amp * spread + pulse)));

        p.circle(dotX, dotY, radius * 2);
      }
    }
  }

  (p as any).blendMode((p as any).BLEND);
}
