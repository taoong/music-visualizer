/**
 * UI Controller for managing DOM interactions
 */
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { fetchBPM, separateStems } from '../audio/bpm';
import { showError, setProcessingState, setFileStatus, injectErrorStyles } from '../utils/errors';
import { initBalls } from '../visualizations';
import { SAMPLE_URL, BANDS, isMobile } from '../utils/constants';
import type { AnalysisMode } from '../types';

/**
 * Initialize all UI event listeners
 */
export function initUI(): () => void {
  injectErrorStyles();

  const cleanupFns: (() => void)[] = [];

  // Sidebar toggle
  cleanupFns.push(bindSidebarToggle());

  // File upload
  cleanupFns.push(bindFileUpload());

  // Sample button
  cleanupFns.push(bindSampleButton());

  // Mode selector
  cleanupFns.push(bindModeSelector());

  // Play button
  cleanupFns.push(bindPlayButton());

  // Pause button
  cleanupFns.push(bindPauseButton());

  // Track switching
  cleanupFns.push(bindTrackSwitching());

  // Volume control
  cleanupFns.push(bindVolumeControl());

  // Sensitivity sliders
  cleanupFns.push(bindSensitivitySliders());

  // Visualization selector
  cleanupFns.push(bindVizSelector());

  // Display sliders
  cleanupFns.push(bindDisplaySliders());

  // Scrubber
  cleanupFns.push(bindScrubber());

  // Randomize button
  cleanupFns.push(bindRandomizeButton());

  // Return combined cleanup function
  return () => cleanupFns.forEach(fn => fn());
}

function bindSidebarToggle(): () => void {
  const sidebar = document.getElementById('sidebar');
  const toggleBtn = document.getElementById('sidebar-toggle');

  if (!sidebar || !toggleBtn) return () => {};

  const handler = () => sidebar.classList.toggle('open');
  toggleBtn.addEventListener('click', handler);

  return () => toggleBtn.removeEventListener('click', handler);
}

function bindFileUpload(): () => void {
  const audioInput = document.getElementById('audio-upload') as HTMLInputElement | null;
  const fileNameEl = document.getElementById('file-name');
  const playBtn = document.getElementById('play-btn') as HTMLButtonElement | null;

  if (!audioInput) return () => {};

  const handler = (e: Event) => {
    const target = e.target as HTMLInputElement;
    if (target.files?.length) {
      store.setUserFile(target.files[0]);
      if (fileNameEl) fileNameEl.textContent = target.files[0].name;
      if (playBtn) playBtn.disabled = false;
    }
  };

  audioInput.addEventListener('change', handler);
  return () => audioInput.removeEventListener('change', handler);
}

function bindSampleButton(): () => void {
  const btn = document.getElementById('use-sample-btn');
  const fileNameEl = document.getElementById('file-name');
  const playBtn = document.getElementById('play-btn') as HTMLButtonElement | null;

  if (!btn) return () => {};

  const handler = () => {
    store.setUseSample(true);
    if (fileNameEl) fileNameEl.textContent = 'Sample track selected';
    if (playBtn) playBtn.disabled = false;
  };

  btn.addEventListener('click', handler);
  return () => btn.removeEventListener('click', handler);
}

function bindModeSelector(): () => void {
  const modeFreqBtn = document.getElementById('mode-freq');
  const modeStemsBtn = document.getElementById('mode-stems');
  const freqSliders = document.getElementById('freq-sliders');
  const stemSliders = document.getElementById('stem-sliders');

  if (!modeFreqBtn || !modeStemsBtn) return () => {};

  const setMode = (mode: AnalysisMode) => {
    store.setMode(mode);

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

    if (store.state.vizMode === 'balls') {
      // Will be re-initialized on next draw
    }
  };

  const freqHandler = () => setMode('freq');
  const stemsHandler = () => setMode('stems');

  modeFreqBtn.addEventListener('click', freqHandler);
  modeStemsBtn.addEventListener('click', stemsHandler);

  return () => {
    modeFreqBtn.removeEventListener('click', freqHandler);
    modeStemsBtn.removeEventListener('click', stemsHandler);
  };
}

function bindPlayButton(): () => void {
  const playBtn = document.getElementById('play-btn');

  if (!playBtn) return () => {};

  const handler = async () => {
    if (store.isFreqMode) {
      await handleFreqModePlay();
    } else {
      await handleStemModePlay();
    }
  };

  playBtn.addEventListener('click', handler);
  return () => playBtn.removeEventListener('click', handler);
}

async function handleFreqModePlay(): Promise<void> {
  const splash = document.getElementById('splash');
  const playBtn = document.getElementById('play-btn') as HTMLButtonElement | null;

  let url: string | null = null;

  if (store.state.useSample) {
    url = SAMPLE_URL;
  } else if (store.state.userFile) {
    url = URL.createObjectURL(store.state.userFile);
    store.state.currentObjectUrl = url;
  }

  if (!url) {
    setFileStatus('Please upload a track or use the sample first.', true);
    return;
  }

  if (playBtn) playBtn.disabled = true;
  setFileStatus('Loading…');

  try {
    await audioEngine.initFreqMode(url);

    try {
      const bpmData = await fetchBPM(store.state.useSample ? 'sample.mp3' : store.state.userFile!);
      store.setBPM(bpmData);
    } catch {
      // Non-critical error - BPM detection failed
    }

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
    setFileStatus('Error loading audio. Try another file.', true);
    if (playBtn) playBtn.disabled = false;
  }
}

async function handleStemModePlay(): Promise<void> {
  const splash = document.getElementById('splash');
  const playBtn = document.getElementById('play-btn') as HTMLButtonElement | null;

  let stemUrls: {
    kick: string | undefined;
    drums: string | undefined;
    bass: string | undefined;
    vocals: string | undefined;
    other: string | undefined;
  } | null = null;

  if (store.state.useSample) {
    stemUrls = {
      kick: 'stems/sample/kick.mp3',
      drums: 'stems/sample/drums.mp3',
      bass: 'stems/sample/bass.mp3',
      vocals: 'stems/sample/vocals.mp3',
      other: 'stems/sample/other.mp3',
    };
  } else if (store.state.userFile) {
    splash?.classList.add('hidden');
    setProcessingState(true, 'Separating stems…');

    try {
      stemUrls = await separateStems(store.state.userFile, text => {
        setProcessingState(true, text);
      });
    } catch (err) {
      console.error('Stem separation error:', err);
      setProcessingState(false);
      splash?.classList.remove('hidden');
      setFileStatus('Stem separation failed. Try frequency mode or another file.', true);
      if (playBtn) playBtn.disabled = false;
      return;
    }
  }

  if (!stemUrls) {
    setFileStatus('Please upload a track or use the sample first.', true);
    return;
  }

  if (playBtn) playBtn.disabled = true;
  setProcessingState(true, 'Loading stems…');

  try {
    await audioEngine.initStemMode(stemUrls);

    try {
      const bpmData = await fetchBPM(store.state.useSample ? 'sample.mp3' : store.state.userFile!);
      store.setBPM(bpmData);
    } catch {
      // Non-critical error
    }

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

function bindPauseButton(): () => void {
  const pauseBtn = document.getElementById('pause-btn');

  if (!pauseBtn) return () => {};

  const handler = () => {
    if (store.state.isPlaying) {
      audioEngine.stop();
      pauseBtn.classList.remove('is-playing');
    } else {
      audioEngine.start();
      pauseBtn.classList.add('is-playing');
    }
  };

  pauseBtn.addEventListener('click', handler);
  return () => pauseBtn.removeEventListener('click', handler);
}

function bindTrackSwitching(): () => void {
  const sidebarUpload = document.getElementById('sidebar-audio-upload') as HTMLInputElement | null;

  if (!sidebarUpload) return () => {};

  const handler = async (e: Event) => {
    const target = e.target as HTMLInputElement;
    if (!target.files?.length) return;

    const file = target.files[0];
    store.setUserFile(file);
    const trackNameEl = document.getElementById('track-name');

    if (store.isFreqMode) {
      if (trackNameEl) trackNameEl.textContent = 'Loading…';

      try {
        const url = URL.createObjectURL(file);
        store.state.currentObjectUrl = url;

        await audioEngine.initFreqMode(url);

        try {
          const bpmData = await fetchBPM(file);
          store.setBPM(bpmData);
        } catch {
          // Non-critical
        }

        audioEngine.start();
        document.getElementById('pause-btn')?.classList.add('is-playing');
        if (trackNameEl) trackNameEl.textContent = file.name;
      } catch (err) {
        console.error('Track switch error:', err);
        if (trackNameEl) trackNameEl.textContent = 'Error loading audio.';
        showError('Failed to load audio file');
      }
    } else {
      setProcessingState(true, 'Separating stems…');

      try {
        const stemUrls = await separateStems(file);
        setProcessingState(true, 'Loading stems…');

        await audioEngine.initStemMode(stemUrls);

        try {
          const bpmData = await fetchBPM(file);
          store.setBPM(bpmData);
        } catch {
          // Non-critical
        }

        setProcessingState(false);
        audioEngine.start();
        document.getElementById('pause-btn')?.classList.add('is-playing');
        if (trackNameEl) trackNameEl.textContent = file.name;
      } catch (err) {
        console.error('Stem switch error:', err);
        setProcessingState(false);
        if (trackNameEl) trackNameEl.textContent = 'Stem separation failed.';
        showError('Failed to separate stems');
      }
    }
  };

  sidebarUpload.addEventListener('change', handler);
  return () => sidebarUpload.removeEventListener('change', handler);
}

function bindVolumeControl(): () => void {
  const volumeSlider = document.getElementById('master-volume') as HTMLInputElement | null;

  if (!volumeSlider) return () => {};

  const handler = () => {
    const value = parseFloat(volumeSlider.value);
    store.updateConfig('masterVolume', value);
    audioEngine.setVolume(value);
  };

  volumeSlider.addEventListener('input', handler);
  return () => volumeSlider.removeEventListener('input', handler);
}

function bindSensitivitySliders(): () => void {
  const cleanupFns: (() => void)[] = [];

  // Freq mode sliders
  for (const band of BANDS) {
    const slider = document.getElementById(band.sliderId) as HTMLInputElement | null;
    if (slider) {
      const handler = () => {
        store.updateConfig(band.sens as keyof typeof store.config, parseFloat(slider.value));
      };
      slider.addEventListener('input', handler);
      cleanupFns.push(() => slider.removeEventListener('input', handler));
    }
  }

  // Stem mode sliders
  const stemConfigs = [
    { id: 'sens-kick', key: 'sensKick' },
    { id: 'sens-drums', key: 'sensDrums' },
    { id: 'sens-bass-stem', key: 'sensStemBass' },
    { id: 'sens-vocals', key: 'sensVocals' },
    { id: 'sens-other', key: 'sensOther' },
  ] as const;

  for (const { id, key } of stemConfigs) {
    const slider = document.getElementById(id) as HTMLInputElement | null;
    if (slider) {
      const handler = () => {
        store.updateConfig(key, parseFloat(slider.value));
      };
      slider.addEventListener('input', handler);
      cleanupFns.push(() => slider.removeEventListener('input', handler));
    }
  }

  return () => cleanupFns.forEach(fn => fn());
}

function bindVizSelector(): () => void {
  const vizSelect = document.getElementById('viz-selector') as HTMLSelectElement | null;
  const rotationSpeedGroup = document.getElementById('rotation-speed-group');
  const ballsKickBoostGroup = document.getElementById('balls-kick-boost-group');

  if (!vizSelect) return () => {};

  // Remove balls option on mobile
  if (isMobile) {
    const ballsOption = vizSelect.querySelector('option[value="balls"]');
    ballsOption?.remove();
  }

  const handler = () => {
    const mode = vizSelect.value as 'circle' | 'spectrum' | 'tunnel' | 'balls';
    store.setVizMode(mode);

    // Show/hide relevant controls
    if (mode === 'circle') {
      rotationSpeedGroup?.classList.remove('hidden');
      ballsKickBoostGroup?.classList.add('hidden');
    } else if (mode === 'balls') {
      rotationSpeedGroup?.classList.add('hidden');
      ballsKickBoostGroup?.classList.remove('hidden');
      initBalls(window.p5Instance);
    } else {
      rotationSpeedGroup?.classList.add('hidden');
      ballsKickBoostGroup?.classList.add('hidden');
    }
  };

  vizSelect.addEventListener('change', handler);
  return () => vizSelect.removeEventListener('change', handler);
}

function bindDisplaySliders(): () => void {
  const cleanupFns: (() => void)[] = [];

  const configs = [
    { id: 'spike-scale', key: 'spikeScale' },
    { id: 'decay-rate', key: 'decayRate' },
    { id: 'rotation-speed', key: 'rotationSpeed' },
    { id: 'balls-kick-boost', key: 'ballsKickBoost' },
  ] as const;

  for (const { id, key } of configs) {
    const slider = document.getElementById(id) as HTMLInputElement | null;
    if (slider) {
      const handler = () => {
        store.updateConfig(key, parseFloat(slider.value));
      };
      slider.addEventListener('input', handler);
      cleanupFns.push(() => slider.removeEventListener('input', handler));
    }
  }

  return () => cleanupFns.forEach(fn => fn());
}

function bindScrubber(): () => void {
  const scrubber = document.getElementById('scrubber') as HTMLInputElement | null;
  const timeDisplay = document.getElementById('time-display');

  if (!scrubber) return () => {};

  const inputHandler = () => {
    store.state.isSeeking = true;
    const pos = parseFloat(scrubber.value);
    const duration = audioEngine.getDuration();
    if (timeDisplay) {
      timeDisplay.textContent = `${formatTime(pos)} / ${formatTime(duration)}`;
    }
  };

  const changeHandler = () => {
    const pos = parseFloat(scrubber.value);
    audioEngine.seek(pos);
    store.state.isSeeking = false;
  };

  scrubber.addEventListener('input', inputHandler);
  scrubber.addEventListener('change', changeHandler);

  return () => {
    scrubber.removeEventListener('input', inputHandler);
    scrubber.removeEventListener('change', changeHandler);
  };
}

function bindRandomizeButton(): () => void {
  const btn = document.getElementById('randomize-btn');

  if (!btn) return () => {};

  const handler = () => {
    const rand = (min: number, max: number) => Math.random() * (max - min) + min;

    if (store.isFreqMode) {
      for (const band of BANDS) {
        setSlider(band.sliderId, rand(1.0, 3.0));
      }
    } else {
      setSlider('sens-kick', rand(1.0, 3.0));
      setSlider('sens-drums', rand(1.0, 3.0));
      setSlider('sens-bass-stem', rand(1.0, 3.0));
      setSlider('sens-vocals', rand(1.0, 3.0));
      setSlider('sens-other', rand(1.0, 3.0));
    }

    setSlider('spike-scale', rand(0.5, 2.0));
    setSlider('decay-rate', rand(0.7, 0.95));

    if (store.state.vizMode === 'circle') {
      setSlider('rotation-speed', rand(0.0, 15.0));
    }

    if (store.state.vizMode === 'balls') {
      setSlider('balls-kick-boost', rand(2.0, 10.0));
    }
  };

  btn.addEventListener('click', handler);
  return () => btn.removeEventListener('click', handler);
}

function setSlider(id: string, value: number): void {
  const el = document.getElementById(id) as HTMLInputElement | null;
  if (el) {
    el.value = String(value);
    el.dispatchEvent(new Event('input'));
  }
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * Update scrubber UI
 */
export function updateScrubberUI(): void {
  const scrubber = document.getElementById('scrubber') as HTMLInputElement | null;
  const timeDisplay = document.getElementById('time-display');

  if (!scrubber || store.state.isSeeking) return;

  const pos = audioEngine.getPlaybackPosition();
  const duration = audioEngine.getDuration();

  if (duration > 0) {
    scrubber.max = String(duration);
    scrubber.value = String(pos);
    if (timeDisplay) {
      timeDisplay.textContent = `${formatTime(pos)} / ${formatTime(duration)}`;
    }
  }
}
