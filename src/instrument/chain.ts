/**
 * Wobble — chain state (ordered block instances), presets, persistence,
 * and the ping-pong chain renderer.
 */
import { BLOCKS, denormalize, type BlockDef, type RenderEnv } from './blocks';
import type { AudioFrame } from './audio';
import type { Palette } from './palettes';

export interface ChainInstance {
  uid: string;
  blockId: string;
  /** normalized 0..1 param values */
  params: Record<string, number>;
  enabled: boolean;
  /** per-instance runtime scratch (particles, feedback buffers, …) */
  state: Record<string, unknown>;
}

export interface SerializedChain {
  instances: { uid: string; blockId: string; params: Record<string, number>; enabled: boolean }[];
}

/** Resolves a param's real value; the UI layer injects macro/patch overrides here. */
export type ParamResolver = (
  inst: ChainInstance,
  def: import('./blocks').BlockParamDef,
  baseNorm: number,
) => number;

export const defaultResolver: ParamResolver = (_inst, def, baseNorm) =>
  denormalize(def, baseNorm);

export const PRESETS: Record<string, string[]> = {
  'Blob Party': ['blob-field', 'kaleido', 'trails', 'palette-pop', 'glow', 'output'],
  'Rain Dance': ['particle-rain', 'wobble', 'trails', 'palette-pop', 'output'],
};

const STORAGE_KEY = 'wobble-chain-v1';
let uidCounter = 0;

export function createInstance(blockId: string): ChainInstance {
  const def = BLOCKS[blockId];
  if (!def) throw new Error(`Unknown block: ${blockId}`);
  const params: Record<string, number> = {};
  for (const p of def.params) {
    params[p.key] = Math.max(
      0,
      Math.min(1, (p.def - p.min) / (p.max - p.min || 1)),
    );
  }
  uidCounter += 1;
  return {
    uid: `inst-${Date.now().toString(36)}-${uidCounter}`,
    blockId,
    params,
    enabled: true,
    state: {},
  };
}

export class WobbleChain {
  instances: ChainInstance[] = [];
  onChange: (() => void) | null = null;

  private notify(): void {
    this.persist();
    if (this.onChange) this.onChange();
  }

  add(blockId: string, index?: number): ChainInstance {
    const inst = createInstance(blockId);
    const at = index === undefined ? this.instances.length : Math.max(0, Math.min(index, this.instances.length));
    // Keep a single output block pinned at the end.
    const outIdx = this.instances.findIndex(i => i.blockId === 'output');
    const insertAt = outIdx >= 0 && at > outIdx ? outIdx : at;
    this.instances.splice(insertAt, 0, inst);
    this.notify();
    return inst;
  }

  remove(uid: string): void {
    this.instances = this.instances.filter(i => i.uid !== uid);
    this.notify();
  }

  move(uid: string, dir: -1 | 1): void {
    const idx = this.instances.findIndex(i => i.uid === uid);
    const j = idx + dir;
    if (idx < 0 || j < 0 || j >= this.instances.length) return;
    const [inst] = this.instances.splice(idx, 1);
    this.instances.splice(j, 0, inst);
    this.notify();
  }

  toggle(uid: string): void {
    const inst = this.instances.find(i => i.uid === uid);
    if (inst) {
      inst.enabled = !inst.enabled;
      this.notify();
    }
  }

  setParam(uid: string, key: string, norm: number): void {
    const inst = this.instances.find(i => i.uid === uid);
    if (inst && inst.params[key] !== undefined) {
      inst.params[key] = Math.max(0, Math.min(1, norm));
      this.persist();
    }
  }

  resetToPreset(name: string): void {
    const ids = PRESETS[name];
    if (!ids) return;
    this.instances = ids.map(id => createInstance(id));
    this.notify();
  }

  serialize(): SerializedChain {
    return {
      instances: this.instances.map(i => ({
        uid: i.uid,
        blockId: i.blockId,
        params: { ...i.params },
        enabled: i.enabled,
      })),
    };
  }

  persist(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.serialize()));
    } catch {
      // ignore
    }
  }

  load(): boolean {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return false;
      const data = JSON.parse(raw) as SerializedChain;
      if (!Array.isArray(data.instances) || data.instances.length === 0) return false;
      this.instances = data.instances
        .filter(s => BLOCKS[s.blockId])
        .map(s => ({ ...s, state: {} as Record<string, unknown> }));
      return this.instances.length > 0;
    } catch {
      return false;
    }
  }

  defOf(inst: ChainInstance): BlockDef {
    return BLOCKS[inst.blockId];
  }
}

/**
 * Ping-pong chain renderer. Sources draw into buffer A; each enabled
 * transform/fx reads the previous buffer and writes the next; disabled
 * blocks are skipped (pass-through). The final buffer is blitted to ctx.
 */
export class ChainRenderer {
  private bufA: HTMLCanvasElement | null = null;
  private bufB: HTMLCanvasElement | null = null;
  private bw = 0;
  private bh = 0;

  private ensureSize(w: number, h: number): void {
    if (!this.bufA || this.bw !== w || this.bh !== h) {
      this.bufA = document.createElement('canvas');
      this.bufB = document.createElement('canvas');
      this.bufA.width = w;
      this.bufA.height = h;
      this.bufB!.width = w;
      this.bufB!.height = h;
      this.bw = w;
      this.bh = h;
    }
  }

  render(
    ctx: CanvasRenderingContext2D,
    w: number,
    h: number,
    t: number,
    audio: AudioFrame,
    chain: WobbleChain,
    palette: Palette,
    chaos: number,
    resolver: ParamResolver,
  ): void {
    this.ensureSize(w, h);
    const env: RenderEnv = { chaos, palette };
    const enabled = chain.instances.filter(i => i.enabled);
    if (enabled.length === 0) {
      ctx.fillStyle = palette.bg;
      ctx.fillRect(0, 0, w, h);
      return;
    }

    let read = this.bufA as HTMLCanvasElement;
    let write = this.bufB as HTMLCanvasElement;
    let haveImage = false;

    for (const inst of enabled) {
      const def = BLOCKS[inst.blockId];
      if (!def) continue;
      const realParams: Record<string, number> = {};
      for (const pd of def.params) {
        realParams[pd.key] = resolver(inst, pd, inst.params[pd.key] ?? 0.5);
      }
      if (def.kind === 'source' && !haveImage) {
        const c = read.getContext('2d') as CanvasRenderingContext2D;
        c.clearRect(0, 0, w, h);
        def.render(c, w, h, t, audio, realParams, null, inst.state, env);
        haveImage = true;
        continue;
      }
      if (def.kind === 'output') continue; // terminal marker
      if (!haveImage) continue; // transform/fx before any source: skip
      const c = write.getContext('2d') as CanvasRenderingContext2D;
      c.clearRect(0, 0, w, h);
      def.render(c, w, h, t, audio, realParams, read, inst.state, env);
      const tmp = read;
      read = write;
      write = tmp;
    }

    if (haveImage) {
      ctx.drawImage(read, 0, 0, w, h);
    } else {
      ctx.fillStyle = palette.bg;
      ctx.fillRect(0, 0, w, h);
    }
  }
}
