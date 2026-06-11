/**
 * Black Wave — a continuously flowing ukiyo-e ocean of layered ink waves.
 *
 * Inspired by teamLab's "Black Waves" series — a real-time generative ocean
 * simulation rendered as a single flowing body of dark line-strokes in an
 * "ultrasubjective" mirrored space — itself a digital descendant of
 * Hokusai's "The Great Wave off Kanagawa" (c. 1831).
 * https://www.teamlab.art/w/black_waves/
 *
 * Seven translucent wave silhouettes stack from back to front, one per
 * frequency band: brilliance forms small, fast ripples far away while
 * sub-bass forms one huge, slow swell dominating the foreground. Each
 * layer's height tracks its band's amplitude, and a beat-triggered "surge"
 * inflates the front wave. Dry-brush ink strokes drift along every crest,
 * brightening near the peak like foam catching light, and beats throw spray
 * off the front wave's crest. The sky uses a "bokashi" gradient wash, the
 * gradated hand-printing technique ukiyo-e artists used for skies and water.
 * The Hue slider sweeps the ink palette from monochrome sumi-e ink, through
 * Hokusai's signature Prussian-blue "ai-zuri", to the vermillion of his
 * "Red Fuji" ("South Wind, Clear Sky").
 *
 * Sliders
 *   Density — ink-stroke & foam-spray richness (0–1)
 *   Swell   — wave amplitude (0 = calm, 1 = towering)
 *   Hue     — palette: 0 = sumi-e monochrome, 0.5 = indigo "ai-zuri", 1 = vermillion "Red Fuji"
 */
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { BAND_COUNT, isMobile } from '../utils/constants';

const RES = isMobile ? 32 : 60;          // wave-curve sample resolution
const MAX_STROKES = isMobile ? 14 : 34;  // ink strokes per layer
const MAX_FOAM = isMobile ? 40 : 110;    // spray particle pool size

/** Converts HSB (0–360, 0–100, 0–100) + alpha (0–1) to CSS rgba string. */
function hsba(h: number, s: number, b: number, a: number): string {
  const sn = s / 100;
  const bn = b / 100;
  const c = bn * sn;
  const hh = ((h % 360) + 360) % 360;
  const x = c * (1 - Math.abs(((hh / 60) % 2) - 1));
  const m = bn - c;
  let r = 0, g = 0, bv = 0;
  if      (hh <  60) { r = c;  g = x;  bv = 0; }
  else if (hh < 120) { r = x;  g = c;  bv = 0; }
  else if (hh < 180) { r = 0;  g = c;  bv = x; }
  else if (hh < 240) { r = 0;  g = x;  bv = c; }
  else if (hh < 300) { r = x;  g = 0;  bv = c; }
  else                { r = c;  g = 0;  bv = x; }
  return `rgba(${Math.round((r + m) * 255)},${Math.round((g + m) * 255)},${Math.round((bv + m) * 255)},${a.toFixed(3)})`;
}

// ── module-scoped buffers (no per-frame allocation) ──────────────────────────
const _wy = new Float32Array(RES + 1);

// Dry-brush ink-stroke particles, one set per band/layer
const _strokeX: Float32Array[] = [];
const _strokeJ: Float32Array[] = [];
const _strokeA: Float32Array[] = [];
const _strokeL: Float32Array[] = [];
for (let i = 0; i < BAND_COUNT; i++) {
  _strokeX.push(new Float32Array(MAX_STROKES));
  _strokeJ.push(new Float32Array(MAX_STROKES));
  _strokeA.push(new Float32Array(MAX_STROKES));
  _strokeL.push(new Float32Array(MAX_STROKES));
}

// Foam-spray particle pool (ring buffer)
const _foamX = new Float32Array(MAX_FOAM);
const _foamY = new Float32Array(MAX_FOAM);
const _foamVX = new Float32Array(MAX_FOAM);
const _foamVY = new Float32Array(MAX_FOAM);
const _foamLife = new Float32Array(MAX_FOAM); // 0 = dead
const _foamSize = new Float32Array(MAX_FOAM);
let _foamCursor = 0;

// ── module-scoped state ──────────────────────────────────────────────────────
let _time = 0;
let _lastBeatIdx = -1;
let _beatFlash = 0;
let _surge = 0;
let _justBeat = false;

// ── reset ────────────────────────────────────────────────────────────────────
export function resetBlackWave(): void {
  _time = 0;
  _lastBeatIdx = -1;
  _beatFlash = 0;
  _surge = 0;
  _justBeat = false;
  for (let layer = 0; layer < BAND_COUNT; layer++) {
    for (let i = 0; i < MAX_STROKES; i++) {
      _strokeX[layer][i] = Math.random();
      _strokeJ[layer][i] = (Math.random() - 0.5) * 2;
      _strokeA[layer][i] = 0.4 + Math.random() * 0.6;
      _strokeL[layer][i] = 0.6 + Math.random() * 0.8;
    }
  }
  _foamLife.fill(0);
  _foamCursor = 0;
}

function spawnFoam(x: number, y: number, strength: number, H: number): void {
  const i = _foamCursor;
  _foamCursor = (_foamCursor + 1) % MAX_FOAM;
  const ang = -Math.PI / 2 + (Math.random() - 0.5) * 1.9;
  const spd = (0.012 + Math.random() * 0.022) * H * (0.6 + strength);
  _foamX[i] = x;
  _foamY[i] = y;
  _foamVX[i] = Math.cos(ang) * spd;
  _foamVY[i] = Math.sin(ang) * spd;
  _foamLife[i] = 1;
  _foamSize[i] = (1.4 + Math.random() * 2.6) * (isMobile ? 0.7 : 1);
}

// ── draw ─────────────────────────────────────────────────────────────────────
export function drawBlackWave(p: P5Instance, dt: number): void {
  const { state, config } = store;
  const { amps } = getBandAverages(BAND_COUNT);

  const density = config.blackwaveDensity;             // 0–1
  const swellMul = 0.5 + config.blackwaveSwell * 1.5;  // 0.5x – 2.0x
  const hueT = config.blackwaveHue;                    // 0–1

  // ── beat detection ────────────────────────────────────────────────────────
  _justBeat = false;
  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adj = pos - state.beatOffset;
    const bi = adj >= 0 ? Math.floor(adj / state.beatIntervalSec) : -1;
    if (bi >= 0 && bi !== _lastBeatIdx) {
      _lastBeatIdx = bi;
      _beatFlash = 1;
      _surge = 1;
      _justBeat = true;
    }
  }

  _time += dt * 0.006;
  _beatFlash *= Math.pow(0.9, dt);
  _surge *= Math.pow(0.93, dt);

  const ctx = (p as any).drawingContext as CanvasRenderingContext2D;
  const W = p.width;
  const H = p.height;

  // ── palette: sumi-e monochrome → Hokusai indigo "ai-zuri" → vermillion "Red Fuji" ──
  const inkHue = hueT <= 0.5 ? 212 : 212 - (hueT - 0.5) * 408;
  const inkSat = hueT <= 0.5 ? 4 + hueT * 122 : 65 - (hueT - 0.5) * 10;
  const bgSat = 5 + inkSat * 0.15;

  // ── sky: bokashi gradient wash, the gradated printing used for ukiyo-e skies ──
  const sky = ctx.createLinearGradient(0, 0, 0, H);
  sky.addColorStop(0,    hsba(inkHue, bgSat + 8, 86, 1));
  sky.addColorStop(0.55, hsba(inkHue, bgSat,     94, 1));
  sky.addColorStop(1,    hsba(inkHue, bgSat,     94, 1));
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, W, H);

  if (_beatFlash > 0.04) {
    ctx.fillStyle = hsba((inkHue + 30) % 360, 35, 100, _beatFlash * 0.05);
    ctx.fillRect(0, 0, W, H);
  }

  const strokeCount = Math.max(3, Math.round(3 + density * (MAX_STROKES - 3)));

  let frontBaseY = 0, frontAmpPx = 0, frontFreq = 0, frontPhase = 0;

  // ── wave layers, back (brilliance) to front (sub-bass) ──────────────────
  for (let layer = BAND_COUNT - 1; layer >= 0; layer--) {
    const depthT = layer / (BAND_COUNT - 1); // 0 = front, 1 = back
    const amp = amps[layer];

    const baseY = H * (0.92 - depthT * 0.56);
    const surgeMul = layer === 0 ? 1 + _surge * 0.7 : 1;
    const ampPx = H * (0.045 + (1 - depthT) * 0.16) * swellMul * (0.35 + amp * 1.25) * surgeMul;
    const freq = 1.1 + depthT * 3.4;
    const speed = 0.18 + (1 - depthT) * 0.55;
    const phase = _time * speed * p.TWO_PI + layer * 1.733;

    for (let s = 0; s <= RES; s++) {
      const t = s / RES;
      const a1 = Math.sin(t * p.TWO_PI * freq + phase);
      const a2 = Math.sin(t * p.TWO_PI * freq * 2.13 - phase * 0.7 + layer);
      _wy[s] = baseY - ampPx * (0.66 * a1 + 0.34 * a2);
    }

    // ── filled silhouette: dark + opaque in front, pale + hazy at back ────
    const layerBri = Math.min(100, 16 + depthT * 58 + amp * 8 + (layer === 0 ? _beatFlash * 10 : 0));
    const layerSat = inkSat * (1 - depthT * 0.35);
    const layerAlpha = 0.55 + (1 - depthT) * 0.42;

    ctx.fillStyle = hsba(inkHue, layerSat, layerBri, layerAlpha);
    ctx.beginPath();
    ctx.moveTo(0, H);
    for (let s = 0; s <= RES; s++) ctx.lineTo((s / RES) * W, _wy[s]);
    ctx.lineTo(W, H);
    ctx.closePath();
    ctx.fill();

    // ── pale crest rim line ────────────────────────────────────────────
    ctx.strokeStyle = hsba(inkHue, Math.max(0, layerSat - 25), 97, 0.15 + amp * 0.3);
    ctx.lineWidth = isMobile ? 1 : 1.5;
    ctx.beginPath();
    ctx.moveTo(0, _wy[0]);
    for (let s = 1; s <= RES; s++) ctx.lineTo((s / RES) * W, _wy[s]);
    ctx.stroke();

    // ── dry-brush ink strokes drifting along the crest ──────────────────
    const peakY = baseY - ampPx;
    const driftSpeed = dt * 0.0005 * (0.4 + (1 - depthT));
    for (let i = 0; i < strokeCount; i++) {
      const xN = _strokeX[layer][i];
      const k1 = xN * p.TWO_PI * freq + phase;
      const k2 = xN * p.TWO_PI * freq * 2.13 - phase * 0.7 + layer;
      const a1 = Math.sin(k1);
      const a2 = Math.sin(k2);
      const y = baseY - ampPx * (0.66 * a1 + 0.34 * a2) + _strokeJ[layer][i] * ampPx * 0.22;

      const d1 = Math.cos(k1) * p.TWO_PI * freq;
      const d2 = Math.cos(k2) * p.TWO_PI * freq * 2.13;
      const slope = -ampPx * (0.66 * d1 + 0.34 * d2);
      const angle = Math.atan2(slope, W);

      const proximity = 1 - Math.min(1, Math.max(0, (y - peakY) / (ampPx * 2)));
      const len = (W / RES) * (1.1 + proximity * 0.8) * _strokeL[layer][i];
      const hl = len * 0.5;
      const dx = Math.cos(angle) * hl;
      const dyv = Math.sin(angle) * hl;
      const x = xN * W;

      const a = _strokeA[layer][i] * (0.25 + amp * 0.6) * (0.25 + proximity * 0.85);
      ctx.strokeStyle = hsba(
        (inkHue + proximity * 10) % 360,
        Math.min(100, layerSat * 0.55 + 8),
        Math.min(100, layerBri + proximity * 40 + 16),
        Math.min(1, a),
      );
      ctx.lineWidth = isMobile ? 1 : 1.4;
      ctx.beginPath();
      ctx.moveTo(x - dx, y - dyv);
      ctx.lineTo(x + dx, y + dyv);
      ctx.stroke();

      _strokeX[layer][i] = (xN + driftSpeed) % 1;
    }

    // ── ambient spray trickling off the front crest ─────────────────────
    if (layer === 0 && amp > 0.3 && Math.random() < amp * dt * 0.04) {
      const xN = Math.random();
      const a1 = Math.sin(xN * p.TWO_PI * freq + phase);
      const a2 = Math.sin(xN * p.TWO_PI * freq * 2.13 - phase * 0.7 + layer);
      const y = baseY - ampPx * (0.66 * a1 + 0.34 * a2);
      spawnFoam(xN * W, y, amp, H);
    }

    if (layer === 0) {
      frontBaseY = baseY;
      frontAmpPx = ampPx;
      frontFreq = freq;
      frontPhase = phase;
    }
  }

  // ── beat: spray burst off the front wave's crest ─────────────────────────
  if (_justBeat) {
    const burst = Math.round(6 + density * 20);
    for (let i = 0; i < burst; i++) {
      const xN = Math.random();
      const a1 = Math.sin(xN * p.TWO_PI * frontFreq + frontPhase);
      const a2 = Math.sin(xN * p.TWO_PI * frontFreq * 2.13 - frontPhase * 0.7);
      const y = frontBaseY - frontAmpPx * (0.66 * a1 + 0.34 * a2);
      spawnFoam(xN * W, y, 1.2, H);
    }
  }

  // ── render + advance foam particles ──────────────────────────────────────
  for (let i = 0; i < MAX_FOAM; i++) {
    if (_foamLife[i] <= 0) continue;
    _foamVY[i] += H * 0.0009 * dt;
    _foamX[i] += _foamVX[i] * dt;
    _foamY[i] += _foamVY[i] * dt;
    _foamLife[i] -= dt * 0.018;
    if (_foamLife[i] <= 0) { _foamLife[i] = 0; continue; }
    const r = Math.max(0.4, _foamSize[i] * _foamLife[i]);
    ctx.fillStyle = hsba(inkHue, Math.max(0, bgSat - 4), 98, _foamLife[i] * 0.85);
    ctx.beginPath();
    ctx.arc(_foamX[i], _foamY[i], r, 0, p.TWO_PI);
    ctx.fill();
  }

  ctx.fillStyle = '#000000';
}
