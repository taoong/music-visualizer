/**
 * Paint — Abstract expressionist brushstrokes.
 *
 * 7 "painters" wander the canvas driven by Perlin noise + audio amplitude.
 * Each maps to a frequency band and leaves coloured stroke trails accumulated
 * in an off-screen buffer. A semi-transparent overlay fades older strokes at a
 * rate set by the Fade slider. Beat pulses scatter all painters outward from
 * the canvas centre.
 *
 * Sliders: Stroke Width, Fade, Speed
 */
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { BAND_COUNT } from '../utils/constants';

// HSB hues per frequency band: sub → bass → lowMid → mid → upperMid → presence → brilliance
const BAND_HUES = [0, 30, 65, 140, 195, 240, 280];

interface Painter {
  x: number;
  y: number;
  px: number;
  py: number;
  vx: number;
  vy: number;
  noiseOff: number;
}

let painters: Painter[] = [];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let buf: any = null;
let lastBeatIndex = -1;
let noiseT = 0;
let initialized = false;

function initPainters(w: number, h: number): void {
  painters = Array.from({ length: BAND_COUNT }, (_, i) => {
    const angle = (i / BAND_COUNT) * Math.PI * 2;
    const r = Math.min(w, h) * 0.18;
    const x = w / 2 + Math.cos(angle) * r;
    const y = h / 2 + Math.sin(angle) * r;
    return { x, y, px: x, py: y, vx: 0, vy: 0, noiseOff: i * 127.3 };
  });
}

export function resetPaint(): void {
  buf = null;
  painters = [];
  lastBeatIndex = -1;
  noiseT = 0;
  initialized = false;
}

export function drawPaint(p: P5Instance, dt: number): void {
  const { state, config } = store;
  const { amps, transients } = getBandAverages(BAND_COUNT);

  const w = p.width;
  const h = p.height;

  // Create or recreate buffer when canvas size changes
  if (!initialized || !buf || buf.width !== w || buf.height !== h) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    buf = (p as any).createGraphics(w, h);
    buf.pixelDensity(1);
    buf.background(0);
    initPainters(w, h);
    initialized = true;
  }

  // Beat detection
  let onBeat = false;
  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    const beat = adjusted >= 0 ? Math.floor(adjusted / state.beatIntervalSec) : -1;
    if (beat >= 0 && beat !== lastBeatIndex) {
      lastBeatIndex = beat;
      onBeat = true;
    }
  }

  const sw = config.paintStrokeWidth;
  const fade = config.paintFade;
  const speed = config.paintSpeed;

  // Fade overlay: alpha 2–40 based on Fade slider
  const fadeAlpha = Math.round(fade * 38 + 2);
  buf.noStroke();
  buf.fill(0, 0, 0, fadeAlpha);
  buf.rect(0, 0, w, h);

  noiseT += 0.003 * dt * speed;

  buf.colorMode(buf['HSB'], 360, 100, 100, 100);
  buf.strokeCap(buf['ROUND']);
  buf.noFill();

  for (let i = 0; i < BAND_COUNT; i++) {
    const painter = painters[i];
    const amp = amps[i];
    const tMult = transients[i];

    // Perlin noise-driven force direction — two independent noise channels for x/y
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const nx = (p as any).noise(painter.noiseOff, noiseT);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ny = (p as any).noise(painter.noiseOff + 71.9, noiseT + 33.7);
    const noiseAngle = nx * Math.PI * 4;
    const forceScale = (0.3 + amp * 2.5 * tMult) * speed;

    painter.vx += Math.cos(noiseAngle) * forceScale * 0.12 * dt;
    painter.vy += (Math.sin(noiseAngle) + (ny - 0.5) * 0.8) * forceScale * 0.12 * dt;

    // On beat: scatter painters outward from canvas centre
    if (onBeat) {
      const dx = painter.x - w / 2;
      const dy = painter.y - h / 2;
      const d = Math.sqrt(dx * dx + dy * dy) + 1;
      const burst = 14 * speed * (0.6 + tMult * 0.4);
      painter.vx += (dx / d) * burst;
      painter.vy += (dy / d) * burst;
    }

    // Velocity damping
    const damp = Math.pow(0.87, dt);
    painter.vx *= damp;
    painter.vy *= damp;

    // Move painter
    painter.px = painter.x;
    painter.py = painter.y;
    painter.x += painter.vx * dt;
    painter.y += painter.vy * dt;

    // Wrap at canvas edges — reset prev position so no edge-crossing stroke is drawn
    let wrapped = false;
    if (painter.x < 0) { painter.x += w; wrapped = true; }
    else if (painter.x > w) { painter.x -= w; wrapped = true; }
    if (painter.y < 0) { painter.y += h; wrapped = true; }
    else if (painter.y > h) { painter.y -= h; wrapped = true; }
    if (wrapped) { painter.px = painter.x; painter.py = painter.y; }

    if (amp < 0.008) continue;

    const hue = BAND_HUES[i];
    const sat = 55 + amp * 45;
    const bri = 65 + amp * 35;
    const alpha = 45 + amp * 55;

    buf.stroke(hue, sat, bri, alpha);
    buf.strokeWeight(sw * (0.4 + amp * 1.6));
    buf.line(painter.px, painter.py, painter.x, painter.y);
  }

  buf.colorMode(buf['RGB'], 255, 255, 255, 255);

  // Blit accumulated buffer onto the main canvas (background(0) already cleared it)
  p.image(buf, 0, 0);
}
