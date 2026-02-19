/**
 * Balls visualization with bouncing physics
 */
import { store } from '../state/store';
import { BAND_COUNT, BALL_COUNT, STEMS, DELTA_BRIGHTNESS_BOOST, isMobile } from '../utils/constants';
import { getBandAverages } from './helpers';

export function initBalls(p: P5Instance): void {
  const { state } = store;
  const isFreqMode = state.mode === 'freq';
  const bandCount = isFreqMode ? BAND_COUNT : STEMS.length;

  state.balls = [];
  for (let i = 0; i < BALL_COUNT; i++) {
    const speed = 1 + Math.random() * 2;
    const angle = Math.random() * Math.PI * 2;
    const minR = isMobile ? 2 : 8;
    const rangeR = isMobile ? 4 : 20;

    state.balls.push({
      x: Math.random() * p.width,
      y: Math.random() * p.height,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      baseRadius: minR + Math.random() * rangeR,
      band: i % bandCount,
    });
  }
}

export function drawBalls(p: P5Instance, dt: number): void {
  const { state, config, audioState } = store;
  if (state.balls.length === 0) return;

  // Kick detection — read transient from sub band (freq) or kick stem (stems)
  let kickTransient = 1.0;
  const isFreqMode = state.mode === 'freq';
  if (isFreqMode) {
    kickTransient = audioState.transientValues[0];
  } else if (audioState.transientStems['kick'] !== undefined) {
    kickTransient = audioState.transientStems['kick'].multiplier;
  }

  // Fast attack / slow decay for kick boost multiplier (frame-rate independent)
  const targetBoost = 1.0 + (kickTransient - 1.0) * config.ballsKickBoost;
  if (targetBoost > state.kickBoostMultiplier) {
    state.kickBoostMultiplier +=
      (targetBoost - state.kickBoostMultiplier) * (1 - Math.pow(1 - 0.5, dt));
  } else {
    state.kickBoostMultiplier +=
      (targetBoost - state.kickBoostMultiplier) * (1 - Math.pow(1 - 0.08, dt));
  }

  const bandCount = isFreqMode ? BAND_COUNT : STEMS.length;

  // Pre-compute per-band averages (avoids redundant loops per ball)
  const { amps: bandAmps, transients: bandTransients, deltas: bandDeltas } = getBandAverages(bandCount);

  for (let i = 0; i < state.balls.length; i++) {
    const ball = state.balls[i];
    const b = ball.band % bandCount;
    const amp = bandAmps[b];
    const tMult = bandTransients[b];
    const delta = bandDeltas[b];

    // Physics: update position with kick boost and delta influence (frame-rate independent)
    const speedMult = state.kickBoostMultiplier * (1 + delta * 0.5) * dt;
    ball.x += ball.vx * speedMult;
    ball.y += ball.vy * speedMult;

    // Bounce off walls
    if (ball.x < 0) {
      ball.x = 0;
      ball.vx = Math.abs(ball.vx);
    } else if (ball.x > p.width) {
      ball.x = p.width;
      ball.vx = -Math.abs(ball.vx);
    }
    if (ball.y < 0) {
      ball.y = 0;
      ball.vy = Math.abs(ball.vy);
    } else if (ball.y > p.height) {
      ball.y = p.height;
      ball.vy = -Math.abs(ball.vy);
    }

    // Size pulses with amplitude
    const scaledAmp = amp * config.spikeScale * tMult;
    const r = ball.baseRadius * (1 + scaledAmp * 1.5);

    // Brightness from amplitude + delta
    const brightness = 60 + Math.min(scaledAmp, 1.0) * 160 + delta * DELTA_BRIGHTNESS_BOOST;
    const clampedBright = Math.min(brightness, 255);

    // Single ellipse with thick stroke for glow + solid fill for core
    const glowWeight = r * 0.6;
    p.stroke(clampedBright * 0.3);
    p.strokeWeight(glowWeight);
    p.fill(clampedBright);
    p.ellipse(ball.x, ball.y, r * 2, r * 2);
  }
}
