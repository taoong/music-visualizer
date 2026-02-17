# Music Visualizer

An interactive browser-based music visualizer with real-time audio-reactive graphics.

## Features

- **Dual Analysis Modes:**
  - **Frequency Bands Mode:** Analyzes audio across 7 logarithmic frequency bands
  - **Stem Separation Mode (Experimental):** Uses AI to separate audio into 5 stems

- **Four Visualization Types:**
  - Circle: Rotating circular spikes that respond to audio
  - Spectrum: Traditional bar spectrum analyzer
  - Tunnel: Concentric rings representing octave-based frequency content
  - Balls: Animated bouncing balls that react to audio

- **Additional Features:**
  - BPM detection with beat-reactive colors
  - Real-time playback controls
  - Adjustable sensitivity controls
  - Keyboard shortcuts
  - Screen reader support
  - Reduced motion support

## Tech Stack

- **Frontend:** TypeScript, p5.js, Tone.js, Vite
- **Backend:** Python, Flask, Demucs (stem separation)

## Quick Start

```bash
# Install dependencies
npm install

# Start development server
npm run dev

# In another terminal, start the Flask backend
cd server
pip install -r requirements.txt
python app.py
```

## Keyboard Shortcuts

- `Space` - Play/Pause
- `←/→` - Seek backward/forward 5s
- `↑/↓` - Volume up/down
- `1-4` - Switch visualization mode
- `M` - Mute/Unmute
- `F` - Toggle fullscreen
- `S` - Toggle sidebar
- `R` - Randomize settings
- `?` - Show keyboard shortcuts
- `ESC` - Close overlays/Go back
- `H` - Return to home screen

## Scripts

- `npm run dev` - Start development server
- `npm run build` - Build for production
- `npm run preview` - Preview production build
- `npm run lint` - Run ESLint
- `npm run lint:fix` - Fix ESLint errors
- `npm run format` - Format code with Prettier
- `npm run typecheck` - Run TypeScript type checking

## Project Structure

```
src/
  ├── main.ts              # Application entry point
  ├── types/               # TypeScript type definitions
  ├── state/               # State management
  ├── audio/               # Audio processing and engine
  ├── visualizations/      # Visualization renderers
  ├── ui/                  # UI controllers and keyboard shortcuts
  └── utils/               # Utilities and constants
```
