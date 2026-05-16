/**
 * Truchet Tile Maze — audio-reactive quarter-circle arc grid.
 *
 * Inspired by Manolo Gamboa Naon (Manoloide) — "88 Allegories" series
 * (https://www.katevassgalerie.com/manolo-gamboa-naon), where dense
 * accumulations of basic geometric strokes produce rich, textile-like
 * visual complexity from simple rules. Each cell holds a Truchet tile
 * (two quarter-circle arcs) that can sit in one of two orientations;
 * their collective arrangement generates emergent maze-like flow paths.
 *
 * Seven frequency bands map to seven hue zones (column bands) across the
 * canvas. Each tile's rotation speed is driven by its column's band
 * amplitude. Beats trigger a mass orientation shuffle and hue palette
 * jump; brilliance drives continuous sparkle perturbations.
 *
 * Sliders: Grid (tile density), Speed (morph rate), Glow (arc weight)
 */
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { BAND_COUNT, isMobile } from '../utils/constants';

// Hues per band: sub=violet, bass=cyan, lowMid=teal-green, mid=lime,
//               upperMid=gold, presence=orange-red, brilliance=magenta
const BAND_HUES = [290, 210, 165, 100, 48, 22, 340];

const MIN_TILE = isMobile ? 36 : 24;
const MAX_TILE = 110;

let tileAngle: Float32Array | null = null;
let tileTarget: Float32Array | null = null;
let cols = 0;
let rows = 0;
let tileCount = 0;
let lastTileSize = -1;
let huePalette = 0;
let lastBeatIndex = -1;

export function resetTruchet(): void {
  tileAngle = null;
  tileTarget = null;
  cols = 0;
  rows = 0;
  tileCount = 0;
  lastTileSize = -1;
  huePalette = 0;
  lastBeatIndex = -1;
}

export function drawTruchet(p: P5Instance, dt: number): void {
  const { state, config } = store;
  const { amps } = getBandAverages(BAND_COUNT);

  const gridParam = config.truchetGrid;    // 0–1: tile density (0=large, 1=small)
  const speedParam = config.truchetSpeed;  // 0–2: morph rate
  const glowParam = config.truchetGlow;    // 0.2–3: glow weight

  const tileSize = Math.round(MIN_TILE + gridParam * (MAX_TILE - MIN_TILE));
  const r = tileSize / 2;

  // Init / resize tile grid when size changes
  const newCols = Math.ceil(p.width / tileSize) + 1;
  const newRows = Math.ceil(p.height / tileSize) + 1;
  const newCount = newCols * newRows;

  if (newCount !== tileCount || lastTileSize !== tileSize) {
    cols = newCols;
    rows = newRows;
    tileCount = newCount;
    lastTileSize = tileSize;
    tileAngle = new Float32Array(tileCount);
    tileTarget = new Float32Array(tileCount);
    for (let i = 0; i < tileCount; i++) {
      tileAngle[i] = Math.random() < 0.5 ? 0 : Math.PI / 2;
      tileTarget[i] = tileAngle[i];
    }
  }

  // Beat detection
  let onBeat = false;
  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    const beatIndex = adjusted >= 0 ? Math.floor(adjusted / state.beatIntervalSec) : -1;
    if (beatIndex >= 0 && beatIndex !== lastBeatIndex) {
      lastBeatIndex = beatIndex;
      onBeat = true;
    }
  }

  const sub = amps[0];
  const bass = amps[1];
  const brilliance = amps[6];
  const presence = amps[5];

  // Beat → shuffle tile targets + shift global hue palette
  if (onBeat) {
    huePalette = (huePalette + 22 + Math.random() * 38) % 360;
    const flipProb = 0.25 + sub * 0.55;
    for (let i = 0; i < tileCount; i++) {
      if (Math.random() < flipProb) {
        tileTarget![i] = tileAngle![i] < Math.PI / 4 ? Math.PI / 2 : 0;
      }
    }
  }

  // Brilliance + presence → continuous sparkle perturbations
  if (brilliance + presence > 0.45) {
    const perturbCount = Math.floor((brilliance + presence) * 14 * dt);
    for (let i = 0; i < perturbCount; i++) {
      const idx = Math.floor(Math.random() * tileCount);
      tileTarget![idx] = Math.random() < 0.5 ? 0 : Math.PI / 2;
    }
  }

  // Update tile angles toward targets; each column's band drives morph speed
  const baseSpeed = speedParam * 0.06 * dt;
  for (let idx = 0; idx < tileCount; idx++) {
    const col = idx % cols;
    const bandIdx = Math.min(BAND_COUNT - 1, Math.floor((col / cols) * BAND_COUNT));
    const amp = amps[bandIdx];
    const speed = Math.min(1, baseSpeed * (0.4 + amp * 3.0));
    tileAngle![idx] += (tileTarget![idx] - tileAngle![idx]) * speed;
  }

  // Draw
  p.background(0);
  (p as any).colorMode(p['HSB'], 360, 100, 100, 100);
  p.noFill();

  // Sub-bass + bass boost global stroke weight
  const weightBoost = 1 + sub * 0.6 + bass * 0.25;

  for (let idx = 0; idx < tileCount; idx++) {
    const col = idx % cols;
    const row = Math.floor(idx / cols);

    const cx = col * tileSize + r;
    const cy = row * tileSize + r;

    const bandIdx = Math.min(BAND_COUNT - 1, Math.floor((col / cols) * BAND_COUNT));
    const amp = Math.min(1, amps[bandIdx]);

    const hue = (BAND_HUES[bandIdx] + huePalette) % 360;
    const sat = 55 + amp * 45;
    const bri = 28 + amp * 72;

    const angle = tileAngle![idx];

    p.push();
    p.translate(cx, cy);
    p.rotate(angle);

    // Outer glow: wide, low alpha
    p.strokeWeight(r * 0.32 * glowParam * weightBoost);
    p.stroke(hue, sat * 0.55, bri * 0.7, 12 + amp * 12);
    (p as any).arc(-r, -r, tileSize, tileSize, 0, Math.PI / 2, 'open');
    (p as any).arc(r, r, tileSize, tileSize, Math.PI, Math.PI * 1.5, 'open');

    // Core: thin, bright
    p.strokeWeight(r * 0.07 * glowParam * weightBoost);
    p.stroke(hue, sat, Math.min(100, bri * 1.25), 72 + amp * 28);
    (p as any).arc(-r, -r, tileSize, tileSize, 0, Math.PI / 2, 'open');
    (p as any).arc(r, r, tileSize, tileSize, Math.PI, Math.PI * 1.5, 'open');

    p.pop();
  }

  (p as any).colorMode(p['RGB'], 255, 255, 255, 255);
}
