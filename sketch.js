/* ================================================================
   Music Visualizer — sketch.js
   p5.js + Tone.js — Circle with frequency-driven spikes
   ================================================================ */

// ── State ────────────────────────────────────────────────────────
let audioReady = false;
let isPlaying = false;
let useSample = false;
let userFile = null;

// Tone.js nodes
let player = null;
let gainNode = null;
let lowFilter, midFilter, highFilter;
let fftLow, fftMid, fftHigh;

// Per-bin smoothed amplitudes for each frequency band
const SPIKES_PER_BAND = 60;
let smoothedLow = new Float32Array(SPIKES_PER_BAND);
let smoothedMid = new Float32Array(SPIKES_PER_BAND);
let smoothedHigh = new Float32Array(SPIKES_PER_BAND);

// GUI values (defaults — overridden by sliders)
const cfg = {
  sensBass: 2.0,
  sensMid: 2.0,
  sensTreble: 2.0,
  spikeScale: 1.2,
  rotationSpeed: 0.3,
  masterVolume: 0.8,
};

// ── p5.js lifecycle ─────────────────────────────────────────────

function setup() {
  const canvas = createCanvas(windowWidth, windowHeight);
  canvas.parent('canvas-container');
  pixelDensity(1);
  wireDOM();
}

function draw() {
  background(0);

  // ── Analyse audio per-bin ──────────────────────────────────
  if (isPlaying && player && player.state === 'started') {
    const rawLow = getFFTAmplitudes(fftLow, SPIKES_PER_BAND);
    const rawMid = getFFTAmplitudes(fftMid, SPIKES_PER_BAND);
    const rawHigh = getFFTAmplitudes(fftHigh, SPIKES_PER_BAND);

    smoothBins(smoothedLow, rawLow, cfg.sensBass, 0.82, 0.10);
    smoothBins(smoothedMid, rawMid, cfg.sensMid, 0.78, 0.12);
    smoothBins(smoothedHigh, rawHigh, cfg.sensTreble, 0.88, 0.14);
  } else {
    for (let i = 0; i < SPIKES_PER_BAND; i++) {
      smoothedLow[i] *= 0.88;
      smoothedMid[i] *= 0.88;
      smoothedHigh[i] *= 0.88;
    }
  }

  drawSpikeCircle();
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
}

// ── Spike circle visualization ───────────────────────────────────

function drawSpikeCircle() {
  const cx = width / 2;
  const cy = height / 2;
  const minDim = Math.min(width, height);
  const baseRadius = minDim * 0.12;
  const maxSpikeLen = minDim * 0.35;

  const totalSpikes = SPIKES_PER_BAND * 3;
  const angleStep = TWO_PI / totalSpikes;
  const rotation = millis() / 1000.0 * cfg.rotationSpeed * 0.4;

  push();
  translate(cx, cy);

  // Draw spikes as tapered triangles
  noStroke();
  for (let i = 0; i < totalSpikes; i++) {
    const angle = i * angleStep + rotation;
    const band = i % 3;
    const bandIdx = Math.floor(i / 3);

    let amp = 0;
    if (band === 0) amp = smoothedLow[bandIdx];
    else if (band === 1) amp = smoothedMid[bandIdx];
    else amp = smoothedHigh[bandIdx];

    amp *= cfg.spikeScale;

    const spikeLen = amp * maxSpikeLen;
    if (spikeLen < 0.5) continue;

    // Spike base half-width (angular) — wider for louder spikes
    const halfBase = angleStep * (0.25 + amp * 0.2);

    const innerR = baseRadius;
    const outerR = baseRadius + spikeLen;

    // Brightness scales with amplitude
    const brightness = 120 + Math.min(amp, 1.0) * 135;
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

// ── Audio initialisation ────────────────────────────────────────

async function initAudio(fileUrl) {
  await Tone.start();

  player = new Tone.Player({
    url: fileUrl,
    loop: true,
    autostart: false,
  });

  gainNode = new Tone.Gain(cfg.masterVolume);

  lowFilter = new Tone.Filter({ frequency: 150, type: 'lowpass', rolloff: -24 });
  midFilter = new Tone.Filter({ frequency: 400, type: 'bandpass', rolloff: -24 });
  midFilter.Q.value = 1.2;
  highFilter = new Tone.Filter({ frequency: 5000, type: 'highpass', rolloff: -24 });

  fftLow = new Tone.FFT(256);
  fftMid = new Tone.FFT(256);
  fftHigh = new Tone.FFT(256);

  player.connect(gainNode);
  gainNode.toDestination();

  player.connect(lowFilter);
  lowFilter.connect(fftLow);

  player.connect(midFilter);
  midFilter.connect(fftMid);

  player.connect(highFilter);
  highFilter.connect(fftHigh);

  await Tone.loaded();
  audioReady = true;
}

// ── FFT helpers ──────────────────────────────────────────────────

function getFFTAmplitudes(fft, count) {
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
    result[i] = Math.min(blended * 10.0, 1.0);
  }
  return result;
}

function smoothBins(smoothed, raw, sensitivity, attack, release) {
  for (let i = 0; i < smoothed.length; i++) {
    const target = raw[i] * sensitivity;
    const rate = target > smoothed[i] ? attack : release;
    smoothed[i] += (target - smoothed[i]) * rate;
  }
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

  playBtn.addEventListener('click', async () => {
    const splash = document.getElementById('splash');
    splash.classList.add('hidden');

    let url;
    if (useSample) {
      url = 'https://tonejs.github.io/audio/berklee/guit_harmonics_01.mp3';
    } else if (userFile) {
      url = URL.createObjectURL(userFile);
    }

    try {
      await initAudio(url);
      player.start();
      isPlaying = true;
      sidebar.classList.add('open');
    } catch (err) {
      console.error('Audio init error:', err);
      fileNameEl.textContent = 'Error loading audio. Try another file.';
      splash.classList.remove('hidden');
    }
  });

  document.getElementById('pause-btn').addEventListener('click', () => {
    if (!player) return;
    if (isPlaying) {
      player.stop();
      isPlaying = false;
      document.getElementById('pause-btn').textContent = 'Resume';
    } else {
      player.start();
      isPlaying = true;
      document.getElementById('pause-btn').textContent = 'Pause';
    }
  });

  document.getElementById('stop-btn').addEventListener('click', () => {
    if (!player) return;
    player.stop();
    isPlaying = false;
    document.getElementById('pause-btn').textContent = 'Resume';
  });

  bindSlider('master-volume', (v) => {
    cfg.masterVolume = v;
    if (gainNode) gainNode.gain.value = v;
  });
  bindSlider('sens-bass', (v) => { cfg.sensBass = v; });
  bindSlider('sens-mid', (v) => { cfg.sensMid = v; });
  bindSlider('sens-treble', (v) => { cfg.sensTreble = v; });
  bindSlider('spike-scale', (v) => { cfg.spikeScale = v; });
  bindSlider('rotation-speed', (v) => { cfg.rotationSpeed = v; });

  document.getElementById('randomize-btn').addEventListener('click', randomize);
}

function bindSlider(id, cb) {
  const el = document.getElementById(id);
  el.addEventListener('input', () => cb(parseFloat(el.value)));
}

// ── Randomize ───────────────────────────────────────────────────

function randomize() {
  const rand = (min, max) => Math.random() * (max - min) + min;

  setSlider('sens-bass', rand(1.0, 3.0));
  setSlider('sens-mid', rand(1.0, 3.0));
  setSlider('sens-treble', rand(1.0, 3.0));
  setSlider('spike-scale', rand(0.5, 2.0));
  setSlider('rotation-speed', rand(0.0, 1.5));
}

function setSlider(id, value) {
  const el = document.getElementById(id);
  el.value = value;
  el.dispatchEvent(new Event('input'));
}
