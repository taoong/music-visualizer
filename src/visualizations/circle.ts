/**
 * Circle visualization with frequency-driven spikes
 */
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import {
  SPIKES_PER_BAND,
  DELTA_SPIKE_WIDTH_MIN,
  DELTA_SPIKE_WIDTH_MAX,
  DELTA_LENGTH_BOOST,
} from '../utils/constants';
import { getBandData } from './helpers';
import { getUserImage } from './userImage';

export function drawSpikeCircle(p: P5Instance): void {
  const { state, config, audioState } = store;

  // Beat-reactive color: change hue on BPM grid (phase-aligned to first beat)
  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    const currentBeatIndex = adjusted >= 0 ? Math.floor(adjusted / state.beatIntervalSec) : -1;
    if (currentBeatIndex >= 0 && currentBeatIndex !== state.lastBeatIndex) {
      state.circleOutlineHue = (state.circleOutlineHue + 90 + Math.random() * 180) % 360;
      state.lastBeatIndex = currentBeatIndex;
    }
  }

  const cx = p.width / 2;
  const cy = p.height / 2;
  const minDim = Math.min(p.width, p.height);
  const baseRadius = minDim * 0.12;
  const maxSpikeLen = minDim * 0.35;

  const isFreqMode = state.mode === 'freq';
  const bandCount = isFreqMode ? 7 : 5;
  const totalSpikes = SPIKES_PER_BAND * bandCount;

  const angleStep = (Math.PI * 2) / totalSpikes;
  const rotation = (p.millis() / 1000.0) * config.rotationSpeed * 0.4;

  p.push();
  p.translate(cx, cy + audioState.centroidYOffset);

  // Draw spikes as tapered triangles
  p.noStroke();
  for (let i = 0; i < totalSpikes; i++) {
    const angle = i * angleStep + rotation;
    const band = Math.floor(i / SPIKES_PER_BAND);
    const bandIdx = i % SPIKES_PER_BAND;

    const { amp: rawAmp, tMult, delta } = getBandData(band, bandIdx);

    const amp = rawAmp * config.spikeScale * tMult;

    const spikeLen = amp * maxSpikeLen * (1.0 + delta * DELTA_LENGTH_BOOST);
    if (spikeLen < 0.5) continue;

    // Spike base half-width — high delta = narrow/punchy, low delta = wide/sustained
    const widthFactor =
      DELTA_SPIKE_WIDTH_MAX - delta * (DELTA_SPIKE_WIDTH_MAX - DELTA_SPIKE_WIDTH_MIN);
    const halfBase = angleStep * (widthFactor + amp * 0.1);

    const innerR = baseRadius;
    const outerR = baseRadius + spikeLen;

    // Brightness scales with amplitude + delta boost
    const brightness = 120 + Math.min(amp, 1.0) * 135 + delta * 30;
    p.fill(brightness);

    p.beginShape();
    p.vertex(Math.cos(angle - halfBase) * innerR, Math.sin(angle - halfBase) * innerR);
    p.vertex(Math.cos(angle) * outerR, Math.sin(angle) * outerR);
    p.vertex(Math.cos(angle + halfBase) * innerR, Math.sin(angle + halfBase) * innerR);
    p.endShape(0); // CLOSE constant
  }

  // Draw base circle on top (beat-reactive color)
  p.noFill();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (p as any).colorMode(p['HSB'], 360, 100, 100);
  p.stroke(state.circleOutlineHue, 85, 100);
  p.strokeWeight(2);
  p.ellipse(0, 0, baseRadius * 2, baseRadius * 2);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (p as any).colorMode(p['RGB'], 255);

  // Draw user image clipped to center circle
  const userImg = getUserImage();
  if (userImg) {
    const ctx = p.drawingContext;
    ctx.save();
    ctx.beginPath();
    ctx.arc(0, 0, baseRadius - 2, 0, Math.PI * 2);
    ctx.clip();

    const imgEl = userImg.elt;
    const r = baseRadius - 2;
    const imgAspect = imgEl.naturalWidth / imgEl.naturalHeight;
    let drawW: number, drawH: number;
    if (imgAspect > 1) {
      drawH = r * 2;
      drawW = drawH * imgAspect;
    } else {
      drawW = r * 2;
      drawH = drawW / imgAspect;
    }
    ctx.drawImage(imgEl, -drawW / 2, -drawH / 2, drawW, drawH);
    ctx.restore();
  }

  p.pop();
}
