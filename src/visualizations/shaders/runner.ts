/**
 * GLSL shader-mode runner — renders a fullscreen fragment shader with audio
 * uniforms into an offscreen WebGL2 canvas, then blits it onto the p5 canvas.
 *
 * Blitting (rather than stacking another overlay canvas) keeps shader modes on
 * the same path as every p5 viz: the post-FX chain, content layers and
 * interactive mode all work on them unchanged.
 *
 * Uniforms available to every shader (see SHADER_PRELUDE):
 *   uResolution  vec2   render-target size in pixels
 *   uTime        float  seconds since the mode was entered
 *   uFlow        float  accumulated "travel" — integrates the mode's speed()
 *                       so speed sliders never make motion jump
 *   uBeatTime    float  continuous beat counter (count + phase)
 *   uBeat        float  beat phase 0–1
 *   uPulse       float  1 on each beat, decays to 0
 *   uBpm         float
 *   uBands[7]    float  band amplitudes 0–1 (sub → brilliance)
 *   uLevel       float  mean band amplitude
 *   uCentroid    float  spectral centroid 0–1 (dark → bright timbre)
 *   uParams      vec3   the mode's three sliders, each 0–1
 *   uPal[5]      vec3   active palette stops dark → light (global palette,
 *                       or the shader's own default when "Original")
 *   uTouch       vec3   last interactive tap/drag (xy 0–1, z = strength)
 *
 * Helpers: pal(t), hash21, noise(vec2), fbm(vec2), rot(a).
 * A shader supplies `void mainImage(out vec4 color, in vec2 fragCoord)`.
 */
import { store } from '../../state/store';
import { BAND_COUNT, isMobile } from '../../utils/constants';
import { getBeatClock } from '../../audio/beatClock';
import { getPalette, paletteUniform, type Palette } from '../../post/palettes';
import type { InteractionEvent } from '../../types';

export interface ShaderDef {
  id: string;
  /** GLSL source defining mainImage(). */
  frag: string;
  /** Palette used when the global palette is "Original". */
  palette: Palette;
  /** Current slider values (0–1 each). */
  params: () => [number, number, number];
  /** Rate at which uFlow advances (per second). Beats add a surge on top. */
  speed: () => number;
  /** Cost hint: raymarchers render at a lower base resolution. */
  heavy?: boolean;
}

const VERT = `#version 300 es
layout(location = 0) in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

export const SHADER_PRELUDE = `#version 300 es
precision highp float;
uniform vec2 uResolution;
uniform float uTime;
uniform float uFlow;
uniform float uBeatTime;
uniform float uBeat;
uniform float uPulse;
uniform float uBpm;
uniform float uBands[7];
uniform float uLevel;
uniform float uCentroid;
uniform vec3 uParams;
uniform vec3 uPal[5];
uniform vec3 uTouch;
out vec4 fragColor_;

vec3 pal(float t) {
  t = clamp(t, 0.0, 1.0) * 4.0;
  if (t < 1.0) return mix(uPal[0], uPal[1], t);
  if (t < 2.0) return mix(uPal[1], uPal[2], t - 1.0);
  if (t < 3.0) return mix(uPal[2], uPal[3], t - 2.0);
  return mix(uPal[3], uPal[4], t - 3.0);
}
float hash21(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2(1, 0)), u.x),
             mix(hash21(i + vec2(0, 1)), hash21(i + vec2(1, 1)), u.x), u.y);
}
mat2 rot(float a) { float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  mat2 m = mat2(1.6, 1.2, -1.2, 1.6);
  for (int i = 0; i < 5; i++) { v += a * noise(p); p = m * p; a *= 0.5; }
  return v;
}
`;

const SHADER_EPILOGUE = `
void main() {
  vec4 c = vec4(0.0, 0.0, 0.0, 1.0);
  mainImage(c, gl_FragCoord.xy);
  fragColor_ = vec4(clamp(c.rgb, 0.0, 1.0), 1.0);
}`;

// ── Module state ─────────────────────────────────────────────────────────────

interface Compiled {
  prog: WebGLProgram;
  loc: Record<string, WebGLUniformLocation | null>;
}

const UNIFORMS = ['uResolution', 'uTime', 'uFlow', 'uBeatTime', 'uBeat', 'uPulse', 'uBpm', 'uBands', 'uLevel', 'uCentroid', 'uParams', 'uPal', 'uTouch'];

let glCanvas: HTMLCanvasElement | null = null;
let gl: WebGL2RenderingContext | null = null;
let unavailable = false;
const programs = new Map<string, Compiled | null>();
let time = 0;
let flow = 0;
let activeId = '';
const bands = new Float32Array(BAND_COUNT);
const palBuf = new Float32Array(15);
const touch = { x: 0.5, y: 0.5, z: 0 };

// Adaptive resolution: scale relative to the p5 canvas size
const MIN_SCALE = isMobile ? 0.22 : 0.3;
const MAX_SCALE = isMobile ? 0.5 : 1.0;
let scale = isMobile ? 0.35 : 0.6;
let frameAvg = 16.7;

function init(): boolean {
  glCanvas = document.createElement('canvas');
  gl = glCanvas.getContext('webgl2', {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    preserveDrawingBuffer: false,
    powerPreference: 'high-performance',
  });
  if (!gl) return false;
  glCanvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    programs.clear();
  });
  glCanvas.addEventListener('webglcontextrestored', () => {
    programs.clear();
    setupQuad();
  });
  setupQuad();
  return true;
}

function setupQuad(): void {
  const g = gl!;
  const vao = g.createVertexArray();
  g.bindVertexArray(vao);
  const buf = g.createBuffer();
  g.bindBuffer(g.ARRAY_BUFFER, buf);
  g.bufferData(g.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), g.STATIC_DRAW);
  g.enableVertexAttribArray(0);
  g.vertexAttribPointer(0, 2, g.FLOAT, false, 0, 0);
}

function compile(def: ShaderDef): Compiled | null {
  const g = gl!;
  const make = (type: number, src: string) => {
    const sh = g.createShader(type)!;
    g.shaderSource(sh, src);
    g.compileShader(sh);
    if (!g.getShaderParameter(sh, g.COMPILE_STATUS)) {
      console.error(`[shader:${def.id}] compile failed:\n${g.getShaderInfoLog(sh)}`);
      g.deleteShader(sh);
      return null;
    }
    return sh;
  };
  const vs = make(g.VERTEX_SHADER, VERT);
  const fs = make(g.FRAGMENT_SHADER, SHADER_PRELUDE + def.frag + SHADER_EPILOGUE);
  if (!vs || !fs) return null;
  const prog = g.createProgram()!;
  g.attachShader(prog, vs);
  g.attachShader(prog, fs);
  g.linkProgram(prog);
  g.deleteShader(vs);
  g.deleteShader(fs);
  if (!g.getProgramParameter(prog, g.LINK_STATUS)) {
    console.error(`[shader:${def.id}] link failed:\n${g.getProgramInfoLog(prog)}`);
    return null;
  }
  const loc: Compiled['loc'] = {};
  for (const name of UNIFORMS) loc[name] = g.getUniformLocation(prog, name);
  return { prog, loc };
}

function drawUnavailable(p: P5Instance): void {
  p.fill(200);
  p.noStroke();
  p.textAlign(p['CENTER'], p['CENTER']);
  p.textSize(16);
  p.text('Shader modes need WebGL2, which this browser does not provide.', p.width / 2, p.height / 2);
}

export function drawShader(p: P5Instance, dt: number, def: ShaderDef): void {
  if (unavailable) { drawUnavailable(p); return; }
  if (!gl && !init()) {
    unavailable = true;
    drawUnavailable(p);
    return;
  }
  const g = gl!;
  if (g.isContextLost()) return;

  if (activeId !== def.id) {
    activeId = def.id;
    time = 0;
    flow = 0;
  }

  if (!programs.has(def.id)) programs.set(def.id, compile(def));
  const prog = programs.get(def.id);
  if (!prog) return;

  // Adaptive resolution — back off when frames run long, recover when there is headroom
  const target = isMobile ? 33.4 : 16.7;
  frameAvg += (p.deltaTime - frameAvg) * 0.05;
  if (frameAvg > target * 1.25) scale = Math.max(MIN_SCALE, scale - 0.004);
  else if (frameAvg < target * 1.05) scale = Math.min(def.heavy ? MAX_SCALE * 0.75 : MAX_SCALE, scale + 0.001);

  const w = Math.max(16, Math.round(p.width * scale));
  const h = Math.max(16, Math.round(p.height * scale));
  if (glCanvas!.width !== w || glCanvas!.height !== h) {
    glCanvas!.width = w;
    glCanvas!.height = h;
  }

  // Audio uniforms
  const { audioState, config } = store;
  let level = 0;
  for (let b = 0; b < BAND_COUNT; b++) {
    const bins = audioState.smoothedBands[b];
    let sum = 0;
    for (let j = 0; j < bins.length; j++) sum += bins[j];
    bands[b] = Math.min(1.5, sum / bins.length);
    level += bands[b];
  }
  level /= BAND_COUNT;
  const beat = getBeatClock();
  time += dt / 60;
  flow += def.speed() * (dt / 60) * (1 + beat.pulse * 0.6);
  touch.z *= Math.pow(0.95, dt);

  const palIdx = Math.round(config.postPalette);
  paletteUniform(palIdx === 0 ? def.palette : getPalette(palIdx), palBuf);
  const [pa, pb, pc] = def.params();

  g.viewport(0, 0, w, h);
  g.useProgram(prog.prog);
  const L = prog.loc;
  g.uniform2f(L.uResolution, w, h);
  g.uniform1f(L.uTime, time);
  g.uniform1f(L.uFlow, flow);
  g.uniform1f(L.uBeatTime, beat.count + beat.phase);
  g.uniform1f(L.uBeat, beat.phase);
  g.uniform1f(L.uPulse, beat.pulse);
  g.uniform1f(L.uBpm, beat.bpm);
  g.uniform1fv(L.uBands, bands);
  g.uniform1f(L.uLevel, level);
  g.uniform1f(L.uCentroid, audioState.smoothedCentroid);
  g.uniform3f(L.uParams, pa, pb, pc);
  g.uniform3fv(L.uPal, palBuf);
  g.uniform3f(L.uTouch, touch.x, touch.y, touch.z);
  g.drawArrays(g.TRIANGLES, 0, 3);

  const ctx = p.drawingContext as CanvasRenderingContext2D;
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(glCanvas!, 0, 0, p.width, p.height);
}

/** Interactive-mode hook: taps/drags set a touch point shaders can react to. */
export function interactShader(event: InteractionEvent): void {
  touch.x = event.x;
  touch.y = 1 - event.y; // GL space is bottom-up
  touch.z = event.type === 'tap' ? 1 : Math.max(touch.z, 0.7);
}

export function resetShader(): void {
  time = 0;
  flow = 0;
  touch.z = 0;
}

/**
 * Shader modes share one long-lived context (re-creating contexts on every
 * mode switch risks hitting the browser's live-context limit), so dispose
 * only shrinks the backbuffer.
 */
export function disposeShaderRunner(): void {
  if (glCanvas) {
    glCanvas.width = 1;
    glCanvas.height = 1;
  }
  activeId = '';
}
