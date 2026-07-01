/**
 * Disco — Mirror ball: a faceted chrome sphere scatters 7 coloured spotlights
 * (one per freq band) across a dark room as it spins; amplitude drives
 * rotation speed; beats flash and shift the hue palette; reflected spots glow
 * via additive blending, merging to white where they overlap — exactly like a
 * real stage lighting rig.
 *
 * Inspired by teamLab's "Planets" immersive light environments (2018–present,
 * Tokyo, https://planets.teamlab.art/tokyo/) — specifically their "Floating
 * Flower Garden" (2015) and "Crystal Universe" (2015) rooms, where luminous
 * particles and reflective surfaces transform space itself into the medium —
 * and by Olafur Eliasson's "Beauty" (1993), in which a fine mist refracts a
 * single spotlight into a circular rainbow; the mirror ball is that same
 * scattering principle taken to a thousand simultaneous facets.
 *
 * Geometry: a sphere of N_LATS × N_LONS mirror tiles. For each front-facing
 * tile at latitude θ and longitude φ + rot, the reflected ray hits the "room"
 * at canvas coordinates derived from doubling φ (law of reflection). Equatorial
 * tiles orbit at the widest radius; polar tiles scatter near the ball itself.
 * Lower-hemisphere tiles scatter to the floor (high Y), upper to the ceiling
 * (low Y). The ball is rendered with perspective-projected tiles on top; a
 * 2D radial-gradient gives the specular highlight.
 *
 * Sliders
 *   Spin    — rotation speed: slow ambient swirl → frantic disco spin
 *   Sparkle — reflected-spot glow radius and intensity
 *   Palette — colour: 0 = rainbow (7 band hues), 1 = white spotlight
 */
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { BAND_COUNT, isMobile } from '../utils/constants';

// Hue per band: sub-bass=violet → brilliance=red
const BAND_HUES: readonly number[] = [280, 230, 180, 120, 60, 30, 0];

// Mirror-tile grid resolution (reduces on mobile)
const N_LATS = isMobile ? 10 : 16;
const N_LONS = isMobile ? 20 : 32;
const TWO_PI = Math.PI * 2;

let _rotation = 0;
let _hueShift = 0;
let _beatFlash = 0;
let _lastBeat = -1;

export function resetDisco(): void {
  _rotation = 0;
  _hueShift = 0;
  _beatFlash = 0;
  _lastBeat = -1;
}

export function drawDisco(p: P5Instance, dt: number): void {
  const { state, config } = store;
  const { amps } = getBandAverages(BAND_COUNT);

  const spin = config.discoSpin;
  const sparkle = config.discoSparkle;
  const palette = config.discoPalette;

  // Overall loudness
  let totalAmp = 0;
  for (let b = 0; b < BAND_COUNT; b++) totalAmp += amps[b];
  totalAmp /= BAND_COUNT;

  // Beat detection
  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adj = pos - state.beatOffset;
    const beatIdx = adj >= 0 ? Math.floor(adj / state.beatIntervalSec) : -1;
    if (beatIdx >= 0 && beatIdx !== _lastBeat) {
      _lastBeat = beatIdx;
      _beatFlash = 1.0;
      // Shift palette hue on every beat
      _hueShift = (_hueShift + 40 + Math.floor(totalAmp * 80)) % 360;
    }
  }

  // Advance rotation and decay flash
  const spinRate = 0.003 + spin * 0.02 + totalAmp * 0.01;
  _rotation += spinRate * dt;
  _beatFlash *= Math.pow(0.88, dt);

  const flash = _beatFlash;

  // Background: deep near-black with subtle indigo tint; beat adds brief glow
  (p as any).colorMode(p['HSB'], 360, 100, 100, 100);
  p.background(240, 28, 4 + flash * 7);

  const cx = p.width / 2;
  const ballY = p.height * 0.25;
  const ballR = Math.min(p.width, p.height) * 0.13;

  // Spot-spread geometry
  const spread    = Math.min(p.width, p.height) * (0.42 + sparkle * 0.14);
  const vertSpread = p.height * 0.52;
  const glowR     = (3.5 + sparkle * 14) * (isMobile ? 0.7 : 1.0);

  // Palette: saturation fades to near-zero as slider → 1 (white spotlight)
  const baseSat = 88 * (1 - palette * 0.92);

  // ── Reflected light spots ─────────────────────────────────────────────────
  (p as any).blendMode(p['ADD']);
  p.noStroke();

  for (let row = 0; row < N_LATS; row++) {
    const theta = ((row / (N_LATS - 1)) - 0.5) * Math.PI;
    const sinTheta = Math.sin(theta);
    const cosTheta = Math.cos(theta);

    const band = Math.min(BAND_COUNT - 1, Math.floor(row * BAND_COUNT / N_LATS));
    const amp = amps[band] * (1 + flash * 0.7);
    if (amp < 0.012) continue;

    // Hue: blend toward neutral (55 = warm yellow) at high palette
    const bandHue = BAND_HUES[band];
    const hue = (bandHue * (1 - palette * 0.85) + 55 * palette * 0.85 + _hueShift + 360) % 360;
    const sat = baseSat;

    for (let col = 0; col < N_LONS; col++) {
      const phi = col * TWO_PI / N_LONS + _rotation;

      // Back-face culling: z-component of tile normal
      const z3 = cosTheta * Math.cos(phi);
      if (z3 < 0.06) continue;

      // Reflected spot position on the room canvas
      // Law of reflection doubles the rotation angle
      const reflPhi = phi * 2;
      // Equatorial tiles orbit at full spread; polar at zero
      const spotR = spread * cosTheta;
      // Lower-hemisphere tiles (sinTheta < 0) go to the floor (high Y)
      const baseY = ballY - sinTheta * vertSpread;

      const sx = cx + spotR * Math.cos(reflPhi);
      const sy = baseY + spotR * Math.sin(reflPhi) * 0.32;

      // Spot size and brightness
      const brt = Math.min(100, amp * 88 * z3 + flash * 22);
      const sz  = glowR * z3 * (0.75 + amp * 0.65);

      // Three-pass glow: wide outer halo, medium ring, bright core
      p.fill(hue, sat * 0.45, brt, 10);
      p.ellipse(sx, sy, sz * 5.5, sz * 5.5);
      p.fill(hue, sat * 0.75, brt, 28);
      p.ellipse(sx, sy, sz * 2.3, sz * 2.3);
      p.fill(hue, sat, Math.min(100, brt * 1.25), 68);
      p.ellipse(sx, sy, sz, sz);
    }
  }

  // ── Disco ball ─────────────────────────────────────────────────────────────
  (p as any).blendMode(p['BLEND']);

  // Hanging cord from ceiling to top of ball
  p.stroke(0, 0, 42, 50);
  p.strokeWeight(1.5);
  p.line(cx, 0, cx, ballY - ballR);

  // Ball base sphere (dark chrome)
  p.noStroke();
  p.fill(0, 0, 9);
  p.ellipse(cx, ballY, ballR * 2, ballR * 2);

  // Mirror tiles on ball surface
  const tileSize = (TWO_PI * ballR / N_LONS) * 0.72;

  for (let row = 0; row < N_LATS; row++) {
    const theta = ((row / (N_LATS - 1)) - 0.5) * Math.PI;
    const sinTheta = Math.sin(theta);
    const cosTheta = Math.cos(theta);
    const band = Math.min(BAND_COUNT - 1, Math.floor(row * BAND_COUNT / N_LATS));
    const amp = amps[band];

    const bandHue = BAND_HUES[band];
    const hue = (bandHue * (1 - palette * 0.85) + 55 * palette * 0.85 + _hueShift + 360) % 360;
    const sat = baseSat;

    for (let col = 0; col < N_LONS; col++) {
      const phi = col * TWO_PI / N_LONS + _rotation;
      const z3 = cosTheta * Math.cos(phi);
      if (z3 <= 0) continue;

      // 2D projected tile center on ball surface
      const tx = cx + cosTheta * Math.sin(phi) * ballR;
      const ty = ballY - sinTheta * ballR;

      // Brightness: brighter when facing viewer; audio energy adds shimmer
      const tileBrt = Math.min(100, 18 + z3 * (32 + amp * 58));
      const tileSat = sat * 0.9;
      const ts = tileSize * (0.55 + z3 * 0.45);

      p.noStroke();
      p.fill(hue, tileSat, tileBrt);
      p.rect(tx - ts * 0.5, ty - ts * 0.5, ts, ts, ts * 0.15);
    }
  }

  // Specular highlight (upper-left glint using native canvas gradient)
  (p as any).blendMode(p['ADD']);
  const ctx2d = (p as any).drawingContext as CanvasRenderingContext2D;
  const sg = ctx2d.createRadialGradient(
    cx - ballR * 0.3, ballY - ballR * 0.3, 0,
    cx - ballR * 0.1, ballY - ballR * 0.1, ballR * 0.58
  );
  sg.addColorStop(0, 'rgba(255,255,255,0.20)');
  sg.addColorStop(0.6, 'rgba(255,255,255,0.05)');
  sg.addColorStop(1, 'rgba(255,255,255,0)');
  ctx2d.save();
  ctx2d.fillStyle = sg;
  ctx2d.beginPath();
  ctx2d.arc(cx, ballY, ballR, 0, TWO_PI);
  ctx2d.fill();
  ctx2d.restore();

  // Ambient pool glow on the floor (subtle)
  const poolAmp = totalAmp + flash * 0.4;
  const fY = p.height * 0.94;
  const fg = ctx2d.createRadialGradient(cx, fY, 0, cx, fY, ballR * 4.5);
  const r = Math.round(poolAmp * 18);
  const g = Math.round(poolAmp * 10);
  const b = Math.round(poolAmp * 30);
  fg.addColorStop(0, `rgba(${r},${g},${b},0.5)`);
  fg.addColorStop(1, 'rgba(0,0,0,0)');
  ctx2d.save();
  ctx2d.fillStyle = fg;
  ctx2d.fillRect(0, 0, p.width, p.height);
  ctx2d.restore();

  // Reset
  (p as any).blendMode(p['BLEND']);
  (p as any).colorMode(p['RGB'], 255, 255, 255, 255);
}
