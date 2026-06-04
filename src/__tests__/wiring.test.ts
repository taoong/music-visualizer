/**
 * Wiring integrity tests — catch the class of bugs where VizMode, index.html
 * dropdown options, and registry keys fall out of sync.
 *
 * These tests caught real regressions: a bad merge once silently dropped 9
 * dropdown options while the registry and types stayed correct.
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
  // Grab the viz-selector block — stops at the closing </select>
  const selectMatch = html.match(/id="viz-selector"[^>]*>([\s\S]*?)<\/select>/);
  if (!selectMatch) throw new Error('viz-selector not found in index.html');
  return [...selectMatch[1].matchAll(/<option value="([^"]+)"/g)].map(m => m[1]);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Visualization wiring', () => {
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
