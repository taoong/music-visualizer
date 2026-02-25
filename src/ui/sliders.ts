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
    { id: 'balls-kick-boost', key: 'ballsKickBoost' },
    { id: 'viz-intensity', key: 'intensity' },
    { id: 'beat-division', key: 'beatDivision' },
    { id: 'pong-ball-count', key: 'pongBallCount' },
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
