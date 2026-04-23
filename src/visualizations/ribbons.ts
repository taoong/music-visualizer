/**
 * Ribbons — Flowing neon wave ribbons visualization.
 *
 * N sinusoidal ribbons flow horizontally across the screen, one color per
 * frequency band. Each ribbon's wave amplitude is driven by its band's energy.
 * Ribbons are rendered with a 3-pass neon glow (ADD blend). Beat pulses spike
 * amplitude across all ribbons.
 *
 * Sliders: Count (2–12), Wave Speed, Bend (waves per screen)
 */
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { BAND_COUNT } from '../utils/constants';

// HSB hues per frequency band: sub → bass → lowMid → mid → upperMid → presence → brilliance
const BAND_HUES = [0, 30, 65, 140, 195, 240, 280];

// Per-ribbon phase offsets (golden-ratio spacing avoids alignment beats)
const PHI = 1.6180339887;

let lastBeatIndex = -1;
let beatPulse = 0;
let phase = 0; // global scroll phase

export function resetRibbons(): void {
  lastBeatIndex = -1;
  beatPulse = 0;
  phase = 0;
}

export function drawRibbons(p: P5Instance, dt: number): void {
  const { state, config } = store;
  const { amps } = getBandAverages(BAND_COUNT);

  const ribbonCount = Math.round(config.ribbonsCount);
  const waveSpeed = config.ribbonsWaveSpeed;
  const bend = config.ribbonsBend;

  // Beat detection
  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    const currentBeatIndex = adjusted >= 0 ? Math.floor(adjusted / state.beatIntervalSec) : -1;
    if (currentBeatIndex >= 0 && currentBeatIndex !== lastBeatIndex) {
      lastBeatIndex = currentBeatIndex;
      beatPulse = 1.0;
    }
  }
  beatPulse *= Math.pow(0.82, dt);

  // Advance scroll phase
  phase += waveSpeed * dt * 0.045;

  (p as any).colorMode(p['HSB'], 360, 100, 100, 100);
  p.background(0, 0, 0);
  p.noFill();
  p.blendMode(p['ADD']);

  const w = p.width;
  const h = p.height;
  const STEPS = 64;

  for (let r = 0; r < ribbonCount; r++) {
    // Map ribbon index to a fractional band position, interpolate color + amp
    const bandT = (r / Math.max(ribbonCount - 1, 1)) * (BAND_COUNT - 1);
    const bandIdx = Math.floor(bandT);
    const bandFrac = bandT - bandIdx;
    const amp0 = amps[Math.min(bandIdx, BAND_COUNT - 1)];
    const amp1 = amps[Math.min(bandIdx + 1, BAND_COUNT - 1)];
    const amp = amp0 + (amp1 - amp0) * bandFrac;

    // Hue interpolates between adjacent band hues, drifts slowly over time
    const hue0 = BAND_HUES[Math.min(bandIdx, BAND_COUNT - 1)];
    const hue1 = BAND_HUES[Math.min(bandIdx + 1, BAND_COUNT - 1)];
    const baseHue = hue0 + (hue1 - hue0) * bandFrac;
    const hue = ((baseHue + phase * 18) % 360 + 360) % 360;

    // Vertical center for this ribbon, evenly distributed
    const yCenter = h * ((r + 0.5) / ribbonCount);

    // Wave amplitude: base idle + audio-reactive + beat pulse
    const maxAmp = h / (ribbonCount * 1.8);
    const waveAmp = maxAmp * (0.15 + amp * 2.0 + beatPulse * 0.5);

    // Each ribbon gets a unique phase offset and slightly different bend frequency
    // so they never all line up perfectly — creates a woven interference look
    const ribbonPhase = r * PHI * Math.PI * 2;
    const freqMult = bend * (0.85 + r * 0.05);

    // 3 draw passes: wide outer glow → mid halo → bright core
    const layers: Array<{ alpha: number; sw: number; sat: number }> = [
      { alpha: 22, sw: 22, sat: 45 },
      { alpha: 55, sw: 9,  sat: 80 },
      { alpha: 100, sw: 3, sat: 100 },
    ];

    for (const layer of layers) {
      p.stroke(hue, layer.sat, 100, layer.alpha);
      p.strokeWeight(layer.sw);
      p.beginShape();
      for (let i = 0; i <= STEPS; i++) {
        const x = (i / STEPS) * w;
        const t = (i / STEPS) * Math.PI * 2 * freqMult;
        const y = yCenter + Math.sin(t + phase + ribbonPhase) * waveAmp;
        // Duplicate first/last vertex so curveVertex spline passes through endpoints
        if (i === 0) p.curveVertex(x, y);
        p.curveVertex(x, y);
        if (i === STEPS) p.curveVertex(x, y);
      }
      p.endShape();
    }
  }

  p.blendMode(p['BLEND']);
  (p as any).colorMode(p['RGB'], 255, 255, 255, 255);
}
