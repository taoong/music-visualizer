/**
 * Splash screen and initial play handlers
 */
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { fetchBPM, separateStems } from '../audio/bpm';
import { setProcessingState, setFileStatus } from '../utils/errors';
import { SAMPLE_URL } from '../utils/constants';
import type { AnalysisMode } from '../types';

let isSeparating = false;

export function bindFileUpload(): () => void {
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

export function bindSampleButton(): () => void {
  const btn = document.getElementById('use-sample-btn');
  const fileNameEl = document.getElementById('file-name');
  const playBtn = document.getElementById('play-btn') as HTMLButtonElement | null;

  if (!btn) return () => {};

  const handler = () => {
    store.setUseSample(true);
    if (fileNameEl) fileNameEl.textContent = 'Sample track selected';
    if (playBtn) playBtn.disabled = false;
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
  const stemsHandler = () => setMode('stems');

  modeFreqBtn.addEventListener('click', freqHandler);
  modeStemsBtn.addEventListener('click', stemsHandler);

  return () => {
    modeFreqBtn.removeEventListener('click', freqHandler);
    modeStemsBtn.removeEventListener('click', stemsHandler);
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

async function handleFreqModePlay(): Promise<void> {
  const splash = document.getElementById('splash');
  const playBtn = document.getElementById('play-btn') as HTMLButtonElement | null;

  let url: string | null = null;

  if (store.state.useSample) {
    url = SAMPLE_URL;
  } else if (store.state.userFile) {
    url = URL.createObjectURL(store.state.userFile);
    store.setCurrentObjectUrl(url);
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
    if (isSeparating) return;
    isSeparating = true;
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
      isSeparating = false;
      return;
    }
    isSeparating = false;
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
