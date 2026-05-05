/**
 * Stained Glass — Binary Space Partitioned polygon panels.
 *
 * The canvas is recursively split into irregular convex polygons, each mapped
 * to one of 7 frequency bands. Each panel pulses with its band's amplitude in
 * HSB colour; glowing white edges simulate lead lines. Beat triggers a bright
 * flash across all panels. Hue drifts slowly for ambient life.
 *
 * Sliders: Shards (8–64), Edge Glow (0–5), Color Drift (0–3)
 */
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { BAND_COUNT } from '../utils/constants';

const BAND_HUES = [0, 35, 65, 140, 195, 240, 280];

type Vec2 = { x: number; y: number };

interface Shard {
  verts: Vec2[];
  band: number;
  phase: number; // per-shard hue jitter (degrees)
}

let shards: Shard[] = [];
let lastBeatIndex = -1;
let beatFlash = 0;
let hueShift = 0;
let lastShardCount = -1;
let lastWidth = 0;
let lastHeight = 0;

export function resetStainedGlass(): void {
  lastBeatIndex = -1;
  beatFlash = 0;
  hueShift = 0;
  lastShardCount = -1;
  lastWidth = 0;
  lastHeight = 0;
  shards = [];
}

function polyArea(verts: Vec2[]): number {
  let area = 0;
  const n = verts.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    area += verts[i].x * verts[j].y - verts[j].x * verts[i].y;
  }
  return Math.abs(area) * 0.5;
}

function polyCentroid(verts: Vec2[]): Vec2 {
  let cx = 0, cy = 0;
  for (const v of verts) { cx += v.x; cy += v.y; }
  return { x: cx / verts.length, y: cy / verts.length };
}

// Split convex polygon into two convex halves by connecting a point on edge
// e1 to a point on non-adjacent edge e2.
function splitPoly(poly: Vec2[]): [Vec2[], Vec2[]] | null {
  const n = poly.length;
  if (n < 4) return null;
  const maxSpan = n - 2;
  if (maxSpan < 2) return null;

  const e1 = Math.floor(Math.random() * n);
  const span = 2 + Math.floor(Math.random() * (maxSpan - 1));
  const e2 = (e1 + span) % n;

  const t1 = 0.2 + Math.random() * 0.6;
  const t2 = 0.2 + Math.random() * 0.6;

  const a1 = poly[e1], b1 = poly[(e1 + 1) % n];
  const a2 = poly[e2], b2 = poly[(e2 + 1) % n];

  const p1: Vec2 = { x: a1.x + t1 * (b1.x - a1.x), y: a1.y + t1 * (b1.y - a1.y) };
  const p2: Vec2 = { x: a2.x + t2 * (b2.x - a2.x), y: a2.y + t2 * (b2.y - a2.y) };

  // half1: p1 → verts[e1+1..e2] → p2
  const half1: Vec2[] = [p1];
  for (let k = (e1 + 1) % n; ; k = (k + 1) % n) {
    half1.push({ ...poly[k] });
    if (k === e2) break;
  }
  half1.push(p2);

  // half2: p2 → verts[e2+1..e1] → p1
  const half2: Vec2[] = [p2];
  for (let k = (e2 + 1) % n; ; k = (k + 1) % n) {
    half2.push({ ...poly[k] });
    if (k === e1) break;
  }
  half2.push(p1);

  return [half1, half2];
}

function generateShards(count: number, w: number, h: number): Shard[] {
  const polys: Vec2[][] = [[
    { x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h },
  ]];

  for (let i = 0; i < count - 1; i++) {
    // Always split the largest remaining polygon for balanced coverage
    let bestIdx = 0, bestArea = 0;
    for (let j = 0; j < polys.length; j++) {
      const a = polyArea(polys[j]);
      if (a > bestArea) { bestArea = a; bestIdx = j; }
    }
    const result = splitPoly(polys[bestIdx]);
    if (result) polys.splice(bestIdx, 1, result[0], result[1]);
  }

  return polys.map(verts => {
    const c = polyCentroid(verts);
    // Assign band by angle from canvas centre so spectrum fans around the screen
    const angle = Math.atan2(c.y - h * 0.5, c.x - w * 0.5);
    const normalized = (angle + Math.PI) / (2 * Math.PI); // 0–1
    const band = Math.floor(normalized * BAND_COUNT) % BAND_COUNT;
    return { verts, band, phase: (Math.random() - 0.5) * 50 };
  });
}

function drawEdges(p: P5Instance): void {
  for (const shard of shards) {
    const n = shard.verts.length;
    for (let i = 0; i < n; i++) {
      const a = shard.verts[i];
      const b = shard.verts[(i + 1) % n];
      p.line(a.x, a.y, b.x, b.y);
    }
  }
}

export function drawStainedGlass(p: P5Instance, dt: number): void {
  const { state, config } = store;
  const { amps } = getBandAverages(BAND_COUNT);

  const targetCount = Math.round(config.stainedglassShards);

  // Regenerate on slider change or canvas resize
  if (targetCount !== lastShardCount || p.width !== lastWidth || p.height !== lastHeight) {
    shards = generateShards(targetCount, p.width, p.height);
    lastShardCount = targetCount;
    lastWidth = p.width;
    lastHeight = p.height;
  }

  // Beat detection
  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    const idx = adjusted >= 0 ? Math.floor(adjusted / state.beatIntervalSec) : -1;
    if (idx >= 0 && idx !== lastBeatIndex) {
      lastBeatIndex = idx;
      beatFlash = 1.0;
    }
  }
  beatFlash *= Math.pow(0.87, dt);

  hueShift += config.stainedglassDrift * dt * 0.15;
  if (hueShift > 360) hueShift -= 360;

  (p as any).colorMode(p['HSB'], 360, 100, 100, 100);
  p.noStroke();

  // Fill each polygon with band-driven colour
  for (const shard of shards) {
    const amp = amps[shard.band];
    const hue = ((BAND_HUES[shard.band] + hueShift + shard.phase) % 360 + 360) % 360;
    const sat = 58 + amp * 40;
    const bri = Math.min(100, 12 + amp * 82 + beatFlash * 20);

    p.fill(hue, sat, bri);
    p.beginShape();
    for (const v of shard.verts) p.vertex(v.x, v.y);
    p.endShape(p['CLOSE']);
  }

  // Glowing lead-line edges
  const glowFactor = config.stainedglassGlow;
  if (glowFactor > 0.01) {
    const avgAmp = amps.reduce((a, b) => a + b, 0) / amps.length;
    p.noFill();
    p.blendMode(p['ADD']);

    // Soft halo
    p.stroke(0, 0, 45 + avgAmp * 25 + beatFlash * 15, 18);
    p.strokeWeight(glowFactor * 5);
    drawEdges(p);

    // Bright core
    p.stroke(0, 0, 100, 65 + avgAmp * 30);
    p.strokeWeight(Math.max(0.4, glowFactor * 0.8));
    drawEdges(p);

    p.blendMode(p['BLEND']);
  }

  // Beat flash overlay
  if (beatFlash > 0.03) {
    p.noStroke();
    p.fill(0, 0, 100, beatFlash * 10);
    p.rect(0, 0, p.width, p.height);
  }

  (p as any).colorMode(p['RGB'], 255, 255, 255, 255);
}
