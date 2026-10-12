/**
 * Global palettes — one colour story per session.
 *
 * Each palette is 5 stops ordered dark → light. The post-FX chain uses them as
 * a gradient map (pixel luminance → palette colour), which re-colours every
 * visualization — p5, Three.js and shader modes alike — without touching
 * their code. Shader modes also receive the stops as uniforms so they are
 * authored in the palette directly rather than remapped after the fact.
 *
 * Index 0 ("Original") means no remap.
 */

export interface Palette {
  name: string;
  /** 5 stops, dark → light, as 0–1 RGB triples. */
  stops: [number, number, number][];
}

function hex(h: string): [number, number, number] {
  const n = parseInt(h.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

function pal(name: string, ...stops: string[]): Palette {
  return { name, stops: stops.map(hex) };
}

export const PALETTES: Palette[] = [
  pal('Original',  '#000000', '#404040', '#808080', '#c0c0c0', '#ffffff'),
  pal('Ember',     '#0b0507', '#4a0d1a', '#b3261e', '#f28c28', '#ffe3a3'),
  pal('Abyss',     '#02040a', '#0b2545', '#13678a', '#45c4b0', '#dafdba'),
  pal('Neon Noir', '#05010d', '#3a0ca3', '#b5179e', '#f72585', '#ffd6ff'),
  pal('Acid',      '#030603', '#0f3d1f', '#2fa84f', '#b7f700', '#f4ffd6'),
  pal('Gilded',    '#050403', '#2b2116', '#7a5c2e', '#d4a64a', '#fff4d6'),
  pal('Glacier',   '#020409', '#1b263b', '#415a77', '#a9c6e8', '#f4f9ff'),
  pal('Dusk',      '#120012', '#4c1036', '#c0392b', '#f39c12', '#fff1c1'),
  pal('Vapor',     '#0d0221', '#261447', '#ff3864', '#2de2e6', '#f6f7ff'),
  pal('Mono',      '#000000', '#2a2a2a', '#6e6e6e', '#bdbdbd', '#ffffff'),
];

export function getPalette(index: number): Palette {
  const i = Math.max(0, Math.min(PALETTES.length - 1, Math.round(index)));
  return PALETTES[i];
}

/** Flattened Float32Array(15) of a palette's stops, for a vec3[5] uniform. */
export function paletteUniform(p: Palette, out = new Float32Array(15)): Float32Array {
  for (let i = 0; i < 5; i++) {
    out[i * 3] = p.stops[i][0];
    out[i * 3 + 1] = p.stops[i][1];
    out[i * 3 + 2] = p.stops[i][2];
  }
  return out;
}
