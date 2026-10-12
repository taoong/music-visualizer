/**
 * Starter GLSL shader modes. Each is a ShaderDef rendered by runner.ts; see
 * the runner header for the uniforms and helpers every shader gets.
 *
 * - sdftunnel  raymarched SDF corridor of rings/frames, smooth-min blended
 * - nebula     Inigo Quilez-style double domain-warped fbm
 * - turing     reaction-diffusion-style labyrinth (ring-spectrum plane waves,
 *              thresholded — the Fourier signature of a Turing pattern)
 * - kifs       2D kaleidoscopic IFS fractal with line glow
 */
import { store } from '../../state/store';
import type { ShaderDef } from './runner';
import { PALETTES } from '../../post/palettes';

const byName = (name: string) => PALETTES.find(p => p.name === name) ?? PALETTES[1];

// ── SDF Tunnel ───────────────────────────────────────────────────────────────

const SDF_TUNNEL = `
float smin(float a, float b, float k) {
  float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}
float sdTorus(vec3 p, vec2 t) { vec2 q = vec2(length(p.xy) - t.x, p.z); return length(q) - t.y; }
float sdBox(vec3 p, vec3 b) { vec3 q = abs(p) - b; return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0); }

const float CELL = 2.4;

float gMat; // 1 = ring/frame, 0 = tunnel wall (set by map)

float map(vec3 p, out float cid) {
  vec3 q = p;
  q.xy *= rot(q.z * 0.06 + uFlow * 0.05);
  float cz = floor(q.z / CELL + 0.5);
  q.z -= cz * CELL;
  cid = cz;
  float band = uBands[int(mod(cz, 7.0))];
  float morph = uParams.y;

  float ring = sdTorus(q, vec2(1.9 + band * 0.5, 0.05 + band * 0.14));
  vec3 fq = q;
  fq.xy *= rot(0.785 * morph + cz * 0.3 * morph);
  float frame = max(sdBox(fq, vec3(1.75 + band * 0.35, 1.75 + band * 0.35, 0.05 + band * 0.1)),
                    -sdBox(fq, vec3(1.45, 1.45, 1.0)));
  float shape = mix(ring, frame, smoothstep(0.2, 0.8, morph));
  float walls = 3.4 - length(p.xy);
  gMat = step(shape, walls);
  return smin(shape, walls, 0.35 + morph * 0.4);
}

vec3 calcNormal(vec3 p) {
  float id;
  vec2 e = vec2(0.003, 0.0);
  return normalize(vec3(map(p + e.xyy, id) - map(p - e.xyy, id),
                        map(p + e.yxy, id) - map(p - e.yxy, id),
                        map(p + e.yyx, id) - map(p - e.yyx, id)));
}

void mainImage(out vec4 color, in vec2 fragCoord) {
  vec2 uv = (fragCoord - 0.5 * uResolution) / uResolution.y;
  float z = uFlow * 3.0;
  vec3 ro = vec3(0.5 * sin(uFlow * 0.7), 0.35 * cos(uFlow * 0.5), z);
  vec3 rd = normalize(vec3(uv, 1.15 - uPulse * 0.25));
  rd.xy *= rot(uFlow * 0.12 + (uTouch.x - 0.5) * uTouch.z);

  float t = 0.0, glow = 0.0, cid = 0.0;
  bool hit = false;
  for (int i = 0; i < 80; i++) {
    vec3 p = ro + rd * t;
    float d = map(p, cid);
    // Glow only accumulates near the rings/frames, not the walls
    glow += gMat * 0.01 / (0.01 + d * d) * exp(-t * 0.08);
    if (d < 0.002) { hit = true; break; }
    if (t > 36.0) break;
    t += d * 0.85;
  }

  vec3 col = pal(0.0);
  if (hit) {
    vec3 p = ro + rd * t;
    vec3 n = calcNormal(p);
    vec3 l = normalize(vec3(0.4, 0.7, -0.5));
    float diff = max(dot(n, l), 0.0);
    float fres = pow(1.0 - max(dot(n, -rd), 0.0), 3.0);
    float mat = gMat;
    float band = uBands[int(mod(cid, 7.0))];
    vec3 ring = pal(0.45 + band * 0.5) * (0.2 + diff * 0.9) + pal(1.0) * fres * (0.3 + band);
    // Walls: dark, with faint panel seams that catch the light
    float seam = smoothstep(0.92, 1.0, abs(sin(atan(p.y, p.x) * 8.0))) + smoothstep(0.96, 1.0, abs(sin(p.z * 2.6)));
    vec3 wall = pal(0.12) * (0.25 + diff * 0.5) + pal(0.6) * seam * 0.25 * (0.3 + uLevel);
    col = mix(wall, ring, mat);
    col = mix(col, pal(0.0), 1.0 - exp(-t * 0.09));
  }
  float glowAmt = mix(0.001, 0.012, uParams.z) * (1.0 + uLevel * 1.5 + uPulse);
  col += pal(0.8) * glow * glowAmt;
  color = vec4(col, 1.0);
}
`;

// ── Nebula (domain-warped fbm) ───────────────────────────────────────────────

const NEBULA = `
void mainImage(out vec4 color, in vec2 fragCoord) {
  vec2 uv = (fragCoord - 0.5 * uResolution) / uResolution.y;
  vec2 tp = (uTouch.xy - 0.5) * vec2(uResolution.x / uResolution.y, 1.0);
  vec2 dv = uv - tp;
  uv = tp + rot(uTouch.z * 2.5 * exp(-dot(dv, dv) * 6.0)) * dv; // interactive swirl

  float sc = mix(1.2, 4.5, uParams.y);
  vec2 p = uv * sc;
  float t = uFlow;
  float warp = mix(0.6, 4.5, uParams.x) * (1.0 + uBands[0] * 0.5 + uPulse * 0.35);

  vec2 q = vec2(fbm(p + vec2(0.0, t * 0.3)), fbm(p + vec2(5.2, 1.3) - t * 0.2));
  vec2 r = vec2(fbm(p + warp * q + vec2(1.7, 9.2) + t * 0.15 + uBands[2] * 0.5),
                fbm(p + warp * q + vec2(8.3, 2.8) - t * 0.12));
  float f = fbm(p + warp * r);

  float v = smoothstep(0.15, 0.95, f * f * 1.4 + length(q) * 0.25 * (0.3 + uBands[3]));
  vec3 col = pal(clamp(v * 0.85 + uBands[1] * 0.1, 0.0, 1.0));
  col += pal(1.0) * pow(clamp(r.x, 0.0, 1.0), 6.0) * (0.15 + uBands[6] * 1.0);
  col *= 0.35 + 0.65 * f + uPulse * 0.2;
  color = vec4(col, 1.0);
}
`;

// ── Turing (reaction-diffusion-style labyrinth) ──────────────────────────────

const TURING = `
const int N = 12;

void mainImage(out vec4 color, in vec2 fragCoord) {
  vec2 uv = (fragCoord - 0.5 * uResolution) / uResolution.y;
  float k = mix(16.0, 64.0, uParams.x);

  // A Turing pattern's spectrum is a ring: many plane waves of one wavelength
  // in different directions. Thresholding their sum yields spots/labyrinths.
  float f = 0.0;
  for (int i = 0; i < N; i++) {
    float fi = float(i);
    float a = fi * 3.14159 / float(N) + 0.18 * sin(uFlow * 0.3 + fi * 1.7);
    vec2 dir = vec2(cos(a), sin(a));
    float band = uBands[i % 7];
    f += cos(dot(uv, dir) * k * (1.0 + 0.06 * band) + uFlow * (0.4 + fi * 0.11) + fi * 2.4);
  }
  f /= sqrt(float(N));

  vec2 tp = (uTouch.xy - 0.5) * vec2(uResolution.x / uResolution.y, 1.0);
  float td = length(uv - tp);
  f += uTouch.z * 2.0 * cos(td * k * 0.5 - uTime * 6.0) * exp(-td * 3.0);

  // Regional threshold drift = feed/kill varying across the dish;
  // bass pushes toward spots, quiet toward stripes
  float region = fbm(uv * 1.4 + uFlow * 0.04) - 0.5;
  float thr = region * 1.4 + (uBands[0] + uBands[1] - 0.7) * 0.6 + uPulse * 0.3;
  float sharp = mix(1.5, 12.0, uParams.y);
  float v = clamp(0.5 + (f - thr) * sharp * 0.25, 0.0, 1.0);

  float edge = 1.0 - abs(v * 2.0 - 1.0);
  vec3 col = pal(v * 0.72 + 0.04);
  col += pal(0.97) * edge * edge * (0.12 + uBands[5] * 0.7 + uPulse * 0.5);
  color = vec4(col, 1.0);
}
`;

// ── KIFS fractal ─────────────────────────────────────────────────────────────

const KIFS = `
void mainImage(out vec4 color, in vec2 fragCoord) {
  vec2 uv = (fragCoord - 0.5 * uResolution) / uResolution.y;
  float zoom = mix(0.7, 2.6, uParams.y) * (1.0 - uPulse * 0.08);
  vec2 p = uv * zoom;
  p *= rot(uFlow * 0.2);

  // Radial N-fold mirror symmetry
  float n = floor(mix(3.0, 12.0, uParams.x) + 0.5);
  float seg = 6.28318 / n;
  float ang = mod(atan(p.y, p.x), seg);
  ang = abs(ang - seg * 0.5);
  p = vec2(cos(ang), sin(ang)) * length(p);

  vec3 col = vec3(0.0);
  float s = 1.0;
  float glowW = mix(0.0006, 0.004, uParams.z);
  for (int i = 0; i < 7; i++) {
    float fi = float(i);
    float b = uBands[i];
    p = abs(p) - vec2(0.45 + 0.2 * sin(uFlow * 0.31 + fi), 0.25 + 0.25 * b);
    p *= rot(0.55 + 0.3 * sin(uFlow * 0.17 + fi * 0.7) + uPulse * 0.12);
    p *= 1.32;
    s *= 1.32;
    float d = abs(p.y) / s;
    col += pal(0.5 + fi / 6.0 * 0.5) * pow(glowW / (d + glowW), 1.5) * (0.3 + b * 1.6);
  }
  col = 1.0 - exp(-col * 1.4);
  col += pal(0.15) * max(0.0, 1.0 - length(uv) * 1.2) * 0.5;
  color = vec4(col, 1.0);
}
`;

export const SHADER_DEFS: Record<'sdftunnel' | 'nebula' | 'turing' | 'kifs', ShaderDef> = {
  sdftunnel: {
    id: 'sdftunnel',
    frag: SDF_TUNNEL,
    palette: byName('Neon Noir'),
    heavy: true,
    params: () => [store.config.sdftunnelSpeed, store.config.sdftunnelMorph, store.config.sdftunnelGlow],
    speed: () => 0.15 + store.config.sdftunnelSpeed * 1.6,
  },
  nebula: {
    id: 'nebula',
    frag: NEBULA,
    palette: byName('Dusk'),
    params: () => [store.config.nebulaWarp, store.config.nebulaScale, store.config.nebulaFlow],
    speed: () => 0.05 + store.config.nebulaFlow * 0.7,
  },
  turing: {
    id: 'turing',
    frag: TURING,
    palette: byName('Abyss'),
    params: () => [store.config.turingScale, store.config.turingSharp, store.config.turingFlow],
    speed: () => 0.05 + store.config.turingFlow * 1.2,
  },
  kifs: {
    id: 'kifs',
    frag: KIFS,
    palette: byName('Gilded'),
    params: () => [store.config.kifsFolds, store.config.kifsZoom, store.config.kifsGlow],
    speed: () => 0.3,
  },
};
