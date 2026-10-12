/**
 * Content layers — webcam or uploaded image composited under/over the
 * generative frame by the post-FX chain (see postfx.ts).
 *
 * Module-scoped state; the post chain pulls the current source each frame.
 */
import { showError } from '../utils/errors';

export type LayerSourceKind = 'none' | 'webcam' | 'image';

export interface LayerSource {
  el: HTMLVideoElement | HTMLImageElement;
  width: number;
  height: number;
  /** Mirror horizontally (selfie view for webcam). */
  mirror: boolean;
  /** True when the source changes every frame and must be re-uploaded. */
  live: boolean;
  /** Bumped whenever a static source changes, so the GPU copy can be refreshed. */
  version: number;
}

let kind: LayerSourceKind = 'none';
let video: HTMLVideoElement | null = null;
let stream: MediaStream | null = null;
let image: HTMLImageElement | null = null;
let imageUrl: string | null = null;
let version = 0;

function stopWebcam(): void {
  stream?.getTracks().forEach(t => t.stop());
  stream = null;
  if (video) {
    video.srcObject = null;
    video = null;
  }
}

async function startWebcam(): Promise<boolean> {
  if (!navigator.mediaDevices?.getUserMedia) {
    showError('Webcam is not available in this browser.');
    return false;
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
  } catch (err) {
    console.error('[layers] Webcam access failed:', err);
    showError('Could not access the webcam. Check camera permissions.');
    return false;
  }
  video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.setAttribute('playsinline', '');
  video.srcObject = stream;
  try {
    await video.play();
  } catch (err) {
    console.error('[layers] Webcam playback failed:', err);
  }
  return true;
}

/** Switch the active layer source. Resolves to the source actually in effect. */
export async function setLayerSource(next: LayerSourceKind): Promise<LayerSourceKind> {
  if (next === kind) return kind;
  if (kind === 'webcam') stopWebcam();
  kind = 'none';

  if (next === 'webcam') {
    if (await startWebcam()) kind = 'webcam';
  } else if (next === 'image') {
    // Image source is active once an image has been loaded
    kind = 'image';
  }
  version++;
  return kind;
}

export function loadLayerImage(file: File): Promise<void> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      if (imageUrl) URL.revokeObjectURL(imageUrl);
      imageUrl = url;
      image = img;
      version++;
      resolve();
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      showError('Could not load that image.');
      reject(new Error('layer image load failed'));
    };
    img.src = url;
  });
}

export function getLayerSourceKind(): LayerSourceKind {
  return kind;
}

/** Current drawable layer source, or null when nothing is ready to composite. */
export function getLayerSource(): LayerSource | null {
  if (kind === 'webcam' && video && video.readyState >= 2 && video.videoWidth > 0) {
    return { el: video, width: video.videoWidth, height: video.videoHeight, mirror: true, live: true, version };
  }
  if (kind === 'image' && image) {
    return { el: image, width: image.naturalWidth, height: image.naturalHeight, mirror: false, live: false, version };
  }
  return null;
}

export function disposeLayers(): void {
  stopWebcam();
  if (imageUrl) URL.revokeObjectURL(imageUrl);
  imageUrl = null;
  image = null;
  kind = 'none';
}
