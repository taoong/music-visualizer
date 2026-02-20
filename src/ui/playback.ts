/**
 * Playback controls: pause, scrubber, track switching
 */
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { separateStems, detectBPMWithFallback } from '../audio/bpm';
import { showError, setProcessingState } from '../utils/errors';
import { formatTime } from '../utils/format';

export function bindPauseButton(): () => void {
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

export function bindScrubber(): () => void {
  const scrubber = document.getElementById('scrubber') as HTMLInputElement | null;
  const timeDisplay = document.getElementById('time-display');

  if (!scrubber) return () => {};

  const inputHandler = () => {
    store.setSeeking(true);
    const pos = parseFloat(scrubber.value);
    const duration = audioEngine.getDuration();
    if (timeDisplay) {
      timeDisplay.textContent = `${formatTime(pos)} / ${formatTime(duration)}`;
    }
  };

  const changeHandler = () => {
    const pos = parseFloat(scrubber.value);
    audioEngine.seek(pos);
    store.setSeeking(false);
  };

  scrubber.addEventListener('input', inputHandler);
  scrubber.addEventListener('change', changeHandler);

  return () => {
    scrubber.removeEventListener('input', inputHandler);
    scrubber.removeEventListener('change', changeHandler);
  };
}

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

export function bindTrackSwitching(): () => void {
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
        await audioEngine.initFreqMode(file);

        const bpmData = await detectBPMWithFallback(file, audioEngine.getAudioBuffer());
        if (bpmData) store.setBPM(bpmData);

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

        const bpmData = await detectBPMWithFallback(file, audioEngine.getAudioBuffer());
        if (bpmData) store.setBPM(bpmData);

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
