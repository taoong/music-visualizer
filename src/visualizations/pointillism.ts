/**
 * Pointillism — Audio-reactive chromoluminous dot field.
 *
 * Inspired by Georges Seurat's chromoluminarism (divisionism) technique in
 * "Un dimanche après-midi à l'Île de la Grande Jatte" (1886, Art Institute
 * of Chicago, https://www.artic.edu/artworks/27992): tiny dabs of pure
 * complementary colors placed side by side are optically blended by the
 * viewer's eye rather than mixed on the palette — creating a luminous
 * vibrancy impossible with conventional mixing.
 *
 * Seven hue zones spread left-to-right (violet sub-bass → red brilliance);
 * dots drift organically via Perlin noise, their size pulsing with band
 * amplitude. Vibration renders a small complementary-hue dab beside each
 * primary, recreating Seurat's chromatic shimmer. ADD blend mode lets
 * overlapping dots optically fuse — primary + complement → neutral luminous
 * gray, exactly as Seurat's eye-mixing theory predicts. Beat snaps the
 * global hue palette and bursts all dots outward from canvas centre.
 *
 * Sliders
 *   Grain     — dot density (0 = few large chunky marks, 1 = fine dense stipple)
 *   Vibration — complement-dab intensity (0 = flat primary only, 1 = full vibration)
 *   Drift     — Perlin-noise animation speed
 */
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { BAND_COUNT, isMobile } from '../utils/constants';

// Primary hue per band: sub=violet, bass=blue, lowMid=teal, mid=green,
// upperMid=yellow, presence=orange, brilliance=red
const BAND_HUES: readonly number[] = [280, 240, 180, 120, 60, 30, 0];
// Complementary hues (≈180° opposite, shifted slightly for visual interest)
const COMP_HUES: readonly number[] = [105, 55, 5, 295, 235, 205, 175];

const DOTS_MIN = isMobile ? 60 : 150;
const DOTS_MAX = isMobile ? 380 : 1500;

type Dot = {
  x: number;   // normalized [0, 1]
  y: number;
  vx: number;
  vy: number;
  nx: number;  // Perlin noise seed X
  ny: number;
  band: number;
  bvx: number; // beat impulse velocity
  bvy: number;
};

let dots: Dot[] = [];
let lastBeatIndex = -1;
let hueShift = 0;
let beatFlash = 0;
let cachedCount = 0;

// Box-Muller Gaussian transform
function gaussRand(mean: number, std: number): number {
  const u1 = Math.max(1e-10, Math.random());
  const u2 = Math.random();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return mean + z * std;
}

export function resetPointillism(): void {
  dots = [];
  lastBeatIndex = -1;
  hueShift = 0;
  beatFlash = 0;
  cachedCount = 0;
}

function initDots(count: number): void {
  dots = [];
  for (let i = 0; i < count; i++) {
    const band = Math.floor(Math.random() * BAND_COUNT);
    // Zone centre for this band (sub-bass left, brilliance right)
    const zoneX = (band + 0.5) / BAND_COUNT;
    // Gaussian spread — std ≈ 0.14 so adjacent band zones overlap gently
    const x = Math.max(0.01, Math.min(0.99, gaussRand(zoneX, 0.14)));
    const y = 0.02 + Math.random() * 0.96;
    dots.push({
      x, y,
      vx: 0, vy: 0,
      nx: Math.random() * 2000,
      ny: Math.random() * 2000,
      band,
      bvx: 0, bvy: 0,
    });
  }
  cachedCount = count;
}

export function drawPointillism(p: P5Instance, dt: number): void {
  const { state, config } = store;
  const { amps } = getBandAverages(BAND_COUNT);

  const W = p.width;
  const H = p.height;

  // Target dot count from grain slider
  const targetCount = Math.round(DOTS_MIN + config.pointillismGrain * (DOTS_MAX - DOTS_MIN));

  // Reinit when count changes notably or on first call
  if (dots.length === 0 || Math.abs(cachedCount - targetCount) > targetCount * 0.12) {
    initDots(targetCount);
  }

  const drift = config.pointillismDrift * 0.9 + 0.1;
  const vibration = config.pointillismVibration;

  // Beat detection
  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    const beatIdx = adjusted >= 0 ? Math.floor(adjusted / state.beatIntervalSec) : -1;
    if (beatIdx >= 0 && beatIdx !== lastBeatIndex) {
      lastBeatIndex = beatIdx;
      hueShift = (hueShift + 28 + Math.floor(amps[1] * 15)) % 360;
      beatFlash = 1.0;
      // Burst dots radially outward from canvas centre
      for (const d of dots) {
        const dx = d.x - 0.5;
        const dy = d.y - 0.5;
        const len = Math.sqrt(dx * dx + dy * dy) + 0.001;
        const str = 0.013 + amps[0] * 0.011;
        d.bvx = (dx / len) * str;
        d.bvy = (dy / len) * str;
      }
    }
  }
  beatFlash *= Math.pow(0.88, dt);

  // Dark background (almost black with a faint blue tint — Seurat's dark canvas)
  p.background(6, 4, 16);

  // Base dot radius: sized so collective coverage is ~35–55% of canvas area.
  // High grain → many fine dots (lower per-dot coverage); low grain → few large marks.
  const targetCoverage = 0.38 + 0.18 * config.pointillismGrain;
  const baseRadius = Math.sqrt((targetCoverage * W * H) / (targetCount * Math.PI));

  // ADD blend: overlapping primary + complement dots optically sum toward neutral
  // (R+C → white in ADD; primary alone → vivid hue — exactly Seurat's theory)
  p.blendMode(p['ADD']);
  (p as any).colorMode(p['HSB'], 360, 100, 100, 255);
  p.noStroke();

  const t = p.frameCount * 0.0014 * drift;
  const avgAmp = amps.reduce((a, b) => a + b, 0) / BAND_COUNT;

  for (const d of dots) {
    // Perlin-noise drift
    d.vx += (p.noise(d.nx + t, 0.0) * 2 - 1) * 0.00028 * drift * dt;
    d.vy += (p.noise(d.ny + t, 4.5) * 2 - 1) * 0.00028 * drift * dt;
    // Beat impulse
    d.vx += d.bvx * dt;
    d.vy += d.bvy * dt;
    d.bvx *= Math.pow(0.91, dt);
    d.bvy *= Math.pow(0.91, dt);
    // Damping
    d.vx *= Math.pow(0.972, dt);
    d.vy *= Math.pow(0.972, dt);
    // Integrate position, bounce at edges
    d.x = Math.max(0.01, Math.min(0.99, d.x + d.vx * dt));
    d.y = Math.max(0.01, Math.min(0.99, d.y + d.vy * dt));

    const amp = amps[d.band];
    const px = d.x * W;
    const py = d.y * H;

    // Primary dot radius swells with amplitude + global energy + beat flash
    const r = baseRadius * (0.55 + amp * 0.75 + avgAmp * 0.25 + beatFlash * 0.38);

    // Primary color: vivid band hue at moderate brightness so multiple dots can ADD
    const primaryHue = (BAND_HUES[d.band] + hueShift) % 360;
    const sat = 75 + amp * 22;
    const bri = 48 + amp * 40 + beatFlash * 12;
    // Alpha kept moderate (90-165) so overlapping dots accumulate but don't immediately saturate
    const alpha = 95 + amp * 70 + beatFlash * 30;

    p.fill(primaryHue, sat, Math.min(bri, 97), alpha);
    p.ellipse(px, py, r * 2, r * 2);

    // Complement dab: smaller dot offset diagonally — Seurat's side-by-side placement
    if (vibration > 0.04) {
      const compHue = (COMP_HUES[d.band] + hueShift) % 360;
      const compR = r * 0.48 * vibration;
      const compAlpha = alpha * 0.50 * vibration;
      const off = r * 0.78;
      p.fill(compHue, sat * 0.80, bri * 0.78, compAlpha);
      p.ellipse(px + off, py + off * 0.42, compR * 2, compR * 2);
    }
  }

  p.blendMode(p['BLEND']);
  (p as any).colorMode(p['RGB'], 255, 255, 255, 255);
}
