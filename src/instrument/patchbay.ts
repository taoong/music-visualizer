/**
 * Wobble — modulation patch bay. Three always-on sources (Kick, Bass, Hats)
 * derived from the audio frame; any knob can be patched to one. A patched
 * knob's effective value = clamp(base + 0.6 * source). Patches persist.
 */
import type { AudioFrame } from './audio';

export type ModSourceId = 'kick' | 'bass' | 'hats';

export interface ModSources {
  kick: number;
  bass: number;
  hats: number;
}

export const MOD_SOURCES: { id: ModSourceId; label: string; color: string }[] = [
  { id: 'kick', label: 'Kick', color: '#FF5CA8' },
  { id: 'bass', label: 'Bass', color: '#4D7CFE' },
  { id: 'hats', label: 'Hats', color: '#FFC53D' },
];

const STORAGE_KEY = 'wobble-patches-v1';
const PATCH_DEPTH = 0.6;

let patches: Record<string, ModSourceId> = {};
try {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw) {
    const parsed = JSON.parse(raw) as Record<string, ModSourceId>;
    if (parsed && typeof parsed === 'object') patches = parsed;
  }
} catch {
  // ignore
}

function persist(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(patches));
  } catch {
    // ignore
  }
}

let kickEnv = 0;

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

/**
 * Update modulation sources from the latest audio frame. `dt` is in seconds.
 */
export function updateSources(dt: number, audio: AudioFrame): ModSources {
  if (audio.beat) kickEnv = 1;
  kickEnv *= Math.pow(0.001, dt); // fast decay envelope
  const bass = clamp01((audio.bands[0] + audio.bands[1]) / 2);
  const hats = clamp01((audio.bands[5] + audio.bands[6]) / 2);
  return { kick: clamp01(kickEnv), bass, hats };
}

export function getPatch(knobId: string): ModSourceId | null {
  return patches[knobId] ?? null;
}

export function setPatch(knobId: string, source: ModSourceId | null): void {
  if (source) patches[knobId] = source;
  else delete patches[knobId];
  persist();
}

/** Remove every patch whose knob no longer exists (called after chain edits). */
export function prunePatches(liveKnobIds: Set<string>): void {
  let changed = false;
  for (const id of Object.keys(patches)) {
    if (!liveKnobIds.has(id)) {
      delete patches[id];
      changed = true;
    }
  }
  if (changed) persist();
}

export function getPatches(): Record<string, ModSourceId> {
  return { ...patches };
}

export function effectiveValue(knobId: string, base: number, sources: ModSources): number {
  const src = patches[knobId];
  if (!src) return base;
  return clamp01(base + PATCH_DEPTH * sources[src]);
}
