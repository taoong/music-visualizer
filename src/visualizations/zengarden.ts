/**
 * Zen Garden (Karesansui 枯山水) — audio-reactive dry-rock-garden visualization.
 *
 * A warm sandy canvas holds stone formations wrapped by flowing rake lines.
 * Seven frequency bands each govern a horizontal zone: sub-bass drives deep
 * rolling waves near the bottom, brilliance produces fine rapid ripples near
 * the top.  On every beat the wave phases jump as if a monk re-raked the
 * entire garden in one sweep.
 *
 * Inspired by the karesansui tradition of the Ryōan-ji temple, Kyoto (c. 1500)
 * and Tokujin Yoshioka's sand-texture installations (2008–2024).
 * https://www.tokujin.com/
 *
 * Sliders
 *   Lines — rake-tine density (10–60 lines)
 *   Depth — wave amplitude (flat → deep rolling waves)
 *   Rocks — number of stone formations (0–6)
 */
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { BAND_COUNT, isMobile } from '../utils/constants';

const X_STEPS = isMobile ? 60 : 120;

interface Rock {
  nx: number;  // normalized x in [0,1]
  ny: number;  // normalized y in [0,1]
  nrx: number; // normalized x-radius relative to canvas width
  nry: number; // normalized y-radius relative to canvas height
  angle: number;
}

// ── module-scoped state ──────────────────────────────────────────────────────
let rocks: Rock[] = [];
let time = 0;
let lastBeatIndex = -1;
let beatFlash = 0;
let phaseShift = 0;
let prevRockCount = -1;

// ── helpers ──────────────────────────────────────────────────────────────────
function initRocks(count: number): void {
  rocks = [];
  const goldenAngle = 2.399963;
  for (let i = 0; i < count; i++) {
    rocks.push({
      nx:    0.12 + ((i * goldenAngle * 0.55) % 0.76),
      ny:    0.18 + ((i * 0.618 + 0.07) % 0.64),
      nrx:   0.022 + (i % 3) * 0.009,
      nry:   0.014 + (i % 2) * 0.006,
      angle: i * 0.71,
    });
  }
  prevRockCount = count;
}

// ── reset ────────────────────────────────────────────────────────────────────
export function resetZengarden(): void {
  time = 0;
  lastBeatIndex = -1;
  beatFlash = 0;
  phaseShift = 0;
  rocks = [];
  prevRockCount = -1;
}

// ── draw ─────────────────────────────────────────────────────────────────────
export function drawZengarden(p: P5Instance, dt: number): void {
  const { state, config } = store;
  const { amps } = getBandAverages(BAND_COUNT);

  const w = p.width;
  const h = p.height;

  const lineCount  = Math.round(10 + config.zengardenLines * 50);   // 10–60
  const depth      = config.zengardenDepth;                          // 0–1
  const rockCount  = Math.round(config.zengardenRocks * 6);          // 0–6

  if (prevRockCount !== rockCount) initRocks(rockCount);

  // ── beat detection ────────────────────────────────────────────────────────
  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adj = pos - state.beatOffset;
    const bi  = adj >= 0 ? Math.floor(adj / state.beatIntervalSec) : -1;
    if (bi >= 0 && bi !== lastBeatIndex) {
      lastBeatIndex = bi;
      phaseShift += Math.PI * (0.4 + Math.random() * 0.35);
      beatFlash   = 1.0;
    }
  }

  time      += dt * 0.007;
  beatFlash *= Math.pow(0.87, dt);

  let energy = 0;
  for (let i = 0; i < BAND_COUNT; i++) energy += amps[i];
  energy /= BAND_COUNT;

  const ctx = (p as any).drawingContext as CanvasRenderingContext2D;

  // ── background ───────────────────────────────────────────────────────────
  const fl  = beatFlash * 0.11;
  const bgG = ctx.createLinearGradient(0, 0, 0, h);
  bgG.addColorStop(0, `rgb(${Math.min(255, 213 + (fl * 255) | 0)},${Math.min(255, 191 + (fl * 255) | 0)},${Math.min(255, 150 + (fl * 255) | 0)})`);
  bgG.addColorStop(1, `rgb(${Math.min(255, 190 + (fl * 255) | 0)},${Math.min(255, 163 + (fl * 255) | 0)},${Math.min(255, 120 + (fl * 255) | 0)})`);
  ctx.fillStyle = bgG;
  ctx.fillRect(0, 0, w, h);

  // ── rocks ─────────────────────────────────────────────────────────────────
  for (const rock of rocks) {
    const rx   = rock.nx  * w;
    const ry   = rock.ny  * h;
    const rw   = rock.nrx * w;
    const rh   = rock.nry * h * 1.6;

    // drop shadow
    ctx.save();
    ctx.translate(rx + rw * 0.25, ry + rh * 0.3);
    ctx.scale(rw, rh);
    ctx.beginPath();
    ctx.arc(0, 0, 1, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    ctx.fill();
    ctx.restore();

    // rock body
    ctx.save();
    ctx.translate(rx, ry);
    ctx.rotate(rock.angle);
    ctx.scale(rw, rh);
    ctx.beginPath();
    ctx.arc(0, 0, 1, 0, Math.PI * 2);
    const rg = ctx.createRadialGradient(-0.3, -0.35, 0, 0, 0, 1);
    rg.addColorStop(0,   '#908070');
    rg.addColorStop(0.6, '#524438');
    rg.addColorStop(1,   '#2a1e16');
    ctx.fillStyle = rg;
    ctx.fill();
    ctx.restore();
  }

  // ── rake lines ────────────────────────────────────────────────────────────
  const lineSpacing = h / (lineCount + 1);
  const xStep       = w / X_STEPS;

  ctx.lineCap  = 'round';
  ctx.lineJoin = 'round';

  for (let li = 0; li < lineCount; li++) {
    const baseY  = lineSpacing * (li + 1);
    const bandIdx = Math.min(BAND_COUNT - 1, Math.floor((li / lineCount) * BAND_COUNT));
    const amp    = amps[bandIdx];
    const bandT  = bandIdx / (BAND_COUNT - 1); // 0 = sub, 1 = brilliance

    // Wave: primary sine + two harmonics for organic feel
    const waveFreq  = 1.8 + bandIdx * 0.55;
    const waveSpeed = 0.55 + bandIdx * 0.09;
    const waveAmp   = depth * (22 + amp * 72 + energy * 14);
    const h2Amp     = waveAmp * 0.16;
    const h3Amp     = waveAmp * 0.07;
    const linePhase = li * 0.17 + phaseShift;

    ctx.beginPath();

    for (let xi = 0; xi <= X_STEPS; xi++) {
      const px  = xi * xStep;
      const nx  = px / w;
      const ph  = nx * Math.PI * 2 * waveFreq + time * waveSpeed + linePhase;
      let yDisp = Math.sin(ph)                            * waveAmp
                + Math.sin(ph * 2.29 + time * 0.38)      * h2Amp
                + Math.sin(ph * 3.61 - time * 0.21)      * h3Amp;

      // deflect around rocks
      for (const rock of rocks) {
        const rkx = rock.nx * w;
        const rky = rock.ny * h;
        const rix = rock.nrx * w + 28;
        const riy = rock.nry * h * 1.6 + 22;
        const ddx = px - rkx;
        const ddy = baseY - rky; // use undisplaced baseY for push direction
        const nd  = Math.sqrt((ddx / rix) ** 2 + (ddy / riy) ** 2);
        if (nd < 1.3) {
          const falloff = (1.3 - nd) / 1.3;
          const smooth  = falloff * falloff * (3 - 2 * falloff);
          yDisp += (ddy >= 0 ? 1 : -1) * smooth * (riy * 0.55);
        }
      }

      const finalY = baseY + yDisp;
      if (xi === 0) ctx.moveTo(px, finalY);
      else          ctx.lineTo(px, finalY);
    }

    // Color: warm earthy tones, slightly darker at higher amplitudes
    const rr = Math.round(125 - bandT * 22 - amp * 18);
    const gg = Math.round(98  - bandT * 15 - amp * 12);
    const bb = Math.round(62  - bandT * 6  - amp * 8 );
    ctx.strokeStyle = `rgba(${rr},${gg},${bb},${0.33 + amp * 0.55})`;
    ctx.lineWidth   = 0.75 + amp * 1.9 + (1 - bandT) * 0.45;
    ctx.stroke();
  }

  // ── vignette ──────────────────────────────────────────────────────────────
  const minDim = Math.min(w, h);
  const vig    = ctx.createRadialGradient(w / 2, h / 2, minDim * 0.22, w / 2, h / 2, minDim * 0.78);
  vig.addColorStop(0, 'rgba(0,0,0,0)');
  vig.addColorStop(1, `rgba(48,32,14,${0.28 + beatFlash * 0.06})`);
  ctx.fillStyle = vig;
  ctx.fillRect(0, 0, w, h);
}
