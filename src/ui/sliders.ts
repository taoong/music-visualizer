/**
 * Slider bindings for sensitivity, display, and volume controls
 */
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { BANDS } from '../utils/constants';

export function bindVolumeControl(): () => void {
  const volumeSlider = document.getElementById('master-volume') as HTMLInputElement | null;
  const splashSlider = document.getElementById('splash-volume') as HTMLInputElement | null;

  function applyVolume(value: number): void {
    store.updateConfig('masterVolume', value);
    audioEngine.setVolume(value);
    // Keep both sliders in sync
    if (volumeSlider) volumeSlider.value = String(value);
    if (splashSlider) {
      splashSlider.value = String(value);
      splashSlider.style.setProperty('--val', String(Math.round(value * 100)));
    }
  }

  // Set initial fill position on the splash slider
  if (splashSlider) {
    splashSlider.style.setProperty('--val', String(Math.round(parseFloat(splashSlider.value) * 100)));
  }

  const handlers: (() => void)[] = [];

  for (const slider of [volumeSlider, splashSlider]) {
    if (!slider) continue;
    const handler = () => applyVolume(parseFloat(slider.value));
    slider.addEventListener('input', handler);
    handlers.push(() => slider.removeEventListener('input', handler));
  }

  return () => handlers.forEach(fn => fn());
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
    { id: 'rippletank-beat-freq', key: 'rippletankBeatFreq' },
    { id: 'rippletank-water-speed', key: 'rippletankWaterSpeed' },
    { id: 'rippletank-beat-surge', key: 'rippletankBeatSurge' },
    { id: 'cymatics-beat-freq', key: 'cymaticsBeatFreq' },
    { id: 'cymatics-sand-size', key: 'cymaticsSandSize' },
    { id: 'cymatics-sand-speed', key: 'cymaticsSandSpeed' },
    { id: 'attractor-chaos', key: 'attractorChaos' },
    { id: 'attractor-trail-length', key: 'attractorTrailLength' },
    { id: 'stringart-pins', key: 'stringartPins' },
    { id: 'stringart-multiplier', key: 'stringartMultiplier' },
    { id: 'stringart-speed', key: 'stringartSpeed' },
    { id: 'constellation-star-count', key: 'constellationStarCount' },
    { id: 'constellation-conn-range', key: 'constellationConnRange' },
    { id: 'constellation-drift-speed', key: 'constellationDriftSpeed' },
    { id: 'waterfall-scroll-speed', key: 'waterfallScrollSpeed' },
    { id: 'waterfall-gain', key: 'waterfallGain' },
    { id: 'waterfall-hue', key: 'waterfallHue' },
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
    { id: 'physarum-agents', key: 'physarumAgents' },
    { id: 'physarum-evaporation', key: 'physarumEvaporation' },
    { id: 'physarum-sensor', key: 'physarumSensor' },
    { id: 'geodesic-shells', key: 'geodesicShells' },
    { id: 'geodesic-spin', key: 'geodesicSpin' },
    { id: 'geodesic-glow', key: 'geodesicGlow' },
    { id: 'ribbons-count', key: 'ribbonsCount' },
    { id: 'ribbons-wave', key: 'ribbonsWave' },
    { id: 'ribbons-shimmer', key: 'ribbonsShimmer' },
    { id: 'infinitynet-scale', key: 'infinitynetScale' },
    { id: 'infinitynet-breathe', key: 'infinitynetBreathe' },
    { id: 'infinitynet-palette', key: 'infinitynetPalette' },
    { id: 'arabesque-steps', key: 'arabesqueSteps' },
    { id: 'arabesque-speed', key: 'arabesqueSpeed' },
    { id: 'arabesque-trail', key: 'arabesqueTrail' },
    { id: 'murmu-birds', key: 'murmuBirds' },
    { id: 'murmu-cohesion', key: 'murmuCohesion' },
    { id: 'murmu-trail', key: 'murmuTrail' },
    { id: 'epicycles-cycles', key: 'epicyclesCycles' },
    { id: 'epicycles-speed', key: 'epicyclesSpeed' },
    { id: 'epicycles-trail', key: 'epicyclesTrail' },
    { id: 'knots-topology', key: 'knotsTopology' },
    { id: 'knots-glow', key: 'knotsGlow' },
    { id: 'knots-speed', key: 'knotsSpeed' },
    { id: 'penrose-density', key: 'penroseDensity' },
    { id: 'penrose-spin', key: 'penroseSpin' },
    { id: 'penrose-glow', key: 'penroseGlow' },
    { id: 'flame-density', key: 'flameDensity' },
    { id: 'flame-glow', key: 'flameGlow' },
    { id: 'flame-mutation', key: 'flameMutation' },
    { id: 'aurora-curtains', key: 'auroraCurtains' },
    { id: 'aurora-wave', key: 'auroraWave' },
    { id: 'aurora-hue', key: 'auroraHue' },
    { id: 'disorders-grid', key: 'disordersGrid' },
    { id: 'disorders-chaos', key: 'disordersChaos' },
    { id: 'disorders-interrupt', key: 'disordersInterrupt' },
    { id: 'blackwave-density', key: 'blackwaveDensity' },
    { id: 'blackwave-swell', key: 'blackwaveSwell' },
    { id: 'blackwave-hue', key: 'blackwaveHue' },
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
