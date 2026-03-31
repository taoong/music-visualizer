/**
 * Magnetic Field Lines visualization — electromagnetic field line simulation
 *
 * 7 charge sources arranged in a ring, each driven by a frequency band.
 * Field lines are traced using Coulomb's law / superposition, creating
 * patterns like iron filings around magnets in a science museum exhibit.
 * Beats flip polarities causing dramatic field reconfiguration.
 */
import { store } from '../state/store';
import { getBandAverages } from './helpers';
import { BAND_COUNT, isMobile } from '../utils/constants';

// ── Types ───────────────────────────────────────────────────────────────────

interface Charge {
  x: number;
  y: number;
  strength: number;   // current amplitude-driven magnitude
  polarity: number;    // +1 or -1, flips on transients
  hue: number;         // HSB hue for this source
  baseAngle: number;   // position angle on ring
}

interface FieldLine {
  points: { x: number; y: number }[];
  hue: number;
  startPolarity: number; // +1 if starting from positive charge
  brightness: number;
}

// ── Constants ───────────────────────────────────────────────────────────────

const CHARGE_HUES = [280, 220, 180, 120, 60, 30, 350]; // purple→blue→cyan→green→yellow→orange→red
const STEP_SIZE = 3;
const MIN_STRENGTH = 0.05;
const BG_COLOR = '#08080f';

// ── Module state ────────────────────────────────────────────────────────────

let charges: Charge[] = [];
let fieldLines: FieldLine[] = [];
let initialized = false;
let canvasW = 0;
let canvasH = 0;
let lastBeatIndex = -1;
let flashAlpha = 0;
let pulseScale = 0; // beat pulse: 0–1, decays
let noiseOffset = 0;

// ── Public API ──────────────────────────────────────────────────────────────

export function drawFieldLines(p: P5Instance, dt: number): void {
  if (!initialized || canvasW !== p.width || canvasH !== p.height) {
    canvasW = p.width;
    canvasH = p.height;
    initCharges();
    initialized = true;
  }

  const density = store.config.fieldDensity;       // 0–1
  const reach = store.config.fieldReach;             // 0–1

  // Read audio
  const { amps, transients } = getBandAverages(BAND_COUNT);

  // Update charges from audio
  updateCharges(amps, transients);

  // Beat detection
  detectBeat(dt);

  // Trace field lines
  const linesPerCharge = Math.floor(4 + density * (isMobile ? 12 : 24)); // 4–28 lines per charge
  const maxSteps = Math.floor(40 + reach * (isMobile ? 160 : 360));       // 40–400 steps
  traceFieldLines(linesPerCharge, maxSteps);

  // Render
  p.background(BG_COLOR);
  (p as any).colorMode(p['HSB'], 360, 100, 100, 255);

  // Beat flash
  if (flashAlpha > 0) {
    p.noStroke();
    p.fill(0, 0, 100, flashAlpha);
    p.rect(0, 0, canvasW, canvasH);
    flashAlpha = Math.max(0, flashAlpha - 6 * dt);
  }

  // Draw field lines
  renderFieldLines(p);

  // Draw charge sources
  renderCharges(p, amps);

  // Decay pulse
  pulseScale *= Math.pow(0.88, dt);
  if (pulseScale < 0.01) pulseScale = 0;

  noiseOffset += 0.005 * dt;

  (p as any).colorMode(p['RGB'], 255, 255, 255, 255);
}

export function resetFieldLines(): void {
  charges = [];
  fieldLines = [];
  initialized = false;
  lastBeatIndex = -1;
  flashAlpha = 0;
  pulseScale = 0;
  noiseOffset = 0;
}

// ── Initialization ─────────────────────────────────────────────────────────

function initCharges(): void {
  charges = [];
  const cx = canvasW / 2;
  const cy = canvasH / 2;
  const radius = Math.min(canvasW, canvasH) * 0.25;

  for (let i = 0; i < 7; i++) {
    const angle = (i / 7) * Math.PI * 2 - Math.PI / 2;
    charges.push({
      x: cx + Math.cos(angle) * radius,
      y: cy + Math.sin(angle) * radius,
      strength: 0,
      polarity: i % 2 === 0 ? 1 : -1,
      hue: CHARGE_HUES[i],
      baseAngle: angle,
    });
  }
}

// ── Audio Mapping ──────────────────────────────────────────────────────────

function updateCharges(amps: number[], transients: number[]): void {
  const cx = canvasW / 2;
  const cy = canvasH / 2;
  const baseRadius = Math.min(canvasW, canvasH) * 0.25;
  const pulseRadius = baseRadius * (1 + pulseScale * 0.3);

  for (let i = 0; i < Math.min(charges.length, 7); i++) {
    const charge = charges[i];

    // Update strength from amplitude
    charge.strength = Math.max(MIN_STRENGTH, amps[i] * 1.5);

    // Flip polarity on strong transients
    if (transients[i] > 1.8) {
      charge.polarity *= -1;
    }

    // Wobble position slightly with audio
    const wobble = amps[i] * 15;
    const angle = charge.baseAngle + Math.sin(noiseOffset + i * 2) * 0.1;
    charge.x = cx + Math.cos(angle) * (pulseRadius + wobble);
    charge.y = cy + Math.sin(angle) * (pulseRadius + wobble);
  }
}

function detectBeat(_dt: number): void {
  const { state } = store;
  if (state.beatIntervalSec <= 0) return;

  const playbackPos = state.isPlaying
    ? (performance.now() / 1000 - state.playStartedAt / 1000 + state.startOffset)
    : state.startOffset;
  const beatIndex = Math.floor((playbackPos - state.beatOffset) / state.beatIntervalSec);

  if (beatIndex > lastBeatIndex && lastBeatIndex >= 0) {
    pulseScale = 1.0;
    flashAlpha = 25;
  }
  lastBeatIndex = beatIndex;
}

// ── Field Line Tracing ─────────────────────────────────────────────────────

function traceFieldLines(linesPerCharge: number, maxSteps: number): void {
  fieldLines = [];

  for (const charge of charges) {
    if (charge.strength < MIN_STRENGTH) continue;

    // Only trace from positive charges (lines go + to -)
    // But also trace from negative charges going "backwards" for visual density
    for (let dir = 0; dir < 2; dir++) {
      const traceDir = dir === 0 ? 1 : -1;
      if (dir === 0 && charge.polarity < 0) continue; // only trace outward from positive
      if (dir === 1 && charge.polarity > 0) continue; // only trace "inward" from negative

      for (let l = 0; l < linesPerCharge; l++) {
        const startAngle = (l / linesPerCharge) * Math.PI * 2 + noiseOffset * 0.5;
        const startDist = 8;
        const sx = charge.x + Math.cos(startAngle) * startDist;
        const sy = charge.y + Math.sin(startAngle) * startDist;

        const line = traceSingleLine(sx, sy, traceDir, maxSteps);
        if (line.length > 3) {
          fieldLines.push({
            points: line,
            hue: charge.hue,
            startPolarity: charge.polarity * traceDir,
            brightness: Math.min(100, charge.strength * 100),
          });
        }
      }
    }
  }
}

function traceSingleLine(
  startX: number, startY: number,
  direction: number, maxSteps: number
): { x: number; y: number }[] {
  const points: { x: number; y: number }[] = [];
  let x = startX;
  let y = startY;

  for (let step = 0; step < maxSteps; step++) {
    points.push({ x, y });

    // Compute electric field at this point via superposition
    let ex = 0;
    let ey = 0;
    let tooClose = false;

    for (const charge of charges) {
      if (charge.strength < MIN_STRENGTH) continue;
      const dx = x - charge.x;
      const dy = y - charge.y;
      const distSq = dx * dx + dy * dy;
      const dist = Math.sqrt(distSq);

      // Stop if we reach another charge (field line terminated)
      if (dist < 10 && step > 5) {
        tooClose = true;
        break;
      }

      // Coulomb: E = kq/r^2 in direction away from charge
      const magnitude = charge.strength * charge.polarity / Math.max(distSq, 100);
      ex += magnitude * (dx / dist);
      ey += magnitude * (dy / dist);
    }

    if (tooClose) break;

    // Normalize and step
    const emag = Math.sqrt(ex * ex + ey * ey);
    if (emag < 0.00001) break;

    x += (ex / emag) * STEP_SIZE * direction;
    y += (ey / emag) * STEP_SIZE * direction;

    // Stop if out of bounds (with margin)
    const margin = -50;
    if (x < margin || x > canvasW - margin || y < margin || y > canvasH - margin) break;
  }

  return points;
}

// ── Rendering ──────────────────────────────────────────────────────────────

function renderFieldLines(p: P5Instance): void {
  p.noFill();

  for (const line of fieldLines) {
    const pts = line.points;
    if (pts.length < 2) continue;

    const baseBrightness = 30 + line.brightness * 0.6;

    // Glow pass (wider, dimmer)
    for (let pass = 0; pass < 2; pass++) {
      const isGlow = pass === 0;
      const weight = isGlow ? 3.0 : 1.0;
      const alphaMult = isGlow ? 0.15 : 0.6;

      p.strokeWeight(weight);
      p.beginShape();
      (p as any).noFill();

      for (let i = 0; i < pts.length; i++) {
        const frac = i / pts.length;
        // Fade at start and end
        const edgeFade = Math.min(frac * 5, (1 - frac) * 5, 1.0);
        const alpha = edgeFade * alphaMult * 255;
        const sat = isGlow ? 40 : 70;
        const bright = isGlow ? baseBrightness * 0.5 : baseBrightness;

        (p as any).stroke(line.hue, sat, bright, alpha);
        (p as any).vertex(pts[i].x, pts[i].y);
      }
      p.endShape();
    }
  }
}

function renderCharges(p: P5Instance, amps: number[]): void {
  for (let i = 0; i < charges.length; i++) {
    const charge = charges[i];
    if (charge.strength < MIN_STRENGTH) continue;

    const amp = amps[i] || 0;
    const size = 6 + amp * 20 + pulseScale * 8;
    const glowSize = size * 3;

    // Outer glow
    p.noStroke();
    const glowAlpha = 30 + amp * 40;
    (p as any).fill(charge.hue, 50, 80, glowAlpha);
    p.ellipse(charge.x, charge.y, glowSize, glowSize);

    // Core
    const coreBright = charge.polarity > 0 ? 100 : 60;
    (p as any).fill(charge.hue, 30, coreBright, 200);
    p.ellipse(charge.x, charge.y, size, size);

    // Polarity indicator: + or -
    (p as any).fill(0, 0, 100, 180);
    p.textAlign(p['CENTER'], p['CENTER']);
    p.textSize(Math.max(10, size * 0.5));
    p.text(charge.polarity > 0 ? '+' : '−', charge.x, charge.y - 1);
  }
}
