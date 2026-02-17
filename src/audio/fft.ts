/**
 * FFT analysis helpers
 */
import {
  BANDS,
  BAND_COUNT,
  SPIKES_PER_BAND,
  OCTAVES,
  OCTAVE_COUNT,
  OCTAVE_SCALES,
} from '../utils/constants';

/**
 * Get FFT amplitudes for stem mode
 */
export function getFFTAmplitudes(fft: ToneFFT, count: number, scaleFactor: number): Float32Array {
  const vals = fft.getValue();
  const result = new Float32Array(count);
  const binsPer = Math.floor(vals.length / count);

  for (let i = 0; i < count; i++) {
    let sum = 0;
    let peak = 0;
    for (let j = 0; j < binsPer; j++) {
      const db = vals[i * binsPer + j];
      const lin = Math.pow(10, db / 20);
      sum += lin;
      if (lin > peak) peak = lin;
    }
    const avg = sum / binsPer;
    // Blend average with peak — peak dominates for punchy transients
    const blended = avg * 0.3 + peak * 0.7;
    result[i] = Math.min(blended * scaleFactor, 1.0);
  }
  return result;
}

/**
 * Get logarithmic band amplitudes for frequency mode
 */
export function getLogBandAmplitudes(fft: ToneFFT): Float32Array[] {
  const vals = fft.getValue();
  const sampleRate = Tone.context.sampleRate;
  const fftSize = vals.length * 2;
  const binHz = sampleRate / fftSize;
  const results: Float32Array[] = [];

  for (let b = 0; b < BAND_COUNT; b++) {
    const band = BANDS[b];
    let loBin = Math.floor(band.loHz / binHz);
    let hiBin = Math.ceil(band.hiHz / binHz);
    loBin = Math.max(1, Math.min(loBin, vals.length - 1));
    hiBin = Math.max(loBin, Math.min(hiBin, vals.length - 1));

    const numBins = hiBin - loBin + 1;
    const result = new Float32Array(SPIKES_PER_BAND);

    if (numBins <= 0) {
      // No bins in range — use nearest bin, fill uniformly
      const nearestBin = Math.max(1, Math.min(Math.round(band.loHz / binHz), vals.length - 1));
      const db = vals[nearestBin];
      const lin = Math.pow(10, db / 20);
      const scaled = Math.min(lin * band.scale, 1.0);
      result.fill(scaled);
    } else {
      // Distribute bins into SPIKES_PER_BAND output slots
      const binsPerSlot = numBins / SPIKES_PER_BAND;

      for (let i = 0; i < SPIKES_PER_BAND; i++) {
        const slotStart = loBin + Math.floor(i * binsPerSlot);
        const slotEnd = Math.min(loBin + Math.floor((i + 1) * binsPerSlot), hiBin + 1);
        const count = Math.max(1, slotEnd - slotStart);

        let sum = 0;
        let peak = 0;
        for (let j = slotStart; j < slotStart + count; j++) {
          const binIdx = Math.min(j, vals.length - 1);
          const db = vals[binIdx];
          const lin = Math.pow(10, db / 20);
          sum += lin;
          if (lin > peak) peak = lin;
        }
        const avg = sum / count;
        const blended = avg * 0.3 + peak * 0.7;
        result[i] = Math.min(blended * band.scale, 1.0);
      }
    }

    results.push(result);
  }

  return results;
}

/**
 * Get octave-based amplitudes for tunnel visualization
 */
export function getOctaveAmplitudes(fft: ToneFFT): Float32Array {
  const vals = fft.getValue();
  const sampleRate = Tone.context.sampleRate;
  const fftSize = vals.length * 2;
  const binHz = sampleRate / fftSize;
  const result = new Float32Array(OCTAVE_COUNT);

  for (let o = 0; o < OCTAVE_COUNT; o++) {
    const oct = OCTAVES[o];
    let loBin = Math.floor(oct.loHz / binHz);
    let hiBin = Math.ceil(oct.hiHz / binHz);
    loBin = Math.max(1, Math.min(loBin, vals.length - 1));
    hiBin = Math.max(loBin, Math.min(hiBin, vals.length - 1));

    const numBins = hiBin - loBin + 1;
    if (numBins <= 1) {
      // Sub-resolution octave — use nearest bin
      const nearestBin = Math.max(1, Math.min(Math.round(oct.loHz / binHz), vals.length - 1));
      const lin = Math.pow(10, vals[nearestBin] / 20);
      result[o] = Math.min(lin * OCTAVE_SCALES[o], 1.0);
    } else {
      let sum = 0;
      let peak = 0;
      for (let j = loBin; j <= hiBin; j++) {
        const lin = Math.pow(10, vals[j] / 20);
        sum += lin;
        if (lin > peak) peak = lin;
      }
      const avg = sum / numBins;
      const blended = avg * 0.3 + peak * 0.7;
      result[o] = Math.min(blended * OCTAVE_SCALES[o], 1.0);
    }
  }
  return result;
}

/**
 * Get octave amplitudes from multiple stem FFTs
 */
export function getOctaveAmplitudesFromStems(
  stemFfts: Record<string, ToneFFT>,
  stems: readonly string[]
): Float32Array {
  const combined = new Float32Array(OCTAVE_COUNT);
  let count = 0;

  for (const stem of stems) {
    if (!stemFfts[stem]) continue;
    const octAmps = getOctaveAmplitudes(stemFfts[stem]);
    for (let o = 0; o < OCTAVE_COUNT; o++) {
      combined[o] += octAmps[o];
    }
    count++;
  }

  if (count > 0) {
    for (let o = 0; o < OCTAVE_COUNT; o++) {
      combined[o] /= count;
    }
  }
  return combined;
}

/**
 * Compute spectral centroid
 */
export function computeSpectralCentroid(fft: ToneFFT): number {
  const vals = fft.getValue();
  const sampleRate = Tone.context.sampleRate;
  const binCount = vals.length;
  const binWidth = sampleRate / (binCount * 2);

  let weightedSum = 0;
  let energySum = 0;

  for (let i = 1; i < binCount; i++) {
    const db = vals[i];
    const energy = Math.pow(10, db / 20);
    const freq = i * binWidth;
    weightedSum += freq * energy;
    energySum += energy;
  }

  if (energySum < 1e-10) return 80;
  return weightedSum / energySum;
}

/**
 * Compute spectral centroid from stem FFTs
 */
export function computeStemCentroid(
  stemFfts: Record<string, ToneFFT>,
  stems: readonly string[]
): number {
  let totalWeightedCentroid = 0;
  let totalEnergy = 0;

  for (const stem of stems) {
    if (!stemFfts[stem]) continue;
    const vals = stemFfts[stem].getValue();
    let stemEnergy = 0;
    for (let i = 1; i < vals.length; i++) {
      stemEnergy += Math.pow(10, vals[i] / 20);
    }
    const centroid = computeSpectralCentroid(stemFfts[stem]);
    totalWeightedCentroid += centroid * stemEnergy;
    totalEnergy += stemEnergy;
  }

  if (totalEnergy < 1e-10) return 80;
  return totalWeightedCentroid / totalEnergy;
}
