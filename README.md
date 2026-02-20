# Music Visualizer

Interactive browser-based music visualizer with real-time frequency analysis and AI-powered stem separation. Built with TypeScript, p5.js, and Tone.js.

Created by Tao Ong with Claude Code.

## Features

- **6 visualization modes** — Circle, Spectrum, Tunnel, Balls, 3D Cube, Stickman
- **Two audio analysis modes:**
  - **Frequency Bands** — Analyzes audio across 7 logarithmic frequency bands
  - **Stem Separation (Experimental)** — Uses AI (Demucs) to separate audio into kick, drums, bass, vocals, and other
- **Beat synchronization** — BPM detection with beat-reactive animations
- **Real-time audio processing** — Transient detection, auto-gain normalization, spectral centroid tracking
- **Full keyboard controls** — Switch visualizations, seek, volume, fullscreen, and more
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
| `6` | Stickman | Dancing stick figure with kick zoom and high-freq color |

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Space` | Play / Pause |
| `Left` / `Right` | Seek -5s / +5s |
| `Up` / `Down` | Volume up / down |
| `1`-`6` | Switch visualization mode |
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
| `npm run typecheck` | Type-check without emitting |

## License

ISC
