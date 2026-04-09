/**
 * String Art visualization
 *
 * Mathematical "times table" / cardioid string art: N pins evenly spaced around a
 * circle; pin i connects to pin round(i * M) mod N. Each of 7 frequency bands renders
 * a slightly-offset multiplier layer in its own color. Fractional M morphs continuously
 * between shapes (cardioid at M=2, trefoil at M=3, etc.). Bass amplitude nudges the
 * multiplier toward richer patterns; beats shift the hue palette.
 *
 * Sliders: Pins, Multiplier, Speed
 */
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { BAND_COUNT } from '../utils/constants';

// --- Module-scoped state ---
let hueOffset = 0;
let multiplierAnim = 3.0;
let rotAngle = 0;
let beatPulse = 0;
let lastBeatIndex = -1;

export function drawStringart(p: P5Instance, dt: number): void {
  const { state, config } = store;
  const isFreqMode = state.mode === 'freq' || state.mode === 'mic';
  const bandCount = isFreqMode ? BAND_COUNT : 5;

  const { amps, transients } = getBandAverages(bandCount);

  // --- Beat detection ---
  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    const currentBeatIndex = adjusted >= 0 ? Math.floor(adjusted / state.beatIntervalSec) : -1;
    if (currentBeatIndex >= 0 && currentBeatIndex !== lastBeatIndex) {
      lastBeatIndex = currentBeatIndex;
      beatPulse = 1.0;
      hueOffset = (hueOffset + 18 + Math.random() * 22) % 360;
    }
  }

  beatPulse *= Math.pow(0.80, dt);
  if (beatPulse < 0.005) beatPulse = 0;

  const N = Math.max(20, Math.min(200, Math.round(config.stringartPins)));
  const speed = config.stringartSpeed;

  // --- Animate multiplier ---
  // Bass amplitude (band 1) nudges multiplier higher for richer patterns
  const bassAmp = amps[Math.min(1, bandCount - 1)] ?? 0;
  const targetM = config.stringartMultiplier + bassAmp * 1.5;
  multiplierAnim += (targetM - multiplierAnim) * 0.015 * dt;
  // Slow continuous drift upward
  multiplierAnim += speed * 0.005 * dt;
  // Wrap: from ~20.5 back to ~2.5 so the journey repeats
  if (multiplierAnim > 20.5) multiplierAnim -= 18.0;

  rotAngle += 0.003 * speed * dt;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pAny = p as any;
  pAny.colorMode(p['HSB'], 360, 100, 100, 1.0);

  const cx = p.width / 2;
  const cy = p.height / 2;
  const radius = Math.min(p.width, p.height) * 0.42;

  // --- Precompute pin positions ---
  const pinX = new Float32Array(N);
  const pinY = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const angle = rotAngle + (i / N) * Math.PI * 2 - Math.PI * 0.5;
    pinX[i] = cx + Math.cos(angle) * radius;
    pinY[i] = cy + Math.sin(angle) * radius;
  }

  // --- Per-band layers ---
  p.noFill();
  for (let band = 0; band < bandCount; band++) {
    const amp = amps[band] ?? 0;
    const tMult = transients[band] ?? 1;
    if (amp < 0.01) continue;

    // Slightly spread multiplier across bands for layered visual depth
    const layerM = multiplierAnim + (band - bandCount * 0.5) * 0.06;
    const hue = (hueOffset + (band / bandCount) * 270) % 360;
    const sat = 65 + amp * 30;
    const transientBoost = tMult > 1.2 ? (tMult - 1.2) * 2.5 : 0;
    const baseWeight = 0.5 + amp * 2.0 + transientBoost;

    // Pass 1 — outer glow (wide, very transparent)
    pAny.stroke(hue, sat * 0.55, 100, Math.min(0.06 + amp * 0.09, 0.18));
    p.strokeWeight(baseWeight * 5.5);
    strokeLayer(p, pinX, pinY, N, layerM);

    // Pass 2 — mid glow
    pAny.stroke(hue, sat * 0.8, 100, Math.min(0.16 + amp * 0.22, 0.45));
    p.strokeWeight(baseWeight * 2.2);
    strokeLayer(p, pinX, pinY, N, layerM);

    // Pass 3 — bright core
    pAny.stroke(hue, sat, 100, Math.min(0.55 + amp * 0.45, 1.0));
    p.strokeWeight(Math.max(baseWeight * 0.55, 0.5));
    strokeLayer(p, pinX, pinY, N, layerM);
  }

  // --- Beat flash overlay ---
  if (beatPulse > 0.01) {
    p.noStroke();
    pAny.fill((hueOffset + 30) % 360, 35, 100, beatPulse * 0.2);
    p.rect(0, 0, p.width, p.height);
  }

  p.colorMode(p['RGB'], 255);
}

/**
 * Draw one string-art layer: connect pin i to pin round(i * M) % N for all i.
 */
function strokeLayer(
  p: P5Instance,
  pinX: Float32Array,
  pinY: Float32Array,
  N: number,
  M: number
): void {
  for (let i = 0; i < N; i++) {
    const j = Math.round((i * M) % N);
    if (j === i) continue; // skip self-connections
    p.line(pinX[i], pinY[i], pinX[j], pinY[j]);
  }
}

export function resetStringart(): void {
  hueOffset = 0;
  multiplierAnim = 3.0;
  rotAngle = 0;
  beatPulse = 0;
  lastBeatIndex = -1;
}
