/**
 * Wobble — block definitions. Each block is one candy-colored module in the
 * chain: sources draw, transforms reshape, fx grade, output terminates.
 *
 * All rendering is 2D canvas. `params` arrive as real (de-normalized) values;
 * `src` is the previous buffer in the ping-pong chain (null for sources);
 * `state` is a per-instance scratch bag that survives across frames.
 */
import type { AudioFrame } from './audio';
import { withAlpha, type Palette } from './palettes';

export type BlockKind = 'source' | 'transform' | 'fx' | 'output';

export interface BlockParamDef {
  key: string;
  label: string;
  min: number;
  max: number;
  /** default in real units */
  def: number;
  step?: number;
}

export interface RenderEnv {
  /** 0..1 global chaos: hue drift + jitter */
  chaos: number;
  palette: Palette;
}

export type BlockState = Record<string, unknown>;

export interface BlockDef {
  id: string;
  name: string;
  blurb: string;
  kind: BlockKind;
  /** candy hex color for the block card + cables */
  color: string;
  params: BlockParamDef[];
  render(
    ctx: CanvasRenderingContext2D,
    w: number,
    h: number,
    t: number,
    audio: AudioFrame,
    params: Record<string, number>,
    src: HTMLCanvasElement | null,
    state: BlockState,
    env: RenderEnv,
  ): void;
}

const TAU = Math.PI * 2;

/** Cheap 1D pseudo-noise in [-1, 1]. */
function n1(x: number): number {
  return (
    Math.sin(x * 1.7) * 0.5 + Math.sin(x * 2.3 + 1.3) * 0.3 + Math.sin(x * 4.1 + 2.1) * 0.2
  );
}

function frameDt(state: BlockState, t: number): number {
  const last = typeof state.lastT === 'number' ? (state.lastT as number) : t;
  state.lastT = t;
  return Math.min(0.1, Math.max(0.0001, t - last));
}

// Module-level scratch canvas shared by blocks that need one.
let scratchA: HTMLCanvasElement | null = null;
function scratch(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  if (!scratchA) {
    scratchA = document.createElement('canvas');
  }
  const a = scratchA as HTMLCanvasElement;
  if (a.width !== w || a.height !== h) {
    a.width = w;
    a.height = h;
  }
  return [a, a.getContext('2d') as CanvasRenderingContext2D];
}

// Luminance -> palette lookup cache (rebuilt when the palette changes).
let lutKey = '';
let lut: Uint8ClampedArray = new Uint8ClampedArray(256 * 3);
function paletteLut(pal: Palette): Uint8ClampedArray {
  const key = pal.name + pal.colors.join('');
  if (key === lutKey) return lut;
  const stops = pal.colors.map(hex => [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ]);
  for (let i = 0; i < 256; i++) {
    const f = (i / 255) * (stops.length - 1);
    const s0 = Math.floor(f);
    const s1 = Math.min(stops.length - 1, s0 + 1);
    const m = f - s0;
    for (let c = 0; c < 3; c++) {
      lut[i * 3 + c] = Math.round(stops[s0][c] + (stops[s1][c] - stops[s0][c]) * m);
    }
  }
  lutKey = key;
  return lut;
}

interface RainDrop {
  x: number;
  y: number;
  band: number;
  seed: number;
}

const blobField: BlockDef = {
  id: 'blob-field',
  name: 'Blob Field',
  blurb: 'Seven blobby friends, one per frequency band',
  kind: 'source',
  color: '#FF5CA8',
  params: [
    { key: 'count', label: 'Count', min: 1, max: 12, def: 7, step: 1 },
    { key: 'squish', label: 'Squish', min: 0, max: 1, def: 0.4 },
    { key: 'glow', label: 'Glow', min: 0, max: 1, def: 0.5 },
  ],
  render(ctx, w, h, t, audio, p, _src, _state, env) {
    const pal = env.palette;
    ctx.fillStyle = pal.bg;
    ctx.fillRect(0, 0, w, h);
    const cx = w / 2;
    const cy = h / 2;
    const R = Math.min(w, h);
    const n = Math.max(1, Math.round(p.count));
    const hueShift = env.chaos * 40 * Math.sin(t * 0.7);
    for (let i = 0; i < n; i++) {
      const band = audio.bands[i % 7];
      const ph = i * 2.399963; // golden angle
      const drift = 0.32 + env.chaos * 0.25 * Math.abs(n1(i * 3.1));
      const px = cx + Math.cos(t * 0.3 * (1 + i * 0.13) + ph) * R * drift;
      const py = cy + Math.sin(t * 0.23 * (1 + i * 0.17) + ph * 1.7) * R * 0.28;
      let r = R * 0.055 * (0.6 + band * 1.8) * (0.7 + p.count * 0.05);
      if (audio.beat) r *= 1.3;
      const squish = 1 - p.squish * 0.45 * Math.sin(t * 2 + i * 1.3);
      const col = pal.colors[i % pal.colors.length];
      ctx.save();
      ctx.translate(px, py);
      ctx.scale(1, Math.max(0.2, squish));
      ctx.rotate(Math.sin(t * 0.9 + i) * 0.35 * p.squish + (hueShift * Math.PI) / 180);
      if (p.glow > 0.01) {
        ctx.shadowColor = col;
        ctx.shadowBlur = 46 * p.glow * (0.35 + band);
      }
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, Math.max(1, r));
      g.addColorStop(0, withAlpha(col, 0.95));
      g.addColorStop(0.7, withAlpha(col, 0.75));
      g.addColorStop(1, withAlpha(col, 0));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(0, 0, Math.max(1, r), 0, TAU);
      ctx.fill();
      ctx.restore();
    }
  },
};

const particleRain: BlockDef = {
  id: 'particle-rain',
  name: 'Particle Rain',
  blurb: 'Falling sparks that speed up with the music',
  kind: 'source',
  color: '#4D7CFE',
  params: [
    { key: 'count', label: 'Count', min: 20, max: 400, def: 160, step: 1 },
    { key: 'speed', label: 'Speed', min: 0, max: 1, def: 0.5 },
    { key: 'size', label: 'Size', min: 0, max: 1, def: 0.5 },
  ],
  render(ctx, w, h, t, audio, p, _src, state, env) {
    const pal = env.palette;
    const dt = frameDt(state, t);
    ctx.fillStyle = pal.bg;
    ctx.fillRect(0, 0, w, h);
    let drops = state.drops as RainDrop[] | undefined;
    if (!drops) {
      drops = [];
      state.drops = drops;
    }
    const target = Math.round(p.count);
    while (drops.length < target) {
      drops.push({
        x: Math.random() * w,
        y: Math.random() * h,
        band: Math.floor(Math.random() * 7),
        seed: Math.random() * 100,
      });
    }
    if (drops.length > target) drops.length = target;
    if (audio.beat) {
      for (let i = 0; i < 24 && drops.length < target + 40; i++) {
        drops.push({
          x: Math.random() * w,
          y: -10 - Math.random() * 40,
          band: Math.floor(Math.random() * 7),
          seed: Math.random() * 100,
        });
      }
    }
    const jitter = env.chaos * 26;
    for (const d of drops) {
      const band = audio.bands[d.band];
      const v = (50 + band * 380) * (0.25 + p.speed * 1.6);
      d.y += v * dt;
      d.x += n1(t * 2 + d.seed) * (10 + band * 60 + jitter) * dt;
      if (d.y > h + 12) {
        d.y = -12;
        d.x = Math.random() * w;
        d.band = Math.floor(Math.random() * 7);
      }
      const r = (1.2 + p.size * 4.5) * (0.5 + band);
      ctx.fillStyle = withAlpha(pal.colors[d.band % pal.colors.length], 0.35 + band * 0.6);
      ctx.beginPath();
      ctx.arc(d.x, d.y, Math.max(0.6, r), 0, TAU);
      ctx.fill();
    }
  },
};

const kaleido: BlockDef = {
  id: 'kaleido',
  name: 'Kaleido',
  blurb: 'Mirror the image into a spinning mandala',
  kind: 'transform',
  color: '#A06BFF',
  params: [
    { key: 'segments', label: 'Segments', min: 2, max: 12, def: 6, step: 1 },
    { key: 'spin', label: 'Spin', min: 0, max: 1, def: 0.25 },
  ],
  render(ctx, w, h, t, _audio, p, src, _state, _env) {
    if (!src) return;
    const n = Math.max(2, Math.round(p.segments));
    ctx.save();
    ctx.translate(w / 2, h / 2);
    ctx.rotate(t * p.spin * 1.2);
    for (let i = 0; i < n; i++) {
      ctx.save();
      ctx.rotate((i / n) * TAU);
      if (i % 2 === 1) ctx.scale(1, -1);
      ctx.drawImage(src, -w / 2, -h / 2, w, h);
      ctx.restore();
    }
    ctx.restore();
  },
};

const wobble: BlockDef = {
  id: 'wobble',
  name: 'Wobble',
  blurb: 'Wavy horizontal slice displacement',
  kind: 'transform',
  color: '#4D7CFE',
  params: [
    { key: 'amount', label: 'Amount', min: 0, max: 1, def: 0.35 },
    { key: 'speed', label: 'Speed', min: 0, max: 1, def: 0.4 },
  ],
  render(ctx, w, h, t, _audio, p, src, _state, _env) {
    if (!src) return;
    if (p.amount < 0.005) {
      ctx.drawImage(src, 0, 0);
      return;
    }
    const strips = 28;
    const sh = h / strips;
    const freq = 1 + p.speed * 5;
    for (let s = 0; s < strips; s++) {
      const off =
        Math.sin((s / strips) * Math.PI * 4 + t * freq * 2) * p.amount * w * 0.055;
      ctx.drawImage(src, 0, s * sh, w, sh + 1, off, s * sh, w, sh + 1);
    }
  },
};

const trails: BlockDef = {
  id: 'trails',
  name: 'Trails',
  blurb: 'Dreamy frame-feedback motion trails',
  kind: 'transform',
  color: '#35E0A1',
  params: [{ key: 'fade', label: 'Fade', min: 0.5, max: 0.97, def: 0.86 }],
  render(ctx, w, h, _t, _audio, p, src, state, _env) {
    let trail = state.trail as HTMLCanvasElement | undefined;
    if (!trail || trail.width !== w || trail.height !== h) {
      trail = document.createElement('canvas');
      trail.width = w;
      trail.height = h;
      state.trail = trail;
    }
    const tc = trail.getContext('2d') as CanvasRenderingContext2D;
    const [tmp, tmpx] = scratch(w, h);
    tmpx.clearRect(0, 0, w, h);
    tmpx.drawImage(trail, 0, 0);
    tc.clearRect(0, 0, w, h);
    tc.globalAlpha = Math.max(0.5, Math.min(0.97, p.fade));
    tc.drawImage(tmp, 0, 0);
    tc.globalAlpha = 1;
    if (src) tc.drawImage(src, 0, 0);
    ctx.drawImage(trail, 0, 0);
  },
};

const glow: BlockDef = {
  id: 'glow',
  name: 'Glow Pop',
  blurb: 'Cheap candy bloom',
  kind: 'fx',
  color: '#FFC53D',
  params: [{ key: 'amount', label: 'Amount', min: 0, max: 1, def: 0.5 }],
  render(ctx, w, h, _t, _audio, p, src, _state, _env) {
    if (!src) return;
    ctx.drawImage(src, 0, 0);
    if (p.amount < 0.01) return;
    const sw = Math.max(2, w >> 3);
    const sh = Math.max(2, h >> 3);
    const [small, sx] = scratch(sw, sh);
    sx.clearRect(0, 0, sw, sh);
    sx.drawImage(src, 0, 0, sw, sh);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = p.amount * 0.9;
    try {
      ctx.filter = 'blur(10px)';
    } catch {
      // ctx.filter unsupported — additive upscale still reads as glow
    }
    ctx.drawImage(small, 0, 0, w, h);
    ctx.restore();
    try {
      ctx.filter = 'none';
    } catch {
      // ignore
    }
  },
};

const palettePop: BlockDef = {
  id: 'palette-pop',
  name: 'Palette Pop',
  blurb: 'Grade everything through the active palette',
  kind: 'fx',
  color: '#FF5CA8',
  params: [],
  render(ctx, w, h, _t, _audio, _p, src, _state, env) {
    if (!src) return;
    const gw = 160;
    const gh = Math.max(1, Math.round((160 * h) / w));
    const [grade, gx] = scratch(gw, gh);
    gx.clearRect(0, 0, gw, gh);
    gx.drawImage(src, 0, 0, gw, gh);
    const img = gx.getImageData(0, 0, gw, gh);
    const d = img.data;
    const table = paletteLut(env.palette);
    for (let i = 0; i < d.length; i += 4) {
      const lum = Math.round(0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]);
      d[i] = table[lum * 3];
      d[i + 1] = table[lum * 3 + 1];
      d[i + 2] = table[lum * 3 + 2];
    }
    gx.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(grade, 0, 0, w, h);
  },
};

const outputBlock: BlockDef = {
  id: 'output',
  name: 'Output',
  blurb: 'To the stage',
  kind: 'output',
  color: '#35E0A1',
  params: [],
  render(_ctx, _w, _h, _t, _audio, _p, _src, _state, _env) {
    // terminal marker — the renderer blits the last buffer itself
  },
};

export const BLOCK_LIST: BlockDef[] = [
  blobField,
  particleRain,
  kaleido,
  wobble,
  trails,
  glow,
  palettePop,
  outputBlock,
];

export const BLOCKS: Record<string, BlockDef> = Object.fromEntries(
  BLOCK_LIST.map(b => [b.id, b]),
);

/** Map a normalized (0..1) knob value to a param's real range. */
export function denormalize(def: BlockParamDef, norm: number): number {
  const v = def.min + Math.max(0, Math.min(1, norm)) * (def.max - def.min);
  return def.step ? Math.round(v / def.step) * def.step : v;
}

/** Map a real param value back to normalized 0..1 (for initializing knobs). */
export function normalize(def: BlockParamDef, real: number): number {
  if (def.max === def.min) return 0;
  return Math.max(0, Math.min(1, (real - def.min) / (def.max - def.min)));
}
