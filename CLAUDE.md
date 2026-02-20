# Music Visualizer

Real-time audio-reactive visualizer built with TypeScript, p5.js, and Tone.js. Optional Flask backend for AI stem separation (Demucs) and BPM detection (Essentia).

## Commands

- `npm run dev` — start Vite dev server (port 3000, proxies `/api/*` and `/server/*` to `:5001`)
- `npm run build` — `tsc && vite build` (output to `dist/`)
- `npm run lint` / `npm run lint:fix` — ESLint
- `npm run typecheck` — `tsc --noEmit`
- `cd server && python app.py` — start Flask backend on port 5001

## Architecture

### Source layout

```
src/
├── main.ts                    # p5 sketch entry point, render loop, audio pipeline orchestration
├── state/store.ts             # Singleton EventEmitter store (AppState, Config, AudioProcessingState)
├── audio/
│   ├── engine.ts              # Tone.js player management (freq mode: 1 player, stem mode: 5 players + FFTs)
│   ├── fft.ts                 # FFT analysis: log-band amplitudes, octave amplitudes, spectral centroid
│   ├── processing.ts          # Auto-gain normalization, transient detection, delta (rate of change)
│   ├── pipeline.ts            # Decay, octave processing, band smoothing with attack/release
│   └── bpm.ts                 # BPM detection: server-side /api/detect-bpm + client-side fallback
├── visualizations/
│   ├── index.ts               # Barrel exports
│   ├── helpers.ts             # getBandData(), getBandAverages() — shared audio state accessors
│   ├── userImage.ts           # User image state: load/clear/get/has, emits 'imageChange' event
│   ├── circle.ts              # Rotating spike circle (7 bands x 60 spikes), optional center image
│   ├── spectrum.ts            # Horizontal bar chart
│   ├── tunnel.ts              # Octave-based concentric rings with glow, optional center image
│   ├── balls.ts               # Physics-based bouncing balls with kick boost
│   ├── cube.ts                # 3D wireframe cube, beat-synced rotation, optional image on faces
│   └── stickman.ts            # Animated stick figure, beat-synced poses, kick zoom, high-freq color
├── ui/
│   ├── controller.ts          # Top-level UI orchestrator, sidebar toggle, viz selector, randomize
│   ├── splash.ts              # Splash screen: file upload, sample button, mode selector, image upload, play button
│   ├── playback.ts            # Pause/play, scrubber, time display, track switching, image controls, BPM trigger
│   ├── sliders.ts             # Volume, sensitivity (7 freq / 5 stem), display sliders
│   └── keyboard.ts            # Keyboard shortcuts (1-6 viz modes, space, arrows, m/f/s/r/i/?/h/Esc)
├── types/
│   ├── index.ts               # Core interfaces: AppState, Config, VizMode, AudioProcessingState, etc.
│   └── globals.d.ts           # Global type stubs for p5.js and Tone.js (loaded from CDN)
└── utils/
    ├── constants.ts           # Frequency bands, octaves, FFT size, default config, mobile detection
    ├── errors.ts              # Error UI injection, processing overlay
    └── format.ts              # Time formatting
```

### Data flow

1. **Audio input** — User uploads a file or selects sample track. Optionally run stem separation via `/api/separate` (Demucs).
2. **BPM detection** — Server-side Essentia via `/api/detect-bpm`, with client-side onset/autocorrelation fallback.
3. **Playback** — `audioEngine` creates Tone.js Player(s) + FFT node(s). Freq mode: 1 player. Stem mode: 5 parallel players (kick, drums, bass, vocals, other).
4. **Render loop** (`main.ts` `p.draw`) runs at 60fps:
   - Get raw FFT → log-band amplitudes (7 bands) or per-stem amplitudes (5 stems)
   - Apply auto-gain normalization, transient detection, delta computation
   - Smooth with attack/release per band, frame-rate independent via `dt`
   - Store results in `store.audioState` (smoothedBands, transientValues, deltaValues)
   - Beat tracking: `floor(playbackPosition / beatInterval)` to detect beat changes
   - Dispatch to active visualization's draw function
5. **Visualization** — Each viz reads `store.audioState` and `store.config` directly. p5.js handles all 2D/3D rendering to a full-screen canvas.

### State management

`store` is a singleton `StateStore` with three state objects:
- **`state: AppState`** — mode, vizMode, isPlaying, BPM data, balls array
- **`config: Config`** — sensitivities (7 freq + 5 stem), spikeScale, decayRate, rotationSpeed, masterVolume
- **`audioState: AudioProcessingState`** — smoothedBands, transientValues, deltaValues, spectral centroid, octave data

Events: `stateChange`, `audioReady`, `playbackStart`, `playbackStop`, `modeChange`, `vizModeChange`, `bpmDetected`, `imageChange`, `error`.

### Key audio concepts

- **Transient** — Sudden loudness spike relative to running average. `multiplier > 1.0` means a punch/kick was detected. Exponential decay back to 1.0.
- **Delta** — Smoothed rate of change of amplitude. Distinguishes sustained tones from punchy hits.
- **Auto-gain** — Rolling window of peak values to normalize amplitudes to [0, 1] regardless of track loudness.
- **Bands** — 7 frequency bands: Sub (20-60Hz), Bass (60-250Hz), Low-Mid (250-500Hz), Mid (500-2kHz), Upper-Mid (2-4kHz), Presence (4-6kHz), Brilliance (6-20kHz).

### Adding a new visualization

1. Create `src/visualizations/<name>.ts` exporting `draw<Name>(p: P5Instance, dt: number)` and `reset<Name>()`.
2. Add `'<name>'` to the `VizMode` union in `src/types/index.ts`.
3. Export from `src/visualizations/index.ts`.
4. Import + add `case` in `main.ts` draw switch and windowResized handler.
5. Add `<option>` in `index.html` viz-selector dropdown.
6. Add `'<name>'` to type cast in `src/ui/controller.ts` `bindVizSelector`.
7. Add keyboard shortcut in `src/ui/keyboard.ts`.
8. Add any missing p5.js methods to `src/types/globals.d.ts`.

### External libraries

- **p5.js 1.9.0** — CDN-loaded, 2D canvas rendering. Global `p5` constructor, instance passed as `P5Instance`.
- **Tone.js 14.8.49** — CDN-loaded, Web Audio wrapper. `Tone.Player`, `Tone.Gain`, `Tone.FFT`.
- Both have type stubs in `src/types/globals.d.ts` (no `@types` packages).

### Server (optional)

Flask app at `server/app.py` (port 5001):
- `POST /api/separate` — Demucs stem separation → 5 MP3s (kick, drums, bass, vocals, other)
- `POST /api/detect-bpm` — Essentia BPM detection → `{bpm, beatOffset}`
- Static file serving for stems output

Frontend works without the server — stem mode won't be available and BPM detection falls back to client-side.

## Maintenance

Keep both this file and `README.md` up to date. After any change that adds/removes/renames files, adds new visualization modes, changes keyboard shortcuts, changes the data flow, modifies the build pipeline, or alters architectural patterns, update the relevant sections of both documents in the same commit.

## Conventions

- Visualizations use module-scoped state (no classes), following the pattern in `cube.ts`.
- p5.js constants accessed via bracket notation: `p['HSB']`, `p['CLOSE']`.
- HSB color mode set per-viz with `(p as any).colorMode(p['HSB'], 360, 100, 100)`, reset to RGB at end.
- Frame-rate independence: all animations multiply by `dt = deltaTime / 16.667`.
- Beat detection pattern: `Math.floor((playbackPosition - beatOffset) / beatIntervalSec)` compared to last index.
