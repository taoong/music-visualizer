/**
 * Slider bindings for sensitivity, display, and volume controls
 */
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { BANDS } from '../utils/constants';

export function bindVolumeControl(): () => void {
  const volumeSlider = document.getElementById('master-volume') as HTMLInputElement | null;

  if (!volumeSlider) return () => {};

  const handler = () => {
    const value = parseFloat(volumeSlider.value);
    store.updateConfig('masterVolume', value);
    audioEngine.setVolume(value);
  };

  volumeSlider.addEventListener('input', handler);
  return () => volumeSlider.removeEventListener('input', handler);
}

export function bindSensitivitySliders(): () => void {
  const cleanupFns: (() => void)[] = [];

  // Freq mode sliders
  for (const band of BANDS) {
    const slider = document.getElementById(band.sliderId) as HTMLInputElement | null;
    if (slider) {
      const handler = () => {
        store.updateConfig(band.sens as keyof typeof store.config, parseFloat(slider.value));
      };
      slider.addEventListener('input', handler);
      cleanupFns.push(() => slider.removeEventListener('input', handler));
    }
  }

  // Stem mode sliders
  const stemConfigs = [
    { id: 'sens-kick', key: 'sensKick' },
    { id: 'sens-drums', key: 'sensDrums' },
    { id: 'sens-bass-stem', key: 'sensStemBass' },
    { id: 'sens-vocals', key: 'sensVocals' },
    { id: 'sens-other', key: 'sensOther' },
  ] as const;

  for (const { id, key } of stemConfigs) {
    const slider = document.getElementById(id) as HTMLInputElement | null;
    if (slider) {
      const handler = () => {
        store.updateConfig(key, parseFloat(slider.value));
      };
      slider.addEventListener('input', handler);
      cleanupFns.push(() => slider.removeEventListener('input', handler));
    }
  }

  return () => cleanupFns.forEach(fn => fn());
}

export function bindDisplaySliders(): () => void {
  const cleanupFns: (() => void)[] = [];

  const configs = [
    { id: 'spike-scale', key: 'spikeScale' },
    { id: 'decay-rate', key: 'decayRate' },
    { id: 'rotation-speed', key: 'rotationSpeed' },
    { id: 'viz-intensity', key: 'intensity' },
    { id: 'beat-division', key: 'beatDivision' },
    { id: 'highway-cam-follow', key: 'highwayCamFollow' },
    { id: 'highway-horizon', key: 'highwayHorizon' },
    { id: 'highway-road-width', key: 'highwayRoadWidth' },
    { id: 'highway-day-speed', key: 'highwayDaySpeed' },
    { id: 'sculpture-zoom', key: 'sculptureZoom' },
    { id: 'circle-image-rotation', key: 'circleImageRotation' },
    { id: 'boots-acceleration', key: 'bootsAcceleration' },
    { id: 'rippletank-beat-freq', key: 'rippletankBeatFreq' },
    { id: 'rippletank-water-speed', key: 'rippletankWaterSpeed' },
    { id: 'rippletank-beat-surge', key: 'rippletankBeatSurge' },
    { id: 'cymatics-beat-freq', key: 'cymaticsBeatFreq' },
    { id: 'cymatics-sand-size', key: 'cymaticsSandSize' },
    { id: 'cymatics-sand-speed', key: 'cymaticsSandSpeed' },
    { id: 'cloud-magnetic-field', key: 'cloudMagneticField' },
    { id: 'cloud-particle-life', key: 'cloudParticleLife' },
    { id: 'cloud-beat-freq', key: 'cloudBeatFreq' },
    { id: 'cloud-beat-boost', key: 'cloudBeatBoost' },
    { id: 'attractor-chaos', key: 'attractorChaos' },
    { id: 'attractor-trail-length', key: 'attractorTrailLength' },
    { id: 'mandala-beat-freq', key: 'mandalaBeatFreq' },
    { id: 'mandala-grid-speed', key: 'mandalaGridSpeed' },
    { id: 'mandala-hex-speed', key: 'mandalaHexSpeed' },
    { id: 'mandala-square-speed', key: 'mandalaSquareSpeed' },
    { id: 'mandala-tri-speed', key: 'mandalaTriSpeed' },
    { id: 'mandala-circle-speed', key: 'mandalaCircleSpeed' },
    { id: 'stringart-pins', key: 'stringartPins' },
    { id: 'stringart-multiplier', key: 'stringartMultiplier' },
    { id: 'stringart-speed', key: 'stringartSpeed' },
    { id: 'constellation-star-count', key: 'constellationStarCount' },
    { id: 'constellation-conn-range', key: 'constellationConnRange' },
    { id: 'constellation-drift-speed', key: 'constellationDriftSpeed' },
    { id: 'petals-petal-count', key: 'petalsPetalCount' },
    { id: 'petals-bloom-scale', key: 'petalsBloomScale' },
    { id: 'petals-spin-speed', key: 'petalsSpinSpeed' },
  ] as const;

  for (const { id, key } of configs) {
    const slider = document.getElementById(id) as HTMLInputElement | null;
    if (slider) {
      const handler = () => {
        store.updateConfig(key, parseFloat(slider.value));
      };
      slider.addEventListener('input', handler);
      cleanupFns.push(() => slider.removeEventListener('input', handler));
    }
  }

  return () => cleanupFns.forEach(fn => fn());
}

export function setSlider(id: string, value: number): void {
  const el = document.getElementById(id) as HTMLInputElement | null;
  if (el) {
    el.value = String(value);
    el.dispatchEvent(new Event('input'));
  }
}
