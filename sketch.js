/* ================================================================
   Music Visualizer — sketch.js
   p5.js + Tone.js — Circle with frequency-driven spikes
   Dual mode: Frequency Bands (default) + Stem Separation (experimental)
   ================================================================ */

// ── Mode state ──────────────────────────────────────────────────
let mode = 'freq'; // 'freq' or 'stems'
let vizMode = 'circle'; // 'circle' or 'spectrum'

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

// ── Freq-mode Tone.js nodes (existing) ──────────────────────────
let player = null;
let gainNode = null;
let lowFilter, midFilter, highFilter;
let fftLow, fftMid, fftHigh;

const sampleUrl = 'sample.mp3';

// Mobile detection
const isMobile = /Android|iPhone|iPad|iPod|webOS/i.test(navigator.userAgent)
  || (navigator.maxTouchPoints > 1 && window.innerWidth < 1024);

// Per-bin smoothed amplitudes for each frequency band
const SPIKES_PER_BAND = isMobile ? 30 : 60;
let smoothedLow = new Float32Array(SPIKES_PER_BAND);
let smoothedMid = new Float32Array(SPIKES_PER_BAND);
let smoothedHigh = new Float32Array(SPIKES_PER_BAND);

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
  // Freq mode
  sensBass: 2.0,
  sensMid: 2.0,
  sensTreble: 2.0,
  // Stem mode
  sensKick: 2.0,
  sensDrums: 2.0,
  sensStemBass: 2.0,
  sensVocals: 2.0,
  sensOther: 2.0,
  // Shared
  spikeScale: 1.2,
  rotationSpeed: 0.3,
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
    // ── Freq mode: analyse audio per-bin ────────────────────
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
  } else {
    // ── Stem mode: analyse each stem's FFT ──────────────────
    const anyPlaying = isPlaying && stemPlayers.kick &&
      stemPlayers.kick.state === 'started';

    if (anyPlaying) {
      for (const stem of STEMS) {
        if (!stemFfts[stem] || !stemSmoothed[stem]) continue;
        const raw = getFFTAmplitudes(stemFfts[stem], SPIKES_PER_BAND);
        const sensKey = STEM_SENS_KEYS[stem];
        const [attack, release] = STEM_SMOOTHING[stem];
        smoothBins(stemSmoothed[stem], raw, cfg[sensKey], attack, release);
      }
    } else {
      for (const stem of STEMS) {
        if (!stemSmoothed[stem]) continue;
        for (let i = 0; i < SPIKES_PER_BAND; i++) {
          stemSmoothed[stem][i] *= 0.88;
        }
      }
    }
  }

  updateScrubber();
  if (vizMode === 'spectrum') {
    drawSpectrum();
  } else {
    drawSpikeCircle();
  }
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

  let totalSpikes, bandCount;
  if (mode === 'freq') {
    bandCount = 3;
    totalSpikes = SPIKES_PER_BAND * 3;
  } else {
    bandCount = 5;
    totalSpikes = SPIKES_PER_BAND * 5;
  }

  const angleStep = TWO_PI / totalSpikes;
  const rotation = millis() / 1000.0 * cfg.rotationSpeed * 0.4;

  push();
  translate(cx, cy);

  // Draw spikes as tapered triangles
  noStroke();
  for (let i = 0; i < totalSpikes; i++) {
    const angle = i * angleStep + rotation;
    const band = i % bandCount;
    const bandIdx = Math.floor(i / bandCount);

    let amp = 0;
    if (mode === 'freq') {
      if (band === 0) amp = smoothedLow[bandIdx];
      else if (band === 1) amp = smoothedMid[bandIdx];
      else amp = smoothedHigh[bandIdx];
    } else {
      const stem = STEMS[band];
      if (stemSmoothed[stem]) amp = stemSmoothed[stem][bandIdx];
    }

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

// ── Spectrum visualization ─────────────────────────────────────────

function drawSpectrum() {
  const hPad = 40;
  const bottomMargin = 60;
  const maxBarHeight = height * 0.7;

  let bandCount, totalBars;
  if (mode === 'freq') {
    bandCount = 3;
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
      if (mode === 'freq') {
        if (b === 0) amp = smoothedLow[i];
        else if (b === 1) amp = smoothedMid[i];
        else amp = smoothedHigh[i];
      } else {
        const stem = STEMS[b];
        if (stemSmoothed[stem]) amp = stemSmoothed[stem][i];
      }

      amp *= cfg.spikeScale;

      const barH = amp * maxBarHeight;
      if (barH < 0.5) continue;

      const x = hPad + idx * (barWidth + gap);
      const y = height - bottomMargin - barH;

      const brightness = 80 + Math.min(amp, 1.0) * 175;
      fill(brightness);
      rect(x, y, barWidth, barH);
    }
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

  lowFilter = new Tone.Filter({ frequency: 150, type: 'lowpass', rolloff: -24 });
  midFilter = new Tone.Filter({ frequency: 400, type: 'bandpass', rolloff: -24 });
  midFilter.Q.value = 1.2;
  highFilter = new Tone.Filter({ frequency: 5000, type: 'highpass', rolloff: -24 });

  const fftSize = isMobile ? 128 : 256;
  fftLow = new Tone.FFT(fftSize);
  fftMid = new Tone.FFT(fftSize);
  fftHigh = new Tone.FFT(fftSize);

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

function disposeAudio() {
  if (player) {
    player.stop();
    player.dispose();
    player = null;
  }
  if (gainNode) { gainNode.dispose(); gainNode = null; }
  if (lowFilter) { lowFilter.dispose(); lowFilter = null; }
  if (midFilter) { midFilter.dispose(); midFilter = null; }
  if (highFilter) { highFilter.dispose(); highFilter = null; }
  if (fftLow) { fftLow.dispose(); fftLow = null; }
  if (fftMid) { fftMid.dispose(); fftMid = null; }
  if (fftHigh) { fftHigh.dispose(); fftHigh = null; }
  if (currentSampleBlobUrl) { URL.revokeObjectURL(currentSampleBlobUrl); currentSampleBlobUrl = null; }
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
  });

  modeStemsBtn.addEventListener('click', () => {
    mode = 'stems';
    modeStemsBtn.classList.add('active');
    modeFreqBtn.classList.remove('active');
    stemSliders.classList.remove('hidden');
    freqSliders.classList.add('hidden');
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

  // ── Freq mode sliders ──────────────────────────────────────
  bindSlider('sens-bass', (v) => { cfg.sensBass = v; });
  bindSlider('sens-mid', (v) => { cfg.sensMid = v; });
  bindSlider('sens-treble', (v) => { cfg.sensTreble = v; });

  // ── Stem mode sliders ──────────────────────────────────────
  bindSlider('sens-kick', (v) => { cfg.sensKick = v; });
  bindSlider('sens-drums', (v) => { cfg.sensDrums = v; });
  bindSlider('sens-bass-stem', (v) => { cfg.sensStemBass = v; });
  bindSlider('sens-vocals', (v) => { cfg.sensVocals = v; });
  bindSlider('sens-other', (v) => { cfg.sensOther = v; });

  // ── Viz mode toggle ────────────────────────────────────────
  const vizCircleBtn = document.getElementById('viz-circle');
  const vizSpectrumBtn = document.getElementById('viz-spectrum');

  vizCircleBtn.addEventListener('click', () => {
    vizMode = 'circle';
    vizCircleBtn.classList.add('active');
    vizSpectrumBtn.classList.remove('active');
  });

  vizSpectrumBtn.addEventListener('click', () => {
    vizMode = 'spectrum';
    vizSpectrumBtn.classList.add('active');
    vizCircleBtn.classList.remove('active');
  });

  // ── Display sliders ────────────────────────────────────────
  bindSlider('spike-scale', (v) => { cfg.spikeScale = v; });
  bindSlider('rotation-speed', (v) => { cfg.rotationSpeed = v; });

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
    setSlider('sens-bass', rand(1.0, 3.0));
    setSlider('sens-mid', rand(1.0, 3.0));
    setSlider('sens-treble', rand(1.0, 3.0));
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
}

function setSlider(id, value) {
  const el = document.getElementById(id);
  el.value = value;
  el.dispatchEvent(new Event('input'));
}
