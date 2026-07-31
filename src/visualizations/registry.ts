/**
 * Visualization registry — single source of truth for dispatch, reset, dispose, and keyboard shortcuts.
 *
 * Importing directly from each viz file (not from ./index) avoids a circular dependency:
 *   index.ts → registry.ts → <viz>.ts is fine;
 *   registry.ts → index.ts → registry.ts would not be.
 */
import type { VizMode, InteractionEvent } from '../types';
import { drawSpikeCircle, resetSpikeCircle } from './circle';
import { drawSpectrum } from './spectrum';
import { drawTunnel } from './tunnel';
import { drawTetris, resetTetris } from './balls';
import { drawLasers, resetLasers } from './lasers';
import { drawText, resetText } from './text';
import { drawHighway, resetHighway } from './highway';
import { drawBinary, resetBinary } from './binary';
import { drawRippleTank, resetRippleTank } from './rippletank';
import { drawCymatics, resetCymatics } from './cymatics';
import { drawAttractor, resetAttractor } from './attractor';
import { drawStringart, resetStringart } from './stringart';
import { drawConstellation, resetConstellation } from './constellation';
import { drawWaterfall, resetWaterfall } from './waterfall';
import { drawWeave, resetWeave } from './weave';
import { drawSynthwave, resetSynthwave } from './synthwave';
import { drawBloom, resetBloom } from './bloom';
import { drawHive, resetHive } from './hive';
import { drawMarbling, resetMarbling } from './marbling';
import { drawFlowField, resetFlowField } from './flowfield';
import { drawTruchet, resetTruchet } from './truchet';
import { drawTopography, resetTopography } from './topography';
import { drawInterference, resetInterference } from './interference';
import { drawVoronoi, resetVoronoi } from './voronoi';
import { drawBlobs, resetBlobs } from './blobs';
import { drawGrayscott, resetGrayscott } from './grayscott';
import { drawGrowth, resetGrowth } from './growth';
import { drawPixelsort, resetPixelsort } from './pixelsort';
import { drawEchoes, resetEchoes } from './echoes';
import { drawPhysarum, resetPhysarum, interactPhysarum } from './physarum';
import { drawGeodesic, resetGeodesic } from './geodesic';
import { drawRibbons, resetRibbons } from './ribbons';
import { drawInfinityNet, resetInfinityNet } from './infinitynet';
import { drawArabesque, resetArabesque } from './arabesque';
import { drawEpicycles, resetEpicycles } from './epicycles';
import { drawMurmuration, resetMurmuration } from './murmuration';
import { drawKnots, resetKnots } from './knots';
import { drawPenrose, resetPenrose } from './penrose';
import { drawFlame, resetFlame } from './flame';
import { drawDisorders, resetDisorders } from './disorders';
import { drawBlackWave, resetBlackWave } from './blackwave';
import { drawOrigami, resetOrigami } from './origami';
import { drawLightField, resetLightField } from './lightfield';
import { drawBrush, resetBrush } from './brush';
import { drawAurora, resetAurora } from './aurora';
import { drawGlitch, resetGlitch } from './glitch';
import { drawWarp, resetWarp } from './warp';
import { drawVortex, resetVortex } from './vortex';
import { drawLumia, resetLumia } from './lumia';
import { drawWoodMirror, resetWoodMirror } from './woodmirror';
import { drawMoire, resetMoire } from './moire';
import { drawNoctiluca, resetNoctiluca } from './noctiluca';
import { drawTesseract, resetTesseract } from './tesseract';
import { drawSupershapes, resetSupershapes } from './supershapes';
import { drawCorridor, resetCorridor } from './corridor';
import { drawRiemann, resetRiemann } from './riemann';
import { drawGlyphs, resetGlyphs } from './glyphs';
import { drawRadiolaria, resetRadiolaria } from './radiolaria';
import { drawFerrofluid, resetFerrofluid } from './ferrofluid';
import { interactBlobs } from './blobs';
import { interactGrayscott } from './grayscott';
import { interactRippleTank } from './rippletank';
import { interactConstellation } from './constellation';
import { interactMarbling } from './marbling';
import { interactBloom } from './bloom';
import { interactHive } from './hive';
import { interactVoronoi } from './voronoi';
import { interactTetris } from './balls';
import { interactFlowField } from './flowfield';
import { interactLasers } from './lasers';
import { interactSynthwave } from './synthwave';
import { interactText } from './text';
import { interactHighway } from './highway';

/**
 * Wraps a dynamically-imported visualization so Three.js is only loaded when
 * the user actually switches to that mode, keeping it out of the main bundle.
 */
function lazyViz(
  loader: () => Promise<{ draw: (p: P5Instance, dt: number) => void; reset?: () => void; dispose?: () => void }>,
  key: string,
  label: string,
): VizEntry {
  type Mod = Awaited<ReturnType<typeof loader>>;
  let mod: Mod | null = null;
  let pending = false;

  function ensureLoaded() {
    if (!mod && !pending) {
      pending = true;
      loader().then(m => { mod = m; pending = false; }).catch(console.error);
    }
  }

  return {
    key,
    label,
    draw:    (p, dt) => { ensureLoaded(); mod?.draw(p, dt); },
    reset:   ()      => { ensureLoaded(); mod?.reset?.(); },
    dispose: ()      => mod?.dispose?.(),
  };
}

export type VizEntry = {
  draw: (p: P5Instance, dt: number) => void;
  reset?: () => void;
  dispose?: () => void;
  /** Called when interactive mode is active and the user taps/drags/presses a key on the canvas. */
  interact?: (event: InteractionEvent) => void;
  /** Keyboard shortcut character (single key). */
  key: string;
  label: string;
};

export const VIZ_REGISTRY: Record<VizMode, VizEntry> = {
  circle:        { draw: drawSpikeCircle,   reset: resetSpikeCircle,   key: '1',  label: 'Circle' },
  spectrum:      { draw: drawSpectrum,                                  key: '2',  label: 'Spectrum' },
  tunnel:        { draw: drawTunnel,                                    key: '3',  label: 'Tunnel' },
  tetris:        { draw: drawTetris,         reset: resetTetris,        key: '4',  label: 'Tetris',       interact: interactTetris },
  lasers:        { draw: drawLasers,         reset: resetLasers,        key: '5',  label: 'Lasers',       interact: (e) => interactLasers(e, window.p5Instance) },
  text:          { draw: drawText,           reset: resetText,          key: '6',  label: 'Text',         interact: interactText },
  highway:       { draw: drawHighway,        reset: resetHighway,       key: '7',  label: 'Highway',      interact: interactHighway },
  liquidmetal:   lazyViz(async () => { const { drawLiquidMetal: draw, resetLiquidMetal: reset, disposeLiquidMetal: dispose } = await import('./liquidmetal'); return { draw, reset, dispose }; }, '8', 'Liquid Metal'),
  neon:          lazyViz(async () => { const { drawNeon: draw, resetNeon: reset, disposeNeon: dispose } = await import('./neon'); return { draw, reset, dispose }; }, 'n', 'Neon Grid'),
  imagegrid:     lazyViz(async () => { const { drawImageGrid: draw, resetImageGrid: reset, disposeImageGrid: dispose } = await import('./imagegrid'); return { draw, reset, dispose }; }, 'g', 'Image Grid'),
  sculpture:     lazyViz(async () => { const { drawSculpture: draw, resetSculpture: reset, disposeSculpture: dispose } = await import('./sculpture'); return { draw, reset, dispose }; }, 'u', 'Sculpture'),
  binary:        { draw: drawBinary,         reset: resetBinary,        key: 'b',  label: 'Binary' },
  rippletank:    { draw: drawRippleTank,     reset: resetRippleTank,    key: 'w',  label: 'Ripple Tank',  interact: interactRippleTank },
  cymatics:      { draw: drawCymatics,       reset: resetCymatics,      key: 'y',  label: 'Cymatics' },
  attractor:     { draw: drawAttractor,      reset: resetAttractor,     key: 'j',  label: 'Attractor' },
  stringart:     { draw: drawStringart,      reset: resetStringart,     key: 'v',  label: 'String Art' },
  constellation: { draw: drawConstellation,  reset: resetConstellation, key: 'o',  label: 'Constellation', interact: (e) => interactConstellation(e, window.p5Instance) },
  waterfall:     { draw: drawWaterfall,      reset: resetWaterfall,     key: 'e',  label: 'Waterfall' },
  weave:         { draw: drawWeave,          reset: resetWeave,         key: 'z',  label: 'Weave' },
  synthwave:     { draw: drawSynthwave,      reset: resetSynthwave,     key: "'",  label: 'Synthwave',    interact: interactSynthwave },
  bloom:         { draw: drawBloom,          reset: resetBloom,         key: '0',  label: 'Bloom',        interact: (e) => interactBloom(e, window.p5Instance) },
  hive:          { draw: drawHive,           reset: resetHive,          key: '9',  label: 'Hive',         interact: (e) => interactHive(e, window.p5Instance) },
  marbling:      { draw: drawMarbling,       reset: resetMarbling,      key: ';',  label: 'Marbling',     interact: interactMarbling },
  flowfield:     { draw: drawFlowField,      reset: resetFlowField,     key: '[',  label: 'Flow Field',   interact: (e) => interactFlowField(e, window.p5Instance) },
  truchet:       { draw: drawTruchet,        reset: resetTruchet,       key: '\\', label: 'Truchet' },
  topography:    { draw: drawTopography,     reset: resetTopography,    key: '-',  label: 'Topography' },
  interference:  { draw: drawInterference,   reset: resetInterference,  key: '=',  label: 'Interference' },
  voronoi:       { draw: drawVoronoi,        reset: resetVoronoi,       key: '.',  label: 'Stained Glass', interact: interactVoronoi },
  blobs:         { draw: drawBlobs,          reset: resetBlobs,         key: ',',  label: 'Blobs',        interact: interactBlobs },
  grayscott:     { draw: drawGrayscott,      reset: resetGrayscott,     key: '/',  label: 'Gray-Scott',   interact: interactGrayscott },
  growth:        { draw: drawGrowth,         reset: resetGrowth,        key: '~',  label: 'Growth' },
  pixelsort:     { draw: drawPixelsort,      reset: resetPixelsort,     key: '@',  label: 'Pixel Sort' },
  echoes:        { draw: drawEchoes,         reset: resetEchoes,        key: '#',  label: 'Echoes' },
  physarum:      { draw: drawPhysarum,       reset: resetPhysarum,      key: '$',  label: 'Physarum',     interact: interactPhysarum },
  geodesic:      { draw: drawGeodesic,       reset: resetGeodesic,      key: '^',  label: 'Geodesic' },
  ribbons:       { draw: drawRibbons,        reset: resetRibbons,       key: '&',  label: 'Ribbons' },
  infinitynet:   { draw: drawInfinityNet,    reset: resetInfinityNet,   key: '*',  label: 'Infinity Net' },
  arabesque:     { draw: drawArabesque,      reset: resetArabesque,     key: '!',  label: 'Arabesque' },
  murmuration:   { draw: drawMurmuration,    reset: resetMurmuration,   key: '|',  label: 'Murmuration' },
  epicycles:     { draw: drawEpicycles,      reset: resetEpicycles,     key: '>',  label: 'Epicycles' },
  knots:         { draw: drawKnots,          reset: resetKnots,         key: 'n',  label: 'Knot' },
  penrose:       { draw: drawPenrose,        reset: resetPenrose,       key: 'p',  label: 'Penrose' },
  flame:         { draw: drawFlame,          reset: resetFlame,         key: 'l',  label: 'Fractal Flame' },
  disorders:     { draw: drawDisorders,      reset: resetDisorders,     key: 'k',  label: 'Disorders' },
  blackwave:     { draw: drawBlackWave,      reset: resetBlackWave,     key: 'q',  label: 'Black Wave' },
  origami:       { draw: drawOrigami,        reset: resetOrigami,       key: 't',  label: 'Origami' },
  lightfield:    { draw: drawLightField,     reset: resetLightField,    key: 'x',  label: 'Light Field' },
  brush:         { draw: drawBrush,          reset: resetBrush,         key: 'd',  label: 'Brush' },
  aurora:        { draw: drawAurora,         reset: resetAurora,        key: 'a',  label: 'Aurora' },
  glitch:        { draw: drawGlitch,         reset: resetGlitch,        key: 'c',  label: 'Glitch' },
  warp:          { draw: drawWarp,           reset: resetWarp,          key: '}',  label: 'Warp' },
  vortex:        { draw: drawVortex,         reset: resetVortex,        key: 'u',  label: 'Vortex' },
  lumia:         { draw: drawLumia,          reset: resetLumia,         key: ']',  label: 'Lumia' },
  woodmirror:    { draw: drawWoodMirror,     reset: resetWoodMirror,    key: '%',  label: 'Wood Mirror' },
  moire:         { draw: drawMoire,          reset: resetMoire,         key: 'f',  label: 'Moiré' },
  noctiluca:     { draw: drawNoctiluca,      reset: resetNoctiluca,     key: ':',  label: 'Noctiluca' },
  tesseract:     { draw: drawTesseract,      reset: resetTesseract,     key: 'T',  label: 'Tesseract' },
  supershapes:   { draw: drawSupershapes,    reset: resetSupershapes,   key: 'V',  label: 'Super Forms' },
  corridor:      { draw: drawCorridor,       reset: resetCorridor,      key: 'Q',  label: 'Corridor' },
  riemann:       { draw: drawRiemann,        reset: resetRiemann,       key: 'Y',  label: 'Riemann Sphere' },
  glyphs:        { draw: drawGlyphs,         reset: resetGlyphs,        key: 'g',  label: 'Glyphs' },
  radiolaria:    { draw: drawRadiolaria,     reset: resetRadiolaria,    key: 'X',  label: 'Radiolaria' },
  ferrofluid:    { draw: drawFerrofluid,    reset: resetFerrofluid,    key: 'E',  label: 'Ferrofluid' },
};
