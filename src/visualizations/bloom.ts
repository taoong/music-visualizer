/**
 * Bloom — Generative neon branching growth visualization.
 *
 * Radiant branches grow outward from the canvas center driven by audio.
 * Sub-bass spawns thick root segments (warm red/orange); each tip can fork
 * into a thinner child mapped to the next higher frequency band, climbing
 * through yellow → green → teal → blue → violet at the finest tips.
 * An offscreen buffer preserves trails; a semi-transparent fade controls
 * persistence. Beats trigger a burst of new root tips; audio amplitude
 * drives continuous forking.
 *
 * Sliders: Density (fork rate / spawn rate), Lifespan (trail persistence),
 *          Spread (branch deviation angle)
 */
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { BAND_COUNT, isMobile } from '../utils/constants';

// Single-hue magenta bloom. Generation depth (not band) drives the colour
// ladder: deep dark magenta at the roots, near-white pink at the finest
// tips. Audio amplitude/beats only affect brightness/saturation, never hue.
const BLOOM_HUE = 320;

interface Tip {
  x: number;
  y: number;
  angle: number;
  life: number;
  maxLife: number;
  thickness: number;
  band: number;
  noiseT: number;
  speed: number;
  forkTimer: number;
  depth: number;
}

const MAX_TIPS = isMobile ? 300 : 700;

let tips: Tip[] = [];
let pg: any = null;
let lastBeatIndex = -1;
let globalNoiseT = 0;

export function resetBloom(): void {
  tips = [];
  pg = null;
  lastBeatIndex = -1;
  globalNoiseT = 0;
}

export function drawBloom(p: P5Instance, dt: number): void {
  const { state, config } = store;
  const { amps } = getBandAverages(BAND_COUNT);

  const density = config.bloomDensity;
  const lifespan = config.bloomLifespan;
  const spread = config.bloomSpread;

  // Init / resize offscreen buffer
  if (!pg || pg.width !== p.width || pg.height !== p.height) {
    pg = (p as any).createGraphics(p.width, p.height);
    pg.pixelDensity(1);
    pg.background(0);
    tips = [];
    lastBeatIndex = -1;
  }

  // Beat detection
  let onBeat = false;
  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    const beatIndex = adjusted >= 0 ? Math.floor(adjusted / state.beatIntervalSec) : -1;
    if (beatIndex >= 0 && beatIndex !== lastBeatIndex) {
      lastBeatIndex = beatIndex;
      onBeat = true;
    }
  }

  // Beat → burst of root tips
  if (onBeat) {
    spawnRootBurst(p, amps, density);
  }

  // Continuous spawn from low-freq energy (works without BPM)
  const avgLow = (amps[0] + amps[1]) * 0.5;
  if (tips.length < MAX_TIPS * 0.3 && avgLow > 0.3 && Math.random() < avgLow * density * 0.3 * dt) {
    spawnRootBurst(p, amps, density);
  }

  globalNoiseT += 0.002 * dt;

  // --- Draw to offscreen buffer ---
  (pg as any).colorMode(pg['HSB'], 360, 100, 100, 100);
  pg.blendMode(pg['BLEND']);

  // Fade: low lifespan → fast fade; high lifespan → slow fade
  const fadeAlpha = (1 - lifespan) * 18 + 1.5;
  pg.noStroke();
  pg.fill(0, 0, 0, fadeAlpha);
  pg.rect(0, 0, pg.width, pg.height);

  pg.noFill();
  pg.blendMode(pg['ADD']);

  const next: Tip[] = [];

  for (const tip of tips) {
    tip.life -= dt;
    if (tip.life <= 0) continue;

    // Perlin-noise steering
    const noiseVal = (p as any).noise(tip.noiseT, globalNoiseT) * 2 - 1;
    tip.angle += noiseVal * spread * 0.055 * dt;

    const prevX = tip.x;
    const prevY = tip.y;
    tip.x += Math.cos(tip.angle) * tip.speed * dt;
    tip.y += Math.sin(tip.angle) * tip.speed * dt;
    tip.noiseT += 0.05 * dt;

    const lifeFrac = tip.life / tip.maxLife;
    const coreAlpha = lifeFrac * 80 + 10;

    // Depth-driven colour ladder: depth01=0 → deep magenta root, =1 → tip.
    const depth01 = Math.min(1, tip.depth / (BAND_COUNT - 1));
    // Sat falls with depth so finest tips read as warm-white, not pink.
    const haloSat = 80 - depth01 * 60;
    const midSat = 90 - depth01 * 70;
    const coreSat = 50 - depth01 * 40;
    // Brightness rises with depth so the canopy glows brighter than the trunk.
    const haloBri = 70 + depth01 * 30;
    const midBri = 78 + depth01 * 22;
    const coreBri = 88 + depth01 * 12;

    // 3-pass glow: outer halo → mid → bright core
    pg.strokeWeight(tip.thickness * 5.5);
    pg.stroke(BLOOM_HUE, haloSat, haloBri, coreAlpha * 0.22);
    pg.line(prevX, prevY, tip.x, tip.y);

    pg.strokeWeight(tip.thickness * 2.2);
    pg.stroke(BLOOM_HUE, midSat, midBri, coreAlpha * 0.55);
    pg.line(prevX, prevY, tip.x, tip.y);

    pg.strokeWeight(tip.thickness);
    pg.stroke(BLOOM_HUE, coreSat, coreBri, coreAlpha);
    pg.line(prevX, prevY, tip.x, tip.y);

    // Forking
    tip.forkTimer -= dt;
    if (
      tip.forkTimer <= 0 &&
      tip.depth < BAND_COUNT - 1 &&
      tip.life > tip.maxLife * 0.2 &&
      next.length < MAX_TIPS
    ) {
      tip.forkTimer = 7 + Math.random() * 11;
      const amp = amps[tip.band];
      const forkChance = amp * density * 0.75 + density * 0.18;
      if (Math.random() < forkChance) {
        const childCount = Math.random() < 0.35 ? 2 : 1;
        for (let c = 0; c < childCount; c++) {
          const side = c === 0 ? 1 : -1;
          const deviation = (Math.random() * 0.45 + 0.18) * spread * Math.PI * side;
          const childBand = tip.band + 1;
          const childLife = tip.maxLife * (0.38 + Math.random() * 0.28);
          if (next.length < MAX_TIPS) {
            next.push({
              x: tip.x,
              y: tip.y,
              angle: tip.angle + deviation,
              life: childLife,
              maxLife: childLife,
              thickness: tip.thickness * 0.62,
              band: childBand,
              noiseT: Math.random() * 1000,
              speed: tip.speed * 0.78 + Math.random() * 0.6,
              forkTimer: 6 + Math.random() * 9,
              depth: tip.depth + 1,
            });
          }
        }
      }
    }

    if (next.length < MAX_TIPS) next.push(tip);
  }

  tips = next;

  pg.blendMode(pg['BLEND']);
  (pg as any).colorMode(pg['RGB'], 255, 255, 255, 255);

  // Composite buffer onto canvas
  p.background(0);
  p.blendMode(p['ADD']);
  p.image(pg, 0, 0);
  p.blendMode(p['BLEND']);
  (p as any).colorMode(p['RGB'], 255, 255, 255, 255);
}

function spawnRootBurst(p: P5Instance, amps: ArrayLike<number>, density: number): void {
  const cx = p.width / 2;
  const cy = p.height / 2;
  const count = Math.max(4, Math.round(density * BAND_COUNT + 2));
  for (let i = 0; i < count; i++) {
    const band = Math.floor((i / count) * BAND_COUNT);
    const amp = amps[band];
    const baseAngle = (i / count) * Math.PI * 2;
    const jitter = (Math.random() - 0.5) * 0.9;
    const maxLife = 55 + amp * 75 + density * 35;
    tips.push({
      x: cx,
      y: cy,
      angle: baseAngle + jitter,
      life: maxLife,
      maxLife,
      thickness: 2.5 + (BAND_COUNT - band) * 0.65,
      band,
      noiseT: Math.random() * 1000,
      speed: 1.8 + amp * 3.5 + density * 1.5,
      forkTimer: 4 + Math.random() * 9,
      depth: 0,
    });
  }
}
