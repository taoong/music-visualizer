/**
 * Wiring integrity tests — catch the class of bugs where VizMode, index.html
 * dropdown options, controls-group divs, and registry keys fall out of sync.
 *
 * These tests caught real regressions: a bad merge once silently dropped 9
 * dropdown options AND 9 controls-group divs while the registry/types stayed
 * correct.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, '../..');

// ── Helpers ──────────────────────────────────────────────────────────────────

function readFile(rel: string): string {
  return readFileSync(resolve(ROOT, rel), 'utf-8');
}

/** Extract VizMode string literals from types/index.ts. */
function getVizModes(): string[] {
  const src = readFile('src/types/index.ts');
  const match = src.match(/export type VizMode\s*=\s*([^;]+);/s);
  if (!match) throw new Error('VizMode union not found in src/types/index.ts');
  return [...match[1].matchAll(/'([^']+)'/g)].map(m => m[1]);
}

/** Extract option values from the viz-selector in index.html. */
function getDropdownOptions(): string[] {
  const html = readFile('index.html');
  const selectMatch = html.match(/id="viz-selector"[^>]*>([\s\S]*?)<\/select>/);
  if (!selectMatch) throw new Error('viz-selector not found in index.html');
  return [...selectMatch[1].matchAll(/<option value="([^"]+)"/g)].map(m => m[1]);
}

/**
 * Extract every '*-controls-group' ID that appears inside the VIZ_CONTROLS
 * record in controller.ts. These are the groups the UI will try to show/hide
 * and must therefore have a matching div in index.html.
 */
function getControlGroupsFromController(): string[] {
  const src = readFile('src/ui/controller.ts');
  // Find the VIZ_CONTROLS block and collect every string ending in -controls-group
  const vizControlsMatch = src.match(/const VIZ_CONTROLS[^=]*=\s*\{([\s\S]*?)\n\};/);
  if (!vizControlsMatch) throw new Error('VIZ_CONTROLS not found in src/ui/controller.ts');
  const ids = [...vizControlsMatch[1].matchAll(/'([^']*-controls-group)'/g)].map(m => m[1]);
  return [...new Set(ids)]; // deduplicate
}

/** Extract all div IDs ending in -controls-group from index.html. */
function getControlGroupDivsInHtml(): string[] {
  const html = readFile('index.html');
  return [...html.matchAll(/id="([^"]*-controls-group)"/g)].map(m => m[1]);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Visualization wiring — dropdown ↔ VizMode', () => {
  const modes = getVizModes();
  const options = getDropdownOptions();

  it('VizMode union is non-empty', () => {
    expect(modes.length).toBeGreaterThan(0);
  });

  it('every VizMode has a <option> in the index.html dropdown', () => {
    const missing = modes.filter(m => !options.includes(m));
    expect(missing, `Missing dropdown options: ${missing.join(', ')}`).toHaveLength(0);
  });

  it('every dropdown <option> corresponds to a VizMode', () => {
    const extra = options.filter(o => !modes.includes(o));
    expect(extra, `Orphaned dropdown options (not in VizMode): ${extra.join(', ')}`).toHaveLength(0);
  });

  it('VizMode count matches dropdown option count', () => {
    expect(options.length).toBe(modes.length);
  });
});

describe('Visualization wiring — controls-groups', () => {
  const referencedGroups = getControlGroupsFromController();
  const htmlGroups = getControlGroupDivsInHtml();

  it('VIZ_CONTROLS references at least one controls-group', () => {
    expect(referencedGroups.length).toBeGreaterThan(0);
  });

  it('every controls-group referenced in VIZ_CONTROLS exists as a div in index.html', () => {
    const missing = referencedGroups.filter(id => !htmlGroups.includes(id));
    expect(
      missing,
      `Controls-groups in VIZ_CONTROLS but missing from index.html: ${missing.join(', ')}`
    ).toHaveLength(0);
  });

  it('every controls-group div in index.html is referenced in VIZ_CONTROLS', () => {
    const orphaned = htmlGroups.filter(id => !referencedGroups.includes(id));
    expect(
      orphaned,
      `Controls-group divs in index.html not referenced in VIZ_CONTROLS: ${orphaned.join(', ')}`
    ).toHaveLength(0);
  });
});
