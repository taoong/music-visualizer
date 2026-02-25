/**
 * Keyboard shortcuts and accessibility features
 */
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { formatTime } from '../utils/format';
import { hasUserImage, clearUserImage } from '../visualizations/userImage';
import type { VizMode } from '../types';

// Keyboard shortcut map
const SHORTCUTS: Record<string, { action: () => void; description: string }> = {};

/**
 * Initialize keyboard shortcuts
 */
export function initKeyboardShortcuts(): () => void {
  // Define shortcuts
  defineShortcut(' ', togglePlayPause, 'Play/Pause');
  defineShortcut('ArrowLeft', () => seek(-5), 'Seek backward 5s');
  defineShortcut('ArrowRight', () => seek(5), 'Seek forward 5s');
  defineShortcut('ArrowUp', () => adjustVolume(0.05), 'Volume up');
  defineShortcut('ArrowDown', () => adjustVolume(-0.05), 'Volume down');
  defineShortcut('1', () => setVizMode('circle'), 'Circle visualization');
  defineShortcut('2', () => setVizMode('spectrum'), 'Spectrum visualization');
  defineShortcut('3', () => setVizMode('tunnel'), 'Tunnel visualization');
  defineShortcut('4', () => setVizMode('balls'), 'Balls visualization');
  defineShortcut('5', () => setVizMode('cube'), '3D Cube visualization');
  defineShortcut('6', () => setVizMode('stickman'), 'Stickman visualization');
  defineShortcut('7', () => setVizMode('lasers'), 'Lasers visualization');
  defineShortcut('8', () => setVizMode('text'), 'Text visualization');
  defineShortcut('9', () => setVizMode('wormhole'), 'Wormhole visualization');
  defineShortcut('0', () => setVizMode('runners'), 'Runners visualization');
  defineShortcut('m', toggleMute, 'Mute/Unmute');
  defineShortcut('f', toggleFullscreen, 'Toggle fullscreen');
  defineShortcut('s', toggleSidebar, 'Toggle sidebar');
  defineShortcut('r', randomizeSettings, 'Randomize settings');
  defineShortcut('i', toggleImage, 'Toggle image upload/remove');
  defineShortcut('?', showShortcutsHelp, 'Show keyboard shortcuts');
  defineShortcut('Escape', hideOverlays, 'Close overlays/Go back');
  defineShortcut('h', goHome, 'Return to home screen');

  // Bind shortcuts button click
  const shortcutsBtn = document.getElementById('keyboard-shortcuts-btn');
  shortcutsBtn?.addEventListener('click', showShortcutsHelp);

  // Event listener
  const handler = (e: KeyboardEvent) => {
    // Don't trigger shortcuts when typing in inputs
    if (
      e.target instanceof HTMLInputElement ||
      e.target instanceof HTMLTextAreaElement ||
      e.target instanceof HTMLSelectElement
    ) {
      return;
    }

    const shortcut = SHORTCUTS[e.key];
    if (shortcut) {
      e.preventDefault();
      shortcut.action();
    }
  };

  document.addEventListener('keydown', handler);

  // Return cleanup function
  return () => {
    document.removeEventListener('keydown', handler);
    shortcutsBtn?.removeEventListener('click', showShortcutsHelp);
  };
}

/**
 * Define a keyboard shortcut
 */
function defineShortcut(key: string, action: () => void, description: string): void {
  SHORTCUTS[key] = { action, description };
}

/**
 * Toggle play/pause
 */
function togglePlayPause(): void {
  const pauseBtn = document.getElementById('pause-btn');
  if (pauseBtn) {
    pauseBtn.click();
  }
}

/**
 * Seek by offset seconds
 */
function seek(offset: number): void {
  const currentPos = audioEngine.getPlaybackPosition();
  const duration = audioEngine.getDuration();
  const newPos = Math.max(0, Math.min(duration, currentPos + offset));
  audioEngine.seek(newPos);

  // Announce to screen readers
  announceToScreenReader(`Seeked to ${formatTime(newPos)}`);
}

/**
 * Adjust volume
 */
function adjustVolume(delta: number): void {
  const newVolume = Math.max(0, Math.min(1, store.config.masterVolume + delta));
  store.updateConfig('masterVolume', newVolume);
  audioEngine.setVolume(newVolume);

  // Update slider
  const volumeSlider = document.getElementById('master-volume') as HTMLInputElement | null;
  if (volumeSlider) {
    volumeSlider.value = String(newVolume);
  }

  announceToScreenReader(`Volume ${Math.round(newVolume * 100)}%`);
}

/**
 * Set visualization mode
 */
function setVizMode(mode: VizMode): void {
  const vizSelect = document.getElementById('viz-selector') as HTMLSelectElement | null;
  if (vizSelect) {
    vizSelect.value = mode;
    vizSelect.dispatchEvent(new Event('change'));
    announceToScreenReader(`Switched to ${mode} visualization`);
  }
}

/**
 * Toggle mute
 */
let previousVolume = 0.8;
function toggleMute(): void {
  if (store.config.masterVolume > 0) {
    previousVolume = store.config.masterVolume;
    store.updateConfig('masterVolume', 0);
    audioEngine.setVolume(0);
  } else {
    store.updateConfig('masterVolume', previousVolume);
    audioEngine.setVolume(previousVolume);
  }

  const volumeSlider = document.getElementById('master-volume') as HTMLInputElement | null;
  if (volumeSlider) {
    volumeSlider.value = String(store.config.masterVolume);
  }

  announceToScreenReader(store.config.masterVolume === 0 ? 'Muted' : 'Unmuted');
}

/**
 * Toggle image upload/remove
 */
function toggleImage(): void {
  if (hasUserImage()) {
    clearUserImage();
    const imageInput = document.getElementById('playback-image-upload') as HTMLInputElement | null;
    if (imageInput) imageInput.value = '';
    announceToScreenReader('Image removed');
  } else {
    const imageInput = document.getElementById('playback-image-upload') as HTMLInputElement | null;
    imageInput?.click();
  }
}

/**
 * Toggle fullscreen
 */
function toggleFullscreen(): void {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen().catch(console.error);
  } else {
    document.exitFullscreen().catch(console.error);
  }
}

/**
 * Toggle sidebar
 */
function toggleSidebar(): void {
  const sidebar = document.getElementById('sidebar');
  const toggleBtn = document.getElementById('sidebar-toggle');
  if (sidebar && toggleBtn) {
    toggleBtn.click();
    const isOpen = sidebar.classList.contains('open');
    announceToScreenReader(isOpen ? 'Sidebar opened' : 'Sidebar closed');
  }
}

/**
 * Randomize settings
 */
function randomizeSettings(): void {
  const randomizeBtn = document.getElementById('randomize-btn');
  if (randomizeBtn) {
    randomizeBtn.click();
    announceToScreenReader('Settings randomized');
  }
}

/**
 * Show keyboard shortcuts help
 */
function showShortcutsHelp(): void {
  // Remove existing modal to prevent stacking
  document.querySelector('.shortcuts-modal')?.remove();

  const helpContent = Object.entries(SHORTCUTS)
    .map(([key, { description }]) => `<kbd>${key}</kbd>: ${description}`)
    .join('<br>');

  const modal = document.createElement('div');
  modal.className = 'shortcuts-modal';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-label', 'Keyboard Shortcuts');
  modal.innerHTML = `
    <div class="shortcuts-modal-content">
      <h2>Keyboard Shortcuts</h2>
      <div class="shortcuts-list">${helpContent}</div>
      <button class="close-btn">Close</button>
    </div>
  `;

  const closeBtn = modal.querySelector('.close-btn') as HTMLElement;
  closeBtn.addEventListener('click', () => modal.remove());

  modal.addEventListener('click', e => {
    if (e.target === modal) modal.remove();
  });

  // Focus trap: keep Tab inside the modal
  modal.addEventListener('keydown', e => {
    if (e.key === 'Tab') {
      e.preventDefault();
      closeBtn.focus();
    }
  });

  document.body.appendChild(modal);
  closeBtn.focus();
}

/**
 * Hide overlays and return to main view
 */
function hideOverlays(): void {
  const modal = document.querySelector('.shortcuts-modal');
  if (modal) {
    modal.remove();
    return;
  }

  // Close sidebar if open
  const sidebar = document.getElementById('sidebar');
  if (sidebar?.classList.contains('open')) {
    sidebar.classList.remove('open');
    return;
  }
}

/**
 * Return to home screen
 */
function goHome(): void {
  const splash = document.getElementById('splash');
  if (splash?.classList.contains('hidden')) {
    audioEngine.stop();
    audioEngine.disposeAll();
    splash.classList.remove('hidden');
    document.getElementById('playback-bar')?.classList.remove('visible');
  }
}

/**
 * Announce message to screen readers
 */
export function announceToScreenReader(message: string): void {
  let announcer = document.getElementById('sr-announcer');
  if (!announcer) {
    announcer = document.createElement('div');
    announcer.id = 'sr-announcer';
    announcer.setAttribute('aria-live', 'polite');
    announcer.setAttribute('aria-atomic', 'true');
    announcer.className = 'sr-only';
    document.body.appendChild(announcer);
  }
  announcer.textContent = message;
}

/**
 * Get all keyboard shortcuts for documentation
 */
export function getAllShortcuts(): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, { description }] of Object.entries(SHORTCUTS)) {
    result[key] = description;
  }
  return result;
}
