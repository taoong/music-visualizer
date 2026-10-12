/**
 * Post-FX pipeline — fullscreen WebGL2 chain applied to the final frame.
 *
 * Every frame (end of p.draw) the finished p5 canvas — plus the Three.js
 * overlay canvas, if the active viz mounted one — is uploaded as a texture
 * and run through:
 *
 *   1. Composite   p5 + Three overlay, content layer (webcam/image, under or
 *                  over, with blend mode), frame feedback (decay/zoom/rotate)
 *   2. Bloom       soft-knee bright pass → dual-Kawase down/up mip chain
 *   3. Final       chromatic aberration, bloom add, exposure + ACES filmic
 *                  tone mapping, palette gradient map, vignette, film grain
 *
 * The result is drawn to a fixed canvas stacked above the viz canvases
 * (pointer-events: none, so interactive mode still receives input). When
 * every effect is at its neutral value the chain is bypassed and the canvas
 * hidden, so there is zero cost when post is off.
 *
 * All parameters live in store.config (post* / layer* keys) so they are
 * driven by sliders and therefore MIDI-mappable via CONFIG_TO_SLIDER.
 */
import { store } from '../state/store';
import { isMobile } from '../utils/constants';
import { getBeatClock } from '../audio/beatClock';
import { getPalette, paletteUniform } from './palettes';
import { getLayerSource } from './layers';

// ── Shaders ──────────────────────────────────────────────────────────────────

const VERT = `#version 300 es
layout(location = 0) in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const FRAG_HEADER = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
`;

const COMPOSITE_FRAG = FRAG_HEADER + `
uniform sampler2D uScene;
uniform sampler2D uOverlay;
uniform float uHasOverlay;
uniform sampler2D uLayer;
uniform float uHasLayer;
uniform float uLayerOpacity;
uniform int uLayerBlend;
uniform float uLayerOver;
uniform vec2 uLayerScale;
uniform float uLayerMirror;
uniform sampler2D uPrev;
uniform float uTrails;
uniform float uFbZoom;
uniform float uFbRot;
uniform float uAspect;

float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

vec3 blendMode(vec3 b, vec3 t, int mode) {
  if (mode == 1) return 1.0 - (1.0 - b) * (1.0 - t);                       // screen
  if (mode == 2) return b * t;                                              // multiply
  if (mode == 3) return mix(2.0 * b * t, 1.0 - 2.0 * (1.0 - b) * (1.0 - t), step(0.5, b)); // overlay
  if (mode == 4) return min(b + t, 1.0);                                    // add
  if (mode == 5) return abs(b - t);                                         // difference
  return t;                                                                 // normal
}

void main() {
  vec3 col = texture(uScene, vUv).rgb;
  if (uHasOverlay > 0.5) {
    vec4 ov = texture(uOverlay, vUv);
    col = mix(col, ov.rgb, ov.a);
  }

  if (uHasLayer > 0.5) {
    vec2 luv = (vUv - 0.5) * uLayerScale + 0.5;
    if (uLayerMirror > 0.5) luv.x = 1.0 - luv.x;
    vec3 layer = texture(uLayer, luv).rgb;
    if (uLayerOver > 0.5) {
      col = mix(col, blendMode(col, layer, uLayerBlend), uLayerOpacity);
    } else {
      // Under: the generative frame sits on top of the layer. Its black
      // background is treated as transparent for "normal" so the layer shows
      // through; other modes blend the frame onto the layer.
      vec3 base = layer * uLayerOpacity;
      col = uLayerBlend == 0
        ? mix(base, col, clamp(luma(col) * 4.0, 0.0, 1.0))
        : blendMode(base, col, uLayerBlend);
    }
  }

  if (uTrails > 0.0) {
    vec2 p = vUv - 0.5;
    p.x *= uAspect;
    float s = 1.0 - uFbZoom * 0.03;
    float a = uFbRot * 0.03;
    p = mat2(cos(a), -sin(a), sin(a), cos(a)) * p * s;
    p.x /= uAspect;
    vec2 puv = p + 0.5;
    float inside = step(0.0, puv.x) * step(puv.x, 1.0) * step(0.0, puv.y) * step(puv.y, 1.0);
    // The small subtraction stops 8-bit buffers from leaving a stuck residue
    vec3 prev = max(texture(uPrev, puv).rgb * uTrails - 1.5 / 255.0, 0.0) * inside;
    col = max(col, prev);
  }

  outColor = vec4(col, 1.0);
}`;

const PREFILTER_FRAG = FRAG_HEADER + `
uniform sampler2D uSrc;
uniform vec2 uTexel;
uniform float uThreshold;
void main() {
  vec2 h = uTexel;
  vec3 c = (texture(uSrc, vUv + vec2(-h.x, -h.y)).rgb + texture(uSrc, vUv + vec2(h.x, -h.y)).rgb +
            texture(uSrc, vUv + vec2(-h.x, h.y)).rgb + texture(uSrc, vUv + vec2(h.x, h.y)).rgb) * 0.25;
  float br = max(c.r, max(c.g, c.b));
  float knee = uThreshold * 0.5 + 1e-4;
  float soft = clamp(br - uThreshold + knee, 0.0, 2.0 * knee);
  soft = soft * soft / (4.0 * knee + 1e-4);
  float w = max(soft, br - uThreshold) / max(br, 1e-4);
  outColor = vec4(c * w, 1.0);
}`;

const DOWN_FRAG = FRAG_HEADER + `
uniform sampler2D uSrc;
uniform vec2 uTexel;
void main() {
  vec2 h = uTexel;
  vec3 s = texture(uSrc, vUv).rgb * 4.0;
  s += texture(uSrc, vUv - h).rgb;
  s += texture(uSrc, vUv + h).rgb;
  s += texture(uSrc, vUv + vec2(h.x, -h.y)).rgb;
  s += texture(uSrc, vUv - vec2(h.x, -h.y)).rgb;
  outColor = vec4(s / 8.0, 1.0);
}`;

const UP_FRAG = FRAG_HEADER + `
uniform sampler2D uSrc;
uniform vec2 uTexel;
void main() {
  vec2 h = uTexel;
  vec3 s = texture(uSrc, vUv + vec2(-h.x * 2.0, 0.0)).rgb;
  s += texture(uSrc, vUv + vec2(-h.x, h.y)).rgb * 2.0;
  s += texture(uSrc, vUv + vec2(0.0, h.y * 2.0)).rgb;
  s += texture(uSrc, vUv + vec2(h.x, h.y)).rgb * 2.0;
  s += texture(uSrc, vUv + vec2(h.x * 2.0, 0.0)).rgb;
  s += texture(uSrc, vUv + vec2(h.x, -h.y)).rgb * 2.0;
  s += texture(uSrc, vUv + vec2(0.0, -h.y * 2.0)).rgb;
  s += texture(uSrc, vUv + vec2(-h.x, -h.y)).rgb * 2.0;
  outColor = vec4(s / 12.0, 1.0);
}`;

const FINAL_FRAG = FRAG_HEADER + `
uniform sampler2D uComp;
uniform sampler2D uBloom;
uniform float uBloomAmt;
uniform float uChroma;
uniform float uTonemap;
uniform float uExposure;
uniform float uVignette;
uniform float uGrain;
uniform float uTime;
uniform vec3 uPal[5];
uniform float uPalMix;
uniform vec2 uRes;

float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

vec3 aces(vec3 x) {
  // Narkowicz ACES filmic fit
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}

vec3 gradientMap(float t) {
  t = clamp(t, 0.0, 1.0) * 4.0;
  if (t < 1.0) return mix(uPal[0], uPal[1], t);
  if (t < 2.0) return mix(uPal[1], uPal[2], t - 1.0);
  if (t < 3.0) return mix(uPal[2], uPal[3], t - 2.0);
  return mix(uPal[3], uPal[4], t - 3.0);
}

float hash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

void main() {
  vec2 d = vUv - 0.5;
  vec3 col;
  if (uChroma > 0.0) {
    // Radial lens-style split: stronger toward the edges
    vec2 off = d * uChroma * 0.035 * (0.3 + dot(d, d) * 3.0);
    col.r = texture(uComp, vUv + off).r;
    col.g = texture(uComp, vUv).g;
    col.b = texture(uComp, vUv - off).b;
  } else {
    col = texture(uComp, vUv).rgb;
  }

  vec3 lin = pow(col, vec3(2.2));
  if (uBloomAmt > 0.0) {
    lin += pow(texture(uBloom, vUv).rgb, vec3(2.2)) * uBloomAmt;
  }
  lin *= uExposure;
  lin = mix(min(lin, 1.0), aces(lin * 1.25), uTonemap);
  col = pow(lin, vec3(1.0 / 2.2));

  if (uPalMix > 0.0) {
    col = mix(col, gradientMap(luma(col)), uPalMix);
  }

  if (uVignette > 0.0) {
    float aspect = uRes.x / uRes.y;
    float r = length(d * vec2(mix(1.0, aspect, 0.5), 1.0));
    col *= mix(1.0, smoothstep(0.85, 0.2, r), uVignette);
  }

  if (uGrain > 0.0) {
    float n = hash(floor(vUv * uRes) + fract(uTime * 7.31) * vec2(419.0, 173.0)) - 0.5;
    // Grain sits mostly in shadows/mids like film
    col += n * uGrain * 0.18 * (1.0 - luma(col) * 0.6);
  }

  outColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;

// ── GL plumbing ──────────────────────────────────────────────────────────────

interface Program {
  prog: WebGLProgram;
  u: (name: string) => WebGLUniformLocation | null;
}

interface Target {
  fbo: WebGLFramebuffer;
  tex: WebGLTexture;
  w: number;
  h: number;
}

let gl: WebGL2RenderingContext | null = null;
let canvas: HTMLCanvasElement | null = null;
let failed = false;
let contextLost = false;
let progs: Record<'composite' | 'prefilter' | 'down' | 'up' | 'final', Program> | null = null;
let vao: WebGLVertexArrayObject | null = null;
let sceneTex: WebGLTexture | null = null;
let overlayTex: WebGLTexture | null = null;
let layerTex: WebGLTexture | null = null;
let sceneSize = { w: 0, h: 0 };
let overlaySize = { w: 0, h: 0 };
let layerUploadedVersion = -1;
let rtInternal: number = 0;
let rtType: number = 0;
let comp: [Target, Target] | null = null;
let compIdx = 0;
let mips: Target[] = [];
let width = 0;
let height = 0;
let time = 0;
const palBuf = new Float32Array(15);

function compile(type: number, src: string): WebGLShader {
  const g = gl!;
  const sh = g.createShader(type)!;
  g.shaderSource(sh, src);
  g.compileShader(sh);
  if (!g.getShaderParameter(sh, g.COMPILE_STATUS)) {
    const log = g.getShaderInfoLog(sh);
    g.deleteShader(sh);
    throw new Error(`[postfx] shader compile failed: ${log}`);
  }
  return sh;
}

function createProgram(frag: string): Program {
  const g = gl!;
  const prog = g.createProgram()!;
  const vs = compile(g.VERTEX_SHADER, VERT);
  const fs = compile(g.FRAGMENT_SHADER, frag);
  g.attachShader(prog, vs);
  g.attachShader(prog, fs);
  g.linkProgram(prog);
  g.deleteShader(vs);
  g.deleteShader(fs);
  if (!g.getProgramParameter(prog, g.LINK_STATUS)) {
    throw new Error(`[postfx] program link failed: ${g.getProgramInfoLog(prog)}`);
  }
  const cache = new Map<string, WebGLUniformLocation | null>();
  return {
    prog,
    u: (name: string) => {
      if (!cache.has(name)) cache.set(name, g.getUniformLocation(prog, name));
      return cache.get(name)!;
    },
  };
}

function createTexture(): WebGLTexture {
  const g = gl!;
  const tex = g.createTexture()!;
  g.bindTexture(g.TEXTURE_2D, tex);
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, g.LINEAR);
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, g.LINEAR);
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_S, g.CLAMP_TO_EDGE);
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_T, g.CLAMP_TO_EDGE);
  return tex;
}

function createTarget(w: number, h: number): Target {
  const g = gl!;
  const tex = createTexture();
  g.texImage2D(g.TEXTURE_2D, 0, rtInternal, w, h, 0, g.RGBA, rtType, null);
  const fbo = g.createFramebuffer()!;
  g.bindFramebuffer(g.FRAMEBUFFER, fbo);
  g.framebufferTexture2D(g.FRAMEBUFFER, g.COLOR_ATTACHMENT0, g.TEXTURE_2D, tex, 0);
  g.clearColor(0, 0, 0, 1);
  g.clear(g.COLOR_BUFFER_BIT);
  return { fbo, tex, w, h };
}

function deleteTarget(t: Target): void {
  gl!.deleteFramebuffer(t.fbo);
  gl!.deleteTexture(t.tex);
}

function init(): boolean {
  canvas = document.createElement('canvas');
  canvas.id = 'postfx-canvas';
  canvas.setAttribute('aria-hidden', 'true');
  canvas.style.cssText =
    'position:fixed;top:0;left:0;width:100%;height:100%;z-index:11;pointer-events:none;display:none';
  document.body.appendChild(canvas);

  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    contextLost = true;
    canvas!.style.display = 'none';
  });
  canvas.addEventListener('webglcontextrestored', () => {
    contextLost = false;
    setupResources();
  });

  gl = canvas.getContext('webgl2', {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    premultipliedAlpha: false,
    preserveDrawingBuffer: false,
    powerPreference: 'high-performance',
  });
  if (!gl) {
    console.warn('[postfx] WebGL2 unavailable — post-processing disabled');
    return false;
  }
  try {
    setupResources();
  } catch (err) {
    console.error(err);
    return false;
  }
  return true;
}

function setupResources(): void {
  const g = gl!;
  const halfFloat = !!(g.getExtension('EXT_color_buffer_float') || g.getExtension('EXT_color_buffer_half_float'));
  rtInternal = halfFloat ? g.RGBA16F : g.RGBA8;
  rtType = halfFloat ? g.HALF_FLOAT : g.UNSIGNED_BYTE;

  progs = {
    composite: createProgram(COMPOSITE_FRAG),
    prefilter: createProgram(PREFILTER_FRAG),
    down: createProgram(DOWN_FRAG),
    up: createProgram(UP_FRAG),
    final: createProgram(FINAL_FRAG),
  };

  // Fullscreen triangle
  vao = g.createVertexArray();
  g.bindVertexArray(vao);
  const buf = g.createBuffer();
  g.bindBuffer(g.ARRAY_BUFFER, buf);
  g.bufferData(g.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), g.STATIC_DRAW);
  g.enableVertexAttribArray(0);
  g.vertexAttribPointer(0, 2, g.FLOAT, false, 0, 0);

  sceneTex = createTexture();
  overlayTex = createTexture();
  layerTex = createTexture();
  sceneSize = { w: 0, h: 0 };
  overlaySize = { w: 0, h: 0 };
  layerUploadedVersion = -1;
  comp = null;
  mips = [];
  width = 0;
  height = 0;
}

function resize(w: number, h: number): void {
  if (comp) { deleteTarget(comp[0]); deleteTarget(comp[1]); }
  mips.forEach(deleteTarget);

  width = w;
  height = h;
  canvas!.width = w;
  canvas!.height = h;

  // Some drivers advertise half-float render targets but reject them; fall back to 8-bit
  const g = gl!;
  const probe = createTarget(w, h);
  if (g.checkFramebufferStatus(g.FRAMEBUFFER) !== g.FRAMEBUFFER_COMPLETE && rtType !== g.UNSIGNED_BYTE) {
    deleteTarget(probe);
    rtInternal = g.RGBA8;
    rtType = g.UNSIGNED_BYTE;
    comp = [createTarget(w, h), createTarget(w, h)];
  } else {
    comp = [probe, createTarget(w, h)];
  }

  // Bloom chain: half res on desktop, quarter on mobile
  mips = [];
  const div = isMobile ? 4 : 2;
  const maxLevels = isMobile ? 4 : 6;
  let mw = Math.max(1, Math.floor(w / div));
  let mh = Math.max(1, Math.floor(h / div));
  for (let i = 0; i < maxLevels && mw >= 8 && mh >= 8; i++) {
    mips.push(createTarget(mw, mh));
    mw = Math.floor(mw / 2);
    mh = Math.floor(mh / 2);
  }
}

/** Upload a canvas/video/image into tex, reusing storage when the size is unchanged. */
function upload(tex: WebGLTexture, src: TexImageSource, w: number, h: number, size: { w: number; h: number }): void {
  const g = gl!;
  g.bindTexture(g.TEXTURE_2D, tex);
  if (size.w !== w || size.h !== h) {
    g.texImage2D(g.TEXTURE_2D, 0, g.RGBA, g.RGBA, g.UNSIGNED_BYTE, src);
    size.w = w;
    size.h = h;
  } else {
    g.texSubImage2D(g.TEXTURE_2D, 0, 0, 0, g.RGBA, g.UNSIGNED_BYTE, src);
  }
}

function bindTex(unit: number, tex: WebGLTexture | null): void {
  gl!.activeTexture(gl!.TEXTURE0 + unit);
  gl!.bindTexture(gl!.TEXTURE_2D, tex);
}

function drawTo(target: Target | null): void {
  const g = gl!;
  if (target) {
    g.bindFramebuffer(g.FRAMEBUFFER, target.fbo);
    g.viewport(0, 0, target.w, target.h);
  } else {
    g.bindFramebuffer(g.FRAMEBUFFER, null);
    g.viewport(0, 0, width, height);
  }
  g.drawArrays(g.TRIANGLES, 0, 3);
}

/** The active Three.js viz's overlay canvas, if any (they mount directly on <body>). */
function findOverlayCanvas(): HTMLCanvasElement | null {
  const list = document.querySelectorAll<HTMLCanvasElement>('body > canvas');
  for (let i = list.length - 1; i >= 0; i--) {
    const c = list[i];
    if (c === canvas || c.style.display === 'none' || c.width === 0 || c.height === 0) continue;
    return c;
  }
  return null;
}

// ── Public API ───────────────────────────────────────────────────────────────

/** True when every effect is neutral — the chain is skipped entirely. */
export function isPostNeutral(): boolean {
  const c = store.config;
  return (
    c.postBloom <= 0 &&
    c.postChroma <= 0 &&
    c.postGrain <= 0 &&
    c.postVignette <= 0 &&
    c.postTonemap <= 0 &&
    Math.abs(c.postExposure - 1) < 1e-3 &&
    c.postTrails <= 0 &&
    (Math.round(c.postPalette) === 0 || c.postPaletteMix <= 0) &&
    getLayerSource() === null
  );
}

/**
 * Run the chain on the frame just rendered into `source` (the p5 canvas).
 * Must be called in the same task the viz rendered in, so WebGL overlay
 * canvases still hold their drawing buffer.
 */
export function renderPostFX(source: HTMLCanvasElement, dt: number): void {
  if (failed || contextLost) return;

  if (isPostNeutral()) {
    if (canvas) canvas.style.display = 'none';
    return;
  }

  if (!gl) {
    if (!init()) {
      failed = true;
      if (canvas) canvas.style.display = 'none';
      return;
    }
  }
  const g = gl!;
  const p = progs!;
  const cfg = store.config;
  const beat = getBeatClock();
  time += dt / 60;

  const w = source.width;
  const h = source.height;
  if (w === 0 || h === 0) return;
  if (w !== width || h !== height) resize(w, h);

  // Audio reactivity: beat pulse pumps bloom, chroma and feedback zoom
  const pump = cfg.postReact * beat.pulse;

  // ── Uploads ────────────────────────────────────────────────────────────────
  g.pixelStorei(g.UNPACK_FLIP_Y_WEBGL, true);
  g.pixelStorei(g.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  upload(sceneTex!, source, w, h, sceneSize);

  const overlay = findOverlayCanvas();
  if (overlay) upload(overlayTex!, overlay, overlay.width, overlay.height, overlaySize);

  const layer = getLayerSource();
  if (layer && (layer.live || layer.version !== layerUploadedVersion)) {
    // Static images upload once; live video every frame
    g.bindTexture(g.TEXTURE_2D, layerTex);
    g.texImage2D(g.TEXTURE_2D, 0, g.RGBA, g.RGBA, g.UNSIGNED_BYTE, layer.el);
    layerUploadedVersion = layer.version;
  }

  g.bindVertexArray(vao);
  g.disable(g.BLEND);

  // ── 1. Composite (+ feedback) ──────────────────────────────────────────────
  const prev = comp![compIdx];
  compIdx = 1 - compIdx;
  const cur = comp![compIdx];

  g.useProgram(p.composite.prog);
  bindTex(0, sceneTex);
  bindTex(1, overlayTex);
  bindTex(2, layerTex);
  bindTex(3, prev.tex);
  g.uniform1i(p.composite.u('uScene'), 0);
  g.uniform1i(p.composite.u('uOverlay'), 1);
  g.uniform1i(p.composite.u('uLayer'), 2);
  g.uniform1i(p.composite.u('uPrev'), 3);
  g.uniform1f(p.composite.u('uHasOverlay'), overlay ? 1 : 0);
  g.uniform1f(p.composite.u('uHasLayer'), layer ? 1 : 0);
  if (layer) {
    // "Cover" fit: fill the screen, crop the overflow
    const ca = w / h;
    const la = layer.width / Math.max(1, layer.height);
    const sx = la > ca ? ca / la : 1;
    const sy = la > ca ? 1 : la / ca;
    g.uniform2f(p.composite.u('uLayerScale'), sx, sy);
    g.uniform1f(p.composite.u('uLayerMirror'), layer.mirror ? 1 : 0);
    g.uniform1f(p.composite.u('uLayerOpacity'), cfg.layerOpacity);
    g.uniform1i(p.composite.u('uLayerBlend'), Math.round(cfg.layerBlend));
    g.uniform1f(p.composite.u('uLayerOver'), Math.round(cfg.layerOrder));
  }
  g.uniform1f(p.composite.u('uTrails'), cfg.postTrails > 0 ? Math.min(0.985, cfg.postTrails) : 0);
  g.uniform1f(p.composite.u('uFbZoom'), cfg.postFeedbackZoom + pump * 0.6 * Math.sign(cfg.postFeedbackZoom || 1));
  g.uniform1f(p.composite.u('uFbRot'), cfg.postFeedbackRotate);
  g.uniform1f(p.composite.u('uAspect'), w / h);
  drawTo(cur);

  // ── 2. Bloom ───────────────────────────────────────────────────────────────
  const bloomAmt = cfg.postBloom * (1 + pump * 1.5);
  const doBloom = bloomAmt > 0 && mips.length > 0;
  if (doBloom) {
    g.useProgram(p.prefilter.prog);
    bindTex(0, cur.tex);
    g.uniform1i(p.prefilter.u('uSrc'), 0);
    g.uniform2f(p.prefilter.u('uTexel'), 1 / w, 1 / h);
    g.uniform1f(p.prefilter.u('uThreshold'), cfg.postBloomThreshold);
    drawTo(mips[0]);

    g.useProgram(p.down.prog);
    g.uniform1i(p.down.u('uSrc'), 0);
    for (let i = 1; i < mips.length; i++) {
      bindTex(0, mips[i - 1].tex);
      g.uniform2f(p.down.u('uTexel'), 1 / mips[i - 1].w, 1 / mips[i - 1].h);
      drawTo(mips[i]);
    }

    // Upsample, accumulating each blurred level into the next-larger one
    g.useProgram(p.up.prog);
    g.uniform1i(p.up.u('uSrc'), 0);
    g.enable(g.BLEND);
    g.blendFunc(g.ONE, g.ONE);
    for (let i = mips.length - 1; i > 0; i--) {
      bindTex(0, mips[i].tex);
      g.uniform2f(p.up.u('uTexel'), 1 / mips[i].w, 1 / mips[i].h);
      drawTo(mips[i - 1]);
    }
    g.disable(g.BLEND);
  }

  // ── 3. Final ───────────────────────────────────────────────────────────────
  const palIdx = Math.round(cfg.postPalette);
  const palMix = palIdx === 0 ? 0 : cfg.postPaletteMix;
  paletteUniform(getPalette(palIdx), palBuf);

  g.useProgram(p.final.prog);
  bindTex(0, cur.tex);
  bindTex(1, doBloom ? mips[0].tex : null);
  g.uniform1i(p.final.u('uComp'), 0);
  g.uniform1i(p.final.u('uBloom'), 1);
  // Bloom energy grows with mip count; normalise so the slider feels the same on mobile
  g.uniform1f(p.final.u('uBloomAmt'), doBloom ? bloomAmt * (3 / mips.length) : 0);
  g.uniform1f(p.final.u('uChroma'), cfg.postChroma + pump * 0.5);
  g.uniform1f(p.final.u('uTonemap'), cfg.postTonemap);
  g.uniform1f(p.final.u('uExposure'), cfg.postExposure);
  g.uniform1f(p.final.u('uVignette'), cfg.postVignette);
  g.uniform1f(p.final.u('uGrain'), cfg.postGrain);
  g.uniform1f(p.final.u('uTime'), time);
  g.uniform3fv(p.final.u('uPal'), palBuf);
  g.uniform1f(p.final.u('uPalMix'), palMix);
  g.uniform2f(p.final.u('uRes'), w, h);
  drawTo(null);

  canvas!.style.display = 'block';
}

/** Clear the feedback buffers (e.g. on viz switch) so the old viz doesn't ghost into the new one. */
export function clearPostFeedback(): void {
  if (!gl || !comp) return;
  gl.clearColor(0, 0, 0, 1);
  for (const t of comp) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }
}

export function disposePostFX(): void {
  if (gl) {
    if (comp) { deleteTarget(comp[0]); deleteTarget(comp[1]); }
    mips.forEach(deleteTarget);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
  canvas?.remove();
  gl = null;
  canvas = null;
  comp = null;
  mips = [];
}
