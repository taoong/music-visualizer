/**
 * Admin review — lets the app owner flag visualizations for deletion and
 * leave freeform notes while browsing, instead of having to separately
 * write a list down to hand to Claude Code later. Stored in localStorage
 * (device-local, no backend needed — this is a one-person authoring tool,
 * not user-facing data) and exported as plain text ready to paste.
 */
import type { VizMode } from '../types';
import { VIZ_REGISTRY } from '../visualizations/registry';

const STORAGE_KEY = 'visualizer-admin-review';
const MODE_KEY = 'visualizer-admin-mode';

export interface VizReview {
  staged: boolean;
  note: string;
}

type ReviewMap = Partial<Record<VizMode, VizReview>>;

function loadAll(): ReviewMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as ReviewMap) : {};
  } catch {
    return {};
  }
}

function saveAll(map: ReviewMap): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // Storage disabled/full — review data just won't persist this session.
  }
}

export function isAdminMode(): boolean {
  try {
    return localStorage.getItem(MODE_KEY) === '1';
  } catch {
    return false;
  }
}

export function setAdminMode(on: boolean): void {
  try {
    if (on) localStorage.setItem(MODE_KEY, '1');
    else localStorage.removeItem(MODE_KEY);
  } catch {
    // ignore
  }
}

export function getReview(viz: VizMode): VizReview {
  return loadAll()[viz] ?? { staged: false, note: '' };
}

// A viz with neither a flag nor a note is pruned entirely, so an empty
// textarea you clicked into and out of doesn't leave a phantom entry
// in the export.
function pruneOrSave(all: ReviewMap, viz: VizMode, next: VizReview): void {
  if (!next.staged && !next.note.trim()) {
    delete all[viz];
  } else {
    all[viz] = next;
  }
  saveAll(all);
}

export function setStaged(viz: VizMode, staged: boolean): void {
  const all = loadAll();
  const current = all[viz] ?? { staged: false, note: '' };
  pruneOrSave(all, viz, { ...current, staged });
}

export function setNote(viz: VizMode, note: string): void {
  const all = loadAll();
  const current = all[viz] ?? { staged: false, note: '' };
  pruneOrSave(all, viz, { ...current, note });
}

export function clearAllReviews(): void {
  saveAll({});
}

export function getAllReviews(): Array<{ viz: VizMode; label: string; staged: boolean; note: string }> {
  const all = loadAll();
  return (Object.keys(all) as VizMode[])
    .map(viz => ({ viz, label: VIZ_REGISTRY[viz]?.label ?? viz, ...all[viz]! }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

export function exportReviewText(): string {
  const reviews = getAllReviews();
  const staged = reviews.filter(r => r.staged);
  const noted = reviews.filter(r => r.note.trim());

  const lines: string[] = [];
  lines.push(`STAGED FOR DELETION (${staged.length})`);
  if (staged.length === 0) lines.push('(none)');
  for (const r of staged) lines.push(`- ${r.label} (${r.viz})`);
  lines.push('');
  lines.push(`FEEDBACK / CHANGES (${noted.length})`);
  if (noted.length === 0) lines.push('(none)');
  for (const r of noted) lines.push(`- ${r.label} (${r.viz}): ${r.note.trim()}`);

  return lines.join('\n');
}
