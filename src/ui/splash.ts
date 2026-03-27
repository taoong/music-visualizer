/**
 * Splash screen and initial play handlers
 */
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { separateStems, detectBPMWithFallback } from '../audio/bpm';
import { setProcessingState, setFileStatus } from '../utils/errors';
import { SAMPLE_URL } from '../utils/constants';
import { loadUserImage, clearUserImage } from '../visualizations/userImage';
import type { AnalysisMode } from '../types';

let isSeparating = false;
let navCursorIndex = 0;
let navItems: HTMLElement[] = [];

async function checkServerAvailable(): Promise<boolean> {
  try {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 3000);
    const resp = await fetch('/api/health', { signal: controller.signal });
    return resp.ok;
  } catch {
    return false;
  }
}

export async function initStemAvailability(): Promise<void> {
  const btn = document.getElementById('mode-stems') as HTMLButtonElement | null;
  const note = document.getElementById('mode-stems-unavail');
  if (!btn) return;

  const available = await checkServerAvailable();
  if (!available) {
    btn.dataset.unavailable = 'true';
    btn.setAttribute('aria-disabled', 'true');
    note?.classList.remove('hidden');
  }
}

function completeStep1(): void {
  document.getElementById('splash-step-mode')?.classList.add('unlocked');
}

function completeStep2(): void {
  if (!store.state.useSample && !store.state.userFile) return;
  const playBtn = document.getElementById('play-btn') as HTMLButtonElement | null;
  if (playBtn) {
    playBtn.disabled = false;
    requestAnimationFrame(() => playBtn.classList.add('is-ready'));
  }
}

declare global {
  interface Window {
    __pendingImageFile?: File;
  }
}

export function bindFileUpload(): () => void {
  const audioInput = document.getElementById('audio-upload') as HTMLInputElement | null;
  const fileNameEl = document.getElementById('file-name');

  if (!audioInput) return () => {};

  const handler = (e: Event) => {
    const target = e.target as HTMLInputElement;
    if (target.files?.length) {
      store.setUserFile(target.files[0]);
      if (fileNameEl) fileNameEl.textContent = target.files[0].name;
      document.getElementById('upload-label')?.classList.add('selected');
      document.getElementById('use-sample-btn')?.classList.remove('selected');
      completeStep1();
    }
  };

  audioInput.addEventListener('change', handler);
  return () => audioInput.removeEventListener('change', handler);
}

export function bindSampleButton(): () => void {
  const btn = document.getElementById('use-sample-btn');
  const fileNameEl = document.getElementById('file-name');

  if (!btn) return () => {};

  const handler = () => {
    store.setUseSample(true);
    if (fileNameEl) fileNameEl.textContent = 'Sample track selected';
    document.getElementById('use-sample-btn')?.classList.add('selected');
    document.getElementById('upload-label')?.classList.remove('selected');
    completeStep1();
  };

  const touchHandler = (e: Event) => {
    e.preventDefault();
    handler();
  };

  btn.addEventListener('click', handler);
  btn.addEventListener('touchend', touchHandler);
  return () => {
    btn.removeEventListener('click', handler);
    btn.removeEventListener('touchend', touchHandler);
  };
}

export function bindModeSelector(): () => void {
  const modeFreqBtn = document.getElementById('mode-freq');
  const modeStemsBtn = document.getElementById('mode-stems');
  const freqSliders = document.getElementById('freq-sliders');
  const stemSliders = document.getElementById('stem-sliders');

  if (!modeFreqBtn || !modeStemsBtn) return () => {};

  const setMode = (mode: AnalysisMode) => {
    store.setMode(mode);
    completeStep2();

    if (mode === 'freq') {
      modeFreqBtn.classList.add('active');
      modeStemsBtn.classList.remove('active');
      freqSliders?.classList.remove('hidden');
      stemSliders?.classList.add('hidden');
    } else {
      modeStemsBtn.classList.add('active');
      modeFreqBtn.classList.remove('active');
      stemSliders?.classList.remove('hidden');
      freqSliders?.classList.add('hidden');
    }
  };

  const freqHandler = () => setMode('freq');
  const stemsHandler = () => {
    if ((modeStemsBtn as HTMLElement).dataset.unavailable === 'true') return;
    setMode('stems');
  };

  modeFreqBtn.addEventListener('click', freqHandler);
  modeStemsBtn.addEventListener('click', stemsHandler);

  return () => {
    modeFreqBtn.removeEventListener('click', freqHandler);
    modeStemsBtn.removeEventListener('click', stemsHandler);
  };
}

export function bindMicButton(): () => void {
  const btn = document.getElementById('use-mic-btn');

  if (!btn) return () => {};

  const handler = async () => {
    btn.classList.add('selected');
    document.getElementById('use-sample-btn')?.classList.remove('selected');
    document.getElementById('upload-label')?.classList.remove('selected');

    await handleMicModePlay();
  };

  const touchHandler = (e: Event) => {
    e.preventDefault();
    handler();
  };

  btn.addEventListener('click', handler);
  btn.addEventListener('touchend', touchHandler);
  return () => {
    btn.removeEventListener('click', handler);
    btn.removeEventListener('touchend', touchHandler);
  };
}

export function bindPlayButton(): () => void {
  const playBtn = document.getElementById('play-btn');

  if (!playBtn) return () => {};

  const handler = async () => {
    if (store.isFreqMode) {
      await handleFreqModePlay();
    } else {
      await handleStemModePlay();
    }
  };

  const touchHandler = (e: Event) => {
    e.preventDefault();
    handler();
  };

  playBtn.addEventListener('click', handler);
  playBtn.addEventListener('touchend', touchHandler);
  return () => {
    playBtn.removeEventListener('click', handler);
    playBtn.removeEventListener('touchend', touchHandler);
  };
}

export function bindImageUpload(): () => void {
  const imageInput = document.getElementById('image-upload') as HTMLInputElement | null;
  const removeBtn = document.getElementById('image-remove-btn');
  const previewGroup = document.getElementById('image-preview-group');
  const previewThumb = document.getElementById('image-preview-thumb') as HTMLImageElement | null;
  const fileNameEl = document.getElementById('image-file-name');

  if (!imageInput) return () => {};

  const changeHandler = (e: Event) => {
    const target = e.target as HTMLInputElement;
    if (!target.files?.length) return;

    const file = target.files[0];

    // Show preview
    const previewUrl = URL.createObjectURL(file);
    if (previewThumb) {
      previewThumb.onload = () => URL.revokeObjectURL(previewUrl);
      previewThumb.src = previewUrl;
    }
    if (fileNameEl) fileNameEl.textContent = file.name;
    previewGroup?.classList.remove('hidden');
    removeBtn?.classList.remove('hidden');

    // Load into p5 if available, otherwise store for later
    if (window.p5Instance) {
      loadUserImage(window.p5Instance, file);
    } else {
      window.__pendingImageFile = file;
    }
  };

  const removeHandler = () => {
    clearUserImage();
    if (previewThumb) previewThumb.src = '';
    if (fileNameEl) fileNameEl.textContent = '';
    previewGroup?.classList.add('hidden');
    removeBtn?.classList.add('hidden');
    imageInput.value = '';
    delete window.__pendingImageFile;
  };

  imageInput.addEventListener('change', changeHandler);
  removeBtn?.addEventListener('click', removeHandler);

  return () => {
    imageInput.removeEventListener('change', changeHandler);
    removeBtn?.removeEventListener('click', removeHandler);
  };
}

async function handleFreqModePlay(): Promise<void> {
  const splash = document.getElementById('splash');
  const playBtn = document.getElementById('play-btn') as HTMLButtonElement | null;

  let source: string | File | null = null;

  if (store.state.useSample) {
    source = SAMPLE_URL;
  } else if (store.state.userFile) {
    source = store.state.userFile;
  }

  if (!source) {
    setFileStatus('Please upload a track or use the sample first.', true);
    return;
  }

  if (playBtn) playBtn.disabled = true;
  setFileStatus('Loading…');

  try {
    await audioEngine.initFreqMode(source);

    const bpmData = await detectBPMWithFallback(
      store.state.useSample ? 'sample.mp3' : store.state.userFile!,
      audioEngine.getAudioBuffer(),
    );
    if (bpmData) store.setBPM(bpmData);

    splash?.classList.add('hidden');
    document.getElementById('playback-bar')?.classList.add('visible');

    audioEngine.start();

    const trackName = document.getElementById('track-name');
    if (trackName) {
      trackName.textContent = store.state.useSample
        ? 'Sample track'
        : (store.state.userFile?.name ?? null);
    }
  } catch (err) {
    console.error('Audio init error:', err);
    const errorMsg = err instanceof Error ? err.message : 'Unknown error';
    setFileStatus(`Error: ${errorMsg}`, true);
    if (playBtn) playBtn.disabled = false;
  }
}

async function handleMicModePlay(): Promise<void> {
  const splash = document.getElementById('splash');

  setFileStatus('Requesting microphone access…');

  try {
    store.setMode('mic');
    await audioEngine.initMicMode();

    splash?.classList.add('hidden');
    document.getElementById('playback-bar')?.classList.add('visible');

    // Hide scrubber and track info for mic mode
    document.getElementById('scrubber-row')?.classList.add('hidden');
    document.getElementById('track-info')?.classList.add('hidden');
    document.getElementById('bpm-group')?.classList.add('hidden');

    audioEngine.start();

    const trackName = document.getElementById('track-name');
    if (trackName) trackName.textContent = 'Microphone';

    // Hide beat-dependent visualizations in mic mode
    const beatVizModes = ['tetris', 'lasers', 'text', 'highway'];
    const vizSelector = document.getElementById('viz-selector') as HTMLSelectElement | null;
    if (vizSelector) {
      for (const opt of Array.from(vizSelector.options)) {
        if (beatVizModes.includes(opt.value)) {
          opt.hidden = true;
          opt.disabled = true;
        }
      }
      // If current viz is beat-dependent, switch to circle
      if (beatVizModes.includes(vizSelector.value)) {
        vizSelector.value = 'circle';
        vizSelector.dispatchEvent(new Event('change'));
      }
    }
  } catch (err) {
    console.error('Microphone init error:', err);
    const errorMsg = err instanceof Error ? err.message : 'Unknown error';
    setFileStatus(`Microphone error: ${errorMsg}`, true);
  }
}

export function bindSplashKeyboard(): () => void {
  const splash = document.getElementById('splash');
  const cursor = document.getElementById('nav-cursor');
  const menu = document.getElementById('term-menu');

  if (!splash || !cursor || !menu) return () => {};

  navItems = Array.from(menu.querySelectorAll<HTMLElement>('[data-nav]'));
  if (navItems.length === 0) return () => {};

  navCursorIndex = 0;

  function isItemAvailable(index: number): boolean {
    const el = navItems[index];
    if (!el) return false;
    const modeSection = el.closest('#splash-step-mode');
    if (modeSection && !modeSection.classList.contains('unlocked')) return false;
    // Only the launch button uses disabled to gate availability
    if (el.id === 'play-btn' && (el as HTMLButtonElement).disabled) return false;
    return true;
  }

  function updateCursorPosition(): void {
    const target = navItems[navCursorIndex];
    if (!target || !menu) return;
    const menuRect = menu.getBoundingClientRect();
    const itemRect = target.getBoundingClientRect();
    const top = itemRect.top - menuRect.top + itemRect.height / 2 - 8;
    cursor!.style.top = `${top}px`;
    navItems.forEach(el => el.classList.remove('nav-active'));
    target.classList.add('nav-active');
  }

  function moveTo(index: number): void {
    if (index === navCursorIndex) return;
    navCursorIndex = index;
    updateCursorPosition();
  }

  function findNext(from: number, dir: 1 | -1): number {
    let next = from + dir;
    while (next >= 0 && next < navItems.length) {
      if (isItemAvailable(next)) return next;
      next += dir;
    }
    return from;
  }

  const keyHandler = (e: KeyboardEvent) => {
    if (splash!.classList.contains('hidden')) return;

    switch (e.key) {
      case 'ArrowDown': {
        e.preventDefault();
        moveTo(findNext(navCursorIndex, 1));
        break;
      }
      case 'ArrowUp': {
        e.preventDefault();
        moveTo(findNext(navCursorIndex, -1));
        break;
      }
      case 'Enter': {
        e.preventDefault();
        const target = navItems[navCursorIndex];
        if (!target || !isItemAvailable(navCursorIndex)) break;
        target.click();

        // Auto-advance cursor after source selection (not mic — it auto-launches)
        if (navCursorIndex <= 1) {
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              const freqIdx = navItems.findIndex(el => el.id === 'mode-freq');
              if (freqIdx >= 0 && isItemAvailable(freqIdx)) {
                moveTo(freqIdx);
              }
            });
          });
        }

        // Auto-advance cursor after mode selection
        if (navCursorIndex === 3 || navCursorIndex === 4) {
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              const launchIdx = navItems.findIndex(el => el.id === 'play-btn');
              if (launchIdx >= 0 && isItemAvailable(launchIdx)) {
                moveTo(launchIdx);
              }
            });
          });
        }
        break;
      }
    }
  };

  document.addEventListener('keydown', keyHandler);

  // Position cursor after menu animation completes
  const initTimer = setTimeout(() => {
    updateCursorPosition();
  }, 2100);

  const resizeHandler = () => updateCursorPosition();
  window.addEventListener('resize', resizeHandler);

  return () => {
    document.removeEventListener('keydown', keyHandler);
    window.removeEventListener('resize', resizeHandler);
    clearTimeout(initTimer);
  };
}

async function handleStemModePlay(): Promise<void> {
  const splash = document.getElementById('splash');
  const playBtn = document.getElementById('play-btn') as HTMLButtonElement | null;

  if (isSeparating) return;

  // Resolve audio file source (sample or uploaded file)
  let audioFile: File | null = null;

  if (store.state.useSample) {
    try {
      const resp = await fetch(SAMPLE_URL);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const blob = await resp.blob();
      audioFile = new File([blob], 'sample.mp3', { type: blob.type || 'audio/mpeg' });
    } catch (err) {
      setFileStatus('Failed to load sample track.', true);
      return;
    }
  } else if (store.state.userFile) {
    audioFile = store.state.userFile;
  }

  if (!audioFile) {
    setFileStatus('Please upload a track or use the sample first.', true);
    return;
  }

  // Stem separation (server-side, same path for both sample and user file)
  isSeparating = true;
  splash?.classList.add('hidden');
  setProcessingState(true, 'Separating stems…');

  let stemUrls: { kick: string; drums: string; bass: string; vocals: string; other: string };
  try {
    stemUrls = await separateStems(audioFile, text => {
      setProcessingState(true, text);
    });
  } catch (err) {
    console.error('Stem separation error:', err);
    setProcessingState(false);
    splash?.classList.remove('hidden');
    setFileStatus('Stem separation failed. Try frequency mode or another file.', true);
    if (playBtn) playBtn.disabled = false;
    isSeparating = false;
    return;
  }
  isSeparating = false;

  if (playBtn) playBtn.disabled = true;
  setProcessingState(true, 'Loading stems…');

  try {
    await audioEngine.initStemMode(stemUrls);

    const bpmData = await detectBPMWithFallback(
      store.state.useSample ? 'sample.mp3' : store.state.userFile!,
      audioEngine.getAudioBuffer(),
    );
    if (bpmData) store.setBPM(bpmData);

    setProcessingState(false);
    splash?.classList.add('hidden');
    document.getElementById('playback-bar')?.classList.add('visible');

    audioEngine.start();

    const trackName = document.getElementById('track-name');
    if (trackName) {
      trackName.textContent = store.state.useSample
        ? 'Sample track'
        : (store.state.userFile?.name ?? null);
    }
  } catch (err) {
    console.error('Stem audio init error:', err);
    setProcessingState(false);
    splash?.classList.remove('hidden');
    setFileStatus('Error loading stems. Try another file.', true);
    if (playBtn) playBtn.disabled = false;
  }
}
