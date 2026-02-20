/**
 * Dancing Stickman visualization — dances to BPM, kick-zoom camera, high-freq color
 */
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { BAND_COUNT } from '../utils/constants';

// --- Pose system ---
interface Pose {
  torsoTilt: number;
  leftShoulderAngle: number;
  leftElbowAngle: number;
  rightShoulderAngle: number;
  rightElbowAngle: number;
  leftHipAngle: number;
  leftKneeAngle: number;
  rightHipAngle: number;
  rightKneeAngle: number;
  bounceY: number;
}

const POSES: Pose[] = [
  // 0: Neutral standing
  { torsoTilt: 0, leftShoulderAngle: -0.3, leftElbowAngle: 0.2, rightShoulderAngle: 0.3, rightElbowAngle: -0.2, leftHipAngle: 0.05, leftKneeAngle: 0, rightHipAngle: -0.05, rightKneeAngle: 0, bounceY: 0 },
  // 1: Arms up V
  { torsoTilt: 0, leftShoulderAngle: -2.2, leftElbowAngle: -0.3, rightShoulderAngle: 2.2, rightElbowAngle: 0.3, leftHipAngle: 0.1, leftKneeAngle: 0, rightHipAngle: -0.1, rightKneeAngle: 0, bounceY: -0.05 },
  // 2: Right leg kick
  { torsoTilt: -0.15, leftShoulderAngle: -0.8, leftElbowAngle: 0.4, rightShoulderAngle: 1.2, rightElbowAngle: -0.6, leftHipAngle: 0.1, leftKneeAngle: 0, rightHipAngle: -0.9, rightKneeAngle: 0.7, bounceY: 0 },
  // 3: Left leg kick
  { torsoTilt: 0.15, leftShoulderAngle: -1.2, leftElbowAngle: 0.6, rightShoulderAngle: 0.8, rightElbowAngle: -0.4, leftHipAngle: 0.9, leftKneeAngle: -0.7, rightHipAngle: -0.1, rightKneeAngle: 0, bounceY: 0 },
  // 4: Squat
  { torsoTilt: 0, leftShoulderAngle: -1.0, leftElbowAngle: 1.2, rightShoulderAngle: 1.0, rightElbowAngle: -1.2, leftHipAngle: 0.6, leftKneeAngle: -1.0, rightHipAngle: -0.6, rightKneeAngle: 1.0, bounceY: 0.15 },
  // 5: Lean right
  { torsoTilt: 0.3, leftShoulderAngle: -1.8, leftElbowAngle: 0.2, rightShoulderAngle: 0.4, rightElbowAngle: -0.8, leftHipAngle: 0.2, leftKneeAngle: 0, rightHipAngle: -0.3, rightKneeAngle: 0.2, bounceY: 0 },
  // 6: Lean left
  { torsoTilt: -0.3, leftShoulderAngle: -0.4, leftElbowAngle: 0.8, rightShoulderAngle: 1.8, rightElbowAngle: -0.2, leftHipAngle: 0.3, leftKneeAngle: -0.2, rightHipAngle: -0.2, rightKneeAngle: 0, bounceY: 0 },
  // 7: Jump / arms wide
  { torsoTilt: 0, leftShoulderAngle: -1.5, leftElbowAngle: 0, rightShoulderAngle: 1.5, rightElbowAngle: 0, leftHipAngle: 0.4, leftKneeAngle: -0.5, rightHipAngle: -0.4, rightKneeAngle: 0.5, bounceY: -0.12 },
];

// --- Module state ---
let currentPose: Pose = { ...POSES[0] };
let targetPose: Pose = { ...POSES[0] };
let lastBeatIndex = -1;
let lastPoseIndex = 0;

// Kick zoom
let currentZoom = 1.0;
let targetZoom = 1.0;

// High-freq color (HSB)
let currentHue = 200;
let currentSaturation = 60;
let currentBrightness = 70;

function lerpPose(current: Pose, target: Pose, factor: number): void {
  const keys = Object.keys(current) as (keyof Pose)[];
  for (const key of keys) {
    current[key] += (target[key] - current[key]) * factor;
  }
}

function pickNewPose(): void {
  let idx = Math.floor(Math.random() * POSES.length);
  if (idx === lastPoseIndex) {
    idx = (idx + 1) % POSES.length;
  }
  lastPoseIndex = idx;
  targetPose = { ...POSES[idx] };
}

export function drawStickman(p: P5Instance, dt: number): void {
  const { state, audioState } = store;

  // --- Beat detection → pick new pose ---
  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    const currentBeatIndex = adjusted >= 0 ? Math.floor(adjusted / state.beatIntervalSec) : -1;

    if (currentBeatIndex >= 0 && currentBeatIndex !== lastBeatIndex) {
      pickNewPose();
      lastBeatIndex = currentBeatIndex;
    }
  }

  // --- Smooth-lerp pose ---
  const poseLerp = Math.min(0.2 * dt, 1.0);
  lerpPose(currentPose, targetPose, poseLerp);

  // --- Kick zoom ---
  const isFreqMode = state.mode === 'freq';
  let kickTransient = 1.0;
  if (isFreqMode) {
    kickTransient = audioState.transientValues[0]; // sub-bass band
  } else if (audioState.transientStems['kick'] !== undefined) {
    kickTransient = audioState.transientStems['kick'].multiplier;
  }

  if (kickTransient > 1.15) {
    targetZoom = 1.0 + (kickTransient - 1.0) * 1.6;
  } else {
    targetZoom = 1.0;
  }

  // Fast attack, slow decay, frame-rate independent
  if (targetZoom > currentZoom) {
    currentZoom += (targetZoom - currentZoom) * Math.min(0.6 * dt, 1.0);
  } else {
    currentZoom += (targetZoom - currentZoom) * Math.min(0.05 * dt, 1.0);
  }

  // --- High-frequency color ---
  const bandData = getBandAverages(BAND_COUNT);
  // Bands 5 (presence) and 6 (brilliance)
  const presenceAmp = bandData.amps[5] ?? 0;
  const brillianceAmp = bandData.amps[6] ?? 0;
  const highFreqEnergy = (presenceAmp + brillianceAmp) * 0.5;

  // Map energy → hue: 200 (blue) → 0 (red) as energy rises
  const targetHue = Math.max(0, 200 - highFreqEnergy * 600);
  const targetSat = Math.min(100, 60 + highFreqEnergy * 120);
  const targetBrt = Math.min(100, 70 + highFreqEnergy * 90);

  const colorLerp = Math.min(0.15 * dt, 1.0);
  currentHue += (targetHue - currentHue) * colorLerp;
  currentSaturation += (targetSat - currentSaturation) * colorLerp;
  currentBrightness += (targetBrt - currentBrightness) * colorLerp;

  // --- Rendering ---
  const scale = Math.min(p.width, p.height);
  const torsoLen = scale * 0.18;
  const headRadius = scale * 0.04;
  const upperArmLen = scale * 0.1;
  const forearmLen = scale * 0.09;
  const thighLen = scale * 0.12;
  const shinLen = scale * 0.11;
  const sw = Math.max(2, scale * 0.008);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (p as any).colorMode(p['HSB'], 360, 100, 100);

  p.push();

  // Center + bounce
  p.translate(p.width / 2, p.height / 2 + currentPose.bounceY * scale);

  // Apply kick zoom
  p.scale(currentZoom);

  // Torso tilt
  p.rotate(currentPose.torsoTilt);

  // Style
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (p as any).stroke(currentHue, currentSaturation, currentBrightness);
  p.strokeWeight(sw);
  p.noFill();

  // --- Draw torso (hip at origin, shoulder at top) ---
  p.line(0, 0, 0, -torsoLen);

  // --- Head ---
  p.ellipse(0, -torsoLen - headRadius, headRadius * 2, headRadius * 2);

  // --- Left arm ---
  p.push();
  p.translate(0, -torsoLen); // shoulder
  p.rotate(currentPose.leftShoulderAngle);
  p.line(0, 0, 0, upperArmLen);
  p.translate(0, upperArmLen); // elbow
  p.rotate(currentPose.leftElbowAngle);
  p.line(0, 0, 0, forearmLen);
  p.pop();

  // --- Right arm ---
  p.push();
  p.translate(0, -torsoLen); // shoulder
  p.rotate(currentPose.rightShoulderAngle);
  p.line(0, 0, 0, upperArmLen);
  p.translate(0, upperArmLen); // elbow
  p.rotate(currentPose.rightElbowAngle);
  p.line(0, 0, 0, forearmLen);
  p.pop();

  // --- Left leg ---
  p.push();
  // hip at origin
  p.rotate(currentPose.leftHipAngle);
  p.line(0, 0, 0, thighLen);
  p.translate(0, thighLen); // knee
  p.rotate(currentPose.leftKneeAngle);
  p.line(0, 0, 0, shinLen);
  p.pop();

  // --- Right leg ---
  p.push();
  p.rotate(currentPose.rightHipAngle);
  p.line(0, 0, 0, thighLen);
  p.translate(0, thighLen); // knee
  p.rotate(currentPose.rightKneeAngle);
  p.line(0, 0, 0, shinLen);
  p.pop();

  p.pop();

  // Reset color mode
  p.colorMode(p['RGB'], 255);
}

export function resetStickman(): void {
  currentPose = { ...POSES[0] };
  targetPose = { ...POSES[0] };
  lastBeatIndex = -1;
  lastPoseIndex = 0;
  currentZoom = 1.0;
  targetZoom = 1.0;
  currentHue = 200;
  currentSaturation = 60;
  currentBrightness = 70;
}
