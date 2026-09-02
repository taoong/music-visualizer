/**
 * Protractor — audio-reactive concentric arc fans
 *
 * Inspired by Frank Stella's "Protractor" series (1967–69, MoMA, New York,
 * https://www.moma.org/artists/5641). Stella arranged interlocking fans of
 * flat concentric arcs — each fan a quarter-circle or half-circle of vivid
 * spectral color — into large-format canvases that vibrate with simultaneous
 * contrast. Here, N fans share the canvas centre, each sweeping through a
 * configurable arc of the circle; their concentric rings are coloured by the
 * 7 frequency bands, with amplitude driving brightness and stroke weight.
 * The whole pattern slowly rotates; beats fire an angular impulse and shift
 * the hue palette.
 *
 * Sliders
 *   Fans   — number of arc fans (2–8)
 *   Rings  — concentric arcs per fan (4–24)
 *   Spread — angular sweep of each fan (narrow wedge → nearly full circle)
 */

import { audioEngine } from '../audio/engine';
import { BAND_COUNT, isMobile } from '../utils/constants';
import { store } from '../state/store';
import { getBandAverages } from './helpers';

const BAND_HUES: readonly number[] = [280, 240, 180, 120, 60, 30, 0];

const MAX_FANS_MOBILE = 5;
const MAX_RINGS_MOBILE = 14;

let rotation = 0;
let beatImpulse = 0;
let hueShift = 0;
let lastBeatIndex = -1;

export function drawProtractor(p: P5Instance, dt: number): void {
  const { amps, transients } = getBandAverages(BAND_COUNT);
  const { config, state } = store;

  const fanCount = Math.round(
    isMobile
      ? Math.min(config.protractorFans, MAX_FANS_MOBILE)
      : config.protractorFans
  );
  const ringCount = Math.round(
    isMobile
      ? Math.min(config.protractorRings, MAX_RINGS_MOBILE)
      : config.protractorRings
  );
  const spread = config.protractorSpread;

  const W = p.width;
  const H = p.height;
  const maxSize = Math.min(W, H);

  // Beat detection
  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    const beatIdx = adjusted >= 0 ? Math.floor(adjusted / state.beatIntervalSec) : -1;
    if (beatIdx >= 0 && beatIdx !== lastBeatIndex) {
      if (lastBeatIndex >= 0) {
        beatImpulse = 1.0;
        hueShift = (hueShift + 47) % 360;
      }
      lastBeatIndex = beatIdx;
    }
  }

  beatImpulse *= Math.pow(0.87, dt);

  const totalAmp = amps.reduce((s, a) => s + a, 0) / BAND_COUNT;

  // Rotation speed driven by amplitude and beat impulse
  rotation += (0.003 + totalAmp * 0.01 + beatImpulse * 0.05) * dt;

  // Trail fade: semi-transparent black rect
  p.blendMode(p['BLEND']);
  p.noStroke();
  p.fill(0, 0, 0, 28);
  p.rect(0, 0, W, H);

  // Additive blend for neon glow
  p.blendMode(p['ADD']);
  p.noFill();
  (p as any).colorMode(p['HSB'], 360, 100, 100, 100);

  const spreadRad = (30 + spread * 270) * (Math.PI / 180); // 30°–300°
  const sectorStep = (2 * Math.PI) / fanCount;

  const innerR = maxSize * 0.04;
  const outerR = maxSize * 0.47;

  const cx = W * 0.5;
  const cy = H * 0.5;

  for (let f = 0; f < fanCount; f++) {
    const fanStart = f * sectorStep + rotation;
    const fanEnd = fanStart + spreadRad;

    for (let r = 0; r < ringCount; r++) {
      const t = ringCount > 1 ? r / (ringCount - 1) : 0;
      const radius = innerR + (outerR - innerR) * t;

      const bandIdx = r % BAND_COUNT;
      const amp = amps[bandIdx];
      const tMult = transients[bandIdx];
      const transientBoost = Math.max(0, tMult - 1.0) * 0.4;

      const hue = (BAND_HUES[bandIdx] + hueShift) % 360;
      const sat = 65 + amp * 35;
      const bri = Math.min(100, 25 + amp * 75 + transientBoost * 50 + beatImpulse * 25);

      // Soft halo
      p.stroke(hue, sat * 0.5, bri * 0.55, 40 + amp * 35);
      p.strokeWeight(4 + amp * 12 + beatImpulse * 6);
      p.arc(cx, cy, radius * 2, radius * 2, fanStart, fanEnd);

      // Bright core
      p.stroke(hue, sat, Math.min(100, bri + 15), 50 + amp * 50);
      p.strokeWeight(0.6 + amp * 2.5 + transientBoost * 2);
      p.arc(cx, cy, radius * 2, radius * 2, fanStart, fanEnd);
    }
  }

  p.blendMode(p['BLEND']);
  (p as any).colorMode(p['RGB'], 255, 255, 255, 255);
}

export function resetProtractor(): void {
  rotation = 0;
  beatImpulse = 0;
  hueShift = 0;
  lastBeatIndex = -1;
}
