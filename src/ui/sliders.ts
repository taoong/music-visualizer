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
    { id: 'knots-beat-freq', key: 'knotsBeatFreq' },
    { id: 'knots-glow', key: 'knotsGlow' },
    { id: 'knots-speed', key: 'knotsSpeed' },
    { id: 'penrose-density', key: 'penroseDensity' },
    { id: 'penrose-spin', key: 'penroseSpin' },
    { id: 'penrose-glow', key: 'penroseGlow' },
    { id: 'flame-density', key: 'flameDensity' },
    { id: 'flame-glow', key: 'flameGlow' },
    { id: 'flame-mutation', key: 'flameMutation' },
    { id: 'disorders-grid', key: 'disordersGrid' },
    { id: 'disorders-chaos', key: 'disordersChaos' },
    { id: 'disorders-interrupt', key: 'disordersInterrupt' },
    { id: 'blackwave-density', key: 'blackwaveDensity' },
    { id: 'blackwave-swell', key: 'blackwaveSwell' },
    { id: 'blackwave-hue', key: 'blackwaveHue' },
    { id: 'origami-fold', key: 'origamiFold' },
    { id: 'origami-grid', key: 'origamiGrid' },
    { id: 'origami-wave', key: 'origamiWave' },
    { id: 'lightfield-grid', key: 'lightfieldGrid' },
    { id: 'lightfield-flow', key: 'lightfieldFlow' },
    { id: 'lightfield-glow', key: 'lightfieldGlow' },
    { id: 'brush-strokes', key: 'brushStrokes' },
    { id: 'brush-weight', key: 'brushWeight' },
    { id: 'brush-trail', key: 'brushTrail' },
    { id: 'aurora-flow', key: 'auroraFlow' },
    { id: 'aurora-layers', key: 'auroraLayers' },
    { id: 'aurora-glow', key: 'auroraGlow' },
    { id: 'glitch-distort', key: 'glitchDistort' },
    { id: 'glitch-split', key: 'glitchSplit' },
    { id: 'glitch-noise', key: 'glitchNoise' },
    { id: 'phase-rings', key: 'phaseRings' },
    { id: 'phase-density', key: 'phaseDensity' },
    { id: 'phase-glow', key: 'phaseGlow' },
    { id: 'warp-speed', key: 'warpSpeed' },
    { id: 'warp-density', key: 'warpDensity' },
    { id: 'warp-trail', key: 'warpTrail' },
    { id: 'substrate-density', key: 'substrateDensity' },
    { id: 'substrate-speed', key: 'substrateSpeed' },
    { id: 'substrate-fade', key: 'substrateFade' },
    { id: 'smear-sweep', key: 'smearSweep' },
    { id: 'smear-blend', key: 'smearBlend' },
    { id: 'smear-palette', key: 'smearPalette' },
    { id: 'ink-flow', key: 'inkFlow' },
    { id: 'ink-density', key: 'inkDensity' },
    { id: 'ink-dry', key: 'inkDry' },
    { id: 'nebula-warp', key: 'nebulaWarp' },
    { id: 'nebula-drift', key: 'nebulaDrift' },
    { id: 'nebula-palette', key: 'nebulaPalette' },
    { id: 'vortex-arms', key: 'vortexArms' },
    { id: 'vortex-twist', key: 'vortexTwist' },
    { id: 'vortex-speed', key: 'vortexSpeed' },
    { id: 'lumia-forms', key: 'lumiaForms' },
    { id: 'lumia-drift', key: 'lumiaDrift' },
    { id: 'lumia-glow', key: 'lumiaGlow' },
    { id: 'mirrors-reflections', key: 'mirrorsReflections' },
    { id: 'mirrors-scatter', key: 'mirrorsScatter' },
    { id: 'mirrors-shimmer', key: 'mirrorsShimmer' },
    { id: 'woodmirror-density', key: 'woodmirrorDensity' },
    { id: 'woodmirror-depth', key: 'woodmirrorDepth' },
    { id: 'woodmirror-speed', key: 'woodmirrorSpeed' },
    { id: 'disco-spin', key: 'discoSpin' },
    { id: 'disco-sparkle', key: 'discoSparkle' },
    { id: 'disco-palette', key: 'discoPalette' },
    { id: 'moire-rings', key: 'moireRings' },
    { id: 'moire-interference', key: 'moireInterference' },
    { id: 'moire-contrast', key: 'moireContrast' },
    { id: 'radiolaria-arms', key: 'radiolariaArms' },
    { id: 'radiolaria-shells', key: 'radiolariaShells' },
    { id: 'radiolaria-spine', key: 'radiolariaSpine' },
    { id: 'radiolaria-glow', key: 'radiolariaGlow' },
    { id: 'noctiluca-drift', key: 'noctilucaDrift' },
    { id: 'noctiluca-bloom', key: 'noctilucaBloom' },
    { id: 'noctiluca-wake',  key: 'noctilucaWake' },
    { id: 'ferrofluid-spikes',  key: 'ferrofluidSpikes' },
    { id: 'ferrofluid-sheen',   key: 'ferrofluidSheen' },
    { id: 'ferrofluid-surface', key: 'ferrofluidSurface' },
    { id: 'spirograph-layers',     key: 'spirographLayers' },
    { id: 'spirograph-complexity', key: 'spirographComplexity' },
    { id: 'spirograph-trail',      key: 'spirographTrail' },
    { id: 'mobile-shapes', key: 'mobileShapes' },
    { id: 'mobile-swing',  key: 'mobileSwing' },
    { id: 'mobile-wind',   key: 'mobileWind' },
    { id: 'irid-film',   key: 'iridFilm' },
    { id: 'irid-ripple', key: 'iridRipple' },
    { id: 'irid-speed',  key: 'iridSpeed' },
    { id: 'strata-density', key: 'strataDensity' },
    { id: 'strata-swell',   key: 'strataSwell' },
    { id: 'strata-hue',     key: 'strataHue' },
    { id: 'boogie-grid',    key: 'boogieGrid' },
    { id: 'boogie-speed',   key: 'boogieSpeed' },
    { id: 'boogie-vivid',   key: 'boogieVivid' },
    { id: 'feedback-zoom', key: 'feedbackZoom' },
    { id: 'feedback-spin', key: 'feedbackSpin' },
    { id: 'feedback-trail', key: 'feedbackTrail' },
    { id: 'tesseract-layers', key: 'tesseractLayers' },
    { id: 'tesseract-spin',   key: 'tesseractSpin' },
    { id: 'tesseract-glow',   key: 'tesseractGlow' },
    { id: 'lumiere-lines', key: 'lumiereLines' },
    { id: 'lumiere-drift', key: 'lumiereDrift' },
    { id: 'lumiere-glow',  key: 'lumiereGlow' },
    { id: 'hilbert-order', key: 'hilbertOrder' },
    { id: 'hilbert-warp',  key: 'hilbertWarp' },
    { id: 'hilbert-glow',  key: 'hilbertGlow' },
    { id: 'hilbert-trail', key: 'hilbertTrail' },
    { id: 'delaunay-sectors',  key: 'delaunaySectors' },
    { id: 'delaunay-spin',     key: 'delaunaySpin' },
    { id: 'delaunay-contrast', key: 'delaunayContrast' },
    { id: 'kintsugi-cracks', key: 'kintsugiCracks' },
    { id: 'kintsugi-glow',   key: 'kintsugiGlow' },
    { id: 'kintsugi-decay',  key: 'kintsugiDecay' },
    { id: 'julia-zoom',       key: 'juliaZoom' },
    { id: 'julia-iterations', key: 'juliaIterations' },
    { id: 'julia-hue',        key: 'juliaHue' },
    { id: 'kandinsky-density', key: 'kandinskyDensity' },
    { id: 'kandinsky-motion',  key: 'kandinskyMotion' },
    { id: 'kandinsky-palette', key: 'kandinskyPalette' },
    { id: 'apollonian-depth',   key: 'apollonianDepth' },
    { id: 'apollonian-glow',    key: 'apollonianGlow' },
    { id: 'apollonian-palette', key: 'apollonianPalette' },
    { id: 'dendrite-growth', key: 'dendriteGrowth' },
    { id: 'dendrite-glow',   key: 'dendriteGlow' },
    { id: 'dendrite-chaos',  key: 'dendriteChaos' },
    { id: 'webwork-strands', key: 'webworkStrands' },
    { id: 'webwork-dew',     key: 'webworkDew' },
    { id: 'webwork-pulse',   key: 'webworkPulse' },
    { id: 'supershapes-symmetry', key: 'supershapesSymmetry' },
    { id: 'supershapes-morph',    key: 'supershapesMorph' },
    { id: 'supershapes-glow',     key: 'supershapesGlow' },
    { id: 'corridor-speed',   key: 'corridorSpeed' },
    { id: 'corridor-depth',   key: 'corridorDepth' },
    { id: 'corridor-palette', key: 'corridorPalette' },
    { id: 'ganzfeld-zones', key: 'ganzfeldZones' },
    { id: 'ganzfeld-haze',  key: 'ganzfeldHaze' },
    { id: 'ganzfeld-drift', key: 'ganzfeldDrift' },
    { id: 'plaid-scale', key: 'plaidScale' },
    { id: 'plaid-weave', key: 'plaidWeave' },
    { id: 'plaid-hue',   key: 'plaidHue' },
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
