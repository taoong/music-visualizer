/**
 * Web Work — Audio-reactive luminous spider web.
 *
 * Inspired by Tomas Saraceno's "Cosmic Jive / Cosmic Jazz" (2020),
 * a spider-web installation at Palais de Tokyo, Paris, in which
 * multi-layered webs built by collaborating spiders are lit with UV
 * light, creating radiant, almost weightless geometric forms floating
 * in deep darkness. https://studiotomassaraceno.org/cosmic-jive-jazz/
 *
 * Architecture: N radial spokes + BAND_COUNT concentric polygon rings.
 * Each ring maps to one frequency band; ring vertices are displaced
 * radially by a sinusoidal vibration driven by that band's amplitude,
 * making the web tremble with the music. Dew drops (bright nodes)
 * appear at spoke–ring intersections at an amplitude-dependent density.
 * Beat fires an expanding radial ripple that brightens each ring as it
 * passes. The whole web rotates slowly, faster when the music is loud.
 *
 * Sliders
 *   Strands — radial spoke count (8 → 48 desktop / 8 → 24 mobile)
 *   Dew     — dew-drop size and density at spoke–ring intersections
 *   Pulse   — beat-triggered ripple wave intensity
 */
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { BAND_COUNT, isMobile } from '../utils/constants';

// Hue per band: sub=violet, bass=blue, lowMid=teal, mid=green, upperMid=yellow, presence=orange, brilliance=red
const BAND_HUES: readonly number[] = [280, 230, 180, 120, 60, 30, 0];

const MIN_SPOKES = 8;
const MAX_SPOKES = isMobile ? 24 : 48;

let lastBeatIndex = -1;
let hueShift = 0;
let rippleRadius = 0; // 0..1 normalised to maxR
let rippleStrength = 0;
let globalAngle = 0;
let animTime = 0;

export function resetWebwork(): void {
  lastBeatIndex = -1;
  hueShift = 0;
  rippleRadius = 0;
  rippleStrength = 0;
  globalAngle = 0;
  animTime = 0;
}

export function drawWebwork(p: P5Instance, dt: number): void {
  const { state, config } = store;
  const { amps } = getBandAverages(BAND_COUNT);

  const W = p.width;
  const H = p.height;
  const cx = W / 2;
  const cy = H / 2;
  const maxR = Math.min(W, H) * 0.46;

  const numSpokes = Math.round(MIN_SPOKES + config.webworkStrands * (MAX_SPOKES - MIN_SPOKES));
  const dewSize = config.webworkDew;
  const pulseAmt = config.webworkPulse;

  // Beat detection
  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    const beatIdx = adjusted >= 0 ? Math.floor(adjusted / state.beatIntervalSec) : -1;
    if (beatIdx >= 0 && beatIdx !== lastBeatIndex) {
      lastBeatIndex = beatIdx;
      hueShift = (hueShift + 40) % 360;
      rippleRadius = 0;
      rippleStrength = 1.0;
    }
  }

  // Ripple propagates outward
  rippleRadius += 0.012 * dt;
  rippleStrength *= Math.pow(0.93, dt);
  if (rippleRadius > 1.3) { rippleRadius = 0; rippleStrength = 0; }

  // Animation time accumulator (frame-rate independent)
  animTime += dt * 0.035;

  // Slow web rotation, amplitude-boosted
  const overallAmp = amps.reduce((a, b) => a + b) / BAND_COUNT;
  globalAngle += 0.00012 * dt * (1 + overallAmp * 2);

  p.background(5, 3, 15);
  (p as any).colorMode(p['HSB'], 360, 100, 100, 255);

  // Build node grid: nodes[ring][spoke] = {x, y}
  // Each node is displaced radially by vibration driven by its ring's amplitude
  const nodes: Array<Array<{ x: number; y: number }>> = [];

  for (let ring = 0; ring < BAND_COUNT; ring++) {
    const r0 = maxR * (ring + 1) / BAND_COUNT;
    const amp = amps[ring];
    const normR = (ring + 1) / BAND_COUNT;
    const rippleDist = Math.abs(rippleRadius - normR);
    const rippleContrib = rippleStrength * Math.exp(-rippleDist * rippleDist * 60) * pulseAmt;
    const row: Array<{ x: number; y: number }> = [];

    for (let s = 0; s < numSpokes; s++) {
      const angle = (s / numSpokes) * Math.PI * 2 + globalAngle;
      // Vibration: standing wave across spokes, driven by band amplitude
      const vibration = amp * maxR * 0.025 * Math.sin(s * 0.9 + animTime + ring * 1.3);
      const r = r0 + vibration + rippleContrib * maxR * 0.06;
      row.push({ x: cx + Math.cos(angle) * r, y: cy + Math.sin(angle) * r });
    }
    nodes.push(row);
  }

  // — Spokes (radial threads from centre to outermost ring) —
  p.noFill();
  for (let s = 0; s < numSpokes; s++) {
    const outer = nodes[BAND_COUNT - 1][s];

    // Outer halo
    p.stroke(200, 12, 28 + overallAmp * 22);
    p.strokeWeight(2.5 + overallAmp * 3.5);
    p.line(cx, cy, outer.x, outer.y);

    // Core
    p.stroke(200, 5, 52 + overallAmp * 30);
    p.strokeWeight(0.5 + overallAmp * 0.7);
    p.line(cx, cy, outer.x, outer.y);
  }

  // — Rings (concentric polygon per band, 3-pass glow) —
  for (let ring = 0; ring < BAND_COUNT; ring++) {
    const amp = amps[ring];
    const hue = (BAND_HUES[ring] + hueShift) % 360;
    const normR = (ring + 1) / BAND_COUNT;
    const rippleDist = Math.abs(rippleRadius - normR);
    const rippleContrib = rippleStrength * Math.exp(-rippleDist * rippleDist * 40) * pulseAmt;
    const bright = 20 + amp * 68 + rippleContrib * 68;
    const sat = 55 + amp * 35;

    // Pass 1 — outer halo
    p.stroke(hue, sat * 0.35, Math.min(bright * 0.35, 100));
    p.strokeWeight(5 + amp * 8 + rippleContrib * 10);
    p.beginShape();
    for (let s = 0; s < numSpokes; s++) p.vertex(nodes[ring][s].x, nodes[ring][s].y);
    p.endShape(p['CLOSE']);

    // Pass 2 — mid
    p.stroke(hue, sat * 0.65, Math.min(bright * 0.65, 100));
    p.strokeWeight(1.8 + amp * 3 + rippleContrib * 4);
    p.beginShape();
    for (let s = 0; s < numSpokes; s++) p.vertex(nodes[ring][s].x, nodes[ring][s].y);
    p.endShape(p['CLOSE']);

    // Pass 3 — core
    p.stroke(hue, sat * 0.45 + 15, Math.min(bright, 100));
    p.strokeWeight(0.5 + amp * 1.1 + rippleContrib * 1.3);
    p.beginShape();
    for (let s = 0; s < numSpokes; s++) p.vertex(nodes[ring][s].x, nodes[ring][s].y);
    p.endShape(p['CLOSE']);
  }

  // — Dew drops at spoke–ring intersections —
  if (dewSize > 0.04) {
    p.noStroke();
    // Reduce density on dense webs to avoid overlap
    const step = Math.max(1, Math.floor(numSpokes / 24));

    for (let ring = 0; ring < BAND_COUNT; ring++) {
      const amp = amps[ring];
      const hue = (BAND_HUES[ring] + hueShift) % 360;
      const normR = (ring + 1) / BAND_COUNT;
      const rippleDist = Math.abs(rippleRadius - normR);
      const rippleContrib = rippleStrength * Math.exp(-rippleDist * rippleDist * 40) * pulseAmt;

      for (let s = 0; s < numSpokes; s += step) {
        // Stable, non-flickering distribution via golden-ratio hash
        const phase = ((ring * 7 + s * 3) * 0.61803398875) % 1.0;
        const threshold = 0.35 + amp * 0.6;
        if (phase > threshold && rippleContrib < 0.08) continue;

        const { x, y } = nodes[ring][s];
        const size = dewSize * (1.5 + amp * 5.5) + rippleContrib * 3.5;
        const brightness = 45 + amp * 45 + rippleContrib * 42;
        const sat = 50 + amp * 35;

        // Outer glow
        p.fill(hue, sat * 0.4, brightness * 0.5, 80);
        p.ellipse(x, y, size * 2.5, size * 2.5);
        // Inner sphere
        p.fill(hue, sat * 0.55, Math.min(brightness, 100), 170);
        p.ellipse(x, y, size, size);
        // Specular highlight
        p.fill(0, 0, 100, 215);
        const hlS = size * 0.28;
        p.ellipse(x - hlS * 0.4, y - hlS * 0.4, hlS, hlS);
      }
    }
  }

  // — Centre orb —
  p.noStroke();
  const cSize = 7 + overallAmp * 18;
  p.fill(220, 20, 45 + overallAmp * 42, 110);
  p.ellipse(cx, cy, cSize * 2.5, cSize * 2.5);
  p.fill(210, 10, 82 + overallAmp * 18, 200);
  p.ellipse(cx, cy, cSize, cSize);
  p.fill(0, 0, 100, 230);
  p.ellipse(cx, cy, cSize * 0.4, cSize * 0.4);

  (p as any).colorMode(p['RGB'], 255, 255, 255, 255);
}
