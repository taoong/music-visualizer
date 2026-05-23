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
    { id: 'waterfall-scroll-speed', key: 'waterfallScrollSpeed' },
    { id: 'waterfall-gain', key: 'waterfallGain' },
    { id: 'waterfall-hue', key: 'waterfallHue' },
    { id: 'kaleido-segments', key: 'kaleidoSegments' },
    { id: 'kaleido-trail', key: 'kaleidoTrail' },
    { id: 'kaleido-smear', key: 'kaleidoSmear' },
    { id: 'kaleidoscope-segments', key: 'kaleidoscopeSegments' },
    { id: 'kaleidoscope-complexity', key: 'kaleidoscopeComplexity' },
    { id: 'kaleidoscope-spin-speed', key: 'kaleidoscopeSpinSpeed' },
    { id: 'weave-threads', key: 'weaveThreads' },
    { id: 'weave-glow', key: 'weaveGlow' },
    { id: 'weave-pulse', key: 'weavePulse' },
    { id: 'hive-hex-size', key: 'hiveHexSize' },
    { id: 'hive-glow', key: 'hiveGlow' },
    { id: 'hive-ripple', key: 'hiveRipple' },
    { id: 'marbling-hue', key: 'marblingHue' },
    { id: 'marbling-zoom', key: 'marblingZoom' },
    { id: 'marbling-speed', key: 'marblingSpeed' },
    { id: 'flowfield-turbulence', key: 'flowfieldTurbulence' },
    { id: 'flowfield-trail', key: 'flowfieldTrail' },
    { id: 'flowfield-width', key: 'flowfieldWidth' },
    { id: 'lissajous-curves', key: 'lissajousCurves' },
    { id: 'lissajous-glow', key: 'lissajousGlow' },
    { id: 'lissajous-drift', key: 'lissajousDrift' },
    { id: 'truchet-grid', key: 'truchetGrid' },
    { id: 'truchet-speed', key: 'truchetSpeed' },
    { id: 'truchet-glow', key: 'truchetGlow' },
    { id: 'topography-resolution', key: 'topographyResolution' },
    { id: 'topography-levels', key: 'topographyLevels' },
    { id: 'topography-speed', key: 'topographySpeed' },
    { id: 'interference-frequency', key: 'interferenceFrequency' },
    { id: 'interference-twist', key: 'interferenceTwist' },
    { id: 'interference-drift', key: 'interferenceDrift' },
    { id: 'voronoi-cells', key: 'voronoiCells' },
    { id: 'voronoi-glow', key: 'voronoiGlow' },
    { id: 'voronoi-shatter', key: 'voronoiShatter' },
    { id: 'blobs-viscosity', key: 'blobsViscosity' },
    { id: 'blobs-drift', key: 'blobsDrift' },
    { id: 'blobs-glow', key: 'blobsGlow' },
    { id: 'grayscott-feed', key: 'grayscottFeed' },
    { id: 'grayscott-kill', key: 'grayscottKill' },
    { id: 'grayscott-speed', key: 'grayscottSpeed' },
    { id: 'growth-speed', key: 'growthSpeed' },
    { id: 'growth-tension', key: 'growthTension' },
    { id: 'growth-repulsion', key: 'growthRepulsion' },
    { id: 'pixelsort-threshold', key: 'pixelsortThreshold' },
    { id: 'pixelsort-span', key: 'pixelsortSpan' },
    { id: 'pixelsort-hue', key: 'pixelsortHue' },
    { id: 'echoes-depth', key: 'echoesDepth' },
    { id: 'echoes-twist', key: 'echoesTwist' },
    { id: 'echoes-scale', key: 'echoesScale' },
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
