/**
 * Boogie — audio-reactive Broadway Boogie-Woogie city-grid painting.
 *
 * Inspired by Piet Mondrian "Broadway Boogie-Woogie" (1942–43, MoMA,
 * https://www.moma.org/collection/works/78682). Mondrian moved to New York
 * in 1940 and fell in love with boogie-woogie jazz; the painting translates
 * Manhattan's street grid and the syncopated rhythm of the music into an
 * interlocking system of yellow avenues studded with tiny coloured blips.
 * Coloured rectangular blocks inhabit the white cells between streets;
 * small squares race along the yellow avenues; beats burst fresh traffic
 * from the canvas centre; 7 frequency bands each own a column of the grid
 * (sub-bass on the left → brilliance on the right), driving intersection
 * brightness and dot density.
 *
 * Sliders: Grid (street count 4–16), Speed (dot velocity), Vivid (colour intensity)
 */

import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { BAND_COUNT, isMobile } from '../utils/constants';

// Per-band colour palette — red → orange → yellow → green → blue → violet → cyan
const CR = [220, 255, 235, 30,  30,  150, 0  ];
const CG = [40,  130, 200, 170, 70,  30,  190];
const CB = [40,  0,   0,   80,  210, 200, 210];

// Street colour: Mondrian yellow
const SY_R = 255, SY_G = 215, SY_B = 0;

// Background: warm cream
const BG_R = 252, BG_G = 248, BG_B = 220;

const MAX_DOTS   = isMobile ? 120 : 400;
const MAX_BLOCKS = isMobile ? 8  : 20;

interface Dot {
  horiz: boolean;
  lane:  number;   // row index (horiz) or column index (!horiz), 0..gridN inclusive
  pos:   number;   // 0..1 along the lane
  speed: number;   // per-dot speed factor
  dir:   1 | -1;
  band:  number;
}

interface ColorBlock {
  col:  number;  // cell column 0..gridN-1
  row:  number;  // cell row    0..gridN-1
  band: number;
  life: number;  // 1 → 0, decays each frame
}

// Module state
let dots:       Dot[]        = [];
let colorBlocks: ColorBlock[] = [];
let lastBeat = -1;
let beatFlash = 0;

export function resetBoogie(): void {
  dots        = [];
  colorBlocks = [];
  lastBeat    = -1;
  beatFlash   = 0;
}

function spawnDot(gridN: number): void {
  if (dots.length >= MAX_DOTS) return;
  const horiz = Math.random() < 0.5;
  dots.push({
    horiz,
    lane:  Math.floor(Math.random() * (gridN + 1)),
    pos:   Math.random(),
    speed: 0.3 + Math.random() * 0.7,
    dir:   Math.random() < 0.5 ? 1 : -1,
    band:  Math.floor(Math.random() * BAND_COUNT),
  });
}

function spawnBlock(gridN: number, bandHint?: number): void {
  if (colorBlocks.length >= MAX_BLOCKS) return;
  colorBlocks.push({
    col:  Math.floor(Math.random() * gridN),
    row:  Math.floor(Math.random() * gridN),
    band: bandHint !== undefined ? bandHint : Math.floor(Math.random() * BAND_COUNT),
    life: 1.0,
  });
}

export function drawBoogie(p: P5Instance, dt: number): void {
  const { state, config } = store;
  const { amps } = getBandAverages(BAND_COUNT);

  const gridN = Math.max(4, Math.min(16, Math.round(config.boogieGrid)));
  const speed = config.boogieSpeed;   // 0..1
  const vivid = config.boogieVivid;   // 0..1

  const W = p.width;
  const H = p.height;
  const csW = W / gridN;             // cell width
  const csH = H / gridN;             // cell height
  const sw  = Math.max(5, Math.min(csW, csH) * 0.28);  // street width

  // ── Beat detection ──────────────────────────────────────────────────────
  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adj = pos - state.beatOffset;
    const bi  = adj >= 0 ? Math.floor(adj / state.beatIntervalSec) : -1;
    if (bi >= 0 && bi !== lastBeat) {
      lastBeat  = bi;
      beatFlash = 1.0;
      // Find the loudest band and spawn blocks in its colour
      let loud = 0;
      for (let k = 1; k < BAND_COUNT; k++) if (amps[k] > amps[loud]) loud = k;
      const nb = 1 + Math.floor(vivid * 4);
      for (let i = 0; i < nb; i++) spawnBlock(gridN, i === 0 ? loud : undefined);
      // Burst-spawn dots
      const burst = isMobile ? 10 : 28;
      for (let i = 0; i < burst; i++) spawnDot(gridN);
    }
  }

  // ── Maintain dot pool proportional to overall amplitude ─────────────────
  const avgAmp = amps.reduce((s, a) => s + a, 0) / BAND_COUNT;
  const target = Math.floor(MAX_DOTS * (0.22 + avgAmp * 0.78));
  while (dots.length < target) spawnDot(gridN);
  if (dots.length > target + 15) dots.splice(0, dots.length - target);

  // ── Background ───────────────────────────────────────────────────────────
  p.background(BG_R, BG_G, BG_B);
  p.noStroke();
  p.rectMode(p['CORNER']);

  // ── Coloured cell blocks (appear in white areas on beats, fade out) ──────
  for (let i = colorBlocks.length - 1; i >= 0; i--) {
    const b = colorBlocks[i];
    b.life -= 0.012 * dt;
    if (b.life <= 0) { colorBlocks.splice(i, 1); continue; }
    const bx = b.col * csW + sw;
    const by = b.row * csH + sw;
    const bw = csW - sw * 2;
    const bh = csH - sw * 2;
    if (bw < 2 || bh < 2) continue;
    p.fill(CR[b.band], CG[b.band], CB[b.band], b.life * 210);
    p.rect(bx, by, bw, bh);
  }

  // ── Yellow streets ───────────────────────────────────────────────────────
  p.fill(SY_R, SY_G, SY_B);
  for (let r = 0; r <= gridN; r++) {
    p.rect(0, r * csH - sw * 0.5, W, sw);
  }
  for (let c = 0; c <= gridN; c++) {
    p.rect(c * csW - sw * 0.5, 0, sw, H);
  }

  // ── Intersection accent squares (amplitude-driven, per-column band) ──────
  for (let c = 0; c <= gridN; c++) {
    const band = Math.min(BAND_COUNT - 1, Math.floor((c / (gridN)) * BAND_COUNT));
    const amp  = amps[band] * vivid;
    if (amp < 0.04) continue;
    const ix = c * csW - sw * 0.5;
    p.fill(CR[band], CG[band], CB[band], amp * 245);
    for (let r = 0; r <= gridN; r++) {
      p.rect(ix, r * csH - sw * 0.5, sw, sw);
    }
  }

  // ── Moving dots along streets ────────────────────────────────────────────
  p.rectMode(p['CENTER']);
  const dotSz  = sw * 0.68;
  const baseV  = (0.006 + speed * 0.012);   // 0.006..0.018 canvas-fraction per normalized frame

  for (const d of dots) {
    const ampFactor = 0.5 + amps[d.band] * 1.5;
    const v = d.speed * baseV * ampFactor * dt;
    d.pos += d.dir * v;
    if (d.pos > 1) d.pos -= 1;
    else if (d.pos < 0) d.pos += 1;

    const alpha = Math.min(255, (0.45 + amps[d.band] * 0.55) * 255);
    p.fill(CR[d.band], CG[d.band], CB[d.band], alpha);

    const px = d.horiz ? d.pos * W : d.lane * csW;
    const py = d.horiz ? d.lane * csH : d.pos * H;
    p.rect(px, py, dotSz, dotSz);
  }

  // ── Beat flash overlay ───────────────────────────────────────────────────
  if (beatFlash > 0) {
    p.rectMode(p['CORNER']);
    beatFlash = Math.max(0, beatFlash - 0.08 * dt);
    p.fill(255, 255, 255, beatFlash * 70);
    p.rect(0, 0, W, H);
  }

  // Restore default rect mode
  p.rectMode(p['CORNER']);
}
