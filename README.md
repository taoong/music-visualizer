# Music Visualizer

Interactive browser-based music visualizer with real-time frequency analysis. Built with TypeScript, p5.js, and Tone.js.

Created by Tao Ong with Claude Code.

## Features

- **Visualization modes** — Circle, Spectrum, Tunnel, Lasers, Text, Highway, Liquid Metal, Neon Grid, Blobs, Gray-Scott, Physarum, Murmuration, and many more (55+ total)
- **Three analysis modes:**
  - **Frequency Bands** — Analyzes audio across 7 logarithmic frequency bands
  - **Microphone** — Live audio input from your mic for real-time visualization
  - **Interactive** — Audio plays as background, but the visualization is driven entirely by touch/drag/keyboard input. Input is synthesized into band amplitudes + transients that every viz already knows how to respond to, so every visualization reacts. Additional bespoke handlers (spawning, shattering, rippling from tap position, etc.) live on Blobs, Gray-Scott, Physarum, Ripple Tank, Constellation, Marbling, Bloom, Hive, Stained Glass, Tetris, Flow Field, Lasers, Synthwave, Text, and Highway.
- **Beat synchronization** — BPM detection with beat-reactive animations; BPM input, TAP tempo, and BEAT phase sync in the playback bar
- **Real-time audio processing** — Transient detection, auto-gain normalization, spectral centroid tracking
- **Full keyboard controls** — Switch visualizations, seek, volume, fullscreen, and more
- **MIDI mapping** — Map physical controller knobs to any slider via Web MIDI API; mappings persist via localStorage
- **Responsive design** — Works on desktop and mobile
- **Accessible** — ARIA labels, screen reader announcements, keyboard navigation

## Quick Start

```bash
npm install
npm run dev
```

Open http://localhost:3000. Upload a track or use the built-in sample.

### Prerequisites

- **Node.js** (v18+)

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
| `U` | Sculpture | 8 flat panels in a circle showing image strips; beat-synced camera orbit with audio-reactive tilt, glow, and spacing |
| `B` | Binary | Matrix-style cascading binary/ASCII characters; columns mapped to frequency bands with beat-synced wave ripple |
| `W` | Ripple Tank | Physics-inspired wave interference; 7 freq-band point-sources emit circular waves with beat-triggered shockwaves |
| `Y` | Cymatics | Chladni plate simulation; particles drift toward nodal lines of standing wave modes driven by frequency bands; beats scatter particles |
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
| `p` | Penrose | Aperiodic rhombus tiling generated by recursively deflating a "sun" of 10 golden triangles via the Robinson-triangle substitution behind Penrose's P3 tiling; the whole lattice rotates slowly like a living mandala; 7 concentric radial zones map distance-from-centre to frequency bands (sub-bass at the core → brilliance at the rim), driving each tile's hue and brightness; beat fires an outward "deflation wave" that flashes tiles brighter and shifts the palette; Density slider sweeps recursion depth from a few bold radiating wedges to a fine lace-like lattice of thousands of tiny rhombi; inspired by the 2023 discovery of "the hat" and "the spectre" — the first true aperiodic monotiles (David Smith, Craig Kaplan, Joseph Myers, Chaim Goodman-Strauss) — and the renewed fascination it sparked with Roger Penrose's pioneering 1974 never-repeating tilings |
| `l` | Fractal Flame | Audio-reactive iterated-function-system "chaos game"; a single point repeatedly jumps between 7 affine transforms (one per frequency band), each blending a rotation/scale/translation map with a nonlinear "variation" (sinusoidal, swirl, spherical, horseshoe, polar); thousands of jumps per frame accumulate into a luminous density+hue buffer rendered with exponential log-density tone mapping for an organic, glowing-nebula look; loud bands dominate the chaos game's transform-selection weight and inflate their lobe's geometry, while transient punches flare it brighter; beats trigger small random mutations of the transform "genes" so the attractor's shape continuously, organically reshapes itself with the music; inspired by Scott Draves' Fractal Flame algorithm (1992) and his Electric Sheep collaborative screensaver (1999–), which evolves flames via a genetic algorithm — https://en.wikipedia.org/wiki/Fractal_flame |
| `k` | Disorders | Minimalist ink-on-dark lattice of straight strokes inspired by Vera Molnár's "(Des)Ordres" (1974) and "Interruptions" (1968–69) — the pioneering computer artist celebrated since her 2023 death as the "grandmother of generative art," who began both series with a dense grid of identical parallel lines, then algorithmically rotated them into "disorder" and erased sections as "interruptions"; the grid starts perfectly aligned along one shared diagonal; 7 vertical zones map to frequency bands (sub-bass at far-left, brilliance at far-right) and each band's amplitude rotates its zone's strokes toward their own fixed random angle; beats fire expanding circular "interruption" waves that erase and reseed a ring of strokes as they sweep across the lattice — https://www.artsy.net/article/artsy-editorial-vera-molnar-mother-computer-art-pioneered-future-abstraction |
| `q` | Black Wave | Layered translucent wave silhouettes with parallax depth, inspired by teamLab's immersive "Black Waves" installation (2016–) — a continuous wave of black ink rendered in real time, its form shaped by the physics of fluid and the artists watching it — https://www.teamlab.art/w/black_waves/ — and Katsushika Hokusai's "The Great Wave off Kanagawa" (c. 1831); 7 frequency bands drive nested wave layers receding from a crashing sub-bass front wave to distant brilliance-band swells near the horizon; a ukiyo-e "bokashi" gradient sky shifts from indigo ai-zuri to vermillion Red Fuji; dry-brush ink strokes streak along each crest and foam particles spray where the front wave breaks on beats; sliders: Density (ink-stroke and foam richness), Swell (wave amplitude, calm rolling swells → towering waves), Hue (sumi-e monochrome → indigo ai-zuri → vermillion Red Fuji) |
| `t` | Origami | A grid of parallelogram facets folds into a Miura-ori herringbone pleat — alternating peak and valley vertices rise and fall along each column's fold depth, warping the whole sheet like a single piece of creased cloth; 7 columnar zones map sub-bass (left) through brilliance (right) to the 7 frequency bands, louder bands folding their zone deeper; per-facet normal/light shading against the live height field gives each pleat sharp foil-like highlights and shadows; beats fire a diagonal "fold wave" that ripples once across the sheet, briefly deepening every pleat as it passes; inspired by Issey Miyake's "132 5." origami-based clothing line (Reality Lab, with computer scientist Jun Mitani's crease-pattern software, launched 2010) — https://www.dezeen.com/2010/10/05/132-5-by-issey-miyake/ — sliders: Fold (base pleat depth, nearly flat → dramatic accordion folds), Grid (tessellation density 6–24 columns), Wave (speed and reach of the beat-triggered fold wave) |
| `x` | Light Field | A drifting 3D lattice of luminous orbs hangs in space, each point gently swaying on its own Perlin-noise current; 7 frequency bands each send a plane wave of brightness rippling through the lattice along its own 3D direction and spatial frequency, so different bands light up different slices of the field at once; a slowly orbiting, tilted camera projects the lattice to the screen with perspective scaling, and every beat fires an expanding spherical shell of brightness that sweeps outward through the points; 3-pass additive glow gives each orb a soft halo, coloured deep-ocean blue → cyan → violet/magenta by whichever band dominates it; inspired by Squidsoup's "Submergence" / "Ocean of Light" suspended-LED installations, immersive fields of thousands of points of light that drift and pulse overhead — https://www.squidsoup.org/portfolio/submergence-2/ — https://www.thisiscolossal.com/2013/01/submergence-an-immersive-field-of-8064-suspended-lights-by-squidsoup/ — sliders: Grid (lattice density, a few floating points → a dense starfield), Flow (wave speed, drift turbulence, and camera orbit speed), Glow (halo brightness around each point) |
| `d` | Brush | Generative action painting inspired by Joan Mitchell's "La Grande Vallée" series (1983-84) — a suite of 21 monumental canvases of swirling, gestural brushwork in vibrant blues, greens, and yellows — https://www.wikiart.org/en/joan-mitchell/la-grande-vallee-xiv-for-a-little-while-1983; autonomous bezier-curve brush strokes spawn on beats and audio energy, each curving through Perlin noise; 7 frequency bands map to a warm-to-cool hue palette (amber bass → violet brilliance); each stroke animates tip-to-tail with 3-pass neon glow (wide outer halo, mid glow, bright core) and tapered thickness; beats shift the hue palette and spawn bold gestural marks from the dominant band; transients trigger spontaneous strokes; amplitude scatters fine paint-splatter particles; offscreen trail buffer with configurable fade creates layered abstract paintings that build up and dissolve with the music; mobile guard: 120 max strokes, 24 points per curve; sliders: Strokes (spawning rate, sparse → dense flurry), Weight (brush thickness, fine lines → bold sweeps), Trail (paint persistence, ephemeral → lasting painting) |

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
| `U` | Sculpture visualization |
| `B` | Binary visualization |
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
| `p` | Penrose visualization |
| `l` | Fractal Flame visualization |
| `k` | Disorders visualization |
| `q` | Black Wave visualization |
| `t` | Origami visualization |
| `x` | Light Field visualization |
| `d` | Brush visualization |
| `M` | Mute / Unmute |
| `F` | Toggle fullscreen |
| `S` | Toggle sidebar |
| `R` | Randomize settings |
| `I` | Toggle image upload / remove |
| `H` | Return to home screen |
| `?` | Show shortcuts help |
| `Esc` | Close overlays |

## Tech Stack

- **TypeScript** — Source language
- **p5.js** — 2D/3D canvas rendering (CDN)
- **Tone.js** — Web Audio playback + FFT analysis (CDN)
- **Vite** — Build tool and dev server

## Project Structure

```
├── index.html              # Main HTML with splash, sidebar, playback bar
├── style.css               # All styles
├── src/
│   ├── main.ts             # p5 sketch entry, render loop, audio pipeline
│   ├── state/store.ts      # Centralized state (EventEmitter singleton)
│   ├── audio/              # Engine, FFT, processing, BPM detection (client-side)
│   ├── visualizations/     # One file per viz mode + shared helpers
│   ├── midi/               # MIDI manager (Web MIDI API, CC routing) + overlay UI
│   ├── ui/                 # Controller, splash, playback, sliders, keyboard
│   ├── types/              # TypeScript interfaces + global type stubs
│   └── utils/              # Constants, errors, formatting
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
