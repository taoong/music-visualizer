/**
 * Admin review mode — UI wiring. See src/state/adminReview.ts for storage.
 */
import { store } from '../state/store';
import type { VizMode } from '../types';
import { VIZ_REGISTRY } from '../visualizations/registry';
import {
  isAdminMode,
  setAdminMode,
  getReview,
  setStaged,
  setNote,
  clearAllReviews,
  exportReviewText,
} from '../state/adminReview';

export function bindAdminMode(): () => void {
  const modeBtn = document.getElementById('admin-mode-btn');
  const exitBtn = document.getElementById('admin-exit-btn');
  const bar = document.getElementById('admin-bar');
  const vizLabel = document.getElementById('admin-viz-label');
  const stageBtn = document.getElementById('admin-stage-btn');
  const note = document.getElementById('admin-note') as HTMLTextAreaElement | null;
  const noteToggle = document.getElementById('admin-note-toggle');
  const reviewBtn = document.getElementById('admin-review-btn');
  const modal = document.getElementById('admin-review-modal');
  const reviewText = document.getElementById('admin-review-text');
  const copyBtn = document.getElementById('admin-copy-btn');
  const clearBtn = document.getElementById('admin-clear-btn');
  const closeBtn = document.getElementById('admin-review-close-btn');

  if (!modeBtn || !bar || !vizLabel || !stageBtn || !note || !noteToggle || !reviewBtn || !modal || !reviewText) {
    return () => {};
  }

  const currentViz = (): VizMode => store.state.vizMode;

  // The note field is collapsed by default — admin mode's whole point here
  // is to stay out of the way of the visualization itself — but auto-opens
  // when the viz already has a note, so existing feedback isn't hidden
  // behind an extra tap. Still independently toggleable either way.
  const setNoteExpanded = (expanded: boolean): void => {
    note.classList.toggle('hidden', !expanded);
    noteToggle.setAttribute('aria-expanded', String(expanded));
  };

  const refreshForCurrentViz = (): void => {
    const viz = currentViz();
    vizLabel.textContent = VIZ_REGISTRY[viz]?.label ?? viz;
    const review = getReview(viz);
    stageBtn.setAttribute('aria-pressed', String(review.staged));
    stageBtn.classList.toggle('active', review.staged);
    stageBtn.textContent = review.staged ? '✓ Staged' : '🗑 Stage';
    // Always overwrite — every keystroke already persists via the input
    // handler below, so there's no unsaved text to lose, and the viz can
    // only change via a separate action (swipe, dropdown, arrow keys —
    // which keyboard.ts already ignores while a text field has focus) that
    // can't happen mid-keystroke. Leaving the previous viz's note on
    // screen after switching would be actively misleading.
    note.value = review.note;
    setNoteExpanded(review.note.trim().length > 0);
  };

  const applyModeVisibility = (on: boolean): void => {
    bar.classList.toggle('hidden', !on);
    modeBtn.textContent = on ? 'Admin Mode: ON' : 'Admin Mode';
    modeBtn.setAttribute('aria-pressed', String(on));
    if (on) refreshForCurrentViz();
  };

  applyModeVisibility(isAdminMode());

  const modeHandler = () => {
    const next = !isAdminMode();
    setAdminMode(next);
    applyModeVisibility(next);
  };
  modeBtn.addEventListener('click', modeHandler);
  exitBtn?.addEventListener('click', () => {
    setAdminMode(false);
    applyModeVisibility(false);
  });

  const vizChangeHandler = () => {
    if (isAdminMode()) refreshForCurrentViz();
  };
  const unsubVizChange = store.on('vizModeChange', vizChangeHandler);

  const stageHandler = () => {
    const viz = currentViz();
    const review = getReview(viz);
    setStaged(viz, !review.staged);
    refreshForCurrentViz();
  };
  stageBtn.addEventListener('click', stageHandler);

  const noteHandler = () => {
    setNote(currentViz(), note.value);
  };
  note.addEventListener('input', noteHandler);

  const noteToggleHandler = () => {
    setNoteExpanded(note.classList.contains('hidden'));
    if (!note.classList.contains('hidden')) note.focus();
  };
  noteToggle.addEventListener('click', noteToggleHandler);

  const openReview = () => {
    reviewText.textContent = exportReviewText();
    modal.classList.remove('hidden');
  };
  const closeReview = () => modal.classList.add('hidden');
  reviewBtn.addEventListener('click', openReview);
  closeBtn?.addEventListener('click', closeReview);
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeReview();
  });

  let copyResetTimer: number | undefined;
  const copyHandler = async () => {
    const text = exportReviewText();
    try {
      await navigator.clipboard.writeText(text);
      if (copyBtn) {
        copyBtn.textContent = 'Copied!';
        window.clearTimeout(copyResetTimer);
        copyResetTimer = window.setTimeout(() => {
          if (copyBtn) copyBtn.textContent = 'Copy to Clipboard';
        }, 1500);
      }
    } catch {
      // Clipboard API unavailable/denied — the text is still visible in the
      // <pre> for manual selection, so this isn't a dead end.
    }
  };
  copyBtn?.addEventListener('click', copyHandler);

  const clearHandler = () => {
    if (!window.confirm('Clear all staged visualizations and notes? This cannot be undone.')) return;
    clearAllReviews();
    reviewText.textContent = exportReviewText();
    refreshForCurrentViz();
  };
  clearBtn?.addEventListener('click', clearHandler);

  return () => {
    modeBtn.removeEventListener('click', modeHandler);
    stageBtn.removeEventListener('click', stageHandler);
    note.removeEventListener('input', noteHandler);
    noteToggle.removeEventListener('click', noteToggleHandler);
    reviewBtn.removeEventListener('click', openReview);
    copyBtn?.removeEventListener('click', copyHandler);
    clearBtn?.removeEventListener('click', clearHandler);
    unsubVizChange();
    window.clearTimeout(copyResetTimer);
  };
}
