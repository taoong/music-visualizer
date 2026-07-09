/**
 * Feedback — recursive canvas-feedback infinite zoom mandala.
 *
 * Inspired by the canonical TouchDesigner "Feedback TOP" aesthetic seen
 * across popular reels by Bjørn Staal, Matthew Ragan, Paketa12 and the wider
 * #touchdesigner community (https://derivative.ca/community-post/feedback-loops,
 * https://www.youtube.com/results?search_query=touchdesigner+feedback+loop).
 *
 * Two graphics buffers ping-pong each frame: the previous frame is drawn back
 * into the current one with a slight scale-up and rotation, dimmed by an alpha
 * fade. A fresh audio-reactive 7-spoke sunburst is then stamped on top in the
 * centre. As the loop iterates the old sunbursts grow outward and tunnel away
 * toward the edges while new ones are stamped at the centre, producing
 * infinite recursive kaleidoscope tunnels — the same look that TD's Feedback
 * TOP node is famous for.
 *
 * Each frequency band drives one spoke (length / brightness). Beats fire an
 * expanding ring flash and shift the global hue palette. Three-pass additive
 * glow gives the sunburst a phosphor neon look that smears beautifully into
 * the recursive history.
 *
 * Mobile guard: half-resolution buffers.
 *
 * Sliders
 *   Zoom  — per-frame scale of the recursive buffer (slow drift → fast tunnel)
 *   Spin  — per-frame rotation of the recursive buffer (none → vortex)
 *   Trail — persistence of the recursive history (short fade → long smear)
 */

import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { BAND_COUNT, isMobile } from '../utils/constants';

const TWO_PI = Math.PI * 2;
const BUF_SCALE = isMobile ? 0.5 : 1.0;

// Distinct hue per frequency band — violet through red rainbow
const BAND_HUES = [275, 230, 190, 140, 65, 30, 350];

let bufA: P5Graphics | null = null;
let bufB: P5Graphics | null = null;
let bufW = 0;
let bufH = 0;
let rotation = 0;
let hueShift = 0;
let lastBeatIndex = -1;
let flashAlpha = 0;
let ringR = 0;
let ringAlpha = 0;

function ensureBuffers(p: P5Instance): void {
  const targetW = Math.max(2, Math.round(p.width * BUF_SCALE));
  const targetH = Math.max(2, Math.round(p.height * BUF_SCALE));
  if (bufA && bufB && bufA.width === targetW && bufA.height === targetH) return;
  if (bufA) bufA.remove();
  if (bufB) bufB.remove();
  bufA = (p as any).createGraphics(targetW, targetH) as P5Graphics;
  bufB = (p as any).createGraphics(targetW, targetH) as P5Graphics;
  (bufA as any).pixelDensity(1);
  (bufB as any).pixelDensity(1);
  (bufA as any).background(0);
  (bufB as any).background(0);
  bufW = targetW;
  bufH = targetH;
}

// Draw the audio-reactive sunburst into the buffer at full brightness.
function drawSunburst(g: any, amps: number[], cx: number, cy: number, minDim: number): void {
  g.colorMode(g.HSB, 360, 100, 100, 100);
  (g as any).blendMode(g.ADD);

  const baseLen = minDim * 0.38;
  const baseWt = Math.max(1.5, minDim * 0.004);

  // 3-pass glow per spoke: outer wide halo → mid → bright core
  const passes: Array<{ wMul: number; aMul: number }> = [
    { wMul: 6.0, aMul: 0.18 },
    { wMul: 2.6, aMul: 0.45 },
    { wMul: 1.0, aMul: 0.95 },
  ];

  for (let pass = 0; pass < 3; pass++) {
    const { wMul, aMul } = passes[pass];
    for (let b = 0; b < BAND_COUNT; b++) {
      const amp = amps[b];
      // Two opposing spokes per band so the sunburst is symmetric — feels
      // more like a star than a comb.
      for (let dir = 0; dir < 2; dir++) {
        const angle = (b / BAND_COUNT) * TWO_PI + (dir === 1 ? Math.PI : 0);
        const len = baseLen * (0.15 + amp * 0.95);
        const hue = (BAND_HUES[b] + hueShift) % 360;
        const sat = 60 + amp * 40;
        const bri = 55 + amp * 45;
        const alpha = (35 + amp * 65) * aMul;
        g.stroke(hue, sat, bri, alpha);
        g.strokeWeight(baseWt * wMul * (0.6 + amp * 0.8));
        g.line(cx, cy, cx + Math.cos(angle) * len, cy + Math.sin(angle) * len);
      }
    }
  }

  // Bright central nucleus pulses with overall amplitude
  const totalAmp = amps.reduce((s, v) => s + v, 0) / BAND_COUNT;
  g.noStroke();
  for (let i = 3; i >= 0; i--) {
    const r = (4 + totalAmp * 22) * (1 + i * 0.8);
    const a = 60 - i * 14;
    g.fill((hueShift + 30) % 360, 25, 100, a);
    g.ellipse(cx, cy, r * 2, r * 2);
  }

  // Beat-triggered expanding ring shockwave
  if (ringAlpha > 0.5) {
    g.noFill();
    g.stroke((hueShift + 200) % 360, 30, 100, ringAlpha);
    g.strokeWeight(baseWt * (1.5 + ringAlpha * 0.05));
    g.ellipse(cx, cy, ringR * 2, ringR * 2);
  }

  // White beat flash overlay (full screen)
  if (flashAlpha > 1) {
    (g as any).blendMode(g.BLEND);
    g.noStroke();
    g.fill(220, 15, 100, flashAlpha);
    g.rect(0, 0, bufW, bufH);
  }

  (g as any).blendMode(g.BLEND);
  g.colorMode(g.RGB, 255, 255, 255, 255);
}

export function drawFeedback(p: P5Instance, dt: number): void {
  ensureBuffers(p);
  if (!bufA || !bufB) return;

  const { state, config } = store;
  const { amps } = getBandAverages(BAND_COUNT);

  const zoom = config.feedbackZoom;  // 0..1
  const spin = config.feedbackSpin;  // 0..1
  const trail = config.feedbackTrail; // 0..1

  // Beat detection — flash, ring shockwave, hue palette shift
  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    const beatIdx = adjusted >= 0 ? Math.floor(adjusted / state.beatIntervalSec) : -1;
    if (beatIdx >= 0 && beatIdx !== lastBeatIndex) {
      hueShift = (hueShift + 47) % 360;
      flashAlpha = 28;
      ringR = 4;
      ringAlpha = 90;
      lastBeatIndex = beatIdx;
    }
  }

  // Decay ephemera frame-rate independent
  flashAlpha *= Math.pow(0.84, dt);
  ringAlpha *= Math.pow(0.92, dt);
  const minDim = Math.min(bufW, bufH);
  ringR += minDim * 0.012 * dt;

  // Per-frame transform of the recursive buffer.
  // Zoom: 1.005 (gentle drift) → 1.05 (fast tunnel toward edges)
  // Spin: 0 → 0.035 rad/frame
  // Trail (persistence): 220 → 254 alpha out of 255
  const scl = 1.005 + zoom * 0.045;
  const rotPer = spin * 0.035 * (dt > 0 ? Math.min(dt, 2) : 1);
  const persist = 218 + Math.round(trail * 36);

  rotation += rotPer;

  // ---- Step 1: into bufB, draw transformed bufA (the previous frame) ----
  const gB: any = bufB;
  const gA: any = bufA;

  // Clear bufB to black each frame so we don't compound stale pixels
  gB.push();
  gB.noStroke();
  gB.fill(0, 0, 0, 255);
  gB.rect(0, 0, bufW, bufH);
  gB.pop();

  gB.push();
  gB.translate(bufW / 2, bufH / 2);
  gB.rotate(rotation * 0.0 + rotPer); // rotation is accumulated via image draw, apply incremental amount
  gB.scale(scl);
  // Tint dims the recursive history so it fades out over many frames
  (gB as any).tint(255, persist);
  gB.image(gA, -bufW / 2, -bufH / 2);
  (gB as any).noTint();
  gB.pop();

  // ---- Step 2: draw new audio-reactive sunburst on top ----
  drawSunburst(gB, amps, bufW / 2, bufH / 2, minDim);

  // ---- Step 3: present bufB to the main canvas ----
  p.background(0);
  (p as any).image(bufB, 0, 0, p.width, p.height);

  // ---- Step 4: ping-pong ----
  const tmp = bufA;
  bufA = bufB;
  bufB = tmp;
}

export function resetFeedback(): void {
  if (bufA) { bufA.remove(); bufA = null; }
  if (bufB) { bufB.remove(); bufB = null; }
  bufW = 0;
  bufH = 0;
  rotation = 0;
  hueShift = 0;
  lastBeatIndex = -1;
  flashAlpha = 0;
  ringR = 0;
  ringAlpha = 0;
}

export function disposeFeedback(): void {
  resetFeedback();
}
