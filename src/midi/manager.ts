/**
 * MIDI Manager — Web MIDI API access, CC listener, mapping storage
 */
import type { Config, MidiMapping, MidiMappings } from '../types';

const STORAGE_KEY = 'visualizer-midi-mappings';

// Config key → slider DOM ID
const CONFIG_TO_SLIDER: Record<keyof Config, string> = {
  sensSub: 'sens-sub',
  sensBass: 'sens-bass',
  sensLowMid: 'sens-low-mid',
  sensMid: 'sens-mid',
  sensUpperMid: 'sens-upper-mid',
  sensPresence: 'sens-presence',
  sensBrilliance: 'sens-brilliance',
  sensKick: 'sens-kick',
  sensDrums: 'sens-drums',
  sensStemBass: 'sens-bass-stem',
  sensVocals: 'sens-vocals',
  sensOther: 'sens-other',
  spikeScale: 'spike-scale',
  decayRate: 'decay-rate',
  rotationSpeed: 'rotation-speed',
  ballsKickBoost: 'balls-kick-boost',
  intensity: 'viz-intensity',
  beatDivision: 'beat-division',
  masterVolume: 'master-volume',
};

type MidiStatus = 'unsupported' | 'denied' | 'no-devices' | 'connected';

let midiAccess: MIDIAccess | null = null;
let status: MidiStatus = 'unsupported';
let mappings: MidiMappings = {};
// reverse map: "channel:cc" → configKey
let reverseMap: Map<string, keyof Config> = new Map();

interface MappingModeState {
  configKey: keyof Config;
  resolve: (mapping: MidiMapping) => void;
  reject: (reason?: unknown) => void;
}
let mappingMode: MappingModeState | null = null;

const changeListeners: Set<() => void> = new Set();

function notifyListeners(): void {
  for (const fn of changeListeners) fn();
}

function buildReverseMap(): void {
  reverseMap = new Map();
  for (const [key, mapping] of Object.entries(mappings) as [keyof Config, MidiMapping][]) {
    if (mapping) {
      reverseMap.set(`${mapping.channel}:${mapping.cc}`, key);
    }
  }
}

function persistMappings(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(mappings));
  } catch {
    // localStorage unavailable
  }
}

function loadMappings(): void {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      mappings = JSON.parse(raw) as MidiMappings;
      buildReverseMap();
    }
  } catch {
    mappings = {};
  }
}

function handleMidiMessage(event: MIDIMessageEvent): void {
  const data = event.data;
  if (!data || data.length < 3) return;

  const statusByte = data[0];
  // Only handle CC messages (0xB0–0xBF)
  if ((statusByte & 0xf0) !== 0xb0) return;

  const channel = (statusByte & 0x0f) + 1;
  const cc = data[1];
  const value = data[2];

  if (mappingMode) {
    // Save the mapping
    const { configKey, resolve } = mappingMode;
    mappingMode = null;
    const newMapping: MidiMapping = { channel, cc };
    mappings[configKey] = newMapping;
    buildReverseMap();
    persistMappings();
    notifyListeners();
    resolve(newMapping);
    return;
  }

  // Look up configKey in reverse map
  const key = `${channel}:${cc}`;
  const configKey = reverseMap.get(key);
  if (!configKey) return;

  const sliderId = CONFIG_TO_SLIDER[configKey];
  if (!sliderId) return;

  const slider = document.getElementById(sliderId) as HTMLInputElement | null;
  if (!slider) return;

  const min = parseFloat(slider.min) || 0;
  const max = parseFloat(slider.max) || 1;
  const mapped = min + (value / 127) * (max - min);

  slider.value = String(mapped);
  slider.dispatchEvent(new Event('input', { bubbles: true }));
}

function attachToAllInputs(): void {
  if (!midiAccess) return;
  for (const input of midiAccess.inputs.values()) {
    input.onmidimessage = handleMidiMessage;
  }
  updateStatus();
}

function updateStatus(): void {
  if (!midiAccess) return;
  const prev = status;
  status = midiAccess.inputs.size > 0 ? 'connected' : 'no-devices';
  if (prev !== status) notifyListeners();
}

export async function initMidi(): Promise<boolean> {
  loadMappings();

  if (!navigator.requestMIDIAccess) {
    status = 'unsupported';
    return false;
  }

  try {
    midiAccess = await navigator.requestMIDIAccess();
    attachToAllInputs();
    midiAccess.onstatechange = () => {
      attachToAllInputs();
    };
    return true;
  } catch {
    status = 'denied';
    return false;
  }
}

export function getMidiStatus(): MidiStatus {
  return status;
}

export function getMappings(): Readonly<MidiMappings> {
  return mappings;
}

export function startMappingMode(configKey: keyof Config): Promise<MidiMapping> {
  // Cancel any existing mapping mode
  if (mappingMode) {
    mappingMode.reject(new Error('Cancelled'));
    mappingMode = null;
  }

  return new Promise<MidiMapping>((resolve, reject) => {
    mappingMode = { configKey, resolve, reject };
  });
}

export function cancelMappingMode(): void {
  if (mappingMode) {
    mappingMode.reject(new Error('Cancelled'));
    mappingMode = null;
  }
}

export function getActiveMappingKey(): keyof Config | null {
  return mappingMode ? mappingMode.configKey : null;
}

export function clearMapping(configKey: keyof Config): void {
  delete mappings[configKey];
  buildReverseMap();
  persistMappings();
  notifyListeners();
}

export function clearAllMappings(): void {
  mappings = {};
  reverseMap = new Map();
  persistMappings();
  notifyListeners();
}

export function onMappingsChange(fn: () => void): () => void {
  changeListeners.add(fn);
  return () => changeListeners.delete(fn);
}
