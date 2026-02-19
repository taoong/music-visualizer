/**
 * UI Controller — thin orchestrator that wires all UI modules
 */
import { store } from '../state/store';
import { injectErrorStyles } from '../utils/errors';
import { initBalls } from '../visualizations';
import { BANDS, isMobile } from '../utils/constants';
import { bindFileUpload, bindSampleButton, bindModeSelector, bindPlayButton } from './splash';
import { bindVolumeControl, bindSensitivitySliders, bindDisplaySliders, setSlider } from './sliders';
import { bindPauseButton, bindScrubber, bindTrackSwitching, updateScrubberUI } from './playback';

export { updateScrubberUI };

/**
 * Initialize all UI event listeners
 */
export function initUI(): () => void {
  injectErrorStyles();

  const cleanupFns: (() => void)[] = [];

  // Sidebar toggle
  cleanupFns.push(bindSidebarToggle());

  // Splash screen controls
  cleanupFns.push(bindFileUpload());
  cleanupFns.push(bindSampleButton());
  cleanupFns.push(bindModeSelector());
  cleanupFns.push(bindPlayButton());

  // Playback controls
  cleanupFns.push(bindPauseButton());
  cleanupFns.push(bindTrackSwitching());
  cleanupFns.push(bindScrubber());

  // Sliders
  cleanupFns.push(bindVolumeControl());
  cleanupFns.push(bindSensitivitySliders());
  cleanupFns.push(bindDisplaySliders());

  // Visualization selector
  cleanupFns.push(bindVizSelector());

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
