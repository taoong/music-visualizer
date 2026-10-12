/**
 * Beat clock — a single per-frame source of beat phase / beat pulse shared by
 * the post-FX chain and the GLSL shader modes.
 *
 * - File playback with a detected BPM: phase is locked to the playback
 *   position (same formula vizzes use: floor((pos - beatOffset) / interval)).
 * - Mic / interactive / no BPM: a free-running clock at the detected BPM (or
 *   120) keeps the phase moving, and a bass/sub transient re-triggers the
 *   pulse so taps, drags and live kicks still punch.
 */
import { store } from '../state/store';
import { audioEngine } from './engine';

export interface BeatClock {
  /** 0–1 position within the current beat. */
  phase: number;
  /** 1 on a beat, decays toward 0. */
  pulse: number;
  /** BPM in use (detected, or 120 fallback). */
  bpm: number;
  /** Monotonic beat counter. */
  count: number;
}

const FALLBACK_BPM = 120;
const PULSE_DECAY = 0.86;          // per 60fps frame
const TRANSIENT_TRIGGER = 1.35;    // transientValues multiplier that counts as a hit
const TRANSIENT_REFRACTORY = 0.18; // seconds between transient-triggered pulses

const clock: BeatClock = { phase: 0, pulse: 0, bpm: FALLBACK_BPM, count: 0 };
let freePhase = 0;
let lastBeatIndex = -1;
let sinceTransient = 1;

/** Call exactly once per frame (main.ts render loop), before the viz draws. */
export function updateBeatClock(dt: number): void {
  const { state, audioState } = store;
  const bpm = state.detectedBPM > 0 ? state.detectedBPM : FALLBACK_BPM;
  clock.bpm = bpm;

  const dtSec = dt / 60;
  sinceTransient += dtSec;
  clock.pulse *= Math.pow(PULSE_DECAY, dt);

  const locked = state.mode === 'freq' && state.beatIntervalSec > 0 && state.isPlaying;
  if (locked) {
    const pos = audioEngine.getPlaybackPosition();
    const beats = (pos - state.beatOffset) / state.beatIntervalSec;
    const idx = Math.floor(beats);
    clock.phase = beats - idx;
    if (idx !== lastBeatIndex) {
      if (idx > lastBeatIndex) { clock.pulse = 1; clock.count++; }
      lastBeatIndex = idx;
    }
    freePhase = clock.phase;
    return;
  }

  lastBeatIndex = -1;
  freePhase += dtSec * (bpm / 60);
  if (freePhase >= 1) {
    freePhase -= Math.floor(freePhase);
    // With no real beat grid only count beats, don't pulse — pulses come from transients
    clock.count++;
  }
  clock.phase = freePhase;

  // Any band counts: interactive taps fire a transient centred on the tapped band
  let hit = 0;
  for (let b = 0; b < audioState.transientValues.length; b++) {
    hit = Math.max(hit, audioState.transientValues[b]);
  }
  if (hit > TRANSIENT_TRIGGER && sinceTransient > TRANSIENT_REFRACTORY) {
    sinceTransient = 0;
    clock.pulse = Math.max(clock.pulse, Math.min(1, (hit - 1) * 1.5));
    // Re-anchor the free clock on hits so phase roughly follows live kicks
    freePhase = 0;
  }
}

export function getBeatClock(): Readonly<BeatClock> {
  return clock;
}
