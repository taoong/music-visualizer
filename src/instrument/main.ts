/**
 * Wobble — prototype entry point. Initializes audio (file upload / sample /
 * mic, same engine as the main app), builds the instrument UI, and runs the
 * requestAnimationFrame loop: sample audio -> update patch sources ->
 * render the block chain -> blit to the stage.
 */
import { buildUI, makeResolver, perf } from './ui';
import { WobbleChain, ChainRenderer } from './chain';
import { sampleAudioFrame } from './audio';
import { updateSources } from './patchbay';
import { getPalette } from './palettes';
import { store } from '../state/store';

const MAX_RENDER_W = 1280;
const MAX_DPR = 1.5;

function fitStage(stage: HTMLCanvasElement): { w: number; h: number } {
  const dpr = Math.min(MAX_DPR, window.devicePixelRatio || 1);
  const cssW = stage.clientWidth || window.innerWidth;
  const cssH = stage.clientHeight || window.innerHeight;
  let w = Math.round(cssW * dpr);
  let h = Math.round(cssH * dpr);
  if (w > MAX_RENDER_W) {
    const s = MAX_RENDER_W / w;
    w = MAX_RENDER_W;
    h = Math.round(h * s);
  }
  w = Math.max(2, w);
  h = Math.max(2, h);
  if (stage.width !== w || stage.height !== h) {
    stage.width = w;
    stage.height = h;
  }
  return { w, h };
}

function init(): void {
  const chain = new WobbleChain();
  const { stage, tick } = buildUI(chain);
  const renderer = new ChainRenderer();
  const ctx = stage.getContext('2d');
  if (!ctx) return;

  let sources = updateSources(0, sampleAudioFrame(1));
  const resolver = makeResolver(() => sources);

  let last = performance.now();
  const frame = (now: number): void => {
    const dtMs = now - last;
    last = now;
    const dtN = dtMs / 16.667; // normalized to 60fps, like the main app
    const t = now / 1000;

    const audio = sampleAudioFrame(Math.min(4, Math.max(0.1, dtN)));
    sources = updateSources(Math.min(0.1, dtMs / 1000), audio);

    const { w, h } = fitStage(stage);
    renderer.render(ctx, w, h, t, audio, chain, getPalette(), perf.chaos, resolver);

    tick(audio, sources);
    requestAnimationFrame(frame);
  };

  window.addEventListener('resize', () => {
    // fitStage re-runs every frame; nothing else needed
  });
  window.addEventListener('beforeunload', () => {
    // keep the main app's store out of the way for the next visit
    if (store.state.isPlaying) store.setPlaying(false);
  });

  requestAnimationFrame(frame);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
