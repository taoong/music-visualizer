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
│   ├── bootsandcats.ts        # Boots & Cats: falling emoji visualization; 🥞 on kick transients (sub/bass), 🐱 on snare (low-mid/mid), ➕ on hihats (upper-mid+); gravity, bounce, fade-out; max 50 active
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
│   ├── weave.ts               # Weave: audio-reactive tapestry; N horizontal warp threads + N vertical weft threads cross the canvas in a grid; each thread mapped to a freq band (weft offset by ½ BAND_COUNT for hue contrast); threads vibrate sinusoidally (amplitude scales with band energy); 3-pass glow per thread; intersection nodes light up proportional to product of both crossing bands' amplitudes — only bright where both are simultaneously active; beat fires an expanding radial shockwave ring from canvas centre; hue shifts on each beat; sliders: Threads (4–32 per axis), Glow (stroke/halo size), Pulse (shockwave intensity)
│   ├── synthwave.ts           # Synthwave: retro 80s perspective grid; cyan horizontal lines scroll toward viewer via t² perspective bunching; magenta vertical fan lines converge to vanishing point; striped glowing sun (yellow→pink) sits on horizon; 7 freq bands drive audio-reactive mountain silhouette heights; beats pulse sun + flash screen pink; ADD blendMode neon glow on all elements; sliders: Speed (scroll rate), Horizon (horizon height 0.2–0.65), Glow (neon intensity)
│   ├── bloom.ts               # Bloom: generative neon branching growth; tips radiate from canvas centre, steered by Perlin noise; sub-bass spawns thick warm-red roots that fork hierarchically up through orange→yellow→green→teal→blue→violet at finest tips (one hue per freq band); 3-pass glow (outer/mid/core) rendered to offscreen buffer with configurable fade rate; beats trigger root burst; amplitude drives continuous forking; sliders: Density (fork rate), Lifespan (trail persistence), Spread (branch deviation angle)
│   ├── monolith.ts            # Monolith: tall faceted crystal obelisk (stretched icosahedron, 80 facets grouped into 7 freq bands) sits at world origin; camera is the protagonist with choreographed beat-driven moves — continuous orbit baseline, crash-zoom punch on every beat, Hitchcock dolly-zoom every 16 beats, sustained-bass pull-back, occasional snap-cuts, top-down/worm's-eye phases every 32 beats, barrel rolls on hi-hat transients, frame-rate-independent decay; Three.js WebGL overlay with UnrealBloomPass
│   ├── hive.ts                # Hive: full-canvas flat-top hexagonal honeycomb grid; 7 concentric radial zones each mapped to one freq band (sub-bass at centre → brilliance at edge); hex brightness driven by band amplitude; beat-triggered expanding ripple ring sweeps outward and nudges global hue palette; bloom glow ellipses behind each active hex; sliders: Hex Size (grid density), Glow (bloom intensity), Ripple (beat ripple strength)
│   ├── marbling.ts            # Marbling: full-screen psychedelic plasma/marble-paper colour field; 3 base sinusoidal waves + 7 audio-reactive band waves superpose into a continuous value field; value → HSV hue → pixel colour via offscreen pixel buffer at ¼ res (⅛ mobile); beat triggers hue-phase jump and brightness flash; sliders: Hue Shift (palette rotation 0–1), Zoom (pattern density 0–1), Speed (animation rate 0–1)
│   ├── flowfield.ts           # Flow Field: Perlin-noise vector field guiding colored brushstroke ribbons (inspired by Tyler Hobbs' "Fidenza" 2021); 7 bands mapped to distinct hues (violet→blue→teal→green→yellow→orange→magenta); amplitude drives ribbon speed, stroke weight, and brightness; sub-bass bends field spatially; beats burst fresh ribbons from canvas edges; 3-pass ADD glow per ribbon; offscreen trail buffer; sliders: Turbulence (laminar→chaotic), Trail (fade rate), Width (stroke weight)
│   ├── lissajous.ts           # Lissajous: 7 oscilloscope-style parametric curves (one per freq band) using coprime integer ratios 1:1→5:6 (ellipse, figure-8, three-lobe, etc.); inspired by Jerobeam Fenderson's oscilloscope music (creativeapplications.net); amplitude drives curve size; phases drift at configurable speed, snap on beats; 3-pass phosphor glow (green→cyan→blue→violet→magenta→amber palette); offscreen trail buffer; sliders: Curves (1–7 visible), Glow (phosphor brightness), Drift (phase speed)
│   ├── truchet.ts             # Truchet Tile Maze: audio-reactive Truchet quarter-circle arc grid inspired by Manolo Gamboa Naon (Manoloide) "88 Allegories" series; 7 freq bands drive color zones (column bands) and tile orientation morph speed (violet→cyan→teal→lime→gold→orange→magenta palette); beat triggers mass orientation shuffle + hue palette jump; brilliance drives continuous sparkle perturbations; 2-pass glow (wide outer halo + bright core); sub-bass boosts stroke weight; sliders: Grid (tile density 0=large→1=small), Speed (morph rate), Glow (arc weight/halo)
│   ├── topography.ts          # Topography: full-canvas audio-reactive topographic contour map inspired by Tyler Hobbs' "Meridian" series (2022); 7 freq bands drive elevation of horizontal stripes (sub-bass=left → brilliance=right) via Gaussian weighting; Perlin noise base terrain drifts over time; marching squares extracts iso-contour lines at 3–15 elevation levels; each level hue-mapped to nearest freq band (blue=sub → red=brilliance); 2-pass neon glow (wide halo + bright core); beat radiates circular elevation surge from canvas centre; sliders: Resolution (grid density 10–60), Levels (contour count 3–15), Speed (animation rate)
│   ├── interference.ts        # Interference: audio-reactive moiré / interference-pattern visualizer inspired by Ryoji Ikeda's "test pattern" series; 7 freq bands each drive a standing-wave layer at evenly distributed angles (0°–154°); superposition creates shifting moiré fringes that tilt, breathe, and shimmer with the music; audio phase offsets + amplitude-driven angular twist animate the pattern; beat fires hue jump and brightness flash; saturation scales with loudness (near-monochrome at silence → vivid colour at full volume); offscreen pixel buffer at ¼ res (⅙ mobile) with imageSmoothingEnabled; sliders: Frequency (spatial density), Twist (audio angular deviation), Drift (animation speed)
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
│   └── keyboard.ts            # Keyboard shortcuts (0-9 viz modes, n/p/g/w/c/b/u/j/z/letter shortcuts, space, arrows, m/f/s/r/i/?/h/Esc; 9→hive, ;→marbling, [→flowfield, ]→lissajous, \→truchet, -→topography, =→interference)
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
