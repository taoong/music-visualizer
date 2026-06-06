# Music Visualizer

Interactive browser-based music visualizer with real-time frequency analysis and AI-powered stem separation. Built with TypeScript, p5.js, and Tone.js.

Created by Tao Ong with Claude Code.

## Features

- **Visualization modes** — Circle, Spectrum, Tunnel, Lasers, Text, Highway, Liquid Metal, Neon Grid, Blobs, Gray-Scott, Physarum, Murmuration, and many more (55+ total)
- **Three audio input modes:**
  - **Frequency Bands** — Analyzes audio across 7 logarithmic frequency bands
  - **Stem Separation (Experimental)** — Uses AI (Demucs) to separate audio into kick, drums, bass, vocals, and other
  - **Microphone** — Live audio input from your mic for real-time visualization
- **Beat synchronization** — BPM detection with beat-reactive animations; BPM input, TAP tempo, and BEAT phase sync in the playback bar
- **Real-time audio processing** — Transient detection, auto-gain normalization, spectral centroid tracking
- **Full keyboard controls** — Switch visualizations, seek, volume, fullscreen, and more
- **MIDI mapping** — Map physical controller knobs to any slider via Web MIDI API; mappings persist via localStorage
- **Responsive design** — Works on desktop and mobile
- **Accessible** — ARIA labels, screen reader announcements, keyboard navigation

## Quick Start

### Frontend only (no stem separation)

```bash
npm install
npm run dev
```

Open http://localhost:3000. Upload a track or use the built-in sample.

### With backend (enables stem separation + server-side BPM detection)

```bash
# Terminal 1 — backend
cd server
python -m venv venv
source venv/bin/activate
pip install -r requirements.txt
python app.py

# Terminal 2 — frontend
npm install
npm run dev
```

The dev server proxies `/api/*` to the Flask backend on port 5001.

### Prerequisites

- **Node.js** (v18+)
- **Python 3.10+** (for backend only)
- **ffmpeg** (for stem separation only)

## Visualization Modes

| Key | Mode | Description |
|-----|------|-------------|
| `1` | Circle | Rotating spike circle driven by frequency bands |
| `2` | Spectrum | Horizontal bar chart of amplitudes |
| `3` | Tunnel | Octave-based concentric rings with glow effect |
| `4` | Balls | Physics-based bouncing balls with kick boost |
| `5` | Lasers | Concert laser light show with beat-synced beams |
| `6` | Text | Beat-synced text in 7 cycling visual patterns |
| `7` | Highway | Audio-reactive highway drive; perspective road with beat-synced lane markings and headlight flares; freq bands drive scenery and road color; Three.js WebGL overlay |
| `8` | Liquid Metal | Molten chrome icosphere; Three.js PBR with IBL environment; amplitude deforms mesh vertices; GlitchPass fires on transients |
| `N` | Neon Grid | Three.js synthwave terrain with audio-driven height displacement and bloom |
| `G` | Image Grid | 16×16 mosaic of 3D tiles viewed from above; column height driven by frequency band; beat → radiating lift-wave; upload an image to see it sliced across the tiles |
| `C` | Color Map | Pixel-level audio-reactive color modulation; user image (or rainbow gradient) with hue-mapped frequency band boosting |
| `U` | Sculpture | 8 flat panels in a circle showing image strips; beat-synced camera orbit with audio-reactive tilt, glow, and spacing |
| `B` | Binary | Matrix-style cascading binary/ASCII characters; columns mapped to frequency bands with beat-synced wave ripple |
| `T` | Dancer | Beat-synced dancing alien with spotlight stage, disco floor, particles, and configurable text flash |
| `W` | Ripple Tank | Physics-inspired wave interference; 7 freq-band point-sources emit circular waves with beat-triggered shockwaves |
| `Y` | Cymatics | Chladni plate simulation; particles drift toward nodal lines of standing wave modes driven by frequency bands; beats scatter particles |
| `D` | Cloud Chamber | Particle physics simulation; 7 particle types with Lorentz force magnetic field curving; beat cosmic ray showers |
| `J` | Strange Attractor | Lorenz attractor chaos theory; particles trace butterfly-shaped 3D paths; audio warps system parameters; beats jolt the attractor |
| `E` | Waterfall | 3D scrolling spectrogram: stacked ribbons of recent spectra receding into the distance; newest snapshot in front, older ones fade back with perspective and haze |
| `Z` | Monolith | Tall faceted crystal obelisk; cinematic camera choreography (orbit, crash-zoom, Hitchcock dolly, snap-cut, top-down / worm's-eye, barrel rolls) all locked to the beat |
| `.` | Stained Glass | Voronoi tessellation lit as a jewel-tone stained glass window; cells glow amethyst→ruby across 7 frequency bands; lead lines between panes; beat fires a warm flash and optionally shatters the mosaic |
| `,` | Blobs | Audio-reactive metaball field; 7 biomorphic orbs (one per freq band) drift via Perlin noise and fuse organically when amplitudes rise; beat bursts them outward |
| `/` | Gray-Scott | Gray-Scott reaction-diffusion chemical simulation; Turing patterns (spots, stripes, mazes) driven by feed/kill parameters; sub-bass seeds activator, beats inject central pulse and rotate hue palette |
| `~` | Growth | Differential growth simulation; 7 closed curves grow by node insertion, fold like coral and brain sulci via spatial-hash repulsion; amplitude drives glow and growth speed |
| `@` | Pixel Sort | Glitch-art column pixel sorting inspired by Kim Asendorf's "Mountain Tour"; synthetic plasma field (7 freq-band hue zones) sorted by luminance; bass lowers sort threshold; beats inject a sort surge |
| `#` | Echoes | Polar slit-scan temporal mandala; each audio frame stored as an annular ring; rings radiate outward (newest innermost, oldest outermost); Twist morphs from concentric mandala to tight spiral; beat shifts 7-band hue palette |
| `$` | Physarum | Slime-mold agent-network simulation (Jeff Jones algorithm, Zach Lieberman 2025); agents sense pheromone trails and steer toward highest concentration; emergent self-organising mycelial web; beat scatters agents + hue jump; bass drives deposit rate; dominant band colours hue |
| `%` | Op-Art | Audio-reactive Op-Art grid inspired by Victor Vasarely's "Vega-Nor" series (1969); NxN circles modulated by 7 per-band sinusoidal standing waves at increasing spatial frequencies plus a central Vasarely dome illusion; beat fires an expanding radial shockwave; Color slider morphs from black/white monochrome to full chromatic HSB |
| `^` | Geodesic | Up to 5 nested icosahedral wireframe shells rotating independently (each driven by a different audio frequency band); overlapping neon wireframes create iridescent crystalline interference patterns; 3-pass glow per edge; vertex node dots; beat fires angular impulses; inspired by teamLab's "Bubble Universe" (2024) |
| `&` | Ribbons | N sinuous silk-ribbon strands float horizontally across the canvas, each driven by a frequency band; amplitude scales oscillation height; iridescent canvas-gradient glow (3 passes: outer halo, mid body, bright core) shimmers along each strand; beat fires a traveling snap wave; inspired by teamLab "Light Sculpture – Flow" (2024) |
| `*` | Infinity Net | Dense hex-offset grid of semicircular arcs inspired by Yayoi Kusama's "Infinity Net" paintings (1958–ongoing); 7 concentric radial zones map to frequency bands (sub-bass at centre → brilliance at edge); amplitude pulses arc size; beat fires an expanding ripple ring; Palette slider morphs from Kusama's iconic white-on-black monochrome to full chromatic per-band colour |
| `_` | Zen Garden | Karesansui (枯山水) dry-rock-garden: rake lines flow across a warm sandy canvas, curving around stone formations; 7 frequency bands each govern a horizontal zone of the garden (sub-bass=deep rolling waves, brilliance=fine ripples); beat triggers a sudden re-raking phase-jump event; inspired by the Ryōan-ji temple garden in Kyoto (c. 1500) and Tokujin Yoshioka's sand installations |
| `!` | Arabesque | 7 arabesque petals traced via John Whitney Sr.'s differential motion formula (r[k] = R·|sin(kπ/N)| at angle k·φ), phase-offset by 2π/7 for 7-fold symmetry; the trail buffer accumulates layered Islamic-geometric forms that bloom and transform with the music; beat snaps the phase angle and shifts the hue palette; inspired by John Whitney Sr., "Arabesque" (1975, programmed by Larry Cuba) |
| `\|` | Murmuration | Boid flocking simulation; thousands of birds exhibit emergent separation/alignment/cohesion; each bird colored by velocity direction producing electric rainbow swirls; persistent trail buffer; beat triggers predator-event scatter + hue jump; inspired by Universal Everything "Future Self" (2012) |
| `+` | Facets | Jittered triangular mesh spanning the full canvas; each facet's hue maps to one of 7 frequency bands (amethyst→sapphire→aquamarine→emerald→topaz→amber→ruby, left to right); two orbiting virtual light sources sweep caustic highlights across the surface; Perlin noise continuously undulates vertices; audio amplitude brightens each band's facets from dark jewel-tone to blazing; beat bursts all vertices radially outward and flashes the surface blue-white; inspired by Quayola "Strata" series (2010–) |
| `>` | Epicycles | Fourier series harmonic visualizer; 7 nested spinning circles (one per frequency band) trace an evolving Lissajous curve; bass drives the outermost arm, brilliance makes fine interior spirals; beat fires a hue jump; inspired by 19th-century harmonograph machines |
| `<` | Halftone | Three CMY dot-screens at 15°/45°/75° composited via MULTIPLY blend on white, replicating offset-press colour mixing (C+M→indigo, M+Y→scarlet, C+Y→olive); each dot's radius is driven by the frequency band whose horizontal screen-zone it falls in, so bass swells the left of the canvas and treble sparkles the right; beat fires an expanding ring-pulse of swollen dots from canvas centre; inspired by Roy Lichtenstein "Drowning Girl" (MoMA, 1963) and the Ben-Day dot printing process |
| `Q` | Circuit | PCB-trace neon routing; N nodes scatter across the canvas connected by smooth L-shaped bezier traces colored by frequency band (violet→magenta, left→right); signal pulses animate along traces; beat fires a cascade burst from random nodes and shifts the hue palette; inspired by Joshua Davis "Praystation" generative circuit-board design system (2001–2003) |
| `G` | Caustics | Underwater light caustic patterns; 7 sinusoidal wave layers (one per frequency band) travel at evenly distributed angles and spatial scales; constructive interference focuses light into bright focal clusters that shift and shimmer with the music; power-law sharpening produces razor-thin caustic lines on a deep-navy background; radial vignette adds pool-depth atmosphere; beat fires a brightness surge and hue shift; inspired by Jason Bruges Studio light-dome installations and Izabela Pluta "Like folds in water (caustic network)" (2024) |
| `n` | Knot | Torus knot T(2, q) rendered as 3 interleaved neon strands in pure p5.js 2D perspective (no Three.js); the Topology slider sweeps q from trefoil (3) to septafoil (7), each creating a distinct knotted geometry; strands colored by frequency register — sub+bass drives violet, mid drives teal, highs drive amber — with a 60° hue gradient along each strand; 3-pass phosphor glow; beat fires angular impulse + hue shift; bass amplitude inflates the torus; inspired by George W. Hart's topological mathematical sculpture at the Bridges Conference on Mathematical Art |

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Space` | Play / Pause |
| `Left` / `Right` | Seek -5s / +5s |
| `Up` / `Down` | Volume up / down |
| `1`-`9`, `0` | Switch visualization mode |
| `N` | Neon Grid visualization |
| `G` | Image Grid visualization |
| `W` | Ripple Tank visualization |
| `Y` | Cymatics visualization |
| `C` | Color Map visualization |
| `U` | Sculpture visualization |
| `B` | Binary visualization |
| `T` | Dancer visualization |
| `D` | Cloud Chamber visualization |
| `J` | Strange Attractor visualization |
| `E` | Waterfall visualization |
| `Z` | Monolith visualization |
| `.` | Stained Glass visualization |
| `,` | Blobs visualization |
| `/` | Gray-Scott visualization |
| `~` | Growth visualization |
| `\|` | Murmuration visualization |
| `@` | Pixel Sort visualization |
| `#` | Echoes visualization |
| `$` | Physarum visualization |
| `%` | Op-Art visualization |
| `^` | Geodesic visualization |
| `&` | Ribbons visualization |
| `*` | Infinity Net visualization |
| `_` | Zen Garden visualization |
| `!` | Arabesque visualization |
| `+` | Facets visualization |
| `>` | Epicycles visualization |
| `<` | Halftone visualization |
| `Q` | Circuit visualization |
| `G` | Caustics visualization |
| `n` | Knot visualization |
| `M` | Mute / Unmute |
| `F` | Toggle fullscreen |
| `S` | Toggle sidebar |
| `R` | Randomize settings |
| `I` | Toggle image upload / remove |
| `H` | Return to home screen |
| `?` | Show shortcuts help |
| `Esc` | Close overlays |

## Tech Stack

### Frontend
- **TypeScript** — Source language
- **p5.js** — 2D/3D canvas rendering (CDN)
- **Tone.js** — Web Audio playback + FFT analysis (CDN)
- **Vite** — Build tool and dev server

### Backend (optional)
- **Flask** — REST API
- **Demucs** — AI stem separation (htdemucs_6s model)
- **Essentia** — BPM detection
- **ffmpeg** — Audio filtering (kick isolation via low-pass)

## Project Structure

```
├── index.html              # Main HTML with splash, sidebar, playback bar
├── style.css               # All styles
├── src/
│   ├── main.ts             # p5 sketch entry, render loop, audio pipeline
│   ├── state/store.ts      # Centralized state (EventEmitter singleton)
│   ├── audio/              # Engine, FFT, processing, BPM detection
│   ├── visualizations/     # One file per viz mode + shared helpers
│   ├── midi/               # MIDI manager (Web MIDI API, CC routing) + overlay UI
│   ├── ui/                 # Controller, splash, playback, sliders, keyboard
│   ├── types/              # TypeScript interfaces + global type stubs
│   └── utils/              # Constants, errors, formatting
├── server/
│   ├── app.py              # Flask backend (stem separation + BPM)
│   └── requirements.txt
├── public/
│   └── sample.mp3          # Built-in sample track
└── CLAUDE.md               # Architecture reference for AI-assisted development
```

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start Vite dev server (port 3000) |
| `npm run build` | Type-check + production build to `dist/` |
| `npm run preview` | Preview production build |
| `npm run lint` | Run ESLint |
| `npm run lint:fix` | Fix ESLint errors |
| `npm run format` | Format code with Prettier |
| `npm run test` | Run Vitest tests |
| `npm run test:watch` | Run Vitest in watch mode |
| `npm run typecheck` | Type-check without emitting |

## License

ISC
