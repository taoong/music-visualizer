/**
 * Epicycles — Fourier series harmonic visualizer.
 *
 * Inspired by the tradition of Fourier's harmonic analysis (1822) and the
 * physical harmonograph machines of 19th-century physics demonstrations,
 * brought to vivid life in works like Étienne-Jules Marey's chronophotography
 * and contemporary coding educators. Seven nested spinning circles (one per
 * frequency band) rotate at integer multiples of a base speed; the tip of
 * the final arm traces a Lissajous-like curve that evolves continuously with
 * the music.
 *
 * Each circle's radius is driven by its frequency band's amplitude — bass
 * swings the outermost arm, brilliance makes fine interior spirals shimmer.
 * The traced curve accumulates in a ring-buffer trail, rendered with a
 * 3-pass phosphor glow whose hue drifts along its length.
 *
 * Audio reactivity
 *   Band[i] amplitude → radius of circle i (sub-bass = arm 1, brilliance = arm 7)
 *   Beat              → hue palette jump (+40°) + brief brightness flash
 *   Overall energy    → trail glow intensity
 *
 * Sliders
 *   Cycles — how many epicycles to show (2–7); fewer = simple ellipses,
 *             more = intricate knotted curves
 *   Speed  — base rotation rate; slow = gentle spirals, fast = dense knots
 *   Trail  — history length; short = recent trace, long = full Lissajous bloom
 */
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { BAND_COUNT, isMobile } from '../utils/constants';

const TWO_PI = Math.PI * 2;
const MAX_TRAIL = isMobile ? 400 : 800;
// Hue per band: sub=violet → brilliance=red (same as blobs/grayscott)
const BAND_HUES: readonly number[] = [280, 230, 180, 120, 60, 30, 0];

let angles: Float32Array = new Float32Array(BAND_COUNT); // current rotation per circle
let trailX: Float32Array = new Float32Array(MAX_TRAIL);
let trailY: Float32Array = new Float32Array(MAX_TRAIL);
let trailLen = 0;
let trailHead = 0; // ring-buffer write head
let lastBeatIndex = -1;
let hueShift = 0;
let flashBrightness = 0;

export function resetEpicycles(): void {
  angles = new Float32Array(BAND_COUNT);
  trailX = new Float32Array(MAX_TRAIL);
  trailY = new Float32Array(MAX_TRAIL);
  trailLen = 0;
  trailHead = 0;
  lastBeatIndex = -1;
  hueShift = 0;
  flashBrightness = 0;
}

export function drawEpicycles(p: P5Instance, dt: number): void {
  const { state, config } = store;
  const { amps } = getBandAverages(BAND_COUNT);

  const W = p.width;
  const H = p.height;
  const cx = W * 0.5;
  const cy = H * 0.5;
  // Max radius: largest single arm can be up to 35% of the shorter canvas dimension
  const maxR = Math.min(W, H) * 0.35;
  const minR = Math.min(W, H) * 0.02;

  // Beat detection
  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    const beatIdx = adjusted >= 0 ? Math.floor(adjusted / state.beatIntervalSec) : -1;
    if (beatIdx >= 0 && beatIdx !== lastBeatIndex) {
      lastBeatIndex = beatIdx;
      hueShift = (hueShift + 40) % 360;
      flashBrightness = 1.0;
    }
  }
  flashBrightness *= Math.pow(0.85, dt);

  // How many circles to show: slider 0→1 maps to 2→7
  const numCycles = Math.max(2, Math.round(2 + config.epicyclesCycles * 5));
  // Base rotation speed: slider 0→1 maps to 0.003→0.025 rad/frame
  const baseSpeed = 0.003 + config.epicyclesSpeed * 0.022;
  // Trail capacity: slider 0→1 maps to 40→MAX_TRAIL
  const trailCap = Math.max(40, Math.round(config.epicyclesTrail * MAX_TRAIL));

  // Advance each circle's angle
  for (let i = 0; i < numCycles; i++) {
    angles[i] = (angles[i] + (i + 1) * baseSpeed * dt) % TWO_PI;
  }

  // Walk the chain of circles, computing arm positions
  const armX = new Float32Array(numCycles + 1);
  const armY = new Float32Array(numCycles + 1);
  armX[0] = cx;
  armY[0] = cy;

  for (let i = 0; i < numCycles; i++) {
    const r = minR + amps[i] * (maxR / numCycles);
    armX[i + 1] = armX[i] + Math.cos(angles[i]) * r;
    armY[i + 1] = armY[i] + Math.sin(angles[i]) * r;
  }

  // Record tip into ring buffer
  trailX[trailHead] = armX[numCycles];
  trailY[trailHead] = armY[numCycles];
  trailHead = (trailHead + 1) % MAX_TRAIL;
  if (trailLen < MAX_TRAIL) trailLen++;

  // ── Render ────────────────────────────────────────────────────────────────

  p.background(8, 8, 16);

  // Overall energy for glow intensity
  let energy = 0;
  for (let i = 0; i < numCycles; i++) energy += amps[i];
  energy /= numCycles;

  (p as any).colorMode(p['HSB'], 360, 100, 100, 1);

  // Draw arm circles (thin, dim)
  p.noFill();
  for (let i = 0; i < numCycles; i++) {
    const r = minR + amps[i] * (maxR / numCycles);
    const hue = (BAND_HUES[i] + hueShift) % 360;
    p.stroke(hue, 60, 40, 0.35);
    p.strokeWeight(0.8);
    p.ellipse(armX[i], armY[i], r * 2, r * 2);
    // Draw the arm line
    p.stroke(hue, 70, 65, 0.5);
    p.strokeWeight(1.2);
    p.line(armX[i], armY[i], armX[i + 1], armY[i + 1]);
    // Dot at each joint
    p.fill(hue, 50, 80, 0.6);
    p.noStroke();
    p.ellipse(armX[i + 1], armY[i + 1], 4, 4);
    p.noFill();
  }

  // Draw trail — 3-pass glow
  const effective = Math.min(trailLen, trailCap);
  if (effective > 1) {
    const passes = [
      { weight: 5.0, alphaScale: 0.15 + energy * 0.1 },
      { weight: 2.5, alphaScale: 0.35 + energy * 0.15 },
      { weight: 1.0, alphaScale: 0.8  + energy * 0.15 },
    ];
    for (const pass of passes) {
      p.strokeWeight(pass.weight);
      p.noFill();
      p.beginShape();
      for (let k = 0; k < effective; k++) {
        const age = k / effective; // 0=oldest, 1=newest
        const idx = (trailHead - effective + k + MAX_TRAIL) % MAX_TRAIL;
        // Hue walks from dominant band towards hueShift as the trail gets older
        const dominantBand = amps.indexOf(Math.max(...Array.from(amps)));
        const hue = (BAND_HUES[dominantBand < 0 ? 0 : dominantBand] + hueShift + age * 60) % 360;
        const sat = 75 + age * 20;
        const bri = 30 + age * 65 + flashBrightness * 40;
        const alpha = age * pass.alphaScale;
        p.stroke(hue, Math.min(sat, 100), Math.min(bri, 100), Math.min(alpha, 1));
        p.curveVertex(trailX[idx], trailY[idx]);
      }
      p.endShape();
    }
  }

  // Bright dot at current tip
  const tipHue = (hueShift + 60) % 360;
  p.fill(tipHue, 20, 100, 0.9 + flashBrightness * 0.1);
  p.noStroke();
  p.ellipse(armX[numCycles], armY[numCycles], 7, 7);

  (p as any).colorMode(p['RGB'], 255, 255, 255, 255);
}
