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
import { drawPhase, resetPhase } from './phase';
import { drawWarp, resetWarp } from './warp';
import { drawSubstrate, resetSubstrate } from './substrate';
import { drawSmear, resetSmear } from './smear';
import { drawInk, resetInk } from './ink';
import { drawNebula, resetNebula } from './nebula';
import { drawVortex, resetVortex } from './vortex';
import { drawLumia, resetLumia } from './lumia';
import { drawMirrors, resetMirrors } from './mirrors';
import { drawWoodMirror, resetWoodMirror } from './woodmirror';
import { drawDisco, resetDisco } from './disco';
import { drawMoire, resetMoire } from './moire';
import { drawRadiolaria, resetRadiolaria } from './radiolaria';
import { drawNoctiluca, resetNoctiluca } from './noctiluca';
import { drawFerrofluid, resetFerrofluid } from './ferrofluid';
import { drawSpirograph, resetSpirograph } from './spirograph';
import { drawMobile, resetMobile } from './mobile';
import { drawIridescent, resetIridescent } from './iridescent';
import { drawStrata, resetStrata } from './strata';
import { drawBoogie, resetBoogie } from './boogie';
import { drawFeedback, resetFeedback, disposeFeedback } from './feedback';
import { drawTesseract, resetTesseract } from './tesseract';
import { drawLumiere, resetLumiere } from './lumiere';
import { drawHilbert, resetHilbert } from './hilbert';
import { drawDelaunay, resetDelaunay } from './delaunay';
import { drawKintsugi, resetKintsugi } from './kintsugi';
import { drawJulia, resetJulia } from './julia';
import { drawKandinsky, resetKandinsky } from './kandinsky';
import { drawApollonian, resetApollonian } from './apollonian';
import { drawDendrite, resetDendrite } from './dendrite';
import { drawWebwork, resetWebwork } from './webwork';
import { drawSupershapes, resetSupershapes } from './supershapes';
import { drawCorridor, resetCorridor } from './corridor';
import { drawGanzfeld, resetGanzfeld } from './ganzfeld';
import { drawPlaid, resetPlaid } from './plaid';
import { drawNewton, resetNewton } from './newton';
import { drawPointillism, resetPointillism } from './pointillism';
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
  phase:         { draw: drawPhase,          reset: resetPhase,         key: '+',  label: 'Phase' },
  warp:          { draw: drawWarp,           reset: resetWarp,          key: '}',  label: 'Warp' },
  substrate:     { draw: drawSubstrate,     reset: resetSubstrate,     key: 'g',  label: 'Substrate' },
  smear:         { draw: drawSmear,        reset: resetSmear,         key: '{',  label: 'Smear' },
  ink:           { draw: drawInk,          reset: resetInk,           key: '<',  label: 'Ink Wash' },
  nebula:        { draw: drawNebula,      reset: resetNebula,        key: ')',  label: 'Nebula' },
  vortex:        { draw: drawVortex,     reset: resetVortex,        key: 'u',  label: 'Vortex' },
  lumia:         { draw: drawLumia,     reset: resetLumia,         key: ']',  label: 'Lumia' },
  mirrors:       { draw: drawMirrors,  reset: resetMirrors,        key: '(',  label: 'Mirrors' },
  woodmirror:    { draw: drawWoodMirror, reset: resetWoodMirror,   key: '%',  label: 'Wood Mirror' },
  disco:         { draw: drawDisco,      reset: resetDisco,         key: '_',  label: 'Disco' },
  moire:         { draw: drawMoire,      reset: resetMoire,         key: 'f',  label: 'Moiré' },
  radiolaria:    { draw: drawRadiolaria, reset: resetRadiolaria,    key: '`',  label: 'Radiolaria' },
  noctiluca:     { draw: drawNoctiluca,  reset: resetNoctiluca,     key: ':',  label: 'Noctiluca' },
  ferrofluid:    { draw: drawFerrofluid, reset: resetFerrofluid,    key: '8',  label: 'Ferrofluid' },
  spirograph:    { draw: drawSpirograph, reset: resetSpirograph,    key: '"',  label: 'Spirograph' },
  mobile:        { draw: drawMobile,     reset: resetMobile,        key: 'M',  label: 'Mobile' },
  iridescent:    { draw: drawIridescent, reset: resetIridescent,    key: 'J',  label: 'Iridescent' },
  strata:        { draw: drawStrata,     reset: resetStrata,        key: 'Z',  label: 'Strata' },
  boogie:        { draw: drawBoogie,     reset: resetBoogie,        key: 'B',  label: 'Boogie' },
  feedback:      { draw: drawFeedback,       reset: resetFeedback,      dispose: disposeFeedback, key: 'C', label: 'Feedback' },
  tesseract:     { draw: drawTesseract,      reset: resetTesseract,                               key: 'T', label: 'Tesseract' },
  lumiere:       { draw: drawLumiere,        reset: resetLumiere,                                 key: 'A', label: 'Lumière' },
  hilbert:       { draw: drawHilbert,        reset: resetHilbert,                                 key: 'D', label: 'Hilbert' },
  delaunay:      { draw: drawDelaunay,       reset: resetDelaunay,                                key: 'E', label: 'Delaunay' },
  kintsugi:      { draw: drawKintsugi,       reset: resetKintsugi,                                key: 'G', label: 'Kintsugi' },
  julia:         { draw: drawJulia,          reset: resetJulia,                                   key: 'N', label: 'Julia Set' },
  kandinsky:     { draw: drawKandinsky,      reset: resetKandinsky,                               key: 'K', label: 'Kandinsky' },
  apollonian:    { draw: drawApollonian,     reset: resetApollonian,                              key: 'P', label: 'Apollonian' },
  dendrite:      { draw: drawDendrite,       reset: resetDendrite,                                key: 'L', label: 'Dendrite' },
  webwork:       { draw: drawWebwork,        reset: resetWebwork,                                 key: 'O', label: 'Web Work' },
  supershapes:   { draw: drawSupershapes,    reset: resetSupershapes,                             key: 'V', label: 'Super Forms' },
  corridor:      { draw: drawCorridor,       reset: resetCorridor,                                key: 'Q', label: 'Corridor' },
  ganzfeld:      { draw: drawGanzfeld,       reset: resetGanzfeld,                                key: 'X', label: 'Ganzfeld' },
  plaid:         { draw: drawPlaid,          reset: resetPlaid,                                   key: 'W', label: 'Plaid' },
  newton:        { draw: drawNewton,         reset: resetNewton,                                  key: 'F', label: 'Newton' },
  pointillism:   { draw: drawPointillism,    reset: resetPointillism,                             key: 'U', label: 'Pointillism' },
};
