/**
 * 3D Cube visualization that rotates on beat
 */
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { BAND_COUNT, SPIKES_PER_BAND, STEMS } from '../utils/constants';

// Cube state
let cubeRotation = 0;
let targetRotation = 0;
let lastBeatIndex = -1;
let cubeSize = 150;

// Cube vertices for 3D projection
const vertices = [
  { x: -1, y: -1, z: -1 }, // 0: front-top-left
  { x: 1, y: -1, z: -1 }, // 1: front-top-right
  { x: 1, y: 1, z: -1 }, // 2: front-bottom-right
  { x: -1, y: 1, z: -1 }, // 3: front-bottom-left
  { x: -1, y: -1, z: 1 }, // 4: back-top-left
  { x: 1, y: -1, z: 1 }, // 5: back-top-right
  { x: 1, y: 1, z: 1 }, // 6: back-bottom-right
  { x: -1, y: 1, z: 1 }, // 7: back-bottom-left
];

// Cube faces (vertex indices)
const faces = [
  [0, 1, 2, 3], // front
  [1, 5, 6, 2], // right
  [5, 4, 7, 6], // back
  [4, 0, 3, 7], // left
  [0, 4, 5, 1], // top
  [3, 2, 6, 7], // bottom
];

// Face colors (HSL hues)
const faceBaseColors = [0, 60, 120, 180, 240, 300];

function project3D(x: number, y: number, z: number, p: P5Instance): { x: number; y: number } {
  const scale = cubeSize;
  const cx = p.width / 2;
  const cy = p.height / 2;

  // Simple perspective projection
  const distance = 4;
  const perspective = distance / (distance + z * 0.5);

  return {
    x: cx + x * scale * perspective,
    y: cy + y * scale * perspective,
  };
}

function rotateX(
  x: number,
  y: number,
  z: number,
  angle: number
): { x: number; y: number; z: number } {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return {
    x: x,
    y: y * cos - z * sin,
    z: y * sin + z * cos,
  };
}

function rotateY(
  x: number,
  y: number,
  z: number,
  angle: number
): { x: number; y: number; z: number } {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return {
    x: x * cos + z * sin,
    y: y,
    z: -x * sin + z * cos,
  };
}

export function drawCube(p: P5Instance, dt: number): void {
  const { state, config, audioState } = store;

  // Calculate audio-reactive color intensity
  let totalAmplitude = 0;
  let maxAmplitude = 0;
  const isFreqMode = state.mode === 'freq';
  const bandCount = isFreqMode ? BAND_COUNT : 5;

  if (isFreqMode) {
    for (let b = 0; b < BAND_COUNT; b++) {
      for (let i = 0; i < SPIKES_PER_BAND; i++) {
        const amp = audioState.smoothedBands[b][i];
        totalAmplitude += amp;
        if (amp > maxAmplitude) maxAmplitude = amp;
      }
    }
  } else {
    const stemSmoothed = audioEngine.getStemSmoothed();
    if (stemSmoothed) {
      for (let b = 0; b < 5; b++) {
        const stem = STEMS[b];
        if (stemSmoothed[stem]) {
          for (let i = 0; i < SPIKES_PER_BAND; i++) {
            const amp = stemSmoothed[stem][i];
            totalAmplitude += amp;
            if (amp > maxAmplitude) maxAmplitude = amp;
          }
        }
      }
    }
  }

  const avgAmplitude = totalAmplitude / (bandCount * SPIKES_PER_BAND);
  const colorIntensity = Math.min(maxAmplitude * config.spikeScale * 2, 1);
  const saturationBoost = 30 + colorIntensity * 70; // 30% to 100%

  // Beat detection for rotation
  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    const currentBeatIndex = adjusted >= 0 ? Math.floor(adjusted / state.beatIntervalSec) : -1;

    if (currentBeatIndex >= 0 && currentBeatIndex !== lastBeatIndex) {
      // Rotate 90 degrees (π/2) on each beat
      targetRotation += Math.PI / 2;
      lastBeatIndex = currentBeatIndex;
    }
  }

  // Smooth rotation interpolation
  const rotationSpeed = 0.15; // How fast it snaps to the next face
  const diff = targetRotation - cubeRotation;
  cubeRotation += diff * rotationSpeed * dt;

  // Base rotation for visual interest
  const baseRotation = p.millis() * 0.0002;

  // Transform vertices
  const transformedVertices = vertices.map(v => {
    // Apply beat rotation (Y axis)
    let rotated = rotateY(v.x, v.y, v.z, cubeRotation);
    // Add subtle continuous rotation
    rotated = rotateX(rotated.x, rotated.y, rotated.z, baseRotation * 0.5);
    rotated = rotateY(rotated.x, rotated.y, rotated.z, baseRotation * 0.3);
    return rotated;
  });

  // Calculate face depths and sort
  const facesWithDepth = faces.map((face, index) => {
    const avgZ = face.reduce((sum, vertexIdx) => sum + transformedVertices[vertexIdx].z, 0) / 4;
    return { face, index, depth: avgZ };
  });

  // Sort by depth (draw back faces first)
  facesWithDepth.sort((a, b) => a.depth - b.depth);

  // Draw faces
  p.noStroke();

  facesWithDepth.forEach(({ face, index }) => {
    const projectedPoints = face.map(vertexIdx => {
      const v = transformedVertices[vertexIdx];
      return project3D(v.x, v.y, v.z, p);
    });

    // Calculate face brightness based on depth (lighting effect)
    const depth = facesWithDepth.find(f => f.index === index)?.depth || 0;
    const depthBrightness = p.map(depth, -1.5, 1.5, 40, 100);

    // Color based on face + audio reactivity
    const hue = (faceBaseColors[index] + avgAmplitude * 60) % 360;
    const saturation = saturationBoost;
    const brightness = depthBrightness * (0.5 + avgAmplitude * 0.5);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (p as any).colorMode(p['HSB'], 360, 100, 100);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (p as any).fill(hue, saturation, brightness);

    // Draw the face
    p.beginShape();
    projectedPoints.forEach(point => {
      p.vertex(point.x, point.y);
    });
    p.endShape(p['CLOSE']);

    // Draw wireframe edges
    p.stroke(255, 100);
    p.strokeWeight(2);
    p.noFill();
    p.beginShape();
    projectedPoints.forEach(point => {
      p.vertex(point.x, point.y);
    });
    p.endShape(p['CLOSE']);
  });

  // Reset color mode
  p.colorMode(p['RGB'], 255);
}

export function resetCube(): void {
  cubeRotation = 0;
  targetRotation = 0;
  lastBeatIndex = -1;
}
