/**
 * User image state management for visualizations
 */
import { store } from '../state/store';

// Module-scoped image state
let currentImage: P5Image | null = null;
let currentObjectUrl: string | null = null;

export function loadUserImage(p: P5Instance, file: File): void {
  // Clean up previous
  if (currentObjectUrl) {
    URL.revokeObjectURL(currentObjectUrl);
  }

  currentObjectUrl = URL.createObjectURL(file);
  p.loadImage(
    currentObjectUrl,
    (img: P5Image) => {
      currentImage = img;
      store.emit('imageChange', true);
    },
    () => {
      console.error('Failed to load user image');
      if (currentObjectUrl) {
        URL.revokeObjectURL(currentObjectUrl);
        currentObjectUrl = null;
      }
    }
  );
}

export function clearUserImage(): void {
  currentImage = null;
  if (currentObjectUrl) {
    URL.revokeObjectURL(currentObjectUrl);
    currentObjectUrl = null;
  }
  store.emit('imageChange', false);
}

export function getUserImage(): P5Image | null {
  return currentImage;
}

export function hasUserImage(): boolean {
  return currentImage !== null;
}
