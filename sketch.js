/* ================================================================
   Music Visualizer — sketch.js
   p5.js + Tone.js — Circle with frequency-driven spikes
   Dual mode: Frequency Bands (default) + Stem Separation (experimental)
   ================================================================ */

// ── Mode state ──────────────────────────────────────────────────
let mode = 'freq'; // 'freq' or 'stems'
let vizMode = 'circle'; // 'circle', 'spectrum', 'tunnel', or 'balls'

// ── State ────────────────────────────────────────────────────────
let audioReady = false;
let isPlaying = false;
let useSample = false;
let userFile = null;
let currentObjectUrl = null;
let currentSampleBlobUrl = null;

// Scrubber / seek state
let playStartedAt = 0;  // Tone.now() when playback last started
let startOffset = 0;    // offset into the song (seconds)
let isSeeking = false;  // true while user drags scrubber

// ── Freq-mode Tone.js nodes ─────────────────────────────────────
let player = null;
let gainNode = null;

const sampleUrl = 'sample.mp3';

// Mobile detection
const isMobile = /Android|iPhone|iPad|iPod|webOS/i.test(navigator.userAgent)
  || (navigator.maxTouchPoints > 1 && window.innerWidth < 1024);

// Per-bin smoothed amplitudes for each frequency band
const SPIKES_PER_BAND = isMobile ? 30 : 60;

// ── Balls mode state ────────────────────────────────────────────
const BALL_COUNT = isMobile ? 15 : 30;
let balls = [];
let kickBoostMultiplier = 1.0;

// Per-band definitions — logarithmic frequency ranges matching human perception
const BANDS = [
  { name: 'sub',        loHz: 20,   hiHz: 60,    scale: 3.0,  sens: 'sensSub',        sliderId: 'sens-sub',        attack: 0.50, release: 0.08, defaultSens: 1.5 },
  { name: 'bass',       loHz: 60,   hiHz: 250,   scale: 4.0,  sens: 'sensBass',       sliderId: 'sens-bass',       attack: 0.55, release: 0.09, defaultSens: 1.2 },
  { name: 'lowMid',     loHz: 250,  hiHz: 500,   scale: 6.0,  sens: 'sensLowMid',     sliderId: 'sens-low-mid',    attack: 0.62, release: 0.10, defaultSens: 1.8 },
  { name: 'mid',        loHz: 500,  hiHz: 2000,  scale: 8.0,  sens: 'sensMid',        sliderId: 'sens-mid',        attack: 0.70, release: 0.11, defaultSens: 2.0 },
  { name: 'upperMid',   loHz: 2000, hiHz: 4000,  scale: 10.0, sens: 'sensUpperMid',   sliderId: 'sens-upper-mid',  attack: 0.78, release: 0.12, defaultSens: 2.0 },
  { name: 'presence',   loHz: 4000, hiHz: 6000,  scale: 12.0, sens: 'sensPresence',   sliderId: 'sens-presence',   attack: 0.83, release: 0.13, defaultSens: 2.0 },
  { name: 'brilliance', loHz: 6000, hiHz: 20000, scale: 14.0, sens: 'sensBrilliance', sliderId: 'sens-brilliance', attack: 0.88, release: 0.14, defaultSens: 2.0 },
];
const BAND_COUNT = BANDS.length;

// ── Octave-based tunnel constants ────────────────────────────────
const OCTAVE_COUNT = 10;
const OCTAVES = [
  { loHz: 27.5,   hiHz: 55 },
  { loHz: 55,     hiHz: 110 },
  { loHz: 110,    hiHz: 220 },
  { loHz: 220,    hiHz: 440 },
  { loHz: 440,    hiHz: 880 },
  { loHz: 880,    hiHz: 1760 },
  { loHz: 1760,   hiHz: 3520 },
  { loHz: 3520,   hiHz: 7040 },
  { loHz: 7040,   hiHz: 14080 },
  { loHz: 14080,  hiHz: 20000 },
];
// Per-octave boost factors — low octaves have fewer FFT bins so need more boost
const OCTAVE_SCALES = [6.0, 5.0, 4.0, 3.5, 3.0, 3.0, 3.5, 4.0, 5.0, 6.0];
// Tunnel rendering constants
const TUNNEL_GLOW_PASSES = [
  { widthMult: 6.0, alphaMult: 0.25 },  // outer glow
  { widthMult: 3.0, alphaMult: 0.55 },  // body
  { widthMult: 1.0, alphaMult: 1.0 },   // core
];
const TUNNEL_BASE_BRIGHTNESS = 40;
const TUNNEL_PERSPECTIVE_POWER = 1.8;    // >1 compresses inner rings
const TUNNEL_PULSE_SCALE = 0.15;         // max radius expansion from energy

// ── Auto-gain: rolling peak normalization (~5s window) ───────────
const AUTO_GAIN_FRAMES = 300;   // ~5s at 60fps
const AUTO_GAIN_FLOOR = 0.01;   // prevents division by zero

const autoGainBands = BANDS.map(() => ({
  peaks: new Float32Array(AUTO_GAIN_FRAMES).fill(AUTO_GAIN_FLOOR), idx: 0,
}));
const autoGainStems = {};  // lazy-initialized per stem

// ── Transient detection ──────────────────────────────────────────
const TRANSIENT_THRESHOLD = 1.8;   // current/avg ratio to trigger
const TRANSIENT_DECAY = 0.85;      // multiplier decay per frame
const TRANSIENT_BOOST = 1.5;       // max visual multiplier
const TRANSIENT_AVG_ALPHA = 0.05;  // slow EMA for baseline

const transientBands = BANDS.map(() => ({ avg: 0, multiplier: 1.0 }));
const transientStems = {};  // lazy-initialized
let transientValues = new Float32Array(BAND_COUNT).fill(1.0);
let transientStemValues = {};
let smoothedBands = BANDS.map(() => new Float32Array(SPIKES_PER_BAND));

// ── Delta (rate-of-change detection) ────────────────────────────
const DELTA_ATTACK  = 0.70;
const DELTA_RELEASE = 0.08;
const DELTA_SPIKE_WIDTH_MIN = 0.08;  // narrowest spike (high delta = punchy)
const DELTA_SPIKE_WIDTH_MAX = 0.35;  // widest spike (low delta = sustained)
const DELTA_LENGTH_BOOST = 0.3;      // max spike length bonus from delta
const DELTA_BRIGHTNESS_BOOST = 60;   // max additive brightness (spectrum mode)

const deltaBands = BANDS.map(() => ({ prevMean: 0, smoothed: 0 }));
let deltaValues = new Float32Array(BAND_COUNT);
const deltaStems = {};       // lazy-initialized per stem
let deltaStemValues = {};

// ── Octave-based state (tunnel mode) ────────────────────────────
let smoothedOctaves = new Float32Array(OCTAVE_COUNT);
const octaveTransients = Array.from({ length: OCTAVE_COUNT }, () => ({ avg: 0, multiplier: 1.0 }));
let octaveTransientValues = new Float32Array(OCTAVE_COUNT).fill(1.0);
const octaveDeltas = Array.from({ length: OCTAVE_COUNT }, () => ({ prevMean: 0, smoothed: 0 }));
let octaveDeltaValues = new Float32Array(OCTAVE_COUNT);
let autoGainOctaves = { peaks: new Float32Array(AUTO_GAIN_FRAMES).fill(AUTO_GAIN_FLOOR), idx: 0 };

// ── Spectral centroid ───────────────────────────────────────────
const CENTROID_LOW_HZ  = 80;
const CENTROID_HIGH_HZ = 8000;
const CENTROID_LOG_LOW  = Math.log(CENTROID_LOW_HZ);
const CENTROID_LOG_HIGH = Math.log(CENTROID_HIGH_HZ);
const CENTROID_LOG_RANGE = CENTROID_LOG_HIGH - CENTROID_LOG_LOW;
const CENTROID_SMOOTHING = 0.06;      // slow EMA to prevent jitter
const CENTROID_Y_RANGE   = 0.15;      // max Y offset as fraction of height

let fftFull = null;          // full-spectrum FFT (freq mode, no filter)
let smoothedCentroid = 0.5;  // normalized [0,1], 0.5 = neutral
let centroidYOffset = 0;     // pixel offset, updated each frame

// ── Stem-mode variables ─────────────────────────────────────────
const STEMS = ['kick', 'drums', 'bass', 'vocals', 'other'];
let stemPlayers = {};
let stemGainNodes = {};
let stemMasterGain = null;
let stemFfts = {};
let stemSmoothed = {};

// Smoothing params per stem: [attack, release]
const STEM_SMOOTHING = {
  kick:   [0.90, 0.06],
  drums:  [0.85, 0.08],
  bass:   [0.75, 0.10],
  vocals: [0.78, 0.12],
  other:  [0.80, 0.14],
};

// GUI values (defaults — overridden by sliders)
const cfg = {
  // Freq mode (7 bands)
  sensSub: 1.5,
  sensBass: 1.2,
  sensLowMid: 1.8,
  sensMid: 2.0,
  sensUpperMid: 2.0,
  sensPresence: 2.0,
  sensBrilliance: 2.0,
  // Stem mode
  sensKick: 2.0,
  sensDrums: 2.0,
  sensStemBass: 2.0,
  sensVocals: 2.0,
  sensOther: 2.0,
  // Shared
  spikeScale: 1.2,
  rotationSpeed: 0.3,
  ballsKickBoost: 3.0,
  masterVolume: 0.8,
};

// Stem sensitivity key mapping
const STEM_SENS_KEYS = {
  kick: 'sensKick',
  drums: 'sensDrums',
  bass: 'sensStemBass',
  vocals: 'sensVocals',
  other: 'sensOther',
};

// ── p5.js lifecycle ─────────────────────────────────────────────

function setup() {
  const canvas = createCanvas(windowWidth, windowHeight);
  canvas.parent('canvas-container');
  pixelDensity(1);
  if (isMobile) frameRate(30);
  wireDOM();
}

function draw() {
  background(0);

  if (mode === 'freq') {
    // ── Freq mode: analyse audio via 7-band log FFT ────────
    if (isPlaying && player && player.state === 'started') {
      const rawBands = getLogBandAmplitudes(fftFull);
      for (let b = 0; b < BAND_COUNT; b++) {
        const raw = applyAutoGain(rawBands[b], autoGainBands[b]);
        transientValues[b] = updateTransient(transientBands[b], raw);
        deltaValues[b] = computeDelta(deltaBands[b], raw);
        smoothBins(smoothedBands[b], raw, cfg[BANDS[b].sens], BANDS[b].attack, BANDS[b].release);
      }
      if (fftFull) updateCentroid(computeSpectralCentroid(fftFull));
      if (vizMode === 'tunnel' && fftFull) {
        const rawOct = applyAutoGain(getOctaveAmplitudes(fftFull), autoGainOctaves);
        for (let o = 0; o < OCTAVE_COUNT; o++) {
          octaveTransientValues[o] = updateTransient(octaveTransients[o], new Float32Array([rawOct[o]]));
          octaveDeltaValues[o] = computeDelta(octaveDeltas[o], new Float32Array([rawOct[o]]));
          smoothedOctaves[o] += (rawOct[o] * cfg.spikeScale - smoothedOctaves[o]) * 0.55;
        }
      }
    } else {
      for (let b = 0; b < BAND_COUNT; b++) {
        for (let i = 0; i < SPIKES_PER_BAND; i++) {
          smoothedBands[b][i] *= 0.88;
        }
        transientValues[b] = 1.0 + (transientValues[b] - 1.0) * TRANSIENT_DECAY;
        deltaValues[b] *= DELTA_RELEASE;
      }
      if (vizMode === 'tunnel') {
        for (let o = 0; o < OCTAVE_COUNT; o++) {
          smoothedOctaves[o] *= 0.88;
          octaveTransientValues[o] = 1.0 + (octaveTransientValues[o] - 1.0) * TRANSIENT_DECAY;
          octaveDeltaValues[o] *= DELTA_RELEASE;
        }
      }
    }
  } else {
    // ── Stem mode: analyse each stem's FFT ──────────────────
    const anyPlaying = isPlaying && stemPlayers.kick &&
      stemPlayers.kick.state === 'started';

    if (anyPlaying) {
      for (const stem of STEMS) {
        if (!stemFfts[stem] || !stemSmoothed[stem]) continue;
        if (!autoGainStems[stem]) {
          autoGainStems[stem] = { peaks: new Float32Array(AUTO_GAIN_FRAMES).fill(AUTO_GAIN_FLOOR), idx: 0 };
        }
        if (!transientStems[stem]) {
          transientStems[stem] = { avg: 0, multiplier: 1.0 };
        }
        if (!deltaStems[stem]) {
          deltaStems[stem] = { prevMean: 0, smoothed: 0 };
        }
        const raw = applyAutoGain(getFFTAmplitudes(stemFfts[stem], SPIKES_PER_BAND, 10.0), autoGainStems[stem]);
        transientStemValues[stem] = updateTransient(transientStems[stem], raw);
        deltaStemValues[stem] = computeDelta(deltaStems[stem], raw);
        const sensKey = STEM_SENS_KEYS[stem];
        const [attack, release] = STEM_SMOOTHING[stem];
        smoothBins(stemSmoothed[stem], raw, cfg[sensKey], attack, release);
      }
      updateCentroid(computeStemCentroid());
      if (vizMode === 'tunnel') {
        const rawOct = applyAutoGain(getOctaveAmplitudesFromStems(stemFfts), autoGainOctaves);
        for (let o = 0; o < OCTAVE_COUNT; o++) {
          octaveTransientValues[o] = updateTransient(octaveTransients[o], new Float32Array([rawOct[o]]));
          octaveDeltaValues[o] = computeDelta(octaveDeltas[o], new Float32Array([rawOct[o]]));
          smoothedOctaves[o] += (rawOct[o] * cfg.spikeScale - smoothedOctaves[o]) * 0.55;
        }
      }
    } else {
      for (const stem of STEMS) {
        if (!stemSmoothed[stem]) continue;
        for (let i = 0; i < SPIKES_PER_BAND; i++) {
          stemSmoothed[stem][i] *= 0.88;
        }
        if (transientStemValues[stem] !== undefined) {
          transientStemValues[stem] = 1.0 + (transientStemValues[stem] - 1.0) * TRANSIENT_DECAY;
        }
        if (deltaStemValues[stem] !== undefined) {
          deltaStemValues[stem] *= DELTA_RELEASE;
        }
      }
      if (vizMode === 'tunnel') {
        for (let o = 0; o < OCTAVE_COUNT; o++) {
          smoothedOctaves[o] *= 0.88;
          octaveTransientValues[o] = 1.0 + (octaveTransientValues[o] - 1.0) * TRANSIENT_DECAY;
          octaveDeltaValues[o] *= DELTA_RELEASE;
        }
      }
    }
  }

  updateScrubber();
  if (vizMode === 'tunnel') {
    drawTunnel();
  } else if (vizMode === 'spectrum') {
    drawSpectrum();
  } else if (vizMode === 'balls') {
    drawBalls();
  } else {
    drawSpikeCircle();
  }
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
  if (vizMode === 'balls') initBalls();
}

// ── Spike circle visualization ───────────────────────────────────

function drawSpikeCircle() {
  const cx = width / 2;
  const cy = height / 2;
  const minDim = Math.min(width, height);
  const baseRadius = minDim * 0.12;
  const maxSpikeLen = minDim * 0.35;

  let totalSpikes, bandCount;
  if (mode === 'freq') {
    bandCount = BAND_COUNT;
    totalSpikes = SPIKES_PER_BAND * BAND_COUNT;
  } else {
    bandCount = 5;
    totalSpikes = SPIKES_PER_BAND * 5;
  }

  const angleStep = TWO_PI / totalSpikes;
  const rotation = millis() / 1000.0 * cfg.rotationSpeed * 0.4;

  push();
  translate(cx, cy + centroidYOffset);

  // Draw spikes as tapered triangles
  noStroke();
  for (let i = 0; i < totalSpikes; i++) {
    const angle = i * angleStep + rotation;
    const band = Math.floor(i / SPIKES_PER_BAND);
    const bandIdx = i % SPIKES_PER_BAND;

    let amp = 0;
    let tMult = 1.0;
    let delta = 0;
    if (mode === 'freq') {
      amp = smoothedBands[band][bandIdx];
      tMult = transientValues[band];
      delta = deltaValues[band];
    } else {
      const stem = STEMS[band];
      if (stemSmoothed[stem]) amp = stemSmoothed[stem][bandIdx];
      if (transientStemValues[stem]) tMult = transientStemValues[stem];
      if (deltaStemValues[stem]) delta = deltaStemValues[stem];
    }

    amp *= cfg.spikeScale * tMult;

    const spikeLen = amp * maxSpikeLen * (1.0 + delta * DELTA_LENGTH_BOOST);
    if (spikeLen < 0.5) continue;

    // Spike base half-width — high delta = narrow/punchy, low delta = wide/sustained
    const widthFactor = DELTA_SPIKE_WIDTH_MAX - delta * (DELTA_SPIKE_WIDTH_MAX - DELTA_SPIKE_WIDTH_MIN);
    const halfBase = angleStep * (widthFactor + amp * 0.1);

    const innerR = baseRadius;
    const outerR = baseRadius + spikeLen;

    // Brightness scales with amplitude + delta boost
    const brightness = 120 + Math.min(amp, 1.0) * 135 + delta * 30;
    fill(brightness);

    beginShape();
    vertex(Math.cos(angle - halfBase) * innerR, Math.sin(angle - halfBase) * innerR);
    vertex(Math.cos(angle) * outerR, Math.sin(angle) * outerR);
    vertex(Math.cos(angle + halfBase) * innerR, Math.sin(angle + halfBase) * innerR);
    endShape(CLOSE);
  }

  // Draw base circle on top
  noFill();
  stroke(255);
  strokeWeight(2);
  ellipse(0, 0, baseRadius * 2, baseRadius * 2);

  pop();
}

// ── Spectrum visualization ─────────────────────────────────────────

function drawSpectrum() {
  const hPad = 40;
  const bottomMargin = 60 - centroidYOffset;
  const maxBarHeight = height * 0.7;

  let bandCount, totalBars;
  if (mode === 'freq') {
    bandCount = BAND_COUNT;
  } else {
    bandCount = 5;
  }
  totalBars = SPIKES_PER_BAND * bandCount;

  const availWidth = width - hPad * 2;
  const barWidth = Math.max((availWidth / totalBars) - 1, 1);
  const gap = 1;

  noStroke();
  for (let b = 0; b < bandCount; b++) {
    for (let i = 0; i < SPIKES_PER_BAND; i++) {
      const idx = b * SPIKES_PER_BAND + i;

      let amp = 0;
      let tMult = 1.0;
      let delta = 0;
      if (mode === 'freq') {
        amp = smoothedBands[b][i];
        tMult = transientValues[b];
        delta = deltaValues[b];
      } else {
        const stem = STEMS[b];
        if (stemSmoothed[stem]) amp = stemSmoothed[stem][i];
        if (transientStemValues[stem]) tMult = transientStemValues[stem];
        if (deltaStemValues[stem]) delta = deltaStemValues[stem];
      }

      amp *= cfg.spikeScale * tMult;

      const barH = amp * maxBarHeight * (1.0 + delta * DELTA_LENGTH_BOOST);
      if (barH < 0.5) continue;

      const x = hPad + idx * (barWidth + gap);
      const y = height - bottomMargin - barH;

      const brightness = 80 + Math.min(amp, 1.0) * 175 + delta * DELTA_BRIGHTNESS_BOOST;
      fill(brightness);
      rect(x, y, barWidth, barH);
    }
  }
}

// ── Tunnel visualization ────────────────────────────────────────

function drawTunnel() {
  const cx = width / 2;
  const cy = height / 2;
  const minDim = Math.min(width, height);
  const maxRadius = minDim * 0.32;
  const minRadius = minDim * 0.03;
  const radiusRange = maxRadius - minRadius;

  push();
  translate(cx, cy);
  noFill();

  for (let o = 0; o < OCTAVE_COUNT; o++) {
    // Octave 0 = outermost (bass), octave 9 = innermost (treble)
    const t = o / (OCTAVE_COUNT - 1); // 0 = outer, 1 = inner
    const perspT = Math.pow(t, TUNNEL_PERSPECTIVE_POWER);
    const baseRadius = maxRadius - perspT * radiusRange;

    const amp = smoothedOctaves[o];
    const tMult = octaveTransientValues[o];
    const delta = octaveDeltaValues[o];

    const energy = amp * tMult;
    const pulse = energy * TUNNEL_PULSE_SCALE * maxRadius * (1.0 + delta * DELTA_LENGTH_BOOST);
    const r = baseRadius + pulse;

    const brightness = TUNNEL_BASE_BRIGHTNESS + Math.min(energy, 1.0) * (255 - TUNNEL_BASE_BRIGHTNESS) + delta * DELTA_BRIGHTNESS_BOOST;
    const clampedBright = Math.min(brightness, 255);

    for (let p = 0; p < TUNNEL_GLOW_PASSES.length; p++) {
      const pass = TUNNEL_GLOW_PASSES[p];
      const sw = pass.widthMult * (1.5 + energy * 2.0);
      const alpha = clampedBright * pass.alphaMult;
      stroke(alpha);
      strokeWeight(sw);
      ellipse(0, 0, r * 2, r * 2);
    }
  }

  pop();
}

// ── Balls visualization ──────────────────────────────────────────

function initBalls() {
  balls = [];
  const bandCount = mode === 'freq' ? BAND_COUNT : STEMS.length;
  for (let i = 0; i < BALL_COUNT; i++) {
    const speed = 1 + Math.random() * 2;
    const angle = Math.random() * TWO_PI;
    balls.push({
      x: Math.random() * width,
      y: Math.random() * height,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      baseRadius: 8 + Math.random() * 20,
      band: i % bandCount,
    });
  }
}

function drawBalls() {
  // Kick detection — read transient from sub band (freq) or kick stem (stems)
  let kickTransient = 1.0;
  if (mode === 'freq') {
    kickTransient = transientValues[0];
  } else if (transientStemValues['kick'] !== undefined) {
    kickTransient = transientStemValues['kick'];
  }

  // Fast attack / slow decay for kick boost multiplier
  const targetBoost = 1.0 + (kickTransient - 1.0) * cfg.ballsKickBoost;
  if (targetBoost > kickBoostMultiplier) {
    kickBoostMultiplier += (targetBoost - kickBoostMultiplier) * 0.5;
  } else {
    kickBoostMultiplier += (targetBoost - kickBoostMultiplier) * 0.08;
  }

  const bandCount = mode === 'freq' ? BAND_COUNT : STEMS.length;

  noStroke();
  for (let i = 0; i < balls.length; i++) {
    const ball = balls[i];

    // Per-ball audio: read assigned band's amplitude, transient, delta
    let amp = 0;
    let tMult = 1.0;
    let delta = 0;
    const b = ball.band % bandCount;
    if (mode === 'freq') {
      // Mean of smoothed bins for this band
      const bins = smoothedBands[b];
      if (bins) {
        let sum = 0;
        for (let j = 0; j < bins.length; j++) sum += bins[j];
        amp = sum / bins.length;
      }
      tMult = transientValues[b];
      delta = deltaValues[b];
    } else {
      const stem = STEMS[b];
      if (stemSmoothed[stem]) {
        let sum = 0;
        for (let j = 0; j < stemSmoothed[stem].length; j++) sum += stemSmoothed[stem][j];
        amp = sum / stemSmoothed[stem].length;
      }
      if (transientStemValues[stem]) tMult = transientStemValues[stem];
      if (deltaStemValues[stem]) delta = deltaStemValues[stem];
    }

    // Physics: update position with kick boost and delta influence
    const speedMult = kickBoostMultiplier * (1 + delta * 0.5);
    ball.x += ball.vx * speedMult;
    ball.y += ball.vy * speedMult;

    // Bounce off walls
    if (ball.x < 0) { ball.x = 0; ball.vx = Math.abs(ball.vx); }
    else if (ball.x > width) { ball.x = width; ball.vx = -Math.abs(ball.vx); }
    if (ball.y < 0) { ball.y = 0; ball.vy = Math.abs(ball.vy); }
    else if (ball.y > height) { ball.y = height; ball.vy = -Math.abs(ball.vy); }

    // Size pulses with amplitude
    const scaledAmp = amp * cfg.spikeScale * tMult;
    const r = ball.baseRadius * (1 + scaledAmp * 1.5);

    // Brightness from amplitude + delta
    const brightness = 60 + Math.min(scaledAmp, 1.0) * 160 + delta * DELTA_BRIGHTNESS_BOOST;
    const clampedBright = Math.min(brightness, 255);

    // Outer halo (glow)
    fill(clampedBright * 0.25);
    ellipse(ball.x, ball.y, r * 3, r * 3);

    // Core circle
    fill(clampedBright);
    ellipse(ball.x, ball.y, r * 2, r * 2);
  }
}

// ── Audio initialisation (freq mode — unchanged) ─────────────────

async function initAudio(fileUrl) {
  disposeAudio();
  await Tone.start();

  // On mobile, fetching remote audio directly through Tone.Player can crash
  // the tab. Pre-fetch and convert to a blob URL to keep decoding local.
  let resolvedUrl = fileUrl;
  if (fileUrl.startsWith('http')) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);
    const resp = await fetch(fileUrl, { signal: controller.signal });
    clearTimeout(timeoutId);
    if (!resp.ok) throw new Error('Failed to fetch audio: HTTP ' + resp.status);
    const blob = await resp.blob();
    if (currentSampleBlobUrl) URL.revokeObjectURL(currentSampleBlobUrl);
    currentSampleBlobUrl = URL.createObjectURL(blob);
    resolvedUrl = currentSampleBlobUrl;
  }

  player = new Tone.Player({
    url: resolvedUrl,
    loop: true,
    autostart: false,
  });

  gainNode = new Tone.Gain(cfg.masterVolume);

  const fftSize = isMobile ? 128 : 256;

  player.connect(gainNode);
  gainNode.toDestination();

  fftFull = new Tone.FFT(fftSize);
  player.connect(fftFull);

  await Tone.loaded();
  audioReady = true;
}

function disposeAudio() {
  if (player) {
    player.stop();
    player.dispose();
    player = null;
  }
  if (gainNode) { gainNode.dispose(); gainNode = null; }
  if (fftFull) { fftFull.dispose(); fftFull = null; }
  if (currentSampleBlobUrl) { URL.revokeObjectURL(currentSampleBlobUrl); currentSampleBlobUrl = null; }
  resetAudioProcessingState();
  audioReady = false;
}

// ── Stem audio initialisation ────────────────────────────────────

async function initStemAudio(stemUrls) {
  disposeStemAudio();
  await Tone.start();

  stemMasterGain = new Tone.Gain(cfg.masterVolume);
  stemMasterGain.toDestination();

  const fftSize = isMobile ? 128 : 256;

  for (const stem of STEMS) {
    stemPlayers[stem] = new Tone.Player({
      url: stemUrls[stem],
      loop: true,
      autostart: false,
    });

    stemGainNodes[stem] = new Tone.Gain(1);
    stemPlayers[stem].connect(stemGainNodes[stem]);
    stemGainNodes[stem].connect(stemMasterGain);

    stemFfts[stem] = new Tone.FFT(fftSize);
    stemPlayers[stem].connect(stemFfts[stem]);

    stemSmoothed[stem] = new Float32Array(SPIKES_PER_BAND);
  }

  await Tone.loaded();
  audioReady = true;
}

function disposeStemAudio() {
  for (const stem of STEMS) {
    if (stemPlayers[stem]) {
      stemPlayers[stem].stop();
      stemPlayers[stem].dispose();
    }
    if (stemGainNodes[stem]) stemGainNodes[stem].dispose();
    if (stemFfts[stem]) stemFfts[stem].dispose();
  }
  stemPlayers = {};
  stemGainNodes = {};
  stemFfts = {};
  stemSmoothed = {};
  if (stemMasterGain) { stemMasterGain.dispose(); stemMasterGain = null; }
  resetAudioProcessingState();
  audioReady = false;
}

// ── Stem playback helpers ────────────────────────────────────────

function startAllStems(offset) {
  const time = '+0';
  for (const stem of STEMS) {
    if (stemPlayers[stem]) {
      stemPlayers[stem].start(time, offset || 0);
    }
  }
}

function stopAllStems() {
  for (const stem of STEMS) {
    if (stemPlayers[stem]) stemPlayers[stem].stop();
  }
}

function getStemDuration() {
  if (stemPlayers.kick && stemPlayers.kick.buffer) {
    return stemPlayers.kick.buffer.duration;
  }
  return 0;
}

// ── FFT helpers ──────────────────────────────────────────────────

function getFFTAmplitudes(fft, count, scaleFactor) {
  const vals = fft.getValue();
  const result = new Float32Array(count);
  const binsPer = Math.floor(vals.length / count);

  for (let i = 0; i < count; i++) {
    let sum = 0;
    let peak = 0;
    for (let j = 0; j < binsPer; j++) {
      const db = vals[i * binsPer + j];
      const lin = Math.pow(10, db / 20);
      sum += lin;
      if (lin > peak) peak = lin;
    }
    const avg = sum / binsPer;
    // Blend average with peak — peak dominates for punchy transients
    const blended = avg * 0.3 + peak * 0.7;
    result[i] = Math.min(blended * scaleFactor, 1.0);
  }
  return result;
}

function getLogBandAmplitudes(fft) {
  const vals = fft.getValue();
  const sampleRate = Tone.context.sampleRate;
  const fftSize = vals.length * 2;
  const binHz = sampleRate / fftSize;
  const results = [];

  for (let b = 0; b < BAND_COUNT; b++) {
    const band = BANDS[b];
    let loBin = Math.floor(band.loHz / binHz);
    let hiBin = Math.ceil(band.hiHz / binHz);
    loBin = Math.max(1, Math.min(loBin, vals.length - 1));
    hiBin = Math.max(loBin, Math.min(hiBin, vals.length - 1));

    const numBins = hiBin - loBin + 1;
    const result = new Float32Array(SPIKES_PER_BAND);

    if (numBins <= 0) {
      // No bins in range — use nearest bin, fill uniformly
      const nearestBin = Math.max(1, Math.min(Math.round(band.loHz / binHz), vals.length - 1));
      const db = vals[nearestBin];
      const lin = Math.pow(10, db / 20);
      const scaled = Math.min(lin * band.scale, 1.0);
      result.fill(scaled);
    } else {
      // Distribute bins into SPIKES_PER_BAND output slots
      const binsPerSlot = numBins / SPIKES_PER_BAND;

      for (let i = 0; i < SPIKES_PER_BAND; i++) {
        const slotStart = loBin + Math.floor(i * binsPerSlot);
        const slotEnd = Math.min(loBin + Math.floor((i + 1) * binsPerSlot), hiBin + 1);
        const count = Math.max(1, slotEnd - slotStart);

        let sum = 0;
        let peak = 0;
        for (let j = slotStart; j < slotStart + count; j++) {
          const binIdx = Math.min(j, vals.length - 1);
          const db = vals[binIdx];
          const lin = Math.pow(10, db / 20);
          sum += lin;
          if (lin > peak) peak = lin;
        }
        const avg = sum / count;
        const blended = avg * 0.3 + peak * 0.7;
        result[i] = Math.min(blended * band.scale, 1.0);
      }
    }

    results.push(result);
  }

  return results;
}

function getOctaveAmplitudes(fft) {
  const vals = fft.getValue();
  const sampleRate = Tone.context.sampleRate;
  const fftSize = vals.length * 2;
  const binHz = sampleRate / fftSize;
  const result = new Float32Array(OCTAVE_COUNT);

  for (let o = 0; o < OCTAVE_COUNT; o++) {
    const oct = OCTAVES[o];
    let loBin = Math.floor(oct.loHz / binHz);
    let hiBin = Math.ceil(oct.hiHz / binHz);
    loBin = Math.max(1, Math.min(loBin, vals.length - 1));
    hiBin = Math.max(loBin, Math.min(hiBin, vals.length - 1));

    const numBins = hiBin - loBin + 1;
    if (numBins <= 1) {
      // Sub-resolution octave — use nearest bin
      const nearestBin = Math.max(1, Math.min(Math.round(oct.loHz / binHz), vals.length - 1));
      const lin = Math.pow(10, vals[nearestBin] / 20);
      result[o] = Math.min(lin * OCTAVE_SCALES[o], 1.0);
    } else {
      let sum = 0;
      let peak = 0;
      for (let j = loBin; j <= hiBin; j++) {
        const lin = Math.pow(10, vals[j] / 20);
        sum += lin;
        if (lin > peak) peak = lin;
      }
      const avg = sum / numBins;
      const blended = avg * 0.3 + peak * 0.7;
      result[o] = Math.min(blended * OCTAVE_SCALES[o], 1.0);
    }
  }
  return result;
}

function getOctaveAmplitudesFromStems(stemFftsObj) {
  const combined = new Float32Array(OCTAVE_COUNT);
  let count = 0;
  for (const stem of STEMS) {
    if (!stemFftsObj[stem]) continue;
    const octAmps = getOctaveAmplitudes(stemFftsObj[stem]);
    for (let o = 0; o < OCTAVE_COUNT; o++) {
      combined[o] += octAmps[o];
    }
    count++;
  }
  if (count > 0) {
    for (let o = 0; o < OCTAVE_COUNT; o++) {
      combined[o] /= count;
    }
  }
  return combined;
}

function smoothBins(smoothed, raw, sensitivity, attack, release) {
  for (let i = 0; i < smoothed.length; i++) {
    const target = raw[i] * sensitivity;
    const rate = target > smoothed[i] ? attack : release;
    smoothed[i] += (target - smoothed[i]) * rate;
  }
}

// ── Auto-gain: rolling peak normalization ─────────────────────────

function updateAutoGain(tracker, rawBins) {
  let framePeak = 0;
  for (let i = 0; i < rawBins.length; i++) {
    if (rawBins[i] > framePeak) framePeak = rawBins[i];
  }
  tracker.peaks[tracker.idx] = Math.max(framePeak, AUTO_GAIN_FLOOR);
  tracker.idx = (tracker.idx + 1) % AUTO_GAIN_FRAMES;

  let rollingMax = 0;
  for (let i = 0; i < AUTO_GAIN_FRAMES; i++) {
    if (tracker.peaks[i] > rollingMax) rollingMax = tracker.peaks[i];
  }
  return rollingMax;
}

function applyAutoGain(rawBins, tracker) {
  const rollingMax = updateAutoGain(tracker, rawBins);
  const result = new Float32Array(rawBins.length);
  for (let i = 0; i < rawBins.length; i++) {
    result[i] = rawBins[i] / rollingMax;
  }
  return result;
}

// ── Transient detection ───────────────────────────────────────────

function updateTransient(state, rawBins) {
  let framePeak = 0;
  for (let i = 0; i < rawBins.length; i++) {
    if (rawBins[i] > framePeak) framePeak = rawBins[i];
  }

  state.avg += (framePeak - state.avg) * TRANSIENT_AVG_ALPHA;

  if (state.avg > AUTO_GAIN_FLOOR && framePeak / state.avg > TRANSIENT_THRESHOLD) {
    state.multiplier = TRANSIENT_BOOST;
  } else {
    state.multiplier = 1.0 + (state.multiplier - 1.0) * TRANSIENT_DECAY;
  }

  return state.multiplier;
}

// ── Delta (rate-of-change detection) ──────────────────────────────

function computeDelta(state, rawBins) {
  let sum = 0;
  for (let i = 0; i < rawBins.length; i++) sum += rawBins[i];
  const currentMean = sum / rawBins.length;

  const rawDelta = Math.max(0, currentMean - state.prevMean);
  state.prevMean = currentMean;

  const alpha = rawDelta > state.smoothed ? DELTA_ATTACK : DELTA_RELEASE;
  state.smoothed += (rawDelta - state.smoothed) * alpha;

  return Math.min(state.smoothed * 4, 1.0);
}

// ── Spectral centroid ─────────────────────────────────────────────

function computeSpectralCentroid(fft) {
  const vals = fft.getValue();
  const sampleRate = Tone.context.sampleRate;
  const binCount = vals.length;
  const binWidth = sampleRate / (binCount * 2);

  let weightedSum = 0;
  let energySum = 0;

  for (let i = 1; i < binCount; i++) {
    const db = vals[i];
    const energy = Math.pow(10, db / 20);
    const freq = i * binWidth;
    weightedSum += freq * energy;
    energySum += energy;
  }

  if (energySum < 1e-10) return CENTROID_LOW_HZ;
  return weightedSum / energySum;
}

function computeStemCentroid() {
  let totalWeightedCentroid = 0;
  let totalEnergy = 0;

  for (const stem of STEMS) {
    if (!stemFfts[stem]) continue;
    const vals = stemFfts[stem].getValue();
    let stemEnergy = 0;
    for (let i = 1; i < vals.length; i++) {
      stemEnergy += Math.pow(10, vals[i] / 20);
    }
    const centroid = computeSpectralCentroid(stemFfts[stem]);
    totalWeightedCentroid += centroid * stemEnergy;
    totalEnergy += stemEnergy;
  }

  if (totalEnergy < 1e-10) return CENTROID_LOW_HZ;
  return totalWeightedCentroid / totalEnergy;
}

function updateCentroid(centroidHz) {
  const clampedHz = Math.max(CENTROID_LOW_HZ, Math.min(centroidHz, CENTROID_HIGH_HZ));
  const normalized = (Math.log(clampedHz) - CENTROID_LOG_LOW) / CENTROID_LOG_RANGE;
  smoothedCentroid += (normalized - smoothedCentroid) * CENTROID_SMOOTHING;
  centroidYOffset = 0;
}

// ── Reset audio processing state on track change ──────────────────

function resetAudioProcessingState() {
  // Reset auto-gain trackers
  for (let b = 0; b < BAND_COUNT; b++) {
    autoGainBands[b].peaks.fill(AUTO_GAIN_FLOOR);
    autoGainBands[b].idx = 0;
  }
  for (const key in autoGainStems) delete autoGainStems[key];

  // Reset transient state
  for (let b = 0; b < BAND_COUNT; b++) {
    transientBands[b].avg = 0;
    transientBands[b].multiplier = 1.0;
  }
  transientValues.fill(1.0);
  for (const key in transientStems) delete transientStems[key];
  transientStemValues = {};

  // Reset delta
  for (let b = 0; b < BAND_COUNT; b++) {
    deltaBands[b].prevMean = 0;
    deltaBands[b].smoothed = 0;
  }
  deltaValues.fill(0);
  for (const key in deltaStems) delete deltaStems[key];
  deltaStemValues = {};

  // Reset smoothed bands
  for (let b = 0; b < BAND_COUNT; b++) {
    smoothedBands[b].fill(0);
  }

  // Reset centroid
  smoothedCentroid = 0.5;
  centroidYOffset = 0;

  // Reset octave state
  smoothedOctaves.fill(0);
  for (let o = 0; o < OCTAVE_COUNT; o++) {
    octaveTransients[o].avg = 0;
    octaveTransients[o].multiplier = 1.0;
    octaveDeltas[o].prevMean = 0;
    octaveDeltas[o].smoothed = 0;
  }
  octaveTransientValues.fill(1.0);
  octaveDeltaValues.fill(0);
  autoGainOctaves.peaks.fill(AUTO_GAIN_FLOOR);
  autoGainOctaves.idx = 0;

  // Reset balls state
  balls = [];
  kickBoostMultiplier = 1.0;
}

// ── Scrubber / playback position ─────────────────────────────────

function getPlaybackPosition() {
  if (mode === 'freq') {
    if (!player || !player.buffer || !player.buffer.duration) return 0;
    if (!isPlaying) return startOffset;
    const elapsed = Tone.now() - playStartedAt;
    const duration = player.buffer.duration;
    return (startOffset + elapsed) % duration;
  } else {
    const dur = getStemDuration();
    if (!dur) return 0;
    if (!isPlaying) return startOffset;
    const elapsed = Tone.now() - playStartedAt;
    return (startOffset + elapsed) % dur;
  }
}

function updateScrubber() {
  if (isSeeking) return;

  let dur;
  if (mode === 'freq') {
    if (!player || !player.buffer || !player.buffer.duration) return;
    dur = player.buffer.duration;
  } else {
    dur = getStemDuration();
    if (!dur) return;
  }

  const pos = getPlaybackPosition();
  const scrubber = document.getElementById('scrubber');
  scrubber.max = dur;
  scrubber.value = pos;
  document.getElementById('time-display').textContent =
    formatTime(pos) + ' / ' + formatTime(dur);
}

function formatTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return m + ':' + String(s).padStart(2, '0');
}

// ── DOM wiring ──────────────────────────────────────────────────

function wireDOM() {
  const sidebar = document.getElementById('sidebar');
  document.getElementById('sidebar-toggle').addEventListener('click', () => {
    sidebar.classList.toggle('open');
  });

  const audioInput = document.getElementById('audio-upload');
  const fileNameEl = document.getElementById('file-name');
  const playBtn = document.getElementById('play-btn');

  audioInput.addEventListener('change', (e) => {
    if (e.target.files.length) {
      userFile = e.target.files[0];
      useSample = false;
      fileNameEl.textContent = userFile.name;
      playBtn.disabled = false;
    }
  });

  document.getElementById('use-sample-btn').addEventListener('click', () => {
    useSample = true;
    userFile = null;
    fileNameEl.textContent = 'Sample track selected';
    playBtn.disabled = false;
  });

  // ── Mode toggle ────────────────────────────────────────────
  const modeFreqBtn = document.getElementById('mode-freq');
  const modeStemsBtn = document.getElementById('mode-stems');
  const freqSliders = document.getElementById('freq-sliders');
  const stemSliders = document.getElementById('stem-sliders');

  modeFreqBtn.addEventListener('click', () => {
    mode = 'freq';
    modeFreqBtn.classList.add('active');
    modeStemsBtn.classList.remove('active');
    freqSliders.classList.remove('hidden');
    stemSliders.classList.add('hidden');
    if (vizMode === 'balls') initBalls();
  });

  modeStemsBtn.addEventListener('click', () => {
    mode = 'stems';
    modeStemsBtn.classList.add('active');
    modeFreqBtn.classList.remove('active');
    stemSliders.classList.remove('hidden');
    freqSliders.classList.add('hidden');
    if (vizMode === 'balls') initBalls();
  });

  // ── Play button (mode-aware) ───────────────────────────────
  playBtn.addEventListener('click', async () => {
    const splash = document.getElementById('splash');
    const processing = document.getElementById('processing');

    if (mode === 'freq') {
      // ── Freq mode (existing flow) ─────────────────────────
      let url;
      if (useSample) {
        url = sampleUrl;
      } else if (userFile) {
        if (currentObjectUrl) URL.revokeObjectURL(currentObjectUrl);
        currentObjectUrl = URL.createObjectURL(userFile);
        url = currentObjectUrl;
      }

      if (!url) {
        fileNameEl.textContent = 'Please upload a track or use the sample first.';
        return;
      }

      playBtn.disabled = true;
      fileNameEl.textContent = 'Loading\u2026';

      try {
        await initAudio(url);
        splash.classList.add('hidden');
        document.getElementById('playback-bar').classList.add('visible');
        player.start();
        playStartedAt = Tone.now();
        startOffset = 0;
        isPlaying = true;
        document.getElementById('track-name').textContent =
          useSample ? 'Sample track' : userFile.name;
      } catch (err) {
        console.error('Audio init error:', err);
        fileNameEl.textContent = 'Error loading audio. Try another file.';
        playBtn.disabled = false;
      }
    } else {
      // ── Stem mode ─────────────────────────────────────────
      let stemUrls;

      if (useSample) {
        stemUrls = {
          kick: 'stems/sample/kick.mp3',
          drums: 'stems/sample/drums.mp3',
          bass: 'stems/sample/bass.mp3',
          vocals: 'stems/sample/vocals.mp3',
          other: 'stems/sample/other.mp3',
        };
      } else if (userFile) {
        // Upload to server for separation
        if (!userFile) {
          fileNameEl.textContent = 'Please upload a track or use the sample first.';
          return;
        }

        playBtn.disabled = true;
        splash.classList.add('hidden');
        processing.classList.remove('hidden');

        try {
          const formData = new FormData();
          formData.append('file', userFile);
          const resp = await fetch('/api/separate', {
            method: 'POST',
            body: formData,
          });
          if (!resp.ok) {
            const errData = await resp.json().catch(() => ({}));
            throw new Error(errData.error || 'Separation failed');
          }
          const data = await resp.json();
          stemUrls = data.stems;
        } catch (err) {
          console.error('Stem separation error:', err);
          processing.classList.add('hidden');
          splash.classList.remove('hidden');
          fileNameEl.textContent = 'Stem separation failed. Try frequency mode or another file.';
          playBtn.disabled = false;
          return;
        }
      }

      if (!stemUrls) {
        fileNameEl.textContent = 'Please upload a track or use the sample first.';
        return;
      }

      playBtn.disabled = true;
      if (!processing.classList.contains('hidden')) {
        document.getElementById('processing-text').textContent = 'Loading stems\u2026';
      } else {
        fileNameEl.textContent = 'Loading stems\u2026';
      }

      try {
        await initStemAudio(stemUrls);
        processing.classList.add('hidden');
        splash.classList.add('hidden');
        document.getElementById('playback-bar').classList.add('visible');
        startAllStems(0);
        playStartedAt = Tone.now();
        startOffset = 0;
        isPlaying = true;
        document.getElementById('track-name').textContent =
          useSample ? 'Sample track' : userFile.name;
      } catch (err) {
        console.error('Stem audio init error:', err);
        processing.classList.add('hidden');
        splash.classList.remove('hidden');
        fileNameEl.textContent = 'Error loading stems. Try another file.';
        playBtn.disabled = false;
      }
    }
  });

  // ── Pause button (mode-aware) ──────────────────────────────
  document.getElementById('pause-btn').addEventListener('click', () => {
    if (mode === 'freq') {
      if (!player) return;
      if (isPlaying) {
        startOffset = getPlaybackPosition();
        player.stop();
        isPlaying = false;
        document.getElementById('pause-btn').classList.remove('is-playing');
      } else {
        player.start('+0', startOffset);
        playStartedAt = Tone.now();
        isPlaying = true;
        document.getElementById('pause-btn').classList.add('is-playing');
      }
    } else {
      if (!stemPlayers.kick) return;
      if (isPlaying) {
        startOffset = getPlaybackPosition();
        stopAllStems();
        isPlaying = false;
        document.getElementById('pause-btn').classList.remove('is-playing');
      } else {
        startAllStems(startOffset);
        playStartedAt = Tone.now();
        isPlaying = true;
        document.getElementById('pause-btn').classList.add('is-playing');
      }
    }
  });

  // ── Track switching (playback bar, mode-aware) ─────────────
  const trackNameEl = document.getElementById('track-name');

  document.getElementById('sidebar-audio-upload').addEventListener('change', async (e) => {
    if (!e.target.files.length) return;
    userFile = e.target.files[0];
    useSample = false;

    if (mode === 'freq') {
      if (currentObjectUrl) URL.revokeObjectURL(currentObjectUrl);
      currentObjectUrl = URL.createObjectURL(userFile);
      trackNameEl.textContent = 'Loading\u2026';
      try {
        await initAudio(currentObjectUrl);
        player.start();
        playStartedAt = Tone.now();
        startOffset = 0;
        isPlaying = true;
        document.getElementById('pause-btn').classList.add('is-playing');
        trackNameEl.textContent = userFile.name;
      } catch (err) {
        console.error('Track switch error:', err);
        trackNameEl.textContent = 'Error loading audio.';
      }
    } else {
      // Stem mode: upload for separation
      const processing = document.getElementById('processing');
      processing.classList.remove('hidden');
      document.getElementById('processing-text').textContent = 'Separating stems\u2026';
      try {
        const formData = new FormData();
        formData.append('file', userFile);
        const resp = await fetch('/api/separate', {
          method: 'POST',
          body: formData,
        });
        if (!resp.ok) {
          const errData = await resp.json().catch(() => ({}));
          throw new Error(errData.error || 'Separation failed');
        }
        const data = await resp.json();
        document.getElementById('processing-text').textContent = 'Loading stems\u2026';
        await initStemAudio(data.stems);
        processing.classList.add('hidden');
        startAllStems(0);
        playStartedAt = Tone.now();
        startOffset = 0;
        isPlaying = true;
        document.getElementById('pause-btn').classList.add('is-playing');
        trackNameEl.textContent = userFile.name;
      } catch (err) {
        console.error('Stem switch error:', err);
        processing.classList.add('hidden');
        trackNameEl.textContent = 'Stem separation failed.';
      }
    }
  });

  // ── Volume (mode-aware) ────────────────────────────────────
  bindSlider('master-volume', (v) => {
    cfg.masterVolume = v;
    if (mode === 'freq') {
      if (gainNode) gainNode.gain.value = v;
    } else {
      if (stemMasterGain) stemMasterGain.gain.value = v;
    }
  });

  // ── Freq mode sliders (7 bands) ────────────────────────────
  for (const band of BANDS) {
    bindSlider(band.sliderId, (v) => { cfg[band.sens] = v; });
  }

  // ── Stem mode sliders ──────────────────────────────────────
  bindSlider('sens-kick', (v) => { cfg.sensKick = v; });
  bindSlider('sens-drums', (v) => { cfg.sensDrums = v; });
  bindSlider('sens-bass-stem', (v) => { cfg.sensStemBass = v; });
  bindSlider('sens-vocals', (v) => { cfg.sensVocals = v; });
  bindSlider('sens-other', (v) => { cfg.sensOther = v; });

  // ── Viz mode toggle ────────────────────────────────────────
  const vizCircleBtn = document.getElementById('viz-circle');
  const vizSpectrumBtn = document.getElementById('viz-spectrum');
  const vizTunnelBtn = document.getElementById('viz-tunnel');
  const vizBallsBtn = document.getElementById('viz-balls');
  const rotationSpeedGroup = document.getElementById('rotation-speed-group');
  const ballsKickBoostGroup = document.getElementById('balls-kick-boost-group');
  const vizBtns = [vizCircleBtn, vizSpectrumBtn, vizTunnelBtn, vizBallsBtn];

  function setVizMode(newMode) {
    vizMode = newMode;
    for (const btn of vizBtns) btn.classList.remove('active');
    if (newMode === 'circle') vizCircleBtn.classList.add('active');
    else if (newMode === 'spectrum') vizSpectrumBtn.classList.add('active');
    else if (newMode === 'tunnel') vizTunnelBtn.classList.add('active');
    else if (newMode === 'balls') vizBallsBtn.classList.add('active');
    // Rotation speed only applies to circle mode
    if (newMode === 'circle') rotationSpeedGroup.classList.remove('hidden');
    else rotationSpeedGroup.classList.add('hidden');
    // Kick boost only applies to balls mode
    if (newMode === 'balls') ballsKickBoostGroup.classList.remove('hidden');
    else ballsKickBoostGroup.classList.add('hidden');
    // Initialize balls when entering balls mode
    if (newMode === 'balls') initBalls();
  }

  vizCircleBtn.addEventListener('click', () => setVizMode('circle'));
  vizSpectrumBtn.addEventListener('click', () => setVizMode('spectrum'));
  vizTunnelBtn.addEventListener('click', () => setVizMode('tunnel'));
  vizBallsBtn.addEventListener('click', () => setVizMode('balls'));

  // ── Display sliders ────────────────────────────────────────
  bindSlider('spike-scale', (v) => { cfg.spikeScale = v; });
  bindSlider('rotation-speed', (v) => { cfg.rotationSpeed = v; });
  bindSlider('balls-kick-boost', (v) => { cfg.ballsKickBoost = v; });

  // ── Scrubber (mode-aware) ──────────────────────────────────
  const scrubber = document.getElementById('scrubber');
  scrubber.addEventListener('input', () => {
    isSeeking = true;
    const pos = parseFloat(scrubber.value);
    let dur;
    if (mode === 'freq') {
      dur = player && player.buffer ? player.buffer.duration : 0;
    } else {
      dur = getStemDuration();
    }
    document.getElementById('time-display').textContent =
      formatTime(pos) + ' / ' + formatTime(dur);
  });
  scrubber.addEventListener('change', () => {
    const pos = parseFloat(scrubber.value);
    if (mode === 'freq') {
      if (player && player.buffer) {
        startOffset = pos;
        if (isPlaying) {
          player.stop();
          player.start('+0', pos);
          playStartedAt = Tone.now();
        }
      }
    } else {
      if (getStemDuration()) {
        startOffset = pos;
        if (isPlaying) {
          stopAllStems();
          startAllStems(pos);
          playStartedAt = Tone.now();
        }
      }
    }
    isSeeking = false;
  });

  document.getElementById('randomize-btn').addEventListener('click', randomize);
}

function bindSlider(id, cb) {
  const el = document.getElementById(id);
  el.addEventListener('input', () => cb(parseFloat(el.value)));
}

// ── Randomize (mode-aware) ───────────────────────────────────────

function randomize() {
  const rand = (min, max) => Math.random() * (max - min) + min;

  if (mode === 'freq') {
    for (const band of BANDS) {
      setSlider(band.sliderId, rand(1.0, 3.0));
    }
  } else {
    setSlider('sens-kick', rand(1.0, 3.0));
    setSlider('sens-drums', rand(1.0, 3.0));
    setSlider('sens-bass-stem', rand(1.0, 3.0));
    setSlider('sens-vocals', rand(1.0, 3.0));
    setSlider('sens-other', rand(1.0, 3.0));
  }
  setSlider('spike-scale', rand(0.5, 2.0));
  if (vizMode === 'circle') {
    setSlider('rotation-speed', rand(0.0, 1.5));
  }
  if (vizMode === 'balls') {
    setSlider('balls-kick-boost', rand(1.0, 5.0));
  }
}

function setSlider(id, value) {
  const el = document.getElementById(id);
  el.value = value;
  el.dispatchEvent(new Event('input'));
}
