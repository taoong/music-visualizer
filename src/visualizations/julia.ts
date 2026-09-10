/**
 * Julia — Julia set escape-time fractal visualization.
 *
 * Inspired by Julius Horsthuis' fractal cinema and real-time VJ performance
 * work (https://www.juliushorsthuis.com/) — his "Fractal Worlds" series
 * (2017–present) uses complex-plane fractals as live audiovisual canvases at
 * concerts and art venues. The Julia set f(z) = z² + c produces an infinite
 * variety of shapes — seahorse spirals, dragon wings, Siegel disks, dendrite
 * galaxies — by varying the single complex parameter c. Each of Horsthuis'
 * real-time fractal films syncs the fractal's evolving shape with electronic
 * music; this visualization does the same thing in the browser.
 *
 * Seven curated c values (one per frequency band) are cycled on every beat,
 * with smooth lerp transitions between shapes. Bass amplitude nudges c.real;
 * presence nudges c.imag. Smooth escape-time coloring creates continuous
 * gradient bands across the fractal boundary that breathe with the music.
 *
 * Rendering: offscreen pixel buffer at ⅕ res (⅛ mobile).
 * Beat: snap c toward the next curated preset with a smooth morph transition.
 *
 * Sliders
 *   Detail — max iteration depth (quality vs. rendering speed)
 *   Zoom   — zoom level into the fractal (1× → 12×)
 *   Morph  — how strongly audio warps the c parameter
 */
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { BAND_COUNT, isMobile } from '../utils/constants';

const PIXEL_SCALE = isMobile ? 8 : 5;

// Seven curated Julia set c values — each creates a distinctively beautiful shape.
// One preset per frequency band: the active preset shifts on every beat.
const PRESETS: ReadonlyArray<readonly [number, number]> = [
  [-0.7269,  0.1889],  // seahorse tail spirals     (sub-bass)
  [-0.4,     0.6   ],  // fractal island              (bass)
  [-0.8,     0.156 ],  // dragon / feather            (low-mid)
  [ 0.285,   0.013 ],  // cauliflower geometry        (mid)
  [-0.7,    -0.3   ],  // dust nebula                 (upper-mid)
  [-0.1,     0.651 ],  // Siegel disk                 (presence)
  [-0.75,    0.13  ],  // dendrite needle forest      (brilliance)
];

// Per-band hue anchors so each preset has a distinct palette
const BAND_HUES = [280, 230, 180, 120, 60, 30, 330] as const;

let fromPreset = 0;
let toPreset   = 1;
let lerpT      = 1.0;   // 1.0 = fully at toPreset; morphs from 0 on beat
let hueShift   = 0;
let lastBeatIndex = -1;

// Pixel buffer
let buf: P5Graphics | null = null;
let bufW = 0;
let bufH = 0;

// Internal HSB → RGB converter (h: 0-360, s/b: 0-100)
function hsbToRgb(h: number, s: number, b: number): [number, number, number] {
  s /= 100; b /= 100;
  const k = (n: number) => (n + h / 60) % 6;
  const f = (n: number) => b * (1 - s * Math.max(0, Math.min(1, Math.min(k(n), 4 - k(n)))));
  return [Math.round(f(5) * 255), Math.round(f(3) * 255), Math.round(f(1) * 255)];
}

export function resetJulia(): void {
  if (buf) { buf.remove(); buf = null; }
  bufW = 0; bufH = 0;
  fromPreset    = 0;
  toPreset      = 1;
  lerpT         = 1.0;
  hueShift      = 0;
  lastBeatIndex = -1;
}

export function drawJulia(p: P5Instance, dt: number): void {
  const W = p.width;
  const H = p.height;

  const cfg = store.config;
  const { state } = store;
  const { amps } = getBandAverages(BAND_COUNT);

  // Beat detection — cycle through presets
  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos     = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    const beatIdx  = adjusted >= 0 ? Math.floor(adjusted / state.beatIntervalSec) : -1;
    if (beatIdx >= 0 && beatIdx !== lastBeatIndex) {
      if (lastBeatIndex >= 0) {
        fromPreset = toPreset;
        toPreset   = (toPreset + 1) % PRESETS.length;
        lerpT      = 0.0;
        hueShift   = (hueShift + 51) % 360;
      }
      lastBeatIndex = beatIdx;
    }
  }

  // Advance morph animation
  const morphRate = 0.018 + (cfg.juliaMorph ?? 0.5) * 0.04;
  lerpT = Math.min(1.0, lerpT + dt * morphRate);
  const ease = lerpT < 0.5 ? 2 * lerpT * lerpT : -1 + (4 - 2 * lerpT) * lerpT; // ease in-out

  // Interpolate c between presets
  const [fr, fi] = PRESETS[fromPreset];
  const [tr, ti] = PRESETS[toPreset];
  let cReal = fr + (tr - fr) * ease;
  let cImag = fi + (ti - fi) * ease;

  // Audio-reactive nudge of c (Morph slider scales the range)
  const warp = (cfg.juliaMorph ?? 0.5) * 0.22;
  cReal += (amps[0] - 0.4) * warp;         // sub-bass → real axis
  cImag += (amps[5] - 0.4) * warp * 0.7;  // presence → imaginary axis

  // Derived rendering params
  const maxIter = Math.round(20 + (cfg.juliaDetail ?? 0.5) * 80);   // 20 – 100
  const zoom    = 1.0 + (cfg.juliaZoom ?? 0.3) * 11.0;             // 1× – 12×

  // Dominant-band hue (shifts continuously with lerpT)
  const domHue  = BAND_HUES[toPreset];
  const totalAmp = amps.reduce((s, v) => s + v, 0) / BAND_COUNT;

  // Resize / create offscreen buffer
  const bW = Math.max(1, Math.ceil(W / PIXEL_SCALE));
  const bH = Math.max(1, Math.ceil(H / PIXEL_SCALE));
  if (!buf || bufW !== bW || bufH !== bH) {
    buf?.remove();
    buf = p.createGraphics(bW, bH);
    buf.noSmooth();
    bufW = bW;
    bufH = bH;
  }

  buf.loadPixels();
  const pix = buf.pixels;

  // Coordinate mapping: full Julia plane spans ±2 on the real axis,
  // scaled by 1/zoom and aspect-corrected on the imaginary axis.
  const scaleX = 4.0 / zoom;
  const scaleY = 4.0 / zoom * (bH / bW);

  for (let py = 0; py < bH; py++) {
    const zy0 = (py / bH - 0.5) * scaleY;
    for (let px = 0; px < bW; px++) {
      const zx0 = (px / bW - 0.5) * scaleX;

      let zx = zx0;
      let zy = zy0;
      let iter = 0;

      // Escape-time iteration: z → z² + c
      while (iter < maxIter) {
        const zx2 = zx * zx;
        const zy2 = zy * zy;
        if (zx2 + zy2 > 4.0) break;
        zy = 2.0 * zx * zy + cImag;
        zx = zx2 - zy2 + cReal;
        iter++;
      }

      const idx = (py * bW + px) * 4;

      if (iter === maxIter) {
        // Interior — near-black with faint blue undertone
        pix[idx]     = 3;
        pix[idx + 1] = 4;
        pix[idx + 2] = 12;
        pix[idx + 3] = 255;
      } else {
        // Smooth escape count (continuous colouring by Iñigo Quílez)
        const zMod2  = zx * zx + zy * zy;
        const smooth = iter + 1.0 - Math.log2(Math.log2(zMod2));

        // Map smooth value to hue/brightness.
        // Multiply by a small factor so the colour cycles several times
        // across the escape bands, creating rich concentric rings.
        const t   = (smooth * 6.0) / maxIter;
        const hue = (domHue + hueShift + t * 280) % 360;
        const sat = 70 + totalAmp * 25;
        // Brightness pulsates with the escape band for a banded glow effect
        const bri = 30 + 55 * (0.5 + 0.5 * Math.sin(t * Math.PI * 3))
                       + totalAmp * 15;

        const [r, g, b2] = hsbToRgb(hue, sat, Math.min(100, bri));
        pix[idx]     = r;
        pix[idx + 1] = g;
        pix[idx + 2] = b2;
        pix[idx + 3] = 255;
      }
    }
  }

  buf.updatePixels();

  p.background(3, 4, 12);
  p.noSmooth();
  p.image(buf as unknown as P5Image, 0, 0, W, H);
  p.smooth();
}
