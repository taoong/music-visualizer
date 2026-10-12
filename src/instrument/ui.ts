/**
 * Wobble — the interface. DrumBoii-inspired: candy colors, cream background,
 * chunky rounded cards, bouncy toy-like controls.
 *
 * Two views: BUILD (block chain + patch bay) and PERFORM (stage + macro deck).
 * All knob values are normalized 0..1; the chain renderer de-normalizes.
 */
import { WobbleChain, PRESETS, type ChainInstance, type ParamResolver } from './chain';
import { BLOCKS, BLOCK_LIST, type BlockParamDef } from './blocks';
import { PALETTES, getPaletteIndex, setPaletteIndex } from './palettes';
import * as patchbay from './patchbay';
import type { ModSourceId, ModSources } from './patchbay';
import * as midiCtl from './midi';
import {
  loadTrackFile,
  loadSampleTrack,
  openMic,
  togglePlay,
  tapTempo,
  type AudioFrame,
} from './audio';
import { store } from '../state/store';

/* ------------------------------------------------------------------ */
/* Performance overrides: macro knobs + XY pad write resolved values   */
/* keyed by `${blockId}:${paramKey}` (0..1 normalized).                */
/* ------------------------------------------------------------------ */

export const perf = {
  overrides: {} as Record<string, number>,
  chaos: 0.25,
};

export function makeResolver(getSources: () => ModSources): ParamResolver {
  return (inst: ChainInstance, def: BlockParamDef, baseNorm: number) => {
    const knobId = `${inst.uid}:${def.key}`;
    const ov = perf.overrides[`${inst.blockId}:${def.key}`];
    const norm = ov !== undefined ? ov : patchbay.effectiveValue(knobId, baseNorm, getSources());
    return def.min + norm * (def.max - def.min);
  };
}

/* ------------------------------------------------------------------ */
/* Knobs                                                               */
/* ------------------------------------------------------------------ */

export interface KnobHandle {
  id: string;
  root: HTMLElement;
  get: () => number;
  set: (v: number) => void;
  onChange: (cb: (v: number) => void) => void;
}

const knobRegistry = new Map<string, KnobHandle>();

export function getKnob(id: string): KnobHandle | undefined {
  return knobRegistry.get(id);
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

let armedPatchSource: ModSourceId | null = null;

export function createKnob(opts: {
  id: string;
  label: string;
  color?: string;
  initial?: number;
  patchable?: boolean;
  midi?: boolean;
  onChange?: (v: number) => void;
}): { root: HTMLElement; handle: KnobHandle } {
  const { id, label, color, initial = 0.5, patchable = true, midi = true, onChange } = opts;
  const root = document.createElement('div');
  root.className = 'wb-knob';
  root.dataset.knob = id;
  root.tabIndex = 0;
  root.setAttribute('role', 'slider');
  root.setAttribute('aria-label', label);
  root.setAttribute('aria-valuemin', '0');
  root.setAttribute('aria-valuemax', '100');
  if (color) root.style.setProperty('--kc', color);

  root.innerHTML = `
    <div class="wb-knob-ring" aria-hidden="true"></div>
    <div class="wb-knob-dial" aria-hidden="true"><div class="wb-knob-pointer"></div></div>
    <div class="wb-knob-label">${label}</div>
    <div class="wb-knob-patchtag" aria-hidden="true"></div>
    ${midi ? '<button class="wb-knob-midi" type="button" title="MIDI learn" aria-label="MIDI learn">M</button>' : ''}
  `;

  const dial = root.querySelector('.wb-knob-dial') as HTMLElement;
  const patchTag = root.querySelector('.wb-knob-patchtag') as HTMLElement;
  const midiBtn = root.querySelector('.wb-knob-midi') as HTMLButtonElement | null;
  const listeners: ((v: number) => void)[] = [];
  let value = clamp01(initial);

  const paint = (): void => {
    dial.style.transform = `rotate(${-135 + value * 270}deg)`;
    root.setAttribute('aria-valuenow', String(Math.round(value * 100)));
  };

  const fire = (): void => {
    paint();
    listeners.forEach(cb => cb(value));
    if (onChange) onChange(value);
  };

  const set = (v: number): void => {
    const nv = clamp01(v);
    if (nv === value) return;
    value = nv;
    fire();
  };

  const refreshPatchTag = (): void => {
    const src = patchbay.getPatch(id);
    if (src) {
      const meta = patchbay.MOD_SOURCES.find(s => s.id === src);
      patchTag.textContent = `← ${meta ? meta.label : src}`;
      patchTag.style.display = 'block';
      root.classList.add('patched');
    } else {
      patchTag.textContent = '';
      patchTag.style.display = 'none';
      root.classList.remove('patched');
    }
  };

  const refreshMidiBtn = (): void => {
    if (!midiBtn) return;
    const binding = midiCtl.getBinding(id);
    midiBtn.classList.toggle('bound', !!binding);
    midiBtn.classList.toggle('armed', midiCtl.getArmedKnob() === id);
    midiBtn.title = binding
      ? `MIDI learn (bound to CC ${binding.cc}) — click to rebind`
      : 'MIDI learn';
  };

  // Drag interaction (vertical).
  let dragging = false;
  let startY = 0;
  let startVal = 0;
  let moved = 0;
  root.addEventListener('pointerdown', e => {
    if ((e.target as HTMLElement).closest('button')) return;
    dragging = true;
    moved = 0;
    startY = e.clientY;
    startVal = value;
    root.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  root.addEventListener('pointermove', e => {
    if (!dragging) return;
    const dy = startY - e.clientY;
    moved = Math.max(moved, Math.abs(dy));
    set(startVal + dy / 160);
  });
  root.addEventListener('pointerup', () => {
    if (!dragging) return;
    dragging = false;
    // Treat as a click when barely moved: patch toggle if a chip is armed.
    if (moved < 5 && patchable && armedPatchSource) {
      const cur = patchbay.getPatch(id);
      patchbay.setPatch(id, cur === armedPatchSource ? null : armedPatchSource);
      refreshPatchTag();
    }
  });
  root.addEventListener('pointercancel', () => {
    dragging = false;
  });

  root.addEventListener('keydown', e => {
    const step = e.shiftKey ? 0.01 : 0.05;
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') {
      set(value + step);
      e.preventDefault();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') {
      set(value - step);
      e.preventDefault();
    } else if (e.key === 'Home') {
      set(0);
      e.preventDefault();
    } else if (e.key === 'End') {
      set(1);
      e.preventDefault();
    }
  });

  if (midiBtn) {
    midiBtn.addEventListener('click', e => {
      e.stopPropagation();
      void midiCtl.ensureMidi().then(() => {
        midiCtl.armKnob(midiCtl.getArmedKnob() === id ? null : id);
      });
    });
  }

  const handle: KnobHandle = {
    id,
    root,
    get: () => value,
    set,
    onChange: cb => {
      listeners.push(cb);
    },
  };
  knobRegistry.set(id, handle);
  midiCtl.registerKnob(id, v => set(v));
  refreshPatchTag();
  refreshMidiBtn();
  paint();

  // expose refreshers for global state changes
  (handle as { _refresh?: () => void })._refresh = () => {
    refreshPatchTag();
    refreshMidiBtn();
  };

  return { root, handle };
}

function refreshAllKnobs(): void {
  knobRegistry.forEach(h => {
    const r = (h as { _refresh?: () => void })._refresh;
    if (r) r();
  });
}

midiCtl.onMidiReady(() => refreshAllKnobs());

/* ------------------------------------------------------------------ */
/* App construction                                                    */
/* ------------------------------------------------------------------ */

export interface UIRefs {
  stage: HTMLCanvasElement;
  tick: (audio: AudioFrame, sources: ModSources) => void;
}

export function buildUI(chain: WobbleChain): UIRefs {
  const app = document.getElementById('wobble-app');
  if (!app) throw new Error('#wobble-app missing');

  app.innerHTML = `
    <header class="wb-topbar">
      <div class="wb-logo"><span class="wb-logo-blob"></span>Wobble</div>
      <nav class="wb-tabs" role="tablist">
        <button class="wb-tab active" data-view="build" role="tab" aria-selected="true">Build</button>
        <button class="wb-tab" data-view="perform" role="tab" aria-selected="false">Perform</button>
      </nav>
      <div class="wb-audiobar">
        <button class="wb-btn" id="wb-upload" type="button">Upload</button>
        <input type="file" id="wb-file" accept="audio/*" hidden />
        <button class="wb-btn" id="wb-sample" type="button">Sample</button>
        <button class="wb-btn" id="wb-mic" type="button">Mic</button>
        <button class="wb-btn wb-play" id="wb-play" type="button" aria-label="Play or pause">▶</button>
        <span class="wb-track" id="wb-track">no track yet</span>
        <span class="wb-bpm" id="wb-bpm">-- BPM</span>
        <button class="wb-btn" id="wb-tap" type="button" title="Tap tempo">TAP</button>
      </div>
    </header>

    <main class="wb-main">
      <section class="wb-view" id="wb-view-build">
        <div class="wb-patchbay">
          <span class="wb-patchbay-label">Patch bay</span>
          <div class="wb-chips" id="wb-chips"></div>
          <span class="wb-patchbay-hint">tap a chip, then tap any knob to make it dance</span>
        </div>
        <div class="wb-chainwrap">
          <div class="wb-chain" id="wb-chain"></div>
        </div>
        <div class="wb-tray" id="wb-tray" hidden>
          <div class="wb-tray-head">
            <span>Add a block</span>
            <button class="wb-btn" id="wb-tray-close" type="button">Done</button>
          </div>
          <div class="wb-tray-groups" id="wb-tray-groups"></div>
        </div>
      </section>

      <section class="wb-view" id="wb-view-perform" hidden>
        <div class="wb-stagewrap" id="wb-stagewrap">
          <canvas id="wb-stage"></canvas>
          <div class="wb-stage-hint" id="wb-stage-hint">press play and pick some audio ↑</div>
          <button class="wb-btn wb-audience-btn" id="wb-audience" type="button">Audience view</button>
          <button class="wb-btn wb-exit-audience" id="wb-exit-audience" type="button" hidden>Exit audience view (Esc)</button>
        </div>
        <div class="wb-deck">
          <div class="wb-macros" id="wb-macros"></div>
          <div class="wb-xypad" id="wb-xypad" role="slider" tabindex="0" aria-label="Expression pad: X spins kaleido, Y drives wobble speed">
            <div class="wb-xypad-dot" id="wb-xypad-dot"></div>
            <span class="wb-xypad-x">spin →</span>
            <span class="wb-xypad-y">↑ wobble</span>
          </div>
          <div class="wb-scenes" id="wb-scenes"></div>
        </div>
      </section>
    </main>

    <footer class="wb-footer">
      Prototype — beat/patch engine is real (Web Audio), visuals are 2D canvas;
      production build would add: mic/line-in polish, WebGL post chain,
      full WebMIDI mapping UI, webcam hand tracking.
    </footer>

    <div class="wb-onboard" id="wb-onboard" hidden>
      <div class="wb-onboard-card">
        <h2>Make your first visual instrument</h2>
        <ol class="wb-onboard-steps" id="wb-onboard-steps"></ol>
        <div class="wb-onboard-actions">
          <button class="wb-btn" id="wb-onboard-skip" type="button">Skip</button>
          <button class="wb-btn wb-btn-primary" id="wb-onboard-next" type="button">Next</button>
        </div>
      </div>
    </div>
  `;

  /* ---- tabs ---- */
  const tabs = Array.from(app.querySelectorAll('.wb-tab')) as HTMLButtonElement[];
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => {
        t.classList.toggle('active', t === tab);
        t.setAttribute('aria-selected', String(t === tab));
      });
      const view = tab.dataset.view;
      (document.getElementById('wb-view-build') as HTMLElement).hidden = view !== 'build';
      (document.getElementById('wb-view-perform') as HTMLElement).hidden = view !== 'perform';
    });
  });

  /* ---- audio bar ---- */
  const trackEl = document.getElementById('wb-track') as HTMLElement;
  const playBtn = document.getElementById('wb-play') as HTMLButtonElement;
  const bpmEl = document.getElementById('wb-bpm') as HTMLElement;
  const fileInput = document.getElementById('wb-file') as HTMLInputElement;

  const setBusy = (busy: boolean, msg: string): void => {
    trackEl.textContent = msg;
    (document.getElementById('wb-upload') as HTMLButtonElement).disabled = busy;
    (document.getElementById('wb-sample') as HTMLButtonElement).disabled = busy;
    (document.getElementById('wb-mic') as HTMLButtonElement).disabled = busy;
  };

  (document.getElementById('wb-upload') as HTMLButtonElement).addEventListener('click', () => {
    fileInput.click();
  });
  fileInput.addEventListener('change', () => {
    const f = fileInput.files?.[0];
    if (!f) return;
    setBusy(true, 'loading…');
    loadTrackFile(f)
      .then(() => {
        trackEl.textContent = f.name;
        setBusy(false, f.name);
        togglePlay();
        syncPlayBtn();
      })
      .catch(() => {
        setBusy(false, 'could not load that file');
      });
    fileInput.value = '';
  });
  (document.getElementById('wb-sample') as HTMLButtonElement).addEventListener('click', () => {
    setBusy(true, 'loading sample…');
    loadSampleTrack()
      .then(() => {
        setBusy(false, 'sample track');
        togglePlay();
        syncPlayBtn();
      })
      .catch(() => {
        setBusy(false, 'sample failed to load');
      });
  });
  (document.getElementById('wb-mic') as HTMLButtonElement).addEventListener('click', () => {
    setBusy(true, 'opening mic…');
    openMic()
      .then(() => {
        setBusy(false, 'live mic — tap TAP to set tempo');
        togglePlay();
        syncPlayBtn();
      })
      .catch(() => {
        setBusy(false, 'mic blocked — check permissions');
      });
  });
  const syncPlayBtn = (): void => {
    const playing = store.state.isPlaying;
    playBtn.textContent = playing ? '⏸' : '▶';
    playBtn.classList.toggle('playing', playing);
    (document.getElementById('wb-stage-hint') as HTMLElement).style.display = playing
      ? 'none'
      : 'block';
  };
  playBtn.addEventListener('click', () => {
    togglePlay();
    syncPlayBtn();
  });
  (document.getElementById('wb-tap') as HTMLButtonElement).addEventListener('click', () => {
    tapTempo();
  });

  /* ---- patch bay chips ---- */
  const chipsEl = document.getElementById('wb-chips') as HTMLElement;
  const chipBtns = new Map<ModSourceId, HTMLButtonElement>();
  for (const src of patchbay.MOD_SOURCES) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'wb-chip';
    b.style.setProperty('--cc', src.color);
    b.innerHTML = `<span class="wb-chip-dot"></span>${src.label}`;
    b.addEventListener('click', () => {
      armedPatchSource = armedPatchSource === src.id ? null : src.id;
      chipBtns.forEach((btn, id) => btn.classList.toggle('armed', id === armedPatchSource));
      app.classList.toggle('patch-arming', armedPatchSource !== null);
    });
    chipsEl.appendChild(b);
    chipBtns.set(src.id, b);
  }

  /* ---- chain view ---- */
  const chainEl = document.getElementById('wb-chain') as HTMLElement;
  const trayEl = document.getElementById('wb-tray') as HTMLElement;
  let trayIndex: number | null = null;

  const knobIdFor = (inst: ChainInstance, key: string): string => `${inst.uid}:${key}`;

  function renderChainView(): void {
    // unregister old knobs
    Array.from(knobRegistry.keys()).forEach(id => {
      if (id.includes(':') && !id.startsWith('macro:')) {
        midiCtl.unregisterKnob(id);
        knobRegistry.delete(id);
      }
    });
    chainEl.innerHTML = '';
    chain.instances.forEach((inst, idx) => {
      const def = BLOCKS[inst.blockId];
      if (!def) return;
      const card = document.createElement('div');
      card.className = 'wb-block' + (inst.enabled ? '' : ' off');
      card.style.setProperty('--blk', def.color);
      card.innerHTML = `
        <div class="wb-block-top">
          <span class="wb-block-dot"></span>
          <span class="wb-block-name">${def.name}</span>
          <div class="wb-block-tools">
            <button type="button" data-act="power" title="Enable / bypass" aria-label="Toggle ${def.name}">⏻</button>
            <button type="button" data-act="left" title="Move left" aria-label="Move ${def.name} left">◀</button>
            <button type="button" data-act="right" title="Move right" aria-label="Move ${def.name} right">▶</button>
            <button type="button" data-act="del" title="Remove" aria-label="Remove ${def.name}">×</button>
          </div>
        </div>
        <div class="wb-block-kind">${def.kind} · ${def.blurb}</div>
        <div class="wb-block-knobs"></div>
      `;
      const tools = card.querySelector('.wb-block-tools') as HTMLElement;
      tools.addEventListener('click', e => {
        const btn = (e.target as HTMLElement).closest('button');
        if (!btn) return;
        const act = btn.dataset.act;
        if (act === 'power') chain.toggle(inst.uid);
        else if (act === 'left') chain.move(inst.uid, -1);
        else if (act === 'right') chain.move(inst.uid, 1);
        else if (act === 'del') chain.remove(inst.uid);
      });
      const knobsEl = card.querySelector('.wb-block-knobs') as HTMLElement;
      for (const pd of def.params) {
        const kid = knobIdFor(inst, pd.key);
        const { root } = createKnob({
          id: kid,
          label: pd.label,
          color: def.color,
          initial: inst.params[pd.key] ?? 0.5,
          onChange: v => chain.setParam(inst.uid, pd.key, v),
        });
        knobsEl.appendChild(root);
      }
      chainEl.appendChild(card);

      if (idx < chain.instances.length - 1) {
        const gap = document.createElement('div');
        gap.className = 'wb-gap';
        gap.innerHTML = `
          <svg class="wb-cable" viewBox="0 0 64 80" aria-hidden="true">
            <path d="M32 4 C 32 30, 10 34, 10 52 S 32 66, 32 76" fill="none" stroke-width="7" stroke-linecap="round"/>
          </svg>
          <button class="wb-insert" type="button" title="Insert block here" aria-label="Insert block">+</button>
        `;
        const cable = gap.querySelector('.wb-cable path') as SVGPathElement;
        cable.setAttribute('stroke', def.color);
        const insertBtn = gap.querySelector('.wb-insert') as HTMLButtonElement;
        insertBtn.addEventListener('click', () => openTray(idx + 1));
        chainEl.appendChild(gap);
      }
    });

    // prune patches for knobs that no longer exist
    const live = new Set<string>(knobRegistry.keys());
    patchbay.prunePatches(live);
  }

  function openTray(index: number): void {
    trayIndex = index;
    trayEl.hidden = false;
  }
  (document.getElementById('wb-tray-close') as HTMLButtonElement).addEventListener('click', () => {
    trayEl.hidden = true;
  });

  // tray groups
  const trayGroups = document.getElementById('wb-tray-groups') as HTMLElement;
  const kinds: { kind: string; label: string }[] = [
    { kind: 'source', label: 'Sources — where the picture starts' },
    { kind: 'transform', label: 'Moves — reshape the picture' },
    { kind: 'fx', label: 'Feels — grade and glow' },
    { kind: 'output', label: 'Outs' },
  ];
  for (const g of kinds) {
    const groupEl = document.createElement('div');
    groupEl.className = 'wb-tray-group';
    groupEl.innerHTML = `<div class="wb-tray-label">${g.label}</div><div class="wb-tray-items"></div>`;
    const itemsEl = groupEl.querySelector('.wb-tray-items') as HTMLElement;
    for (const def of BLOCK_LIST.filter(b => b.kind === g.kind)) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'wb-tray-item';
      item.style.setProperty('--blk', def.color);
      item.innerHTML = `<span class="wb-block-dot"></span><span><b>${def.name}</b><i>${def.blurb}</i></span>`;
      item.addEventListener('click', () => {
        chain.add(def.id, trayIndex ?? undefined);
        trayIndex = null;
        trayEl.hidden = true;
      });
      itemsEl.appendChild(item);
    }
    trayGroups.appendChild(groupEl);
  }

  chain.onChange = () => renderChainView();

  /* ---- perform view: macro knobs ---- */
  const macrosEl = document.getElementById('wb-macros') as HTMLElement;
  const macroDefs: { id: string; label: string; color: string; initial: number; apply: (v: number) => void }[] = [
    {
      id: 'macro:energy',
      label: 'Energy',
      color: '#FF5CA8',
      initial: 0.6,
      apply: v => {
        perf.overrides['blob-field:count'] = v;
        perf.overrides['particle-rain:speed'] = v;
      },
    },
    {
      id: 'macro:wobble',
      label: 'Wobble',
      color: '#4D7CFE',
      initial: 0.35,
      apply: v => {
        perf.overrides['wobble:amount'] = v;
      },
    },
    {
      id: 'macro:glow',
      label: 'Glow',
      color: '#FFC53D',
      initial: 0.5,
      apply: v => {
        perf.overrides['glow:amount'] = v;
      },
    },
    {
      id: 'macro:chaos',
      label: 'Chaos',
      color: '#A06BFF',
      initial: 0.25,
      apply: v => {
        perf.chaos = v;
      },
    },
  ];
  for (const m of macroDefs) {
    const { root } = createKnob({
      id: m.id,
      label: m.label,
      color: m.color,
      initial: m.initial,
      onChange: m.apply,
    });
    root.classList.add('wb-macro');
    macrosEl.appendChild(root);
    m.apply(m.initial);
  }

  /* ---- XY pad ---- */
  const xyEl = document.getElementById('wb-xypad') as HTMLElement;
  const xyDot = document.getElementById('wb-xypad-dot') as HTMLElement;
  const xyState = { x: 0.5, y: 0.5 };
  const paintXY = (): void => {
    xyDot.style.left = `${xyState.x * 100}%`;
    xyDot.style.top = `${(1 - xyState.y) * 100}%`;
    xyEl.setAttribute('aria-valuetext', `spin ${Math.round(xyState.x * 100)}, wobble ${Math.round(xyState.y * 100)}`);
  };
  const applyXY = (): void => {
    perf.overrides['kaleido:spin'] = xyState.x;
    perf.overrides['wobble:speed'] = xyState.y;
    paintXY();
  };
  let xyDrag = false;
  const xyFromEvent = (e: PointerEvent): void => {
    const r = xyEl.getBoundingClientRect();
    xyState.x = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    xyState.y = Math.max(0, Math.min(1, 1 - (e.clientY - r.top) / r.height));
    applyXY();
  };
  xyEl.addEventListener('pointerdown', e => {
    xyDrag = true;
    xyEl.setPointerCapture(e.pointerId);
    xyFromEvent(e);
  });
  xyEl.addEventListener('pointermove', e => {
    if (xyDrag) xyFromEvent(e);
  });
  xyEl.addEventListener('pointerup', () => {
    xyDrag = false;
  });
  xyEl.addEventListener('keydown', e => {
    const step = 0.05;
    if (e.key === 'ArrowRight') xyState.x = Math.min(1, xyState.x + step);
    else if (e.key === 'ArrowLeft') xyState.x = Math.max(0, xyState.x - step);
    else if (e.key === 'ArrowUp') xyState.y = Math.min(1, xyState.y + step);
    else if (e.key === 'ArrowDown') xyState.y = Math.max(0, xyState.y - step);
    else return;
    e.preventDefault();
    applyXY();
  });
  applyXY();

  /* ---- palette scenes ---- */
  const scenesEl = document.getElementById('wb-scenes') as HTMLElement;
  const sceneBtns: HTMLButtonElement[] = [];
  PALETTES.forEach((pal, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'wb-scene';
    b.style.setProperty('--s0', pal.colors[0]);
    b.style.setProperty('--s1', pal.colors[1]);
    b.style.setProperty('--s2', pal.colors[2]);
    b.innerHTML = `<span class="wb-scene-dots"><i></i><i></i><i></i></span>${pal.name}`;
    b.addEventListener('click', () => {
      setPaletteIndex(i);
      sceneBtns.forEach((sb, j) => sb.classList.toggle('active', j === i));
    });
    scenesEl.appendChild(b);
    sceneBtns.push(b);
  });
  sceneBtns[getPaletteIndex()]?.classList.add('active');

  /* ---- audience view ---- */
  const exitAudience = (): void => {
    app.classList.remove('audience');
    (document.getElementById('wb-exit-audience') as HTMLButtonElement).hidden = true;
  };
  (document.getElementById('wb-audience') as HTMLButtonElement).addEventListener('click', () => {
    app.classList.add('audience');
    (document.getElementById('wb-exit-audience') as HTMLButtonElement).hidden = false;
  });
  (document.getElementById('wb-exit-audience') as HTMLButtonElement).addEventListener('click', exitAudience);
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && app.classList.contains('audience')) exitAudience();
  });

  /* ---- onboarding ---- */
  const onboardEl = document.getElementById('wb-onboard') as HTMLElement;
  const stepsEl = document.getElementById('wb-onboard-steps') as HTMLElement;
  const nextBtn = document.getElementById('wb-onboard-next') as HTMLButtonElement;
  const skipBtn = document.getElementById('wb-onboard-skip') as HTMLButtonElement;
  let onboardStep = 0;
  const onboardSteps: { title: string; body: string; presets?: boolean }[] = [
    {
      title: 'Pick a starter chain',
      body: 'Each block is one candy module. Sources make the picture, moves reshape it, feels grade it.',
      presets: true,
    },
    {
      title: 'Press play, add audio',
      body: 'Upload a track, play the built-in sample, or open your mic. Everything reacts live.',
    },
    {
      title: 'Twist knobs, patch the beat',
      body: 'Drag any knob. Or tap a Kick/Bass/Hats chip, then tap a knob — now it dances to the music.',
    },
  ];
  function renderOnboard(): void {
    const s = onboardSteps[onboardStep];
    stepsEl.innerHTML = `
      <li class="active"><b>${s.title}</b><p>${s.body}</p>
      ${
        s.presets
          ? `<div class="wb-onboard-presets">${Object.keys(PRESETS)
              .map(n => `<button type="button" class="wb-btn wb-btn-primary" data-preset="${n}">${n}</button>`)
              .join('')}</div>`
          : ''
      }</li>
      <li class="wb-onboard-progress">step ${onboardStep + 1} of ${onboardSteps.length}</li>
    `;
    nextBtn.textContent = onboardStep === onboardSteps.length - 1 ? "Let's wobble" : 'Next';
    stepsEl.querySelectorAll('[data-preset]').forEach(btn => {
      (btn as HTMLButtonElement).addEventListener('click', () => {
        chain.resetToPreset((btn as HTMLButtonElement).dataset.preset as string);
      });
    });
  }
  function closeOnboard(): void {
    onboardEl.hidden = true;
    try {
      localStorage.setItem('wobble-onboarded', '1');
    } catch {
      // ignore
    }
  }
  nextBtn.addEventListener('click', () => {
    if (onboardStep < onboardSteps.length - 1) {
      onboardStep += 1;
      renderOnboard();
    } else {
      closeOnboard();
    }
  });
  skipBtn.addEventListener('click', closeOnboard);
  let showOnboard = false;
  try {
    showOnboard = !localStorage.getItem('wobble-onboarded');
  } catch {
    showOnboard = true;
  }
  if (showOnboard) {
    renderOnboard();
    onboardEl.hidden = false;
  }

  /* ---- initial chain ---- */
  if (!chain.load()) {
    chain.resetToPreset('Blob Party');
  }
  renderChainView();

  /* ---- per-frame UI tick ---- */
  const stage = document.getElementById('wb-stage') as HTMLCanvasElement;
  let lastBpm = -1;
  const tick = (audio: AudioFrame, sources: ModSources): void => {
    // beat flash on the play button
    playBtn.classList.toggle('beat', audio.beat);
    // patch glow rings follow their source
    const patches = patchbay.getPatches();
    for (const [knobId, src] of Object.entries(patches)) {
      const k = knobRegistry.get(knobId);
      if (k) k.root.style.setProperty('--pv', sources[src].toFixed(3));
    }
    if (audio.bpm !== lastBpm) {
      lastBpm = audio.bpm;
      bpmEl.textContent = audio.bpm > 0 ? `${audio.bpm} BPM` : '-- BPM';
    }
  };

  return { stage, tick };
}
