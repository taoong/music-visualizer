/**
 * Text visualization — beat-synchronized text patterns
 * 7 distinct visual effects cycling on every detected beat.
 */
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';

let lastBeatIndex = -1;
let lastBeatGroupIndex = -1;
let beatFlash = 0;
let sweepT = 0;
let userText = 'TEXT';
let currentPatternIdx = -1;

interface PatternConfig {
  hue: number;
  saturation: number;
  count: number;
  angle: number;
  orbitRadius: number;
}

let patternConfig: PatternConfig = {
  hue: 0,
  saturation: 90,
  count: 6,
  angle: 0,
  orbitRadius: 0.3,
};

// ── Pattern renderers ──────────────────────────────────────────────────────

function renderZoomPulse(
  p: P5Instance,
  w: number,
  h: number,
  text: string,
  hue: number,
  sat: number,
  t: number,
  flash: number,
  bass: number
): void {
  const baseSize = Math.min(w, h) * 0.12;
  const scale = 1 + bass * 0.5 + flash * 0.7;

  p.push();
  p.translate(w / 2, h / 2);
  p.rotate(Math.sin(t * 0.25) * 0.06);
  p.scale(scale);
  (p as any).fill(hue, sat, 100);
  (p as any).textSize(baseSize);
  (p as any).text(text, 0, 0);
  p.pop();
}

function renderDiagonalRush(
  p: P5Instance,
  w: number,
  h: number,
  text: string,
  hue: number,
  sat: number,
  t: number,
  flash: number,
  bass: number,
  config: PatternConfig
): void {
  const baseSize = Math.min(w, h) * 0.12;
  const amp = Math.min(w, h) * 0.25 + bass * Math.min(w, h) * 0.1;
  const offset = Math.sin(t * 1.1) * amp;
  const dx = Math.cos(config.angle);
  const dy = Math.sin(config.angle);
  const brightness = 90 + flash * 10;

  p.push();
  p.translate(w / 2 + dx * offset, h / 2 + dy * offset);
  p.rotate(config.angle);
  (p as any).fill(hue, sat, brightness);
  (p as any).textSize(baseSize);
  (p as any).text(text, 0, 0);
  p.pop();

  p.push();
  p.translate(w / 2 - dx * offset, h / 2 - dy * offset);
  p.rotate(config.angle);
  (p as any).fill(hue, sat, brightness);
  (p as any).textSize(baseSize);
  (p as any).text(text, 0, 0);
  p.pop();
}

function renderQuadMirror(
  p: P5Instance,
  w: number,
  h: number,
  text: string,
  hue: number,
  sat: number,
  t: number,
  flash: number,
  bass: number
): void {
  const baseSize = Math.min(w, h) * 0.10;
  const baseOffsetX = w * 0.22 + bass * w * 0.04;
  const baseOffsetY = h * 0.18 + Math.sin(t * 0.7) * h * 0.04;
  const brightness = 85 + flash * 15;

  const signs: [number, number][] = [[1, 1], [-1, 1], [1, -1], [-1, -1]];
  for (const [sx, sy] of signs) {
    p.push();
    p.translate(w / 2 + sx * baseOffsetX, h / 2 + sy * baseOffsetY);
    p.scale(sx, sy);
    (p as any).fill(hue, sat, brightness);
    (p as any).textSize(baseSize);
    (p as any).text(text, 0, 0);
    p.pop();
  }
}

function renderRadialCrown(
  p: P5Instance,
  w: number,
  h: number,
  text: string,
  hue: number,
  sat: number,
  t: number,
  flash: number,
  bass: number,
  config: PatternConfig
): void {
  const baseSize = Math.min(w, h) * 0.08;
  const radius = Math.min(w, h) * (config.orbitRadius + bass * 0.05);
  const ringAngle = t * 0.2;
  const brightness = 85 + flash * 15;

  for (let i = 0; i < config.count; i++) {
    const a = ringAngle + (i / config.count) * Math.PI * 2;
    const cx = w / 2 + Math.cos(a) * radius;
    const cy = h / 2 + Math.sin(a) * radius;

    p.push();
    p.translate(cx, cy);
    p.rotate(a + Math.PI / 2);
    (p as any).fill(hue, sat, brightness);
    (p as any).textSize(baseSize);
    (p as any).text(text, 0, 0);
    p.pop();
  }
}

function renderEchoRings(
  p: P5Instance,
  w: number,
  h: number,
  text: string,
  hue: number,
  sat: number,
  _t: number,
  flash: number,
  bass: number
): void {
  const echoCount = 5;
  for (let i = 0; i < echoCount; i++) {
    const t2 = i / (echoCount - 1);
    const sc = 0.35 + t2 * 1.15 + flash * t2 * 0.4;
    const baseSize = Math.min(w, h) * 0.12;
    const alpha = (1 - t2 * 0.75) * 100;
    const brightness = 80 + bass * 20;

    p.push();
    p.translate(w / 2, h / 2);
    p.scale(sc);
    (p as any).fill(hue, sat, brightness, alpha);
    (p as any).textSize(baseSize);
    (p as any).text(text, 0, 0);
    p.pop();
  }
}

function renderBilateralReflect(
  p: P5Instance,
  w: number,
  h: number,
  text: string,
  hue: number,
  sat: number,
  t: number,
  flash: number,
  bass: number
): void {
  const baseSize = Math.min(w, h) * 0.12;
  const gap = h * 0.08 + bass * h * 0.05 + Math.sin(t * 1.2) * h * 0.02;
  const brightness = 85 + flash * 15;

  // Main text
  p.push();
  p.translate(w / 2, h / 2 - gap / 2);
  (p as any).fill(hue, sat, brightness);
  (p as any).textSize(baseSize);
  (p as any).text(text, 0, 0);
  p.pop();

  // Reflected text
  p.push();
  p.translate(w / 2, h / 2 + gap / 2);
  p.scale(1, -1);
  (p as any).fill(hue, sat, brightness, 60);
  (p as any).textSize(baseSize);
  (p as any).text(text, 0, 0);
  p.pop();
}

function renderKaleidoscope(
  p: P5Instance,
  w: number,
  h: number,
  text: string,
  hue: number,
  sat: number,
  t: number,
  flash: number,
  bass: number,
  config: PatternConfig
): void {
  const baseSize = Math.min(w, h) * 0.09;
  const radius = Math.min(w, h) * (config.orbitRadius + bass * 0.04);
  const ringAngle = t * 0.15;
  const brightness = 85 + flash * 15;
  const total = config.count * 2;

  for (let i = 0; i < total; i++) {
    const a = ringAngle + (i / total) * Math.PI * 2;
    const cx = w / 2 + Math.cos(a) * radius;
    const cy = h / 2 + Math.sin(a) * radius;
    const mirror = i % 2 === 1 ? -1 : 1;

    p.push();
    p.translate(cx, cy);
    p.rotate(a + Math.PI / 2);
    p.scale(mirror, 1);
    (p as any).fill(hue, sat, brightness);
    (p as any).textSize(baseSize);
    (p as any).text(text, 0, 0);
    p.pop();
  }
}

// ── Pattern generation ─────────────────────────────────────────────────────

function generateNextPattern(): void {
  let next = Math.floor(Math.random() * 6);
  if (next >= currentPatternIdx) next++;
  currentPatternIdx = next;

  patternConfig = {
    hue: Math.random() * 360,
    saturation: 80 + Math.random() * 20,
    count: [4, 6, 8][Math.floor(Math.random() * 3)],
    angle: [30, 45, 60, 120, 135, 150][Math.floor(Math.random() * 6)] * (Math.PI / 180),
    orbitRadius: 0.25 + Math.random() * 0.12,
  };
}

// ── Main draw function ─────────────────────────────────────────────────────

export function drawText(p: P5Instance, dt: number): void {
  const w = p.width;
  const h = p.height;
  const { state, audioState, config } = store;

  // Dark trail
  p.push();
  (p as any).fill(0, 0, 0, 160);
  p.rect(0, 0, w, h);
  p.pop();

  (p as any).colorMode(p['HSB'], 360, 100, 100, 100);

  // Audio data
  const bassAmp = audioState.smoothedBands[1]
    ? Array.from(audioState.smoothedBands[1]).reduce((s, v) => s + v, 0) /
      audioState.smoothedBands[1].length
    : 0;

  // Beat detection
  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    const currentBeatIndex = adjusted >= 0 ? Math.floor(adjusted / state.beatIntervalSec) : -1;

    if (currentBeatIndex >= 0 && currentBeatIndex !== lastBeatIndex) {
      beatFlash = 1.0;
      lastBeatIndex = currentBeatIndex;

      const beatsPerChange = Math.pow(2, config.beatDivision - 1);
      const currentGroup = Math.floor(currentBeatIndex / beatsPerChange);
      if (currentGroup !== lastBeatGroupIndex) {
        generateNextPattern();
        lastBeatGroupIndex = currentGroup;
      }
    }
  }

  // Generate initial pattern
  if (currentPatternIdx === -1) {
    generateNextPattern();
  }

  // Advance animation
  beatFlash *= Math.pow(0.78, dt);
  sweepT += dt * 0.016667;

  // Text setup
  (p as any).textAlign(p['CENTER'], p['CENTER']);
  (p as any).textStyle('bold');
  p.noStroke();

  const { hue, saturation } = patternConfig;

  // Apply glow
  p.drawingContext.shadowBlur = (15 + beatFlash * 20 + bassAmp * 15) * config.intensity;
  p.drawingContext.shadowColor = `hsl(${hue}, 100%, 60%)`;

  // Dispatch to pattern renderer
  switch (currentPatternIdx) {
    case 0:
      renderZoomPulse(p, w, h, userText, hue, saturation, sweepT, beatFlash, bassAmp);
      break;
    case 1:
      renderDiagonalRush(p, w, h, userText, hue, saturation, sweepT, beatFlash, bassAmp, patternConfig);
      break;
    case 2:
      renderQuadMirror(p, w, h, userText, hue, saturation, sweepT, beatFlash, bassAmp);
      break;
    case 3:
      renderRadialCrown(p, w, h, userText, hue, saturation, sweepT, beatFlash, bassAmp, patternConfig);
      break;
    case 4:
      renderEchoRings(p, w, h, userText, hue, saturation, sweepT, beatFlash, bassAmp);
      break;
    case 5:
      renderBilateralReflect(p, w, h, userText, hue, saturation, sweepT, beatFlash, bassAmp);
      break;
    case 6:
      renderKaleidoscope(p, w, h, userText, hue, saturation, sweepT, beatFlash, bassAmp, patternConfig);
      break;
  }

  // Clear glow
  p.drawingContext.shadowBlur = 0;

  // Reset color mode
  (p as any).colorMode(p['RGB'], 255);
}

export function resetText(): void {
  lastBeatIndex = -1;
  lastBeatGroupIndex = -1;
  beatFlash = 0;
  sweepT = 0;
  currentPatternIdx = -1;
}

export function setVisualizerText(str: string): void {
  userText = str.toUpperCase() || 'TEXT';
}
