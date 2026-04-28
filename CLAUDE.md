# Music Visualizer

Real-time audio-reactive visualizer built with TypeScript, p5.js, and Tone.js. Supports file upload, sample track, and live microphone input. Optional Flask backend for AI stem separation (Demucs) and BPM detection (Essentia).

## Commands

- `npm run dev` — start Vite dev server (port 3000, proxies `/api/*` and `/server/*` to `:5001`)
- `npm run build` — `tsc && vite build` (output to `dist/`)
- `npm run lint` / `npm run lint:fix` — ESLint
- `npm run test` — run Vitest tests
- `npm run test:watch` — run Vitest in watch mode
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
├── __tests__/
│   ├── setup.ts               # Global test setup: browser global stubs for Node environment
│   ├── mocks/
│   │   ├── p5.ts              # Mock factories: createMockContext, createMockP5Image, createMockP5
│   │   └── store.ts           # Mock factory: createMockStoreState
│   └── helpers/
│       └── callOrder.ts       # expectCallSequence — verifies mock call ordering
├── visualizations/
│   ├── index.ts               # Barrel exports
│   ├── helpers.ts             # getBandData(), getBandAverages() — shared audio state accessors
│   ├── userImage.ts           # User image state: load/clear/get/has, emits 'imageChange' event
│   ├── circle.ts              # Rotating spike circle (7 bands x 60 spikes), optional center image
│   ├── spectrum.ts            # Horizontal bar chart
│   ├── tunnel.ts              # Octave-based concentric rings with glow, optional center image
│   ├── balls.ts               # Physics-based bouncing balls with kick boost
│   ├── text.ts                # Beat-synced text patterns (7 modes: zoom, diagonal, quad-mirror, crown, echo, reflect, kaleidoscope)
│   ├── space.ts               # Third-person spaceship + asteroid field; asteroids spawn on beat, ship swerves to dodge, ~every 8 beats ship mis-swerves and gets hit
│   ├── runners.ts             # Infinite side-scrolling marathon runners at 3 depth layers; beat → instant 7× speed burst 180 ms
│   ├── imagegrid.ts           # 16×16 mosaic of 3D tiles viewed top-down; tile height driven by column's freq band; beat → radiating height-wave; image upload → tile tops show image regions
│   ├── colormap.ts            # Pixel-level audio-reactive color modulation; user image (or rainbow gradient) hue-mapped to 7 freq bands; band amplitude boosts saturation/brightness of matching pixels
│   ├── sculpture.ts           # 8 flat panels in a circle showing image strips; beat-synced camera orbit; audio-reactive tilt/glow/spacing; Three.js WebGL overlay
│   ├── binary.ts              # Matrix-style cascading binary/ASCII characters; columns mapped to 7 freq bands; beat-synced wave ripple; green-tinted with transient white flash
│   ├── tungtung.ts            # Dancer: beat-synced dancing alien; pose interpolation; spotlight stage; disco floor; beat particles; configurable text flash (default "Move those feet!")
│   ├── aurora.ts              # Neon Ring Tunnel: first-person flight through 36 neon polygon rings mapped to 7 freq bands (teal→magenta); beat zoom-punch/shake/shockwaves/flash; Perlin camera drift; hyperspace particles; centroid-shifted palette
│   ├── bootsandcats.ts        # Boots & Cats: falling emoji visualization; 👢 on kick transients (sub/bass), 🐱 on snare (low-mid/mid), ➕ on hihats (upper-mid+); gravity, bounce, fade-out; max 50 active
│   ├── rippletank.ts          # Ripple Tank: 7 point-sources in a ring emit circular waves per freq band; wave superposition creates interference patterns; beats spawn expanding shockwave rings; beat surge speeds up water on hits; offscreen pixel buffer at 1/4 res (1/6 mobile) with precomputed distance tables; sliders: Beat Frequency, Water Speed, Beat Surge
│   ├── cymatics.ts            # Cymatics: Chladni plate simulation; ~3000 particles (1500 mobile) drift toward nodal lines of 7 standing wave modes driven by freq bands; beat-triggered scatter/reform; HSB coloring by dominant band
│   ├── cloudchamber.ts        # Cloud Chamber: particle physics simulation; 7 particle types (alpha/proton/muon/electron/positron/pion/gamma) mapped to freq bands; Lorentz force magnetic field curving; beat cosmic ray showers; pion decay kinks; gamma pair production; max 200 particles
│   ├── attractor.ts           # Strange Attractor: Lorenz attractor chaos theory simulation; particles trace 3D butterfly-shaped paths; freq bands spawn colored groups; amplitude warps sigma/rho; beats jolt parameters; 3D→2D projection with orbiting camera; sliders: Chaos, Trail Length
│   ├── mandala.ts             # Mandala: 5 concentric rotating shapes (grid, hexagon, square, triangle, circle) from largest to smallest; each shape has independent rotation speed slider; beat hits temporarily spike all rotation speeds; HSB colors driven by freq band amplitudes; glow layers on shapes; sliders: Beat Frequency, Grid/Hex/Square/Triangle/Circle Speed
│   ├── stringart.ts           # String Art: mathematical "times table" / cardioid visualization; N pins evenly around a circle connected by lines from pin i to pin round(i*M)%N; 7 colored layers (one per freq band) each with a slightly offset multiplier; fractional M morphs continuously between geometric shapes (cardioid, trefoil, etc.); bass amplitude nudges multiplier; beats shift hue palette; 3-pass glow (outer/mid/core); sliders: Pins (20–200), Multiplier (2–20), Drift Speed
│   ├── constellation.ts       # Constellation: drifting star particles forming network connections; stars mapped to freq bands by screen position; beats push stars outward; connection lines glow with audio energy; sliders: Star Count, Connection Range, Drift Speed
│   ├── petals.ts              # Petal Bloom: 7 concentric rings of bezier-curve flower petals (one per freq band); each ring rotates independently (alternating CW/CCW, audio-driven speed); amplitude blooms petal size and brightness; beat pulse bursts all rings outward; HSB palette slowly drifts; sliders: Petal Count, Bloom Scale, Spin Speed
│   ├── waterfall.ts           # Waterfall: 3D scrolling spectrogram; ring buffer of recent spectrum snapshots rendered as stacked ribbons in oblique projection (newest in front, older receding up-and-back with perspective scaling + atmospheric haze); amplitude = ribbon height, plasma palette colors each bin via a horizontal canvas gradient; beat flash glazes the scene; sliders: Scroll Speed, Brightness, Palette Hue
│   ├── kaleido.ts             # Kaleidoscope: audio spectrum mapped to a continuous closed curve in polar coordinates with N-fold mirror symmetry; radius at each angle interpolated from 7 freq bands; N rainbow-tinted wedge fills + 3-layer glow outline; organic phase-harmonic smear breaks perfect symmetry; beat jumps hue + flashes; trail effect creates layered mandala patterns; sliders: Segments (2–12), Trail, Organic
│   ├── kaleidoscope.ts        # Kaleidoscope: 7 oscillating polar curves (one per freq band) drawn in a source wedge and mirrored 2×N times around the canvas; each curve oscillates at integer frequency (b+1) so it closes seamlessly at the outer edge; beat snaps hue palette and widens oscillations; HSB colors per band drift over time; central glow; sliders: Segments (3–12), Complexity (1–4 layers), Spin Speed
│   ├── ribbons.ts             # Ribbons: horizontal sinusoidal wave ribbons stacked across the screen; each ribbon interpolates across 7 freq bands with golden-ratio phase offsets for organic non-repeating patterns; 3-layer glow (outer/mid/core) via ADD blendMode; beat pulse bursts wave amplitude; hue slowly drifts over time; sliders: Count (2–12 ribbons), Wave Speed, Bend (wave cycles)
│   ├── liquify.ts             # Liquify: feedback-warp image distortion; user image (or rainbow gradient) continuously melts through 7 wandering swirl centers (one per freq band) that rotate pixels around themselves; bass radial breath, treble jitter, beats trigger random-origin shockwaves + small hue shift; ping-pong canvas buffers at 320×180 (192×108 mobile) bilinear-resampled per pixel with manual alpha blend back to source; sliders: Flow, Persistence, Beat Surge
│   ├── paint.ts               # Paint: abstract expressionist brushstrokes; 7 painters (one per freq band) wander the canvas driven by Perlin noise + audio amplitude; each leaves coloured stroke trails in an off-screen p5.Graphics buffer; semi-transparent overlay fades older strokes at a configurable rate; beat pulses scatter all painters outward from centre; sliders: Stroke Width, Fade, Speed
│   └── __tests__/             # Visualization tests (image drawing, userImage lifecycle)
├── midi/
│   ├── manager.ts             # Web MIDI API access, CC listener, mapping storage (localStorage), startMappingMode
│   └── ui.ts                  # MIDI overlay panel: Map/Clear buttons per slider, status badge, ESC close
├── ui/
│   ├── controller.ts          # Top-level UI orchestrator, sidebar toggle, viz selector, randomize, MIDI init
│   ├── splash.ts              # Splash screen: file upload, sample button, mic button, mode selector, image upload, play button
│   ├── playback.ts            # Pause/play, scrubber, time display, track switching, image controls, BPM trigger
│   ├── bpm.ts                 # BPM controls: number input (auto-populated), TAP tempo, BEAT phase sync
│   ├── sliders.ts             # Volume, sensitivity (7 freq / 5 stem), display sliders
│   └── keyboard.ts            # Keyboard shortcuts (0-9 viz modes, n/p/g/w/c/b/u/j/'/letter shortcuts, space, arrows, m/f/s/r/i/?/h/Esc)
├── types/
│   ├── index.ts               # Core interfaces: AppState, Config, VizMode, WormholeEvent, ActiveObject, AudioProcessingState, MidiMapping, etc.
│   └── globals.d.ts           # Global type stubs for p5.js and Tone.js (loaded from CDN)
└── utils/
    ├── constants.ts           # Frequency bands, octaves, FFT size, default config, mobile detection
    ├── errors.ts              # Error UI injection, processing overlay
    └── format.ts              # Time formatting
```

### Data flow

1. **Audio input** — User uploads a file, selects sample track, or uses microphone for live input (via `Tone.UserMedia`). Optionally run stem separation via `/api/separate` (Demucs).
2. **BPM detection** — Server-side Essentia via `/api/detect-bpm`, with client-side onset/autocorrelation fallback.
3. **Space reset** — On `audioReady`, `resetSpace()` clears asteroid/beat state for the new track. Asteroids are spawned purely on detected beats at runtime (no pre-computation).
4. **Playback** — `audioEngine` creates Tone.js Player(s) + FFT node(s). Freq mode: 1 player. Stem mode: 5 parallel players (kick, drums, bass, vocals, other).
5. **Render loop** (`main.ts` `p.draw`) runs at 60fps:
   - Get raw FFT → log-band amplitudes (7 bands) or per-stem amplitudes (5 stems)
   - Apply auto-gain normalization, transient detection, delta computation
   - Smooth with attack/release per band, frame-rate independent via `dt`
   - Store results in `store.audioState` (smoothedBands, transientValues, deltaValues)
   - Beat tracking: `floor(playbackPosition / beatInterval)` to detect beat changes
   - Dispatch to active visualization's draw function
5. **Visualization** — Each viz reads `store.audioState` and `store.config` directly. p5.js handles all 2D/3D rendering to a full-screen canvas.

### State management

`store` is a singleton `StateStore` with three state objects:
- **`state: AppState`** — mode (`freq`/`stems`/`mic`), vizMode, isPlaying, BPM data
- **`config: Config`** — sensitivities (7 freq + 5 stem), spikeScale, decayRate, rotationSpeed, masterVolume
- **`audioState: AudioProcessingState`** — smoothedBands, transientValues, deltaValues, spectral centroid, octave data

Events: `stateChange`, `audioReady`, `playbackStart`, `playbackStop`, `modeChange`, `vizModeChange`, `bpmDetected`, `imageChange`, `error`.

### Key audio concepts

- **Transient** — Sudden loudness spike relative to running average. `multiplier > 1.0` means a punch/kick was detected. Exponential decay back to 1.0.
- **Delta** — Smoothed rate of change of amplitude. Distinguishes sustained tones from punchy hits.
- **Auto-gain** — Rolling window of peak values to normalize amplitudes to [0, 1] regardless of track loudness.
- **Bands** — 7 frequency bands: Sub (20-60Hz), Bass (60-250Hz), Low-Mid (250-500Hz), Mid (500-2kHz), Upper-Mid (2-4kHz), Presence (4-6kHz), Brilliance (6-20kHz).

### MIDI mapping

`src/midi/manager.ts` owns all Web MIDI state (module-scoped, no classes):
- `initMidi()` — calls `navigator.requestMIDIAccess()`, attaches `onmidimessage` to all inputs, re-attaches on `onstatechange` (device plug/unplug), loads saved mappings from localStorage.
- CC messages (`0xB0`): if `startMappingMode(configKey)` is active, the next CC resolves the promise and saves the mapping; otherwise the CC value is mapped `0–127 → [slider.min, slider.max]` and dispatched as an `input` event on the slider DOM element.
- Mappings persisted under `localStorage` key `visualizer-midi-mappings`.
- `CONFIG_TO_SLIDER` table maps every `keyof Config` to its slider DOM id (20 entries).

`src/midi/ui.ts` renders the overlay panel and is initialized by `initUI()` in `controller.ts`. The overlay is injected into `<body>` on first call (not present in static HTML). Styles are injected as a `<style>` tag.

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

- Visualizations use module-scoped state (no classes), following the pattern in `circle.ts`.
- p5.js constants accessed via bracket notation: `p['HSB']`, `p['CLOSE']`.
- HSB color mode set per-viz with `(p as any).colorMode(p['HSB'], 360, 100, 100)`, reset to RGB at end.
- Frame-rate independence: all animations multiply by `dt = deltaTime / 16.667`.
- Beat detection pattern: `Math.floor((playbackPosition - beatOffset) / beatIntervalSec)` compared to last index.
