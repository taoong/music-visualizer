/**
 * Cloud Chamber visualization — particle physics cloud chamber simulation
 *
 * Subatomic particles leave glowing vapor trails. Frequency bands trigger
 * different particle types, beats trigger cosmic ray showers, and a magnetic
 * field curves charged particle paths via Lorentz force.
 */
import { store } from '../state/store';
import { getBandAverages } from './helpers';
import { BAND_COUNT, isMobile } from '../utils/constants';

// ── Types ───────────────────────────────────────────────────────────────────

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  charge: number;   // -1, 0, +1 (alpha uses +2 internally but stored as +1 for Lorentz)
  mass: number;      // affects curvature radius
  lifetime: number;
  maxLifetime: number;
  thickness: number;
  trail: { x: number; y: number }[];
  maxTrail: number;
  type: ParticleType;
  hue: number;       // HSB hue tint
  brightness: number;
  // Pion decay
  decayed: boolean;
  decayTime: number;
  // Gamma pair production
  converted: boolean;
  convertTime: number;
  children: Particle[];
}

type ParticleType = 'alpha' | 'proton' | 'muon' | 'electron' | 'positron' | 'pion' | 'gamma';

// ── Constants ───────────────────────────────────────────────────────────────

const MAX_PARTICLES = isMobile ? 100 : 200;
const SPAWN_THRESHOLD = 0.15;
const SHOWER_MIN = 5;
const SHOWER_MAX = 15;
const BG_COLOR = '#0a0a14';

// Particle type definitions indexed by band
const PARTICLE_DEFS: {
  type: ParticleType;
  charge: number;
  mass: number;
  thickness: number;
  speed: number;
  trailLen: number;
  hue: number;
  brightness: number;
}[] = [
  // Sub → Alpha: thick, short, bright, barely curves
  { type: 'alpha', charge: 1, mass: 8.0, thickness: 4, speed: 2.5, trailLen: 20, hue: 40, brightness: 100 },
  // Bass → Proton: medium, slight curve
  { type: 'proton', charge: 1, mass: 4.0, thickness: 2.5, speed: 3.5, trailLen: 40, hue: 200, brightness: 95 },
  // Low-Mid → Muon: thin, long, straight
  { type: 'muon', charge: 0, mass: 1.0, thickness: 1.5, speed: 5.0, trailLen: 60, hue: 180, brightness: 85 },
  // Mid → Electron: thin, tight spiral
  { type: 'electron', charge: -1, mass: 0.2, thickness: 1.2, speed: 4.0, trailLen: 50, hue: 220, brightness: 90 },
  // Upper-Mid → Positron: mirror of electron
  { type: 'positron', charge: 1, mass: 0.2, thickness: 1.2, speed: 4.0, trailLen: 50, hue: 300, brightness: 90 },
  // Presence → Pion: medium, decays mid-flight
  { type: 'pion', charge: 1, mass: 1.0, thickness: 2.0, speed: 3.5, trailLen: 35, hue: 120, brightness: 88 },
  // Brilliance → Gamma: invisible until pair production
  { type: 'gamma', charge: 0, mass: 0, thickness: 0, speed: 6.0, trailLen: 50, hue: 60, brightness: 95 },
];

// ── Module state ────────────────────────────────────────────────────────────

let particles: Particle[] = [];
let lastBeatIndex = -1;
let initialized = false;
let canvasW = 0;
let canvasH = 0;
let flashAlpha = 0;

// ── Public API ──────────────────────────────────────────────────────────────

export function drawCloudChamber(p: P5Instance, dt: number): void {
  if (!initialized || canvasW !== p.width || canvasH !== p.height) {
    canvasW = p.width;
    canvasH = p.height;
    if (!initialized) {
      particles = [];
      lastBeatIndex = -1;
      flashAlpha = 0;
    
    }
    initialized = true;
  }

  const magneticField = store.config.cloudMagneticField;
  const lifetimeScale = store.config.cloudParticleLife;
  const maxLifeFrames = 30 + lifetimeScale * 270; // 30–300

  // Read audio
  const { amps } = getBandAverages(BAND_COUNT);

  // Beat detection
  detectBeatShower(p, amps, maxLifeFrames);

  // Continuous spawning from audio bands
  spawnFromAudio(p, amps, dt, maxLifeFrames);

  // Background
  p.background(BG_COLOR);

  // Subtle grain noise
  drawGrain(p, dt);

  // Beat flash
  if (flashAlpha > 0) {
    p.noStroke();
    p.fill(255, 255, 255, flashAlpha);
    p.rect(0, 0, canvasW, canvasH);
    flashAlpha = Math.max(0, flashAlpha - 8 * dt);
  }

  // Update & render particles
  (p as any).colorMode(p['HSB'], 360, 100, 100, 255);

  for (let i = particles.length - 1; i >= 0; i--) {
    const part = particles[i];

    // Update physics
    updateParticle(part, magneticField, dt);

    // Render trail
    renderTrail(p, part);

    // Remove dead particles
    if (part.lifetime <= 0) {
      // If gamma converted, children are already in the particles array
      particles.splice(i, 1);
    }
  }

  (p as any).colorMode(p['RGB'], 255, 255, 255, 255);
}

export function resetCloudChamber(): void {
  particles = [];
  lastBeatIndex = -1;
  initialized = false;
  flashAlpha = 0;

}

// ── Spawning ────────────────────────────────────────────────────────────────

function spawnFromAudio(p: P5Instance, amps: number[], dt: number, maxLife: number): void {
  for (let b = 0; b < Math.min(amps.length, 7); b++) {
    if (amps[b] < SPAWN_THRESHOLD) continue;
    // Spawn probability scales with amplitude
    const prob = (amps[b] - SPAWN_THRESHOLD) * 1.5 * dt;
    if (Math.random() < prob && particles.length < MAX_PARTICLES) {
      particles.push(createParticle(p, b, maxLife, null));
    }
  }
}

function detectBeatShower(p: P5Instance, _amps: number[], maxLife: number): void {
  const { state } = store;
  if (state.beatIntervalSec <= 0) return;

  const playbackPos = state.isPlaying
    ? (performance.now() / 1000 - state.playStartedAt / 1000 + state.startOffset)
    : state.startOffset;
  const beatIndex = Math.floor((playbackPos - state.beatOffset) / state.beatIntervalSec);

  if (beatIndex > lastBeatIndex && lastBeatIndex >= 0) {
    // Cosmic ray shower
    const count = SHOWER_MIN + Math.floor(Math.random() * (SHOWER_MAX - SHOWER_MIN + 1));
    const originX = Math.random() * canvasW;
    const originY = Math.random() * canvasH;
    flashAlpha = 40;

    for (let i = 0; i < count && particles.length < MAX_PARTICLES; i++) {
      const band = Math.floor(Math.random() * 7);
      particles.push(createParticle(p, band, maxLife, { x: originX, y: originY }));
    }
  }
  lastBeatIndex = beatIndex;
}

function createParticle(
  _p: P5Instance,
  band: number,
  maxLife: number,
  origin: { x: number; y: number } | null,
): Particle {
  const def = PARTICLE_DEFS[band];
  let x: number, y: number, angle: number;

  if (origin) {
    // Shower: radiate from a point
    x = origin.x;
    y = origin.y;
    angle = Math.random() * Math.PI * 2;
  } else {
    // Spawn from random edge
    const edge = Math.floor(Math.random() * 4);
    switch (edge) {
      case 0: x = Math.random() * canvasW; y = 0; angle = Math.PI * 0.25 + Math.random() * Math.PI * 0.5; break;
      case 1: x = canvasW; y = Math.random() * canvasH; angle = Math.PI * 0.75 + Math.random() * Math.PI * 0.5; break;
      case 2: x = Math.random() * canvasW; y = canvasH; angle = -Math.PI * 0.75 + Math.random() * Math.PI * 0.5; break;
      default: x = 0; y = Math.random() * canvasH; angle = -Math.PI * 0.25 + Math.random() * Math.PI * 0.5; break;
    }
  }

  const speed = def.speed * (0.8 + Math.random() * 0.4);
  const life = maxLife * (0.5 + Math.random() * 0.5);

  const particle: Particle = {
    x, y,
    vx: Math.cos(angle) * speed,
    vy: Math.sin(angle) * speed,
    charge: def.charge,
    mass: def.mass,
    lifetime: life,
    maxLifetime: life,
    thickness: def.thickness,
    trail: [{ x, y }],
    maxTrail: def.trailLen,
    type: def.type,
    hue: def.hue,
    brightness: def.brightness,
    decayed: false,
    decayTime: 0.3 + Math.random() * 0.4, // fraction of lifetime when pion decays
    converted: false,
    convertTime: 0.1 + Math.random() * 0.3, // fraction of lifetime when gamma converts
    children: [],
  };

  return particle;
}

// ── Physics ─────────────────────────────────────────────────────────────────

function updateParticle(p: Particle, B: number, dt: number): void {
  p.lifetime -= dt;

  // Pion decay: kink mid-flight
  if (p.type === 'pion' && !p.decayed && p.lifetime < p.maxLifetime * (1 - p.decayTime)) {
    p.decayed = true;
    // Sudden direction change (kink)
    const kinkAngle = (Math.random() - 0.5) * Math.PI * 0.6;
    const speed = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
    const currentAngle = Math.atan2(p.vy, p.vx) + kinkAngle;
    p.vx = Math.cos(currentAngle) * speed;
    p.vy = Math.sin(currentAngle) * speed;
    p.charge = 0; // decay product goes straight
    p.thickness *= 0.6;
  }

  // Gamma pair production: invisible then spawns e+/e-
  if (p.type === 'gamma' && !p.converted && p.lifetime < p.maxLifetime * (1 - p.convertTime)) {
    p.converted = true;
    // Spawn electron and positron as children
    const speed = Math.sqrt(p.vx * p.vx + p.vy * p.vy) * 0.7;
    const baseAngle = Math.atan2(p.vy, p.vx);
    const spread = 0.3 + Math.random() * 0.2;

    const remainLife = Math.max(p.lifetime, 20);

    const electron: Particle = {
      x: p.x, y: p.y,
      vx: Math.cos(baseAngle + spread) * speed,
      vy: Math.sin(baseAngle + spread) * speed,
      charge: -1, mass: 0.2,
      lifetime: remainLife, maxLifetime: remainLife,
      thickness: 1.2,
      trail: [{ x: p.x, y: p.y }],
      maxTrail: 40,
      type: 'electron',
      hue: 220, brightness: 90,
      decayed: false, decayTime: 1, converted: false, convertTime: 1, children: [],
    };
    const positron: Particle = {
      x: p.x, y: p.y,
      vx: Math.cos(baseAngle - spread) * speed,
      vy: Math.sin(baseAngle - spread) * speed,
      charge: 1, mass: 0.2,
      lifetime: remainLife, maxLifetime: remainLife,
      thickness: 1.2,
      trail: [{ x: p.x, y: p.y }],
      maxTrail: 40,
      type: 'positron',
      hue: 300, brightness: 90,
      decayed: false, decayTime: 1, converted: false, convertTime: 1, children: [],
    };

    particles.push(electron, positron);
    p.lifetime = 0; // gamma disappears
    return;
  }

  // Lorentz force: F = qv×B (B perpendicular to screen)
  // For 2D: ax = (q * B / m) * vy, ay = -(q * B / m) * vx
  if (p.charge !== 0 && p.mass > 0 && B > 0) {
    const qBm = (p.charge * B * 3.0) / p.mass; // scale B for visible effect
    const ax = qBm * p.vy;
    const ay = -qBm * p.vx;
    p.vx += ax * dt;
    p.vy += ay * dt;
  }

  p.x += p.vx * dt;
  p.y += p.vy * dt;

  // Store trail point
  p.trail.push({ x: p.x, y: p.y });
  if (p.trail.length > p.maxTrail) {
    p.trail.shift();
  }
}

// ── Rendering ───────────────────────────────────────────────────────────────

function renderTrail(p: P5Instance, part: Particle): void {
  // Gamma before conversion is invisible
  if (part.type === 'gamma' && !part.converted) return;

  const trail = part.trail;
  if (trail.length < 2) return;

  const lifeFrac = Math.max(0, part.lifetime / part.maxLifetime);
  const baseAlpha = lifeFrac * 220;

  p.noFill();

  // Glow pass (wider, dimmer)
  for (let pass = 0; pass < 2; pass++) {
    const isGlow = pass === 0;
    const widthMult = isGlow ? 3.0 : 1.0;
    const alphaMult = isGlow ? 0.3 : 1.0;

    for (let i = 1; i < trail.length; i++) {
      const frac = i / trail.length;
      const alpha = frac * baseAlpha * alphaMult;
      const w = part.thickness * widthMult * frac;

      if (isGlow) {
        // Glow: white-blue tint
        (p as any).stroke(part.hue, 20, part.brightness, alpha * 0.5);
      } else {
        // Core: bright white with subtle hue
        (p as any).stroke(part.hue, 15, Math.min(100, part.brightness + 10), alpha);
      }

      p.strokeWeight(w);
      p.line(trail[i - 1].x, trail[i - 1].y, trail[i].x, trail[i].y);
    }
  }
}

function drawGrain(p: P5Instance, _dt: number): void {
  // Sparse grain — just a few random dots per frame
  p.noStroke();
  const grainCount = isMobile ? 20 : 50;
  for (let i = 0; i < grainCount; i++) {
    const gx = Math.random() * canvasW;
    const gy = Math.random() * canvasH;
    const brightness = 15 + Math.random() * 15;
    p.fill(brightness, brightness, brightness + 5, 20);
    p.rect(gx, gy, 1, 1);
  }
}
