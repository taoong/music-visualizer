/**
 * Ganzfeld — nested luminous light zones inspired by James Turrell.
 *
 * Inspired by James Turrell "Aten Reign" (2013, Solomon R. Guggenheim Museum,
 * New York, https://www.guggenheim.org/artwork/33146) — an immersive skyspace
 * where five concentric ellipses of pure diffuse coloured light fill the rotunda,
 * dissolving depth cues into an infinite luminous field. 7 frequency bands each
 * drive one concentric ring from warm sub-bass at the outer edge to cool
 * brilliance at the centre. Beats shift the global colour temperature across the
 * field. The Haze slider applies a Gaussian blur that progressively dissolves
 * ring boundaries into true Ganzfeld diffusion — the perceptual state where the
 * eye can no longer gauge depth in a field of undifferentiated coloured light.
 *
 * Sliders:
 *   ganzfeldZones — number of concentric light rings (3–7)
 *   ganzfeldHaze  — atmospheric diffusion / blur (0–1)
 *   ganzfeldDrift — colour temperature drift speed (0–1)
 */
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { BAND_COUNT, isMobile } from '../utils/constants';

// Warm-to-cool Turrell palette: amber → orange-red → rose → violet → blue → cyan → indigo
const BAND_HUES: readonly number[] = [38, 12, 342, 285, 222, 188, 262];

let phase = 0;
let globalHueShift = 0;
let lastBeatIndex = -1;
let beatFlash = 0;

let offBuf: InstanceType<typeof OffscreenCanvas> | null = null;
let offCtx: CanvasRenderingContext2D | null = null;
let offW = 0;
let offH = 0;

function ensureOffscreen(w: number, h: number): void {
  const scale = isMobile ? 0.5 : 1.0;
  const tw = Math.floor(w * scale);
  const th = Math.floor(h * scale);
  if (offBuf && offW === tw && offH === th) return;
  offW = tw;
  offH = th;
  if (typeof OffscreenCanvas !== 'undefined') {
    offBuf = new OffscreenCanvas(tw, th);
  } else {
    const c = document.createElement('canvas');
    c.width = tw;
    c.height = th;
    offBuf = c as unknown as InstanceType<typeof OffscreenCanvas>;
  }
  offCtx = offBuf.getContext('2d') as unknown as CanvasRenderingContext2D;
}

export function drawGanzfeld(p: P5Instance, dt: number): void {
  const { state, config } = store;
  const { amps, transients } = getBandAverages(BAND_COUNT);

  const w = p.width;
  const h = p.height;

  // Beat detection
  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    const beatIdx = adjusted >= 0 ? Math.floor(adjusted / state.beatIntervalSec) : -1;
    if (beatIdx >= 0 && beatIdx !== lastBeatIndex) {
      lastBeatIndex = beatIdx;
      beatFlash = 1.0;
      // Turrell's installations shift colour temperature throughout the day
      globalHueShift = (globalHueShift + 50) % 360;
    }
  }

  const driftSpeed = 0.0005 + config.ganzfeldDrift * 0.004;
  phase += driftSpeed * dt;
  beatFlash *= Math.pow(0.93, dt);
  if (beatFlash < 0.004) beatFlash = 0;

  const numZones = Math.round(3 + config.ganzfeldZones * 4); // 3–7
  const haze = config.ganzfeldHaze;

  ensureOffscreen(w, h);
  if (!offCtx || !offBuf) return;

  const ctx = offCtx;

  // Deep near-black — the museum room in darkness
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = '#000008';
  ctx.fillRect(0, 0, offW, offH);

  ctx.globalCompositeOperation = 'lighter';

  const cx = offW * 0.5;
  const cy = offH * 0.5;

  // r1 extends slightly beyond the canvas diagonal so outer rings fill the frame
  const r1 = Math.hypot(offW, offH) * 0.58;
  // halfWidth determines how wide (and how much rings overlap each other)
  const maxR = Math.min(offW, offH) * 0.52;
  const halfWidth = maxR * 0.24;

  // Draw rings from outermost (sub-bass) to innermost (brilliance)
  for (let z = 0; z < numZones; z++) {
    const bandIdx = Math.round(z * (BAND_COUNT - 1) / Math.max(1, numZones - 1));
    const amp = amps[bandIdx] ?? 0;
    const trans = transients[bandIdx] ?? 1;

    const t = numZones <= 1 ? 0 : z / (numZones - 1);
    // Ring peak radius: z=0 outermost (0.9*maxR), z=numZones-1 innermost (0.1*maxR)
    const peakR = maxR * (0.9 - t * 0.8);

    const hue = (BAND_HUES[bandIdx] + globalHueShift + phase * 18) % 360;
    const sat = 48 + amp * 52;
    const lum = 18 + amp * 62 + beatFlash * 18 + (trans > 1.2 ? (trans - 1) * 10 : 0);
    const alpha = Math.min(1, (0.12 + amp * 0.72) * (0.55 + haze * 0.45));

    // Gradient position fractions within [0, r1]
    const innerFrac = Math.max(0, (peakR - halfWidth) / r1);
    const peakFrac = peakR / r1;
    const outerFrac = Math.min(0.98, (peakR + halfWidth) / r1);

    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r1);
    grad.addColorStop(0, 'transparent');
    if (innerFrac > 0.02) {
      grad.addColorStop(innerFrac, 'transparent');
    }
    grad.addColorStop(
      peakFrac,
      `hsla(${hue | 0},${sat | 0}%,${Math.min(100, lum) | 0}%,${alpha.toFixed(3)})`,
    );
    grad.addColorStop(outerFrac, 'transparent');
    if (outerFrac < 0.97) {
      grad.addColorStop(1, 'transparent');
    }

    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, offW, offH);
  }

  // Central aperture glow — the "sky through the opening", near-white at full volume
  const overallAmp = amps.reduce((s, a) => s + a, 0) / BAND_COUNT;
  if (overallAmp > 0.02 || beatFlash > 0.01) {
    const centreR = maxR * (0.06 + overallAmp * 0.08 + beatFlash * 0.04);
    const centreHue = (globalHueShift + phase * 20) % 360;
    const a = Math.min(1, overallAmp * 0.85 + beatFlash * 0.4);
    const centreGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, centreR);
    centreGrad.addColorStop(0, `hsla(${centreHue | 0},15%,96%,${a.toFixed(3)})`);
    centreGrad.addColorStop(0.55, `hsla(${centreHue | 0},38%,65%,${(a * 0.4).toFixed(3)})`);
    centreGrad.addColorStop(1, 'transparent');
    ctx.fillStyle = centreGrad;
    ctx.fillRect(0, 0, offW, offH);
  }

  ctx.globalCompositeOperation = 'source-over';

  // Blit to main canvas; apply Gaussian blur for the Ganzfeld haze effect
  const mainCtx = ((p as unknown as Record<string, unknown>).drawingContext as CanvasRenderingContext2D) || null;
  if (!mainCtx) return;

  mainCtx.save();
  if (haze > 0.01) {
    const blurPx = haze * 22 * (offW / 800);
    mainCtx.filter = `blur(${blurPx.toFixed(1)}px)`;
  }
  mainCtx.drawImage(offBuf as unknown as HTMLCanvasElement, 0, 0, w, h);
  mainCtx.filter = 'none';
  mainCtx.restore();
}

export function resetGanzfeld(): void {
  phase = 0;
  globalHueShift = 0;
  lastBeatIndex = -1;
  beatFlash = 0;
  offBuf = null;
  offCtx = null;
  offW = 0;
  offH = 0;
}
