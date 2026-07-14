/**
 * Kintsugi — Audio-reactive golden joinery visualization.
 *
 * Kintsugi (金継ぎ, "golden joinery") is the Japanese art of repairing broken
 * pottery with lacquer mixed with powdered gold, silver, or platinum. The
 * philosophy (wabi-sabi) treats breakage and repair as part of an object's
 * history, embracing imperfection as beautiful. This visualization pays homage
 * to the masters of Kyoto kintsugi such as Murata Gen and Morimoto Yasukiyo,
 * and to the contemporary ceramic artist Tsubaki Akasegawa, whose work has
 * renewed interest in the technique globally.
 *
 * Dark ceramic surface. Beat events trigger new crack clusters that propagate
 * outward from an impact point in real time — tips growing each frame at
 * amplitude-driven speed, branching stochastically, stopping when they hit
 * canvas edges or each other. Existing cracks glow with gold proportional to
 * their frequency band's current amplitude; 7 horizontal zones map sub-bass
 * (left) through brilliance (right). The three-pass glow (outer halo → mid →
 * bright core) mimics the multi-layer urushi lacquer filling real kintsugi cracks.
 *
 * Sliders
 *   Fracture — branching probability and maximum crack tree depth
 *   Glow     — metallic palette: 0=pure gold/copper, 1=opal/iridescent rainbow
 *   Decay    — crack trail persistence: 0=fast fade, 1=permanent accumulation
 */

import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { BAND_COUNT, isMobile } from '../utils/constants';

// Gold-family hues per band (sub-bass → brilliance): copper, amber-gold, yellow-gold,
// pale gold, white gold, rose gold, platinum-silver
const GOLD_HUES: readonly number[] = [25, 42, 50, 54, 58, 340, 210];
const GOLD_SATS: readonly number[] = [70, 80, 85, 80, 70, 55, 20];

// Rainbow hues per band (for high-glow iridescent mode)
const IRIS_HUES: readonly number[] = [280, 230, 180, 120, 60, 30, 0];

const MAX_SEGMENTS = isMobile ? 800 : 2000;
const MAX_TIPS     = isMobile ? 40  : 100;

type CrackTip = {
  x: number;
  y: number;
  angle: number;
  depth: number;
  band: number;
  speed: number;
  stepsLeft: number;
};

type CrackSegment = {
  x1: number; y1: number;
  x2: number; y2: number;
  band: number;
  age: number;   // 1.0 = fresh, decays toward 0
  width: number; // base line width
};

let tips: CrackTip[] = [];
let segments: CrackSegment[] = [];
let lastBeatIndex = -1;
let initialized = false;

export function resetKintsugi(): void {
  tips = [];
  segments = [];
  lastBeatIndex = -1;
  initialized = false;
}

// Band index from normalised horizontal position in [0,1]
function bandFromX(nx: number): number {
  return Math.min(BAND_COUNT - 1, Math.floor(nx * BAND_COUNT));
}

function spawnCrackCluster(
  cx: number, cy: number,
  canvasW: number,
  numArms: number, depth: number
): void {
  for (let i = 0; i < numArms; i++) {
    const angle = (i / numArms) * Math.PI * 2 + (Math.random() - 0.5) * 0.6;
    const band  = bandFromX(cx / canvasW);
    const speed = 2.5 + Math.random() * 2.5;
    const steps = Math.round(40 + Math.random() * 60);
    if (tips.length < MAX_TIPS) {
      tips.push({ x: cx, y: cy, angle, depth, band, speed, stepsLeft: steps });
    }
  }
}

export function drawKintsugi(p: P5Instance, dt: number): void {
  const W = p.width;
  const H = p.height;

  if (!initialized) {
    initialized = true;
    // Seed initial cracks before any beat
    for (let i = 0; i < 4; i++) {
      const cx = W * (0.2 + Math.random() * 0.6);
      const cy = H * (0.2 + Math.random() * 0.6);
      spawnCrackCluster(cx, cy, W, 4, 0);
    }
  }

  const { amps: bands } = getBandAverages(BAND_COUNT);
  const totalAmp = bands.reduce((s, v) => s + v, 0) / BAND_COUNT;

  const cfg         = store.config;
  const fracture    = cfg.kintsugiCracks ?? 0.5;
  const glowMode    = cfg.kintsugiGlow   ?? 0.4;
  const decayRate   = cfg.kintsugiDecay  ?? 0.5;

  // Beat detection
  const { beatIntervalSec, beatOffset } = store.state;
  if (beatIntervalSec > 0) {
    const pos       = audioEngine.getPlaybackPosition();
    const beatIndex = Math.floor((pos - beatOffset) / beatIntervalSec);
    if (beatIndex !== lastBeatIndex && lastBeatIndex >= 0) {
      // New impact site driven by dominant band position
      const domBand = bands.indexOf(Math.max(...bands));
      const cx = (domBand / (BAND_COUNT - 1)) * W * 0.8 + W * 0.1;
      const cy = H * (0.15 + Math.random() * 0.7);
      const numArms = Math.round(4 + fracture * 5);
      spawnCrackCluster(cx, cy, W, numArms, 0);
    }
    lastBeatIndex = beatIndex;
  }

  // Advance crack tips
  const crackSpeed = 1.5 + totalAmp * 4.0;
  const branchProb = 0.005 + fracture * 0.025;
  const maxDepth   = 1 + Math.round(fracture * 3);

  const nextTips: CrackTip[] = [];
  for (const tip of tips) {
    const speed = tip.speed * crackSpeed * dt * 0.06;
    const nx    = tip.x + Math.cos(tip.angle) * speed;
    const ny    = tip.y + Math.sin(tip.angle) * speed;

    if (nx < 0 || nx > W || ny < 0 || ny > H) continue;
    if (tip.stepsLeft <= 0) continue;

    const seg: CrackSegment = {
      x1: tip.x, y1: tip.y,
      x2: nx,    y2: ny,
      band:  bandFromX(nx / W),
      age:   1.0,
      width: Math.max(0.4, 2.2 - tip.depth * 0.45),
    };
    if (segments.length < MAX_SEGMENTS) {
      segments.push(seg);
    }

    // Slight direction wobble
    const wobble = (Math.random() - 0.5) * 0.18;

    // Branching
    if (Math.random() < branchProb * dt && tip.depth < maxDepth && tips.length < MAX_TIPS) {
      const branchAngle = tip.angle + (Math.random() - 0.5) * Math.PI * 0.85;
      nextTips.push({
        x: nx, y: ny,
        angle: branchAngle,
        depth: tip.depth + 1,
        band: bandFromX(nx / W),
        speed: tip.speed * 0.75,
        stepsLeft: Math.round(tip.stepsLeft * 0.55),
      });
    }

    nextTips.push({
      ...tip,
      x: nx, y: ny,
      angle: tip.angle + wobble,
      stepsLeft: tip.stepsLeft - 1,
    });
  }
  tips = nextTips;

  // Background — dark ceramic warm-black
  p.background(22, 17, 13);

  const ctx = (p as any).drawingContext as CanvasRenderingContext2D;
  ctx.save();
  ctx.lineCap = 'round';

  // Age out and draw segments
  const ageFade = (0.002 + (1 - decayRate) * 0.018) * dt;
  const surviving: CrackSegment[] = [];

  for (const seg of segments) {
    seg.age -= ageFade;
    if (seg.age <= 0) continue;
    surviving.push(seg);

    const bandAmp = bands[seg.band];
    const glow    = seg.age * (0.25 + bandAmp * 0.75);
    if (glow < 0.015) continue;

    const goldH = GOLD_HUES[seg.band];
    const goldS = GOLD_SATS[seg.band];
    const irisH = IRIS_HUES[seg.band];
    const hue   = goldH + (irisH - goldH) * glowMode;
    const sat   = goldS + (90 - goldS) * glowMode;
    const w     = seg.width;

    // Outer halo
    ctx.beginPath();
    ctx.moveTo(seg.x1, seg.y1);
    ctx.lineTo(seg.x2, seg.y2);
    ctx.lineWidth   = w * 7;
    ctx.strokeStyle = `hsla(${hue.toFixed(0)},${sat.toFixed(0)}%,55%,${(glow * 0.12).toFixed(3)})`;
    ctx.stroke();

    // Mid glow
    ctx.beginPath();
    ctx.moveTo(seg.x1, seg.y1);
    ctx.lineTo(seg.x2, seg.y2);
    ctx.lineWidth   = w * 2.5;
    ctx.strokeStyle = `hsla(${hue.toFixed(0)},${sat.toFixed(0)}%,72%,${(glow * 0.38).toFixed(3)})`;
    ctx.stroke();

    // Bright core
    ctx.beginPath();
    ctx.moveTo(seg.x1, seg.y1);
    ctx.lineTo(seg.x2, seg.y2);
    ctx.lineWidth   = w * 0.7;
    ctx.strokeStyle = `hsla(${hue.toFixed(0)},${(sat * 0.55).toFixed(0)}%,94%,${(glow * 0.92).toFixed(3)})`;
    ctx.stroke();
  }

  segments = surviving;
  ctx.restore();

  // Amplitude-driven spontaneous micro-cracks (always a little activity)
  if (totalAmp > 0.3 && Math.random() < totalAmp * fracture * 0.04 * dt && tips.length < MAX_TIPS / 2) {
    const cx = W * (0.05 + Math.random() * 0.9);
    const cy = H * (0.05 + Math.random() * 0.9);
    spawnCrackCluster(cx, cy, W, 2, 1);
  }
}
