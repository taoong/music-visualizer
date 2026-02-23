import { store } from '../state/store';
import { audioEngine } from '../audio/engine';

export function bindBPMControls(): () => void {
  const bpmInput = document.getElementById('bpm-input') as HTMLInputElement | null;
  const tapBtn   = document.getElementById('tap-tempo-btn') as HTMLButtonElement | null;
  const beatBtn  = document.getElementById('beat-sync-btn') as HTMLButtonElement | null;
  if (!bpmInput || !tapBtn || !beatBtn) return () => {};

  // Populate input when BPM is detected
  const unsubBpm = store.on('bpmDetected', (data: unknown) => {
    const bpmData = data as { bpm: number };
    bpmInput.value = String(bpmData.bpm);
  });

  // Manual input edit
  const inputChangeHandler = () => {
    const bpm = parseFloat(bpmInput.value);
    if (bpm >= 20 && bpm <= 300) {
      store.setBPM({ bpm, beatOffset: store.state.beatOffset });
    }
  };
  bpmInput.addEventListener('change', inputChangeHandler);

  // Tap tempo
  const TAP_RESET_MS = 2500;
  let tapTimes: number[] = [];

  const tapHandler = () => {
    const now = Date.now();
    const playbackPos = audioEngine.getPlaybackPosition();

    // Reset if too long since last tap
    if (tapTimes.length > 0 && now - tapTimes[tapTimes.length - 1] > TAP_RESET_MS) {
      tapTimes = [];
    }
    tapTimes.push(now);

    // Need at least 2 taps to compute BPM
    if (tapTimes.length >= 2) {
      const intervals = tapTimes.slice(1).map((t, i) => t - tapTimes[i]);
      const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;
      const bpm = Math.round(60000 / avgInterval);

      bpmInput.value = String(bpm);
      store.setBPM({ bpm, beatOffset: playbackPos });
    }

    flashElement(tapBtn);
  };
  tapBtn.addEventListener('click', tapHandler);

  // Beat phase sync
  const beatHandler = () => {
    const bpm = store.state.detectedBPM;
    if (bpm > 0) {
      const playbackPos = audioEngine.getPlaybackPosition();
      store.setBPM({ bpm, beatOffset: playbackPos });
    }
    flashElement(beatBtn);
  };
  beatBtn.addEventListener('click', beatHandler);

  return () => {
    unsubBpm();
    bpmInput.removeEventListener('change', inputChangeHandler);
    tapBtn.removeEventListener('click', tapHandler);
    beatBtn.removeEventListener('click', beatHandler);
  };
}

function flashElement(el: HTMLElement): void {
  el.classList.remove('tap-flash');
  // Force reflow to restart animation
  void el.offsetWidth;
  el.classList.add('tap-flash');
}
