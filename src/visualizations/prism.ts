/**
 * Prism visualization — Newton's light dispersion experiment
 *
 * A beam of white light enters a triangular glass prism and splits into
 * 7 rainbow rays (one per frequency band). Each ray's brightness/width
 * pulses with its band's amplitude. Beats widen the dispersion angle
 * and flash. Photon particles drift along each ray. Like the classic
 * optics exhibit at a science museum.
 */
import { store } from '../state/store';
import { getBandAverages } from './helpers';
import { BAND_COUNT, isMobile } from '../utils/constants';

// ── Types ───────────────────────────────────────────────────────────────────

interface Photon {
  x: number;
  y: number;
  vx: number;
  vy: number;
  band: number;
  hue: number;
  life: number;
  maxLife: number;
  size: number;
}

// ── Constants ───────────────────────────────────────────────────────────────

const MAX_PHOTONS = isMobile ? 80 : 160;
const BG_COLOR = '#04040a';
// ROYGBIV mapped to 7 bands (sub→brilliance)
const RAY_HUES = [0, 20, 45, 120, 200, 250, 280];    // red→orange→yellow→green→blue→indigo→violet
const RAY_SATS = [90, 95, 95, 90, 90, 85, 80];

// ── Module state ────────────────────────────────────────────────────────────

let photons: Photon[] = [];
let initialized = false;
let canvasW = 0;
let canvasH = 0;
let lastBeatIndex = -1;
let flashAlpha = 0;
let beatPulse = 0;       // 0–1, spikes on beat, widens dispersion briefly
let noiseTime = 0;

// Prism geometry (computed on init/resize)
let prismCx = 0;
let prismCy = 0;
let prismSize = 0;
// Triangle vertices
let prismA = { x: 0, y: 0 };  // top
let prismB = { x: 0, y: 0 };  // bottom-left
let prismC = { x: 0, y: 0 };  // bottom-right

// ── Public API ──────────────────────────────────────────────────────────────

export function drawPrism(p: P5Instance, dt: number): void {
  if (!initialized || canvasW !== p.width || canvasH !== p.height) {
    canvasW = p.width;
    canvasH = p.height;
    computePrismGeometry();
    if (!initialized) {
      photons = [];
      lastBeatIndex = -1;
      flashAlpha = 0;
      beatPulse = 0;
      noiseTime = 0;
    }
    initialized = true;
  }

  const dispersion = store.config.prismDispersion;   // 0–1
  const beamWidth = store.config.prismBeamWidth;     // 0–1

  const { amps, transients } = getBandAverages(BAND_COUNT);

  // Beat detection
  detectBeat();

  // Decay beat pulse (~250ms)
  beatPulse *= Math.pow(0.82, dt);
  if (beatPulse < 0.01) beatPulse = 0;

  noiseTime += 0.01 * dt;

  // ── Render ────────────────────────────────────────────────────────────────

  p.background(BG_COLOR);

  (p as any).colorMode(p['HSB'], 360, 100, 100, 255);

  // Beat flash
  if (flashAlpha > 0) {
    p.noStroke();
    (p as any).fill(0, 0, 100, flashAlpha);
    p.rect(0, 0, canvasW, canvasH);
    flashAlpha = Math.max(0, flashAlpha - 5 * dt);
  }

  // Draw incoming white beam (left side → prism)
  drawIncomingBeam(p, amps, beamWidth);

  // Draw outgoing dispersed rays (prism → right side)
  drawOutgoingRays(p, amps, transients, dispersion, beamWidth, dt);

  // Draw the prism (glass triangle with subtle refraction look)
  drawPrismShape(p, amps);

  // Update & render photons
  updatePhotons(p, dt);

  (p as any).colorMode(p['RGB'], 255, 255, 255, 255);
}

export function resetPrism(): void {
  photons = [];
  initialized = false;
  lastBeatIndex = -1;
  flashAlpha = 0;
  beatPulse = 0;
  noiseTime = 0;
}

// ── Geometry ────────────────────────────────────────────────────────────────

function computePrismGeometry(): void {
  prismCx = canvasW * 0.42;
  prismCy = canvasH * 0.5;
  prismSize = Math.min(canvasW, canvasH) * 0.18;

  const h = prismSize * Math.sqrt(3) / 2;
  prismA = { x: prismCx, y: prismCy - h * 0.6 };
  prismB = { x: prismCx - prismSize * 0.5, y: prismCy + h * 0.4 };
  prismC = { x: prismCx + prismSize * 0.5, y: prismCy + h * 0.4 };
}

// ── Beat Detection ─────────────────────────────────────────────────────────

function detectBeat(): void {
  const { state } = store;
  if (state.beatIntervalSec <= 0) return;

  const playbackPos = state.isPlaying
    ? (performance.now() / 1000 - state.playStartedAt / 1000 + state.startOffset)
    : state.startOffset;
  const beatIndex = Math.floor((playbackPos - state.beatOffset) / state.beatIntervalSec);

  if (beatIndex > lastBeatIndex && lastBeatIndex >= 0) {
    beatPulse = 1.0;
    flashAlpha = 15;
  }
  lastBeatIndex = beatIndex;
}

// ── Incoming Beam ──────────────────────────────────────────────────────────

function drawIncomingBeam(p: P5Instance, amps: number[], beamWidth: number): void {
  const avgAmp = amps.reduce((s, v) => s + v, 0) / amps.length;
  const width = (3 + beamWidth * 12 + avgAmp * 8) * (1 + beatPulse * 0.3);

  // Entry point on the left face of the prism
  const entryX = prismCx - prismSize * 0.2;
  const entryY = prismCy;

  // Beam comes from left edge of screen
  const startX = 0;
  const startY = entryY;

  // Glow pass
  p.noFill();
  (p as any).stroke(0, 0, 100, 25 + avgAmp * 30);
  p.strokeWeight(width * 3);
  p.line(startX, startY, entryX, entryY);

  // Core white beam
  (p as any).stroke(0, 0, 100, 150 + avgAmp * 100);
  p.strokeWeight(width);
  p.line(startX, startY, entryX, entryY);
}

// ── Outgoing Rays ──────────────────────────────────────────────────────────

function drawOutgoingRays(
  p: P5Instance, amps: number[], transients: number[],
  dispersion: number, beamWidth: number, dt: number
): void {
  // Exit point on the right face of the prism
  const exitX = prismCx + prismSize * 0.25;
  const exitY = prismCy;

  // Total fan angle: dispersion slider + beat pulse widens it
  const totalAngle = (0.15 + dispersion * 0.7 + beatPulse * 0.25) * Math.PI;
  const startAngle = -totalAngle / 2;

  const rayLength = canvasW * 0.7;

  for (let b = 0; b < 7; b++) {
    const amp = amps[b];
    const transient = transients[b];
    const angle = startAngle + (b / 6) * totalAngle;

    const endX = exitX + Math.cos(angle) * rayLength;
    const endY = exitY + Math.sin(angle) * rayLength;

    const baseWidth = 2 + beamWidth * 8;
    const width = baseWidth * (0.3 + amp * 1.5) * (1 + (transient > 1.3 ? 0.5 : 0));
    const alpha = 40 + amp * 200;

    // Glow pass
    p.noFill();
    (p as any).stroke(RAY_HUES[b], RAY_SATS[b] * 0.5, 60, alpha * 0.2);
    p.strokeWeight(width * 4);
    p.line(exitX, exitY, endX, endY);

    // Core ray
    (p as any).stroke(RAY_HUES[b], RAY_SATS[b], 95, alpha);
    p.strokeWeight(width);
    p.line(exitX, exitY, endX, endY);

    // Bright tip where ray exits prism
    p.noStroke();
    const tipSize = width * 2 + amp * 6;
    (p as any).fill(RAY_HUES[b], RAY_SATS[b] * 0.4, 100, alpha * 0.6);
    p.ellipse(exitX, exitY, tipSize, tipSize);

    // Spawn photons along this ray
    if (amp > 0.1 && photons.length < MAX_PHOTONS) {
      const prob = amp * 0.6 * dt;
      if (Math.random() < prob) {
        const speed = 2 + amp * 3;
        photons.push({
          x: exitX + Math.cos(angle) * 10,
          y: exitY + Math.sin(angle) * 10,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed,
          band: b,
          hue: RAY_HUES[b],
          life: 60 + Math.random() * 80,
          maxLife: 60 + Math.random() * 80,
          size: 2 + amp * 3 + beamWidth * 2,
        });
      }
    }
  }
}

// ── Prism Shape ────────────────────────────────────────────────────────────

function drawPrismShape(p: P5Instance, amps: number[]): void {
  const avgAmp = amps.reduce((s, v) => s + v, 0) / amps.length;

  // Glass fill — subtle blue tint, semi-transparent
  p.noStroke();
  (p as any).fill(210, 20, 30 + avgAmp * 15, 80 + beatPulse * 40);
  p.triangle(prismA.x, prismA.y, prismB.x, prismB.y, prismC.x, prismC.y);

  // Edge highlight glow
  (p as any).stroke(210, 15, 60 + avgAmp * 30, 80 + beatPulse * 60);
  p.strokeWeight(2);
  p.noFill();
  p.triangle(prismA.x, prismA.y, prismB.x, prismB.y, prismC.x, prismC.y);

  // Inner refraction shimmer — subtle rainbow line inside
  const shimmerAlpha = 30 + avgAmp * 40 + beatPulse * 30;
  for (let i = 0; i < 7; i++) {
    const t = (i + 0.5) / 7;
    const y = prismA.y + (prismB.y - prismA.y) * (0.25 + t * 0.5);
    const xLeft = prismCx - prismSize * 0.15;
    const xRight = prismCx + prismSize * 0.15;
    (p as any).stroke(RAY_HUES[i], 60, 80, shimmerAlpha * amps[i]);
    p.strokeWeight(1);
    p.line(xLeft, y, xRight, y);
  }
}

// ── Photons ────────────────────────────────────────────────────────────────

function updatePhotons(p: P5Instance, dt: number): void {
  for (let i = photons.length - 1; i >= 0; i--) {
    const ph = photons[i];

    ph.x += ph.vx * dt;
    ph.y += ph.vy * dt;
    ph.life -= dt;

    if (ph.life <= 0 || ph.x > canvasW + 20 || ph.x < -20 ||
        ph.y > canvasH + 20 || ph.y < -20) {
      photons.splice(i, 1);
      continue;
    }

    const lifeFrac = Math.max(0, ph.life / ph.maxLife);

    // Glow
    p.noStroke();
    (p as any).fill(ph.hue, 40, 90, 30 * lifeFrac);
    p.ellipse(ph.x, ph.y, ph.size * 4, ph.size * 4);

    // Core
    (p as any).fill(ph.hue, 20, 100, 180 * lifeFrac);
    p.ellipse(ph.x, ph.y, ph.size, ph.size);
  }
}
