/**
 * 3D Cube visualization that rotates on beat
 */
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { BAND_COUNT, SPIKES_PER_BAND, STEMS } from '../utils/constants';
import { getUserImage } from './userImage';

// Cube state
let cubeRotationX = 0;
let cubeRotationY = 0;
let cubeRotationZ = 0;
let targetRotationX = 0;
let targetRotationY = 0;
let targetRotationZ = 0;
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

function rotateZ(
  x: number,
  y: number,
  z: number,
  angle: number
): { x: number; y: number; z: number } {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return {
    x: x * cos - y * sin,
    y: x * sin + y * cos,
    z: z,
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
      // Rotate 90 degrees (π/2) in a random direction on each beat
      const direction = Math.floor(Math.random() * 6);
      switch (direction) {
        case 0: targetRotationY += Math.PI / 2; break; // left
        case 1: targetRotationY -= Math.PI / 2; break; // right
        case 2: targetRotationX -= Math.PI / 2; break; // up
        case 3: targetRotationX += Math.PI / 2; break; // down
        case 4: targetRotationZ += Math.PI / 2; break; // clockwise roll
        case 5: targetRotationZ -= Math.PI / 2; break; // counterclockwise roll
      }
      lastBeatIndex = currentBeatIndex;
    }
  }

  // Smooth rotation interpolation — fast snap so the cube settles between beats
  const rotationSpeed = 0.35;
  const diffX = targetRotationX - cubeRotationX;
  const diffY = targetRotationY - cubeRotationY;
  const diffZ = targetRotationZ - cubeRotationZ;
  cubeRotationX += diffX * rotationSpeed * dt;
  cubeRotationY += diffY * rotationSpeed * dt;
  cubeRotationZ += diffZ * rotationSpeed * dt;

  // Transform vertices
  const transformedVertices = vertices.map(v => {
    let rotated = rotateZ(v.x, v.y, v.z, cubeRotationZ);
    rotated = rotateY(rotated.x, rotated.y, rotated.z, cubeRotationY);
    rotated = rotateX(rotated.x, rotated.y, rotated.z, cubeRotationX);
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
  const userImg = getUserImage();

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

    // Draw user image on face
    if (userImg) {
      const ctx = p.drawingContext;
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(projectedPoints[0].x, projectedPoints[0].y);
      for (let i = 1; i < projectedPoints.length; i++) {
        ctx.lineTo(projectedPoints[i].x, projectedPoints[i].y);
      }
      ctx.closePath();
      ctx.clip();

      // Bounding box of projected quad
      let minX = projectedPoints[0].x, maxX = projectedPoints[0].x;
      let minY = projectedPoints[0].y, maxY = projectedPoints[0].y;
      for (let i = 1; i < projectedPoints.length; i++) {
        if (projectedPoints[i].x < minX) minX = projectedPoints[i].x;
        if (projectedPoints[i].x > maxX) maxX = projectedPoints[i].x;
        if (projectedPoints[i].y < minY) minY = projectedPoints[i].y;
        if (projectedPoints[i].y > maxY) maxY = projectedPoints[i].y;
      }
      ctx.drawImage(userImg.canvas, minX, minY, maxX - minX, maxY - minY);

      // Color tint overlay
      const h = hue;
      const s = Math.round(saturation);
      const b = Math.round(brightness);
      ctx.fillStyle = `hsla(${h}, ${s}%, ${b}%, 0.35)`;
      ctx.fillRect(minX, minY, maxX - minX, maxY - minY);
      ctx.restore();
    }

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
  cubeRotationX = 0;
  cubeRotationY = 0;
  cubeRotationZ = 0;
  targetRotationX = 0;
  targetRotationY = 0;
  targetRotationZ = 0;
  lastBeatIndex = -1;
}
