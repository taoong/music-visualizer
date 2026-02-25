/**
 * Pong visualization — AI vs AI pong game, beat-synchronized speed bursts
 */
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';

interface PongBall {
  x: number;
  y: number;
  vx: number;
  vy: number;
  hue: number;
  band: number;
}

const PADDLE_W = 14;
const PADDLE_H_RATIO = 0.18;
const PADDLE_MARGIN = 40;
const BASE_BALL_SPEED = 4;
const BASE_PADDLE_SPEED = 5;
const BEAT_BURST_MS = 180;
const BALL_R = 8;
const BAND_HUES = [200, 270, 130, 30, 300, 160, 50];

let pongBalls: PongBall[] = [];
let leftPaddleY = 0;
let rightPaddleY = 0;
let speedMult = 1.0;
let burstTimer = 0;
let lastBeatIndex = -1;
let lastBeatGroupIndex = -1;
let initialized = false;
let leftScore = 0;
let rightScore = 0;

function spawnBall(p: P5Instance): PongBall {
  const sign = Math.random() < 0.5 ? 1 : -1;
  const angle = (25 + Math.random() * 40) * Math.PI / 180;
  const band = Math.floor(Math.random() * 7);
  return {
    x: p.width / 2,
    y: p.height / 2,
    vx: sign * Math.cos(angle),
    vy: (Math.random() < 0.5 ? 1 : -1) * Math.sin(angle),
    hue: BAND_HUES[band],
    band,
  };
}

function initPong(p: P5Instance): void {
  leftPaddleY = p.height / 2;
  rightPaddleY = p.height / 2;
  pongBalls = [];
  leftScore = 0;
  rightScore = 0;
  speedMult = 1.0;
  burstTimer = 0;
  lastBeatIndex = -1;
  lastBeatGroupIndex = -1;
  const { config } = store;
  for (let i = 0; i < config.pongBallCount; i++) {
    pongBalls.push(spawnBall(p));
  }
}

export function resetPong(): void {
  initialized = false;
  pongBalls = [];
  speedMult = 1.0;
  burstTimer = 0;
  lastBeatIndex = -1;
  lastBeatGroupIndex = -1;
  leftScore = 0;
  rightScore = 0;
}

export function drawPong(p: P5Instance, dt: number): void {
  const { state, config, audioState } = store;

  if (!initialized) {
    initPong(p);
    initialized = true;
  }

  // Beat-synchronized speed burst — square wave, same pattern as runners
  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    const currentBeatIndex = adjusted >= 0 ? Math.floor(adjusted / state.beatIntervalSec) : -1;
    if (currentBeatIndex >= 0 && currentBeatIndex !== lastBeatIndex) {
      lastBeatIndex = currentBeatIndex;
      const beatsPerBurst = Math.pow(2, config.beatDivision - 1);
      const currentGroup = Math.floor(currentBeatIndex / beatsPerBurst);
      if (currentGroup !== lastBeatGroupIndex) {
        lastBeatGroupIndex = currentGroup;
        speedMult = 1 + config.intensity * 6;
        burstTimer = BEAT_BURST_MS;
      }
    }
  }

  if (burstTimer > 0) {
    burstTimer -= p.deltaTime;
    if (burstTimer <= 0) {
      burstTimer = 0;
      speedMult = 1.0;
    }
  }

  // Ball count management
  while (pongBalls.length < config.pongBallCount) {
    pongBalls.push(spawnBall(p));
  }
  if (pongBalls.length > config.pongBallCount) {
    pongBalls.length = config.pongBallCount;
  }

  const paddleH = p.height * PADDLE_H_RATIO;
  const effectiveSpeed = config.intensity * speedMult;

  // AI paddle movement — tracks nearest ball moving toward that side
  const nearestBallY = (isLeft: boolean): number => {
    let nearest = p.height / 2;
    let minDist = Infinity;
    for (const ball of pongBalls) {
      const movingToward = isLeft ? ball.vx < 0 : ball.vx > 0;
      if (!movingToward) continue;
      const paddleX = isLeft ? PADDLE_MARGIN + PADDLE_W : p.width - PADDLE_MARGIN - PADDLE_W;
      const dist = Math.abs(ball.x - paddleX);
      if (dist < minDist) {
        minDist = dist;
        nearest = ball.y;
      }
    }
    return nearest;
  };

  const paddleSpeed = BASE_PADDLE_SPEED * effectiveSpeed * dt;

  const moveToward = (current: number, target: number, speed: number): number => {
    const diff = target - current;
    const step = Math.max(-speed, Math.min(speed, diff));
    return Math.max(paddleH / 2, Math.min(p.height - paddleH / 2, current + step));
  };

  leftPaddleY = moveToward(leftPaddleY, nearestBallY(true), paddleSpeed);
  rightPaddleY = moveToward(rightPaddleY, nearestBallY(false), paddleSpeed);

  // Bass amplitude for paddle brightness
  const bassData = audioState.smoothedBands[1];
  const bassAmp = bassData
    ? Array.from(bassData).reduce((a, b) => a + b, 0) / bassData.length
    : 0;

  // Ball physics
  for (let i = 0; i < pongBalls.length; i++) {
    const ball = pongBalls[i];
    const ballSpeed = BASE_BALL_SPEED * effectiveSpeed;

    ball.x += ball.vx * ballSpeed * dt;
    ball.y += ball.vy * ballSpeed * dt;

    // Top/bottom walls
    if (ball.y < BALL_R) {
      ball.y = BALL_R;
      ball.vy = Math.abs(ball.vy);
    } else if (ball.y > p.height - BALL_R) {
      ball.y = p.height - BALL_R;
      ball.vy = -Math.abs(ball.vy);
    }

    // Left paddle collision (only when moving left)
    if (
      ball.vx < 0 &&
      ball.x - BALL_R < PADDLE_MARGIN + PADDLE_W &&
      ball.x - BALL_R > PADDLE_MARGIN &&
      Math.abs(ball.y - leftPaddleY) < paddleH / 2
    ) {
      ball.vx = Math.abs(ball.vx);
      ball.vy += ((ball.y - leftPaddleY) / paddleH) * 0.5;
      const len = Math.sqrt(ball.vx * ball.vx + ball.vy * ball.vy);
      if (len > 0) { ball.vx /= len; ball.vy /= len; }
    }

    // Right paddle collision (only when moving right)
    if (
      ball.vx > 0 &&
      ball.x + BALL_R > p.width - PADDLE_MARGIN - PADDLE_W &&
      ball.x + BALL_R < p.width - PADDLE_MARGIN &&
      Math.abs(ball.y - rightPaddleY) < paddleH / 2
    ) {
      ball.vx = -Math.abs(ball.vx);
      ball.vy += ((ball.y - rightPaddleY) / paddleH) * 0.5;
      const len = Math.sqrt(ball.vx * ball.vx + ball.vy * ball.vy);
      if (len > 0) { ball.vx /= len; ball.vy /= len; }
    }

    // Miss: ball exits left or right — respawn at center
    if (ball.x < 0) {
      rightScore++;
      pongBalls[i] = spawnBall(p);
    } else if (ball.x > p.width) {
      leftScore++;
      pongBalls[i] = spawnBall(p);
    }
  }

  // Rendering (HSB mode)
  (p as any).colorMode(p['HSB'], 360, 100, 100, 100);

  // Center dashed dividing line
  (p as any).stroke(0, 0, 100, 20);
  p.strokeWeight(2);
  const dashLen = 16;
  for (let y = 0; y < p.height; y += dashLen * 2) {
    p.line(p.width / 2, y, p.width / 2, y + dashLen);
  }

  // Paddles — white-ish, reactive to bass amplitude
  const paddleBrightness = 70 + bassAmp * 30;
  (p as any).fill(0, 0, paddleBrightness, 100);
  p.noStroke();
  (p as any).rect(PADDLE_MARGIN, leftPaddleY - paddleH / 2, PADDLE_W, paddleH, 4);
  (p as any).rect(p.width - PADDLE_MARGIN - PADDLE_W, rightPaddleY - paddleH / 2, PADDLE_W, paddleH, 4);

  // Balls with optional motion streak during burst
  for (const ball of pongBalls) {
    const bandData = audioState.smoothedBands[ball.band];
    const amp = bandData
      ? Array.from(bandData).reduce((a, b) => a + b, 0) / bandData.length
      : 0;

    const brightness = 80 + amp * 50;
    const radius = BALL_R * (1 + amp * 0.4);

    if (burstTimer > 0) {
      (p as any).fill(ball.hue, 80, brightness, 30);
      p.noStroke();
      p.rect(ball.x - 24 * ball.vx, ball.y - 4, 24 * Math.abs(ball.vx), 8);
    }

    (p as any).fill(ball.hue, 80, brightness, 100);
    p.noStroke();
    p.ellipse(ball.x, ball.y, radius * 2, radius * 2);
  }

  // Score display — subtle, low alpha
  (p as any).fill(0, 0, 100, 30);
  p.noStroke();
  (p as any).textSize(14);
  (p as any).textAlign(p['CENTER']);
  (p as any).text(`L: ${leftScore}   R: ${rightScore}`, p.width / 2, 20);

  // Reset color mode
  (p as any).colorMode(p['RGB'], 255, 255, 255, 255);
}
