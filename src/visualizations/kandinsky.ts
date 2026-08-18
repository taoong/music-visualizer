/**
 * Kandinsky — Audio-reactive synesthetic color-form composition.
 *
 * Inspired by Wassily Kandinsky's theory that musical tones correspond to
 * specific colors and geometric forms, as described in "Concerning the
 * Spiritual in Art" (1911) and directly embodied in "Composition VIII" (1923,
 * Solomon R. Guggenheim Museum, New York,
 * https://www.guggenheim.org/artwork/1924).
 *
 * Kandinsky believed yellow = sharp/forceful (trumpet), blue = deep/inward
 * (cello), red = percussive (drum), green = balanced (violin), orange =
 * bugle-bright, violet = spiritual/low, white = pure potential. Each of the
 * seven frequency bands maps to one Kandinsky color-tone affinity and one
 * characteristic geometric form (triangle, circle, square, arc, cross,
 * chevron, star). Forms drift via Perlin noise, scale with band amplitude,
 * and accumulate on an offscreen trail buffer — building layered painterly
 * compositions. A 3-pass additive glow renders each form. Beat fires a hue-
 * palette shift and scatters forms radially from canvas centre.
 *
 * Sliders
 *   Forms  — number of forms per band (3–20), up to 140 total on desktop
 *   Chaos  — Perlin-noise turbulence: slow contemplative drift → kinetic scatter
 *   Glow   — trail persistence and neon bloom intensity
 */
import { store } from '../state/store';
import { getBandAverages } from './helpers';
import { BAND_COUNT, isMobile } from '../utils/constants';

// Kandinsky's color-tone affinities for each freq band:
// sub=violet(spiritual/low), bass=yellow(trumpet), lowMid=orange(bugle),
// mid=red(drum), upperMid=green(violin), presence=blue(cello), brilliance=white
const BAND_HUES: readonly number[] = [270, 55, 28, 0, 120, 220, 40];
const BAND_SATS: readonly number[] = [85,  90, 90, 95, 75,  85, 20];
const BAND_BRIS: readonly number[] = [70,  90, 80, 80, 75,  75, 95];

type FormKind = 'triangle' | 'circle' | 'square' | 'arc' | 'cross' | 'chevron' | 'star';
const FORM_KINDS: readonly FormKind[] = [
  'triangle', 'circle', 'square', 'arc', 'cross', 'chevron', 'star',
];

interface Form {
  x: number;   // normalized [0,1]
  y: number;
  nx: number;  // Perlin noise offset x
  ny: number;
  bandIdx: number;
  kind: FormKind;
  rot: number;
  drot: number;
  scale: number;
  bvx: number; // burst velocity x
  bvy: number;
}

let forms: Form[] = [];
let lastBeatIndex = -1;
let hueShift = 0;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let buf: any = null;
let bufW = 0;
let bufH = 0;

const MAX_FORMS = isMobile ? 10 : 20;
const MIN_FORMS = 3;

function makeForm(bandIdx: number, p: P5Instance): Form {
  return {
    x: (p as any).random(0.05, 0.95) as number,
    y: (p as any).random(0.05, 0.95) as number,
    nx: (p as any).random(0, 100) as number,
    ny: (p as any).random(0, 100) as number,
    bandIdx,
    kind: FORM_KINDS[bandIdx],
    rot: (p as any).random(0, Math.PI * 2) as number,
    drot: ((p as any).random(-1, 1) as number) * 0.006,
    scale: ((p as any).random(0.6, 1.4)) as number,
    bvx: 0,
    bvy: 0,
  };
}

function ensureForms(p: P5Instance, target: number): void {
  const count = Math.max(MIN_FORMS, Math.min(MAX_FORMS, Math.round(target)));
  for (let b = 0; b < BAND_COUNT; b++) {
    const existing = forms.filter(f => f.bandIdx === b);
    while (existing.length < count) {
      const f = makeForm(b, p);
      forms.push(f);
      existing.push(f);
    }
    let excess = existing.length - count;
    if (excess > 0) {
      forms = forms.filter(f => {
        if (f.bandIdx === b && excess > 0) { excess--; return false; }
        return true;
      });
    }
  }
}

function ensureBuf(p: P5Instance): void {
  const w = p.width;
  const h = p.height;
  if (buf && bufW === w && bufH === h) return;
  if (buf) buf.remove();
  buf = (p as any).createGraphics(w, h);
  bufW = w;
  bufH = h;
  buf.background(0);
}

function drawFormShape(g: any, kind: FormKind, sz: number): void {
  switch (kind) {
    case 'triangle': {
      const h = sz * 0.866;
      g.triangle(0, -h * 0.667, -sz * 0.5, h * 0.333, sz * 0.5, h * 0.333);
      break;
    }
    case 'circle':
      g.circle(0, 0, sz * 2);
      break;
    case 'square':
      g.rectMode(g['CENTER'] ?? 'center');
      g.rect(0, 0, sz * 1.6, sz * 1.6);
      break;
    case 'arc':
      g.arc(0, 0, sz * 2, sz * 2, 0, g['PI'] ?? Math.PI);
      break;
    case 'cross': {
      const t = sz * 0.22;
      g.rect(-t, -sz * 0.7, t * 2, sz * 1.4);
      g.rect(-sz * 0.7, -t, sz * 1.4, t * 2);
      break;
    }
    case 'chevron': {
      const h2 = sz * 0.55;
      g.beginShape();
      g.vertex(0, -h2);
      g.vertex(sz * 0.7, h2);
      g.vertex(sz * 0.35, h2);
      g.vertex(0, -h2 * 0.15);
      g.vertex(-sz * 0.35, h2);
      g.vertex(-sz * 0.7, h2);
      g.endShape(g['CLOSE'] ?? 'close');
      break;
    }
    case 'star': {
      const outer = sz;
      const inner = sz * 0.42;
      const pts = 6;
      g.beginShape();
      for (let i = 0; i < pts * 2; i++) {
        const r = i % 2 === 0 ? outer : inner;
        const a = (i * Math.PI) / pts - Math.PI / 2;
        g.vertex(r * Math.cos(a), r * Math.sin(a));
      }
      g.endShape(g['CLOSE'] ?? 'close');
      break;
    }
  }
}

export function drawKandinsky(p: P5Instance, dt: number): void {
  const { config } = store;
  const { amps, transients } = getBandAverages(BAND_COUNT);

  ensureBuf(p);
  ensureForms(p, config.kandinskyForms);

  const chaos = config.kandinskyChaos;
  const glowAmt = config.kandinskyGlow;

  // Fade trail buffer — lower glow = faster fade
  const fadeAlpha = Math.round((1 - glowAmt * 0.68) * 18 + 3);
  buf.noStroke();
  buf.fill(0, 0, 0, fadeAlpha);
  buf.rect(0, 0, bufW, bufH);

  // Beat detection
  const state = store.state;
  const { beatIntervalSec, beatOffset } = state;
  const playPos = state.isPlaying
    ? (performance.now() / 1000 - state.playStartedAt / 1000 + state.startOffset)
    : state.startOffset;
  let beatFired = false;
  if (beatIntervalSec > 0) {
    const idx = Math.floor((playPos - beatOffset) / beatIntervalSec);
    if (idx !== lastBeatIndex && idx >= 0) {
      lastBeatIndex = idx;
      beatFired = true;
      hueShift = (hueShift + ((p as any).random(25, 55) as number)) % 360;
    }
  }

  // On beat — scatter all forms radially from centre
  if (beatFired) {
    for (const f of forms) {
      const dx = f.x - 0.5;
      const dy = f.y - 0.5;
      const len = Math.sqrt(dx * dx + dy * dy) + 0.001;
      const str = ((p as any).random(0.025, 0.06)) as number;
      f.bvx = (dx / len) * str;
      f.bvy = (dy / len) * str;
    }
  }

  buf.colorMode(buf['HSB'] ?? 'hsb', 360, 100, 100, 100);

  for (const f of forms) {
    const amp = Math.min(1, amps[f.bandIdx] * 2.2);
    const trans = transients[f.bandIdx] - 1.0; // transientValues is a multiplier; subtract 1 for additive boost

    // Perlin drift
    const noiseSpeed = 0.002 * (0.5 + chaos * 2.5) * dt;
    f.nx += noiseSpeed;
    f.ny += noiseSpeed * 0.7;
    const nx = ((p as any).noise(f.nx) as number) * 2 - 1;
    const ny = ((p as any).noise(f.ny) as number) * 2 - 1;

    const moveSpeed = (0.0006 + chaos * 0.0024) * dt;
    f.x += nx * moveSpeed + f.bvx;
    f.y += ny * moveSpeed + f.bvy;
    f.bvx *= 0.90;
    f.bvy *= 0.90;

    // Wrap canvas
    if (f.x < -0.12) f.x += 1.24;
    if (f.x >  1.12) f.x -= 1.24;
    if (f.y < -0.12) f.y += 1.24;
    if (f.y >  1.12) f.y -= 1.24;

    f.rot += f.drot * dt * (1 + amp * 2.5);

    // Size driven by amplitude + transient
    const baseSz = (isMobile ? 14 : 20) * f.scale;
    const sz = baseSz * (0.35 + amp * 1.15 + trans * 0.5);
    if (sz < 2) continue;

    const hue = (BAND_HUES[f.bandIdx] + hueShift) % 360;
    const sat = BAND_SATS[f.bandIdx];
    const bri = Math.min(100, BAND_BRIS[f.bandIdx] * (0.45 + amp * 0.7));
    const alpha = Math.min(100, 50 + amp * 55);

    const cx = f.x * bufW;
    const cy = f.y * bufH;
    const isArc = f.kind === 'arc';
    const isCross = f.kind === 'cross';

    buf.push();
    buf.translate(cx, cy);
    buf.rotate(f.rot);

    // 3-pass glow: outer halo → mid → bright core
    const passes = [
      { sw: sz * 0.55 * glowAmt, a: alpha * 0.15 },
      { sw: sz * 0.25 * glowAmt, a: alpha * 0.30 },
      { sw: 0, a: alpha },
    ];

    for (const pass of passes) {
      if (isArc) {
        buf.noFill();
        buf.stroke(hue, sat, bri, pass.a);
        buf.strokeWeight(Math.max(1, pass.sw > 0 ? pass.sw : sz * 0.09));
      } else if (isCross) {
        buf.fill(hue, sat, bri, pass.a);
        if (pass.sw > 0) {
          buf.noStroke();
        } else {
          buf.stroke(hue, Math.min(100, sat + 10), Math.min(100, bri + 15), alpha * 0.6);
          buf.strokeWeight(1.0);
        }
      } else {
        buf.fill(hue, sat, bri, pass.a);
        buf.noStroke();
      }
      drawFormShape(buf, f.kind, sz);
    }

    // Crisp outline for filled forms
    if (!isArc) {
      buf.noFill();
      buf.stroke(hue, Math.min(100, sat + 12), Math.min(100, bri + 18), Math.min(100, alpha * 0.65));
      buf.strokeWeight(1.0);
      drawFormShape(buf, f.kind, sz);
    }

    buf.pop();
  }

  // Composite onto canvas with ADD blend for neon glow
  p.blendMode(p['ADD']);
  p.image(buf, 0, 0);
  p.blendMode(p['BLEND']);
}

export function resetKandinsky(): void {
  forms = [];
  lastBeatIndex = -1;
  hueShift = 0;
  if (buf) { buf.remove(); buf = null; }
  bufW = 0;
  bufH = 0;
}
