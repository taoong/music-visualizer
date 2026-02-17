/**
 * Spectrum bar visualization
 */
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import {
  SPIKES_PER_BAND,
  DELTA_LENGTH_BOOST,
  DELTA_BRIGHTNESS_BOOST,
  STEMS,
} from '../utils/constants';

export function drawSpectrum(p: P5Instance): void {
  const { state, config, audioState } = store;

  const hPad =
    /Android|iPhone|iPad|iPod|webOS/i.test(navigator.userAgent) ||
    (navigator.maxTouchPoints > 1 && window.innerWidth < 1024)
      ? 10
      : 40;
  const bottomMargin = 60 - audioState.centroidYOffset;
  const maxBarHeight = p.height * 0.7;

  const isFreqMode = state.mode === 'freq';
  const bandCount = isFreqMode ? 7 : 5;
  const totalBars = SPIKES_PER_BAND * bandCount;

  const availWidth = p.width - hPad * 2;
  const barStep = availWidth / totalBars;
  const gap = Math.max(barStep * 0.15, 0.5);
  const barWidth = Math.max(barStep - gap, 1);
  const usedWidth = totalBars * (barWidth + gap) - gap;
  const leftOffset = hPad + (availWidth - usedWidth) / 2;

  p.noStroke();
  for (let b = 0; b < bandCount; b++) {
    for (let i = 0; i < SPIKES_PER_BAND; i++) {
      const idx = b * SPIKES_PER_BAND + i;

      let amp = 0;
      let tMult = 1.0;
      let delta = 0;

      if (isFreqMode) {
        amp = audioState.smoothedBands[b][i];
        tMult = audioState.transientValues[b];
        delta = audioState.deltaValues[b];
      } else {
        const stem = STEMS[b];
        const stemSmoothed = audioEngine.getStemSmoothed();
        const stemTransients = audioState.transientStems;
        const stemDeltas = audioState.deltaStems;

        if (stemSmoothed?.[stem]) amp = stemSmoothed[stem][i];
        if (stemTransients[stem]) tMult = stemTransients[stem].multiplier;
        if (stemDeltas[stem]) delta = stemDeltas[stem].smoothed;
      }

      amp *= config.spikeScale * tMult;

      const barH = amp * maxBarHeight * (1.0 + delta * DELTA_LENGTH_BOOST);
      if (barH < 0.5) continue;

      const x = leftOffset + idx * (barWidth + gap);
      const y = p.height - bottomMargin - barH;

      const brightness = 80 + Math.min(amp, 1.0) * 175 + delta * DELTA_BRIGHTNESS_BOOST;
      p.fill(brightness);
      p.rect(x, y, barWidth, barH);
    }
  }
}
