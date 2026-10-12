/**
 * Wobble — tiny MIDI learn. Every knob gets an "M" arm button; while armed,
 * the next incoming CC (any channel) binds to that knob. Bindings persist to
 * localStorage. Uses the raw Web MIDI API — no dependency on src/midi.
 */

interface MidiBinding {
  cc: number;
  channel: number;
}

const STORAGE_KEY = 'wobble-midi-v1';

let bindings: Record<string, MidiBinding> = {};
try {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw) {
    const parsed = JSON.parse(raw) as Record<string, MidiBinding>;
    if (parsed && typeof parsed === 'object') bindings = parsed;
  }
} catch {
  // ignore
}

function persist(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(bindings));
  } catch {
    // ignore
  }
}

type ValueHandler = (v: number) => void;
const handlers = new Map<string, ValueHandler>();

let armedKnob: string | null = null;
let midiReady = false;
let midiFailed = false;
const readyListeners = new Set<() => void>();

export function onMidiReady(cb: () => void): () => void {
  readyListeners.add(cb);
  return () => {
    readyListeners.delete(cb);
  };
}

function notifyReady(): void {
  readyListeners.forEach(cb => cb());
}

/** Register a knob's value handler so incoming CCs can drive it. */
export function registerKnob(knobId: string, onValue: ValueHandler): void {
  handlers.set(knobId, onValue);
}

export function unregisterKnob(knobId: string): void {
  handlers.delete(knobId);
  if (armedKnob === knobId) armedKnob = null;
}

export function armKnob(knobId: string | null): void {
  armedKnob = knobId;
  notifyReady(); // refresh arm-button visuals
}

export function getArmedKnob(): string | null {
  return armedKnob;
}

export function getBinding(knobId: string): MidiBinding | null {
  return bindings[knobId] ?? null;
}

export function clearBinding(knobId: string): void {
  delete bindings[knobId];
  persist();
  notifyReady();
}

export function isMidiReady(): boolean {
  return midiReady;
}

export function didMidiFail(): boolean {
  return midiFailed;
}

function handleMessage(data: Uint8Array): void {
  const status = data[0];
  const kind = status & 0xf0;
  if (kind !== 0xb0) return; // CC only
  const cc = data[1];
  const value = data[2] / 127;
  if (armedKnob) {
    const channel = status & 0x0f;
    bindings[armedKnob] = { cc, channel };
    persist();
    const target = armedKnob;
    armedKnob = null;
    const h = handlers.get(target);
    if (h) h(value); // snap to the incoming value
    notifyReady();
    return;
  }
  for (const [id, b] of Object.entries(bindings)) {
    if (b.cc === cc) {
      const h = handlers.get(id);
      if (h) h(value);
    }
  }
}

/** Request MIDI access once; safe to call repeatedly. */
export async function ensureMidi(): Promise<boolean> {
  if (midiReady) return true;
  if (midiFailed) return false;
  try {
    if (!navigator.requestMIDIAccess) {
      midiFailed = true;
      return false;
    }
    const access = await navigator.requestMIDIAccess();
    const attach = (input: MIDIInput): void => {
      input.onmidimessage = (ev: MIDIMessageEvent) => {
        if (ev.data) handleMessage(ev.data);
      };
    };
    access.inputs.forEach(attach);
    // Pick up devices connected later.
    access.onstatechange = (ev: MIDIConnectionEvent): void => {
      const port = ev.port;
      if (port && port.type === 'input' && port.state === 'connected') {
        attach(port as MIDIInput);
      }
    };
    midiReady = true;
    notifyReady();
    return true;
  } catch {
    midiFailed = true;
    return false;
  }
}
