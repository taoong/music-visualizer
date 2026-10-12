/**
 * Post FX / Palette / Layers sidebar controls.
 *
 * The sliders themselves are plain config sliders (bound in sliders.ts, and
 * MIDI-mappable through CONFIG_TO_SLIDER); this module adds the bits around
 * them: presets, name readouts for stepped sliders, the palette swatch, and
 * the layer source picker.
 */
import { store } from '../state/store';
import { PALETTES, getPalette } from '../post/palettes';
import { setLayerSource, loadLayerImage, getLayerSourceKind, type LayerSourceKind } from '../post/layers';
import { setSlider } from './sliders';

const BLEND_NAMES = ['Normal', 'Screen', 'Multiply', 'Overlay', 'Add', 'Difference'];
const ORDER_NAMES = ['Under', 'Over'];

type PresetValues = Record<string, number>;

// Slider id → value. Palette is deliberately not part of presets.
const PRESETS: Record<string, PresetValues> = {
  off:       { 'post-bloom': 0,   'post-bloom-threshold': 0.6,  'post-tonemap': 0,   'post-exposure': 1,    'post-chroma': 0,    'post-grain': 0,    'post-vignette': 0,    'post-trails': 0,    'post-feedback-zoom': 0,   'post-feedback-rotate': 0,    'post-react': 0 },
  subtle:    { 'post-bloom': 0.6, 'post-bloom-threshold': 0.6,  'post-tonemap': 0,   'post-exposure': 1,    'post-chroma': 0.08, 'post-grain': 0.12, 'post-vignette': 0.3,  'post-trails': 0,    'post-feedback-zoom': 0,   'post-feedback-rotate': 0,    'post-react': 0.35 },
  cinematic: { 'post-bloom': 1.0, 'post-bloom-threshold': 0.55, 'post-tonemap': 1,   'post-exposure': 1.25, 'post-chroma': 0.15, 'post-grain': 0.2,  'post-vignette': 0.55, 'post-trails': 0,    'post-feedback-zoom': 0,   'post-feedback-rotate': 0,    'post-react': 0.4 },
  dream:     { 'post-bloom': 1.3, 'post-bloom-threshold': 0.45, 'post-tonemap': 0.6, 'post-exposure': 1.1,  'post-chroma': 0.2,  'post-grain': 0.1,  'post-vignette': 0.4,  'post-trails': 0.9,  'post-feedback-zoom': 0.15, 'post-feedback-rotate': 0,   'post-react': 0.5 },
  tunnel:    { 'post-bloom': 0.9, 'post-bloom-threshold': 0.5,  'post-tonemap': 0.5, 'post-exposure': 1.1,  'post-chroma': 0.25, 'post-grain': 0.1,  'post-vignette': 0.5,  'post-trails': 0.93, 'post-feedback-zoom': 0.6, 'post-feedback-rotate': 0.35, 'post-react': 0.6 },
  vhs:       { 'post-bloom': 0.5, 'post-bloom-threshold': 0.5,  'post-tonemap': 0.3, 'post-exposure': 1.05, 'post-chroma': 0.7,  'post-grain': 0.6,  'post-vignette': 0.65, 'post-trails': 0.55, 'post-feedback-zoom': 0,   'post-feedback-rotate': 0,    'post-react': 0.5 },
};

function setReadout(id: string, text: string): void {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function updateReadouts(): void {
  const c = store.config;
  const pal = getPalette(c.postPalette);
  setReadout('post-palette-readout', `· ${pal.name}`);
  setReadout('layer-blend-readout', `· ${BLEND_NAMES[Math.round(c.layerBlend)] ?? ''}`);
  setReadout('layer-order-readout', `· ${ORDER_NAMES[Math.round(c.layerOrder)] ?? ''}`);

  const swatch = document.getElementById('palette-swatch');
  if (swatch) {
    swatch.style.background = Math.round(c.postPalette) === 0
      ? 'transparent'
      : `linear-gradient(90deg, ${pal.stops.map(s => `rgb(${s.map(v => Math.round(v * 255)).join(',')})`).join(', ')})`;
    swatch.title = pal.name;
  }
}

export function bindPostFXControls(): () => void {
  const cleanupFns: (() => void)[] = [];
  const on = (el: EventTarget | null, ev: string, fn: EventListener) => {
    if (!el) return;
    el.addEventListener(ev, fn);
    cleanupFns.push(() => el.removeEventListener(ev, fn));
  };

  // Keep the palette slider range in sync with the palette list
  const palSlider = document.getElementById('post-palette') as HTMLInputElement | null;
  if (palSlider) palSlider.max = String(PALETTES.length - 1);

  // Readouts follow config (covers sliders, MIDI and presets alike)
  for (const id of ['post-palette', 'layer-blend', 'layer-order']) {
    on(document.getElementById(id), 'input', updateReadouts);
  }
  updateReadouts();

  // Presets
  const presetSelect = document.getElementById('postfx-preset') as HTMLSelectElement | null;
  on(presetSelect, 'change', () => {
    const preset = presetSelect && PRESETS[presetSelect.value];
    if (!preset) return;
    for (const [id, value] of Object.entries(preset)) setSlider(id, value);
  });

  // Layer source
  const sourceSelect = document.getElementById('layer-source') as HTMLSelectElement | null;
  const imageInput = document.getElementById('layer-image-input') as HTMLInputElement | null;
  const syncSourceSelect = () => {
    if (sourceSelect) sourceSelect.value = getLayerSourceKind();
  };

  on(sourceSelect, 'change', () => {
    const next = (sourceSelect?.value ?? 'none') as LayerSourceKind;
    if (next === 'image') {
      // Activate only once an image is actually chosen
      imageInput?.click();
      syncSourceSelect();
      return;
    }
    void setLayerSource(next).then(syncSourceSelect);
  });

  on(imageInput, 'change', () => {
    const file = imageInput?.files?.[0];
    if (!file) return;
    void loadLayerImage(file)
      .then(() => setLayerSource('image'))
      .then(syncSourceSelect)
      .catch(syncSourceSelect)
      .finally(() => { if (imageInput) imageInput.value = ''; });
  });

  return () => cleanupFns.forEach(fn => fn());
}
