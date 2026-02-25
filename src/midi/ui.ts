/**
 * MIDI UI — Overlay panel for mapping MIDI CC to visualizer sliders
 */
import type { Config } from '../types';
import {
  initMidi,
  getMidiStatus,
  getMappings,
  startMappingMode,
  cancelMappingMode,
  getActiveMappingKey,
  clearMapping,
  clearAllMappings,
  onMappingsChange,
} from './manager';

interface ControlRow {
  label: string;
  configKey: keyof Config;
}

const FREQ_ROWS: ControlRow[] = [
  { label: 'Sub (20–60 Hz)', configKey: 'sensSub' },
  { label: 'Bass (60–250 Hz)', configKey: 'sensBass' },
  { label: 'Low-Mid (250–500 Hz)', configKey: 'sensLowMid' },
  { label: 'Mid (500 Hz–2 kHz)', configKey: 'sensMid' },
  { label: 'Upper-Mid (2–4 kHz)', configKey: 'sensUpperMid' },
  { label: 'Presence (4–6 kHz)', configKey: 'sensPresence' },
  { label: 'Brilliance (6–20 kHz)', configKey: 'sensBrilliance' },
];

const STEM_ROWS: ControlRow[] = [
  { label: 'Kick', configKey: 'sensKick' },
  { label: 'Drums', configKey: 'sensDrums' },
  { label: 'Bass', configKey: 'sensStemBass' },
  { label: 'Vocals', configKey: 'sensVocals' },
  { label: 'Other', configKey: 'sensOther' },
];

const DISPLAY_ROWS: ControlRow[] = [
  { label: 'Scale', configKey: 'spikeScale' },
  { label: 'Decay Rate', configKey: 'decayRate' },
  { label: 'Rotation Speed', configKey: 'rotationSpeed' },
  { label: 'Intensity', configKey: 'intensity' },
  { label: 'Beat Frequency', configKey: 'beatDivision' },
  { label: 'Volume', configKey: 'masterVolume' },
];

function getMappingLabel(configKey: keyof Config): string {
  const mappings = getMappings();
  const m = mappings[configKey];
  return m ? `Ch${m.channel} CC${m.cc}` : '—';
}

function buildRowHTML(row: ControlRow): string {
  const key = row.configKey;
  return `
    <div class="midi-row" data-key="${key}">
      <span class="midi-row-label">${row.label}</span>
      <span class="midi-row-mapping" id="midi-mapping-${key}">${getMappingLabel(key)}</span>
      <button class="midi-map-btn" data-key="${key}" type="button">Map</button>
      <button class="midi-clear-btn" data-key="${key}" type="button">Clear</button>
    </div>`;
}

function buildSectionHTML(title: string, rows: ControlRow[]): string {
  return `
    <div class="midi-section">
      <h3 class="midi-section-title">${title}</h3>
      ${rows.map(buildRowHTML).join('')}
    </div>`;
}

function injectOverlayHTML(): void {
  if (document.getElementById('midi-overlay')) return;

  const overlay = document.createElement('div');
  overlay.id = 'midi-overlay';
  overlay.className = 'hidden';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'MIDI Mapping');

  overlay.innerHTML = `
    <div class="midi-panel">
      <div class="midi-header">
        <h2>MIDI Mapping</h2>
        <span id="midi-status-badge" class="midi-status-badge"></span>
        <button id="midi-close" type="button" aria-label="Close MIDI mapping panel">&times;</button>
      </div>
      <div id="midi-controls-list">
        ${buildSectionHTML('Freq Sensitivity', FREQ_ROWS)}
        ${buildSectionHTML('Stem Sensitivity', STEM_ROWS)}
        ${buildSectionHTML('Display', DISPLAY_ROWS)}
      </div>
      <div class="midi-footer">
        <button id="midi-clear-all" type="button">Clear All</button>
      </div>
    </div>`;

  document.body.appendChild(overlay);
}

function injectStyles(): void {
  if (document.getElementById('midi-styles')) return;

  const style = document.createElement('style');
  style.id = 'midi-styles';
  style.textContent = `
    #midi-overlay {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.75);
      z-index: 1000;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    #midi-overlay.hidden {
      display: none;
    }
    .midi-panel {
      background: #1a1a2e;
      border: 1px solid #333;
      border-radius: 8px;
      width: min(480px, 95vw);
      max-height: 80vh;
      display: flex;
      flex-direction: column;
      color: #e0e0e0;
      font-family: Inter, sans-serif;
      font-size: 13px;
    }
    .midi-header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 12px 16px;
      border-bottom: 1px solid #333;
      flex-shrink: 0;
    }
    .midi-header h2 {
      margin: 0;
      font-size: 15px;
      font-weight: 600;
      flex: 1;
    }
    .midi-status-badge {
      font-size: 11px;
      padding: 2px 8px;
      border-radius: 10px;
      background: #333;
      color: #aaa;
    }
    .midi-status-badge.connected {
      background: #1a3a1a;
      color: #4caf50;
    }
    .midi-status-badge.no-devices {
      background: #3a2a1a;
      color: #ff9800;
    }
    .midi-status-badge.denied,
    .midi-status-badge.unsupported {
      background: #3a1a1a;
      color: #f44336;
    }
    #midi-close {
      background: none;
      border: none;
      color: #aaa;
      font-size: 20px;
      cursor: pointer;
      padding: 0 4px;
      line-height: 1;
    }
    #midi-close:hover {
      color: #fff;
    }
    #midi-controls-list {
      overflow-y: auto;
      flex: 1;
      padding: 8px 16px;
    }
    .midi-section {
      margin-bottom: 12px;
    }
    .midi-section-title {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: #888;
      margin: 8px 0 4px;
    }
    .midi-row {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 4px 0;
      border-bottom: 1px solid #222;
    }
    .midi-row-label {
      flex: 1;
      color: #ccc;
    }
    .midi-row-mapping {
      font-size: 11px;
      font-family: monospace;
      color: #4fc3f7;
      min-width: 72px;
      text-align: right;
    }
    .midi-row-mapping.unmapped {
      color: #555;
    }
    .midi-map-btn,
    .midi-clear-btn {
      font-size: 11px;
      padding: 2px 8px;
      border-radius: 4px;
      border: 1px solid #444;
      cursor: pointer;
      background: #2a2a3e;
      color: #ccc;
    }
    .midi-map-btn:hover {
      background: #3a3a5e;
      color: #fff;
    }
    .midi-map-btn.listening {
      background: #5c2d00;
      border-color: #ff9800;
      color: #ff9800;
    }
    .midi-clear-btn:hover {
      background: #3a1a1a;
      color: #f44336;
    }
    .midi-footer {
      padding: 10px 16px;
      border-top: 1px solid #333;
      display: flex;
      justify-content: flex-end;
      flex-shrink: 0;
    }
    #midi-clear-all {
      font-size: 12px;
      padding: 4px 12px;
      border-radius: 4px;
      border: 1px solid #555;
      cursor: pointer;
      background: #2a2a2e;
      color: #aaa;
    }
    #midi-clear-all:hover {
      background: #3a1a1a;
      color: #f44336;
      border-color: #f44336;
    }
  `;
  document.head.appendChild(style);
}

function updateStatusBadge(): void {
  const badge = document.getElementById('midi-status-badge');
  if (!badge) return;
  const s = getMidiStatus();
  const labels: Record<string, string> = {
    connected: 'connected',
    'no-devices': 'no devices',
    denied: 'denied',
    unsupported: 'not supported',
  };
  badge.textContent = labels[s] ?? s;
  badge.className = `midi-status-badge ${s}`;
}

function refreshAllMappingDisplays(): void {
  const allRows = [...FREQ_ROWS, ...STEM_ROWS, ...DISPLAY_ROWS];
  for (const row of allRows) {
    const span = document.getElementById(`midi-mapping-${row.configKey}`);
    if (!span) continue;
    const label = getMappingLabel(row.configKey);
    span.textContent = label;
    span.className = label === '—' ? 'midi-row-mapping unmapped' : 'midi-row-mapping';
  }
  updateStatusBadge();
}

function showOverlay(): void {
  const overlay = document.getElementById('midi-overlay');
  overlay?.classList.remove('hidden');
  refreshAllMappingDisplays();
}

function hideOverlay(): void {
  cancelMappingMode();
  // Reset any listening buttons
  document.querySelectorAll<HTMLButtonElement>('.midi-map-btn.listening').forEach(btn => {
    btn.textContent = 'Map';
    btn.disabled = false;
    btn.classList.remove('listening');
  });
  const overlay = document.getElementById('midi-overlay');
  overlay?.classList.add('hidden');
}

function bindOverlayEvents(): void {
  const overlay = document.getElementById('midi-overlay');
  if (!overlay) return;

  // Close button
  document.getElementById('midi-close')?.addEventListener('click', hideOverlay);

  // Click backdrop to close
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) hideOverlay();
  });

  // ESC key
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !overlay.classList.contains('hidden')) {
      hideOverlay();
    }
  });

  // Clear all
  document.getElementById('midi-clear-all')?.addEventListener('click', () => {
    clearAllMappings();
    refreshAllMappingDisplays();
  });

  // Map and Clear buttons (delegated)
  document.getElementById('midi-controls-list')?.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;

    if (target.classList.contains('midi-map-btn')) {
      const key = target.dataset.key as keyof Config;
      if (!key) return;

      // Cancel previous mapping mode if clicking a different key
      const activeKey = getActiveMappingKey();
      if (activeKey && activeKey !== key) {
        cancelMappingMode();
        const prevBtn = document.querySelector<HTMLButtonElement>(`.midi-map-btn[data-key="${activeKey}"]`);
        if (prevBtn) {
          prevBtn.textContent = 'Map';
          prevBtn.disabled = false;
          prevBtn.classList.remove('listening');
        }
      }

      target.textContent = 'Listening…';
      target.classList.add('listening');
      (target as HTMLButtonElement).disabled = true;

      startMappingMode(key).then(() => {
        target.textContent = 'Map';
        target.classList.remove('listening');
        (target as HTMLButtonElement).disabled = false;
        refreshAllMappingDisplays();
      }).catch(() => {
        target.textContent = 'Map';
        target.classList.remove('listening');
        (target as HTMLButtonElement).disabled = false;
      });
    }

    if (target.classList.contains('midi-clear-btn')) {
      const key = target.dataset.key as keyof Config;
      if (!key) return;
      clearMapping(key);
      refreshAllMappingDisplays();
    }
  });
}

export function initMidiUI(): void {
  injectStyles();
  injectOverlayHTML();

  // Bind MIDI button in sidebar
  const midiBtn = document.getElementById('midi-btn');
  midiBtn?.addEventListener('click', showOverlay);

  bindOverlayEvents();

  // Request MIDI access
  initMidi().then(() => {
    updateStatusBadge();
  });

  // Listen for mapping/status changes
  onMappingsChange(() => {
    refreshAllMappingDisplays();
  });
}
