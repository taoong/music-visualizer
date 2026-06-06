/**
 * Physarum — slime-mold agent network simulation.
 *
 * Inspired by Zach Lieberman's 2025 daily sketch explorations of the physarum
 * algorithm (based on Jeff Jones "Characteristics of pattern formation and
 * evolution in approximations of Physarum transport networks", 2010) as
 * popularised in creative coding circles by Sage Jessen's implementation.
 *
 * N agents drift forward, sense pheromone at three probe positions
 * (front-left, front, front-right) and steer toward the highest concentration,
 * depositing fresh trail as they go. After each agent step the trail map is
 * diffused (3×3 box blur) and decayed. The emergent result is a self-organising
 * glowing web of highways — mycelial, neural, leaf-vein aesthetics — that
 * breathes and pulses with the music.
 *
 * Audio reactivity
 *   Beat              → scatter 20 % of agents to new random positions,
 *                        hue palette jump (+47°)
 *   Sub-bass amp      → trail deposit rate (thicker, more luminous highways)
 *   Dominant band     → colour hue (sub=violet → bass=blue → lowMid=teal
 *                        → mid=green → upperMid=yellow → presence=orange
 *                        → brilliance=magenta)
 *   Overall amplitude → agent step speed
 *   Any transient > 1.5 → brief 2× speed burst
 *
 * Rendering
 *   Float32Array trail map at ⅓ canvas resolution (⅕ on mobile).
 *   Trail concentration → HSB colour via manual conversion; drawn into an
 *   offscreen P5Graphics buffer then scaled to full canvas with smooth
 *   upscaling for a soft neon-glow aesthetic.
 *   Auto-normalisation tracks peak trail value so brightness self-calibrates.
 *
 * Sliders
 *   Agents      — number of agents (100–3000; capped at 600 on mobile)
 *   Evaporation — trail persistence (low = fast fade, high = permanent)
 *   Sensor      — sensor angle in degrees (narrow = thin fast lanes,
 *                  wide = dense branching web)
 */
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { BAND_COUNT, isMobile } from '../utils/constants';

// ── Constants ─────────────────────────────────────────────────────────────────

const PIXEL_SCALE  = isMobile ? 5 : 3;     // canvas → trail-buffer downscale
const SENSOR_DIST  = 9;                     // sensor probe distance (buffer px)
const DEPOSIT_BASE = 4.0;                   // pheromone deposited per agent step
const EVAP_MIN     = 0.88;                  // evaporation range (slider = 0)
const EVAP_MAX     = 0.995;                 // evaporation range (slider = 1)
const MOBILE_CAP   = 600;                   // max agents on mobile
const TWO_PI       = Math.PI * 2;

// sub=violet, bass=blue, lowMid=teal, mid=green, upperMid=yellow,
// presence=orange, brilliance=magenta
const BAND_HUES: readonly number[] = [270, 220, 180, 140, 60, 30, 300];

// ── Module state ──────────────────────────────────────────────────────────────

let trailBuf: Float32Array = new Float32Array(0);
let nextBuf:  Float32Array = new Float32Array(0);
let bufW = 0;
let bufH = 0;

let gfx:  P5Graphics | null = null;
let gfxW = 0;
let gfxH = 0;

// Parallel float arrays — better cache locality than array-of-structs
let agentX:     Float32Array = new Float32Array(0);
let agentY:     Float32Array = new Float32Array(0);
let agentAngle: Float32Array = new Float32Array(0);
let agentCount = 0;

let lastBeatIndex = -1;
let baseHue   = 200;    // accumulated hue offset, shifted on each beat
let currentHue = 200;   // smoothly interpolated display hue
let maxTrail  = 1.0;    // auto-normalises brightness
let beatFlash = 0.0;    // 1→0 flash on beat

// ── Helpers ───────────────────────────────────────────────────────────────────

function hsbToRgb(h: number, s: number, b: number): [number, number, number] {
  s /= 100; b /= 100;
  const k = (n: number) => (n + h / 60) % 6;
  const f = (n: number) => b * (1 - s * Math.max(0, Math.min(1, Math.min(k(n), 4 - k(n)))));
  return [Math.round(f(5) * 255), Math.round(f(3) * 255), Math.round(f(1) * 255)];
}

function sampleTrail(x: number, y: number): number {
  const ix = ((Math.floor(x) % bufW) + bufW) % bufW;
  const iy = ((Math.floor(y) % bufH) + bufH) % bufH;
  return trailBuf[iy * bufW + ix];
}

function initAgents(count: number): void {
  agentCount  = count;
  agentX      = new Float32Array(count);
  agentY      = new Float32Array(count);
  agentAngle  = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    agentX[i]     = Math.random() * bufW;
    agentY[i]     = Math.random() * bufH;
    agentAngle[i] = Math.random() * TWO_PI;
  }
}

function scatterFraction(fraction: number): void {
  const n = Math.floor(agentCount * fraction);
  for (let k = 0; k < n; k++) {
    const i          = Math.floor(Math.random() * agentCount);
    agentX[i]        = Math.random() * bufW;
    agentY[i]        = Math.random() * bufH;
    agentAngle[i]    = Math.random() * TWO_PI;
  }
}

function resizeAgents(target: number): void {
  if (agentCount === target) return;
  const newX = new Float32Array(target);
  const newY = new Float32Array(target);
  const newA = new Float32Array(target);
  const copy = Math.min(agentCount, target);
  newX.set(agentX.subarray(0, copy));
  newY.set(agentY.subarray(0, copy));
  newA.set(agentAngle.subarray(0, copy));
  for (let i = copy; i < target; i++) {
    newX[i] = Math.random() * bufW;
    newY[i] = Math.random() * bufH;
    newA[i] = Math.random() * TWO_PI;
  }
  agentX = newX; agentY = newY; agentAngle = newA;
  agentCount = target;
}

// ── Public API ────────────────────────────────────────────────────────────────

export function interactPhysarum(event: import('../types').InteractionEvent): void {
  if (bufW === 0 || bufH === 0) return;
  const { type, x, y } = event;
  if (type === 'tap' || type === 'drag' || type === 'dragstart') {
    const cx = Math.floor(x * bufW);
    const cy = Math.floor(y * bufH);
    const r = Math.max(2, Math.floor(Math.min(bufW, bufH) * 0.05));
    for (let oy = -r; oy <= r; oy++) {
      for (let ox = -r; ox <= r; ox++) {
        if (ox * ox + oy * oy <= r * r) {
          const px = Math.max(0, Math.min(bufW - 1, cx + ox));
          const py = Math.max(0, Math.min(bufH - 1, cy + oy));
          trailBuf[py * bufW + px] = Math.min(1.0, trailBuf[py * bufW + px] + 0.9);
        }
      }
    }
  }
}

export function resetPhysarum(): void {
  trailBuf   = new Float32Array(0);
  nextBuf    = new Float32Array(0);
  bufW = 0;  bufH = 0;
  agentX     = new Float32Array(0);
  agentY     = new Float32Array(0);
  agentAngle = new Float32Array(0);
  agentCount = 0;
  gfx?.remove();
  gfx = null;  gfxW = 0;  gfxH = 0;
  lastBeatIndex = -1;
  baseHue    = 200;
  currentHue = 200;
  maxTrail   = 1.0;
  beatFlash  = 0.0;
}

export function drawPhysarum(p: P5Instance, _dt: number): void {
  const { state, config } = store;
  const { amps, transients } = getBandAverages(BAND_COUNT);

  const W = p.width;
  const H = p.height;
  const newBufW = Math.max(1, Math.ceil(W / PIXEL_SCALE));
  const newBufH = Math.max(1, Math.ceil(H / PIXEL_SCALE));

  // Allocate / resize trail buffers on first call or canvas resize
  if (bufW !== newBufW || bufH !== newBufH) {
    bufW     = newBufW;
    bufH     = newBufH;
    trailBuf = new Float32Array(bufW * bufH);
    nextBuf  = new Float32Array(bufW * bufH);
    initAgents(Math.min(isMobile ? MOBILE_CAP : 3000, config.physarumAgents));
  }

  // Allocate / resize offscreen graphics buffer
  if (!gfx || gfxW !== newBufW || gfxH !== newBufH) {
    gfx?.remove();
    gfx  = p.createGraphics(newBufW, newBufH);
    gfx.noSmooth();
    gfxW = newBufW;
    gfxH = newBufH;
  }

  // ── Beat detection ────────────────────────────────────────────────────────

  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos      = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    const beatIdx  = adjusted >= 0 ? Math.floor(adjusted / state.beatIntervalSec) : -1;
    if (beatIdx >= 0 && beatIdx !== lastBeatIndex) {
      lastBeatIndex = beatIdx;
      baseHue = (baseHue + 47) % 360;
      beatFlash = 1.0;
      scatterFraction(0.20);
    }
  }
  beatFlash *= 0.90;

  // ── Sync agent count with slider ──────────────────────────────────────────

  const targetCount = isMobile
    ? Math.min(MOBILE_CAP, config.physarumAgents)
    : config.physarumAgents;
  if (agentCount !== targetCount) resizeAgents(targetCount);

  // ── Audio parameters ──────────────────────────────────────────────────────

  const totalAmp = (amps[0] + amps[1] + amps[2] + amps[3]) * 0.25;
  const bassAmp  = amps[1];
  const deposit  = DEPOSIT_BASE * (1.0 + bassAmp * 4.0);

  // Speed boost on any transient
  let burstSpeed = 1.0;
  for (let b = 0; b < BAND_COUNT; b++) {
    if (transients[b] > 1.5) { burstSpeed = 2.0; break; }
  }
  const speed = (1.0 + totalAmp * 1.5) * burstSpeed;

  // Precompute sensor-angle trig once per frame (used in rotation formula)
  const sensorAngle = (config.physarumSensor * Math.PI) / 180;
  const cosSA = Math.cos(sensorAngle);
  const sinSA = Math.sin(sensorAngle);

  // ── Step agents ───────────────────────────────────────────────────────────

  for (let i = 0; i < agentCount; i++) {
    const x = agentX[i];
    const y = agentY[i];
    const a = agentAngle[i];

    // Compute three sensor directions via rotation formula — only 2 trig calls
    const cosA = Math.cos(a);
    const sinA = Math.sin(a);

    // forward: (cosA, sinA)
    // left  (a - θ): cosL = cosA·cosSA + sinA·sinSA,  sinL = sinA·cosSA - cosA·sinSA
    // right (a + θ): cosR = cosA·cosSA - sinA·sinSA,  sinR = sinA·cosSA + cosA·sinSA
    const cosL = cosA * cosSA + sinA * sinSA;
    const sinL = sinA * cosSA - cosA * sinSA;
    const cosR = cosA * cosSA - sinA * sinSA;
    const sinR = sinA * cosSA + cosA * sinSA;

    const sf = sampleTrail(x + cosA * SENSOR_DIST, y + sinA * SENSOR_DIST);
    const sl = sampleTrail(x + cosL * SENSOR_DIST, y + sinL * SENSOR_DIST);
    const sr = sampleTrail(x + cosR * SENSOR_DIST, y + sinR * SENSOR_DIST);

    let newAngle = a;
    if (sf >= sl && sf >= sr) {
      // Continue straight — no turn
    } else if (sl > sr) {
      newAngle = a - sensorAngle * 0.5;
    } else if (sr > sl) {
      newAngle = a + sensorAngle * 0.5;
    } else {
      // Equal flanks — small jitter breaks symmetry
      newAngle = a + (Math.random() - 0.5) * 0.2;
    }

    const nx = x + Math.cos(newAngle) * speed;
    const ny = y + Math.sin(newAngle) * speed;

    // Toroidal wrap
    agentX[i]     = ((nx % bufW) + bufW) % bufW;
    agentY[i]     = ((ny % bufH) + bufH) % bufH;
    agentAngle[i] = newAngle;

    // Deposit pheromone
    const ix = Math.floor(agentX[i]);
    const iy = Math.floor(agentY[i]);
    if (ix >= 0 && ix < bufW && iy >= 0 && iy < bufH) {
      trailBuf[iy * bufW + ix] += deposit;
    }
  }

  // ── Diffuse + decay ───────────────────────────────────────────────────────

  const decayFactor = EVAP_MIN + config.physarumEvaporation * (EVAP_MAX - EVAP_MIN);

  for (let y = 0; y < bufH; y++) {
    const yN   = y === 0        ? bufH - 1 : y - 1;
    const yS   = y === bufH - 1 ? 0        : y + 1;
    const rowC = y  * bufW;
    const rowN = yN * bufW;
    const rowS = yS * bufW;

    for (let x = 0; x < bufW; x++) {
      const xW = x === 0        ? bufW - 1 : x - 1;
      const xE = x === bufW - 1 ? 0        : x + 1;

      // 3×3 box-blur average × decay
      const sum =
        trailBuf[rowN + xW] + trailBuf[rowN + x] + trailBuf[rowN + xE] +
        trailBuf[rowC + xW] + trailBuf[rowC + x] + trailBuf[rowC + xE] +
        trailBuf[rowS + xW] + trailBuf[rowS + x] + trailBuf[rowS + xE];

      nextBuf[rowC + x] = (sum / 9) * decayFactor;
    }
  }

  // Swap ping-pong buffers — zero allocation
  const tmp = trailBuf; trailBuf = nextBuf; nextBuf = tmp;

  // ── Auto-normalise brightness ─────────────────────────────────────────────

  let localMax = 0.0;
  for (let i = 0, len = bufW * bufH; i < len; i++) {
    if (trailBuf[i] > localMax) localMax = trailBuf[i];
  }
  if (localMax > maxTrail) maxTrail = localMax;
  maxTrail = maxTrail * 0.998 + 0.002; // slowly drift down toward current peak

  // ── Hue computation ───────────────────────────────────────────────────────

  let dominantBand = 0;
  let maxBandAmp   = 0.0;
  for (let b = 0; b < BAND_COUNT; b++) {
    if (amps[b] > maxBandAmp) { maxBandAmp = amps[b]; dominantBand = b; }
  }
  const rawHue = (BAND_HUES[dominantBand] + baseHue) % 360;

  // Shortest-arc interpolation around the colour wheel
  const hueDelta = ((rawHue - currentHue + 540) % 360) - 180;
  currentHue = (currentHue + hueDelta * 0.03 + 360) % 360;

  // ── Render to offscreen buffer ────────────────────────────────────────────

  gfx.loadPixels();
  const px = gfx.pixels;

  const invMax = 1.0 / maxTrail;
  const flashHueMod = beatFlash * 25;

  for (let y = 0; y < bufH; y++) {
    const row = y * bufW;
    for (let x = 0; x < bufW; x++) {
      const i   = row + x;
      const t   = trailBuf[i] * invMax; // normalised 0–1
      const idx = i * 4;

      if (t < 0.04) {
        // Background: deep void blue-black
        px[idx] = 3; px[idx + 1] = 2; px[idx + 2] = 12; px[idx + 3] = 255;
      } else {
        // Power curve → pleasing contrast between dim paths and bright nodes
        const powered = Math.pow(t, 0.55);
        const bri     = Math.min(100, powered * 115);
        // Saturation drops at high values, letting bright intersections bloom white
        const sat     = Math.max(15, 88 - powered * 55);
        const hue     = (currentHue + flashHueMod) % 360;
        const [r, g, b] = hsbToRgb(hue, sat, bri);
        px[idx] = r; px[idx + 1] = g; px[idx + 2] = b; px[idx + 3] = 255;
      }
    }
  }

  gfx.updatePixels();

  // Draw to main canvas — smooth upscale gives the neon soft-glow look
  p.background(3, 2, 12);
  p.smooth();
  p.image(gfx as unknown as P5Image, 0, 0, W, H);
  p.noSmooth();
}
