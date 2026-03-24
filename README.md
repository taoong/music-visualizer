# Music Visualizer

Interactive browser-based music visualizer with real-time frequency analysis and AI-powered stem separation. Built with TypeScript, p5.js, and Tone.js.

Created by Tao Ong with Claude Code.

## Features

- **11 visualization modes** — Circle, Spectrum, Tunnel, Balls, 3D Cube, Lasers, Text, Space, Runners, Liquid Metal, Neon Grid, Image Grid
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
| `5` | 3D Cube | Wireframe cube with beat-synced rotation |
| `6` | Lasers | Concert laser light show with beat-synced beams |
| `7` | Text | Beat-synced text in 7 cycling visual patterns |
| `8` | Space | Third-person spaceship navigating an asteroid field; asteroids fly toward the viewer timed to song events |
| `9` | Runners | Infinite side-scrolling marathon of stick-figure runners at 3 depth layers; beat fires an instant 7× speed burst for 180 ms |
| `N` | Neon Grid | Three.js synthwave terrain with audio-driven height displacement and bloom |
| `G` | Image Grid | 16×16 mosaic of 3D tiles viewed from above; column height driven by frequency band; beat → radiating lift-wave; upload an image to see it sliced across the tiles |
| `C` | Color Map | Pixel-level audio-reactive color modulation; user image (or rainbow gradient) with hue-mapped frequency band boosting |
| `U` | Sculpture | 8 flat panels in a circle showing image strips; beat-synced camera orbit with audio-reactive tilt, glow, and spacing |
| `B` | Binary | Matrix-style cascading binary/ASCII characters; columns mapped to frequency bands with beat-synced wave ripple |
| `T` | Dancer | Beat-synced dancing alien with spotlight stage, disco floor, particles, and configurable text flash |

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Space` | Play / Pause |
| `Left` / `Right` | Seek -5s / +5s |
| `Up` / `Down` | Volume up / down |
| `1`-`9`, `0` | Switch visualization mode |
| `N` | Neon Grid visualization |
| `G` | Image Grid visualization |
| `W` | Waveform visualization |
| `C` | Color Map visualization |
| `U` | Sculpture visualization |
| `B` | Binary visualization |
| `T` | Dancer visualization |
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
