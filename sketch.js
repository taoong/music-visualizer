/* ================================================================
   Music Visualizer — sketch.js
   p5.js (WEBGL) + Tone.js
   ================================================================ */

// ── State ────────────────────────────────────────────────────────
let audioReady = false;
let isPlaying = false;
let useSample = false;
let userFile = null;
let userImage = null;
let defaultImg = null; // generated at setup
let feedbackGraphics = null;

// Tone.js nodes
let player = null;
let gainNode = null;
let lowFilter, midFilter, highFilter;
let fftLow, fftMid, fftHigh;

// Analysed energy (smoothed 0‒1)
let bassEnergy = 0;
let midEnergy = 0;
let trebleEnergy = 0;

// GUI values (defaults — overridden by sliders)
const cfg = {
  sensBass: 1.0,
  sensMid: 1.0,
  sensTreble: 1.0,
  warpIntensity: 1.0,
  rotationSpeed: 0.3,
  feedback: 0.85,
  masterVolume: 0.8,
};

// Shader source (embedded)
const vertSrc = `
  precision mediump float;
  attribute vec3 aPosition;
  attribute vec2 aTexCoord;
  varying vec2 vUv;
  void main() {
    vUv = aTexCoord;
    vec4 pos = vec4(aPosition, 1.0);
    pos.xy = pos.xy * 2.0 - 1.0;
    gl_Position = pos;
  }
`;

const fragSrc = `
  precision mediump float;

  varying vec2 vUv;

  uniform sampler2D uTexture;
  uniform sampler2D uFeedback;
  uniform float uTime;
  uniform float uBass;
  uniform float uMid;
  uniform float uTreble;
  uniform float uWarp;
  uniform float uRotation;
  uniform float uFeedbackAmt;
  uniform vec2  uResolution;

  // ── helpers ───────────────────────────────────────────────
  vec2 rotate2d(vec2 p, float a) {
    float s = sin(a);
    float c = cos(a);
    return vec2(c * p.x - s * p.y, s * p.x + c * p.y);
  }

  // Simple 2D noise (hash‑based)
  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }

  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    float a = hash(i);
    float b = hash(i + vec2(1.0, 0.0));
    float c = hash(i + vec2(0.0, 1.0));
    float d = hash(i + vec2(1.0, 1.0));
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(a, b, u.x) + (c - a) * u.y * (1.0 - u.x) + (d - b) * u.x * u.y;
  }

  void main() {
    vec2 uv = vUv;
    vec2 center = vec2(0.5);

    // ── Bass → scale / expansion ────────────────────────────
    float scale = 1.0 - uBass * 0.15 * uWarp;
    uv = center + (uv - center) * scale;

    // ── Rotation (bass‑modulated) ───────────────────────────
    uv = center + rotate2d(uv - center, uRotation * uTime + uBass * 0.3 * uWarp);

    // ── Vocals → sine‑wave warp distortion ──────────────────
    float wave = sin(uv.y * 12.0 + uTime * 2.5) * uMid * 0.04 * uWarp;
    float wave2 = cos(uv.x * 10.0 + uTime * 1.8) * uMid * 0.03 * uWarp;
    uv.x += wave;
    uv.y += wave2;

    // ── Treble → noise displacement ─────────────────────────
    float n = noise(uv * 8.0 + uTime * 0.5) - 0.5;
    uv += n * uTreble * 0.05 * uWarp;

    // Clamp UVs for mirror‑repeat feel
    uv = clamp(uv, 0.0, 1.0);

    // ── Sample texture ──────────────────────────────────────
    vec4 tex = texture2D(uTexture, uv);

    // ── Treble → RGB split / chromatic aberration ───────────
    float aberr = uTreble * 0.012 * uWarp;
    float r = texture2D(uTexture, uv + vec2(aberr, 0.0)).r;
    float g = tex.g;
    float b = texture2D(uTexture, uv - vec2(aberr, 0.0)).b;
    vec4 color = vec4(r, g, b, 1.0);

    // ── Treble → scanline grain ─────────────────────────────
    float grain = hash(uv * uResolution + uTime) * uTreble * 0.15;
    color.rgb += grain;

    // ── Feedback blend (motion trails) ──────────────────────
    vec4 fb = texture2D(uFeedback, vUv);
    color = mix(color, fb, uFeedbackAmt);

    // ── Subtle vignette ─────────────────────────────────────
    float d = distance(vUv, center);
    color.rgb *= smoothstep(0.9, 0.35, d);

    gl_FragColor = color;
  }
`;

// ── p5.js lifecycle ─────────────────────────────────────────────

function setup() {
  const canvas = createCanvas(windowWidth, windowHeight, WEBGL);
  canvas.parent('canvas-container');
  pixelDensity(1);

  // Offscreen buffer for feedback
  feedbackGraphics = createGraphics(width, height, WEBGL);
  feedbackGraphics.pixelDensity(1);

  // Generate default procedural image
  defaultImg = createDefaultImage();

  // Wire up DOM
  wireDOM();
}

function draw() {
  background(0);

  // ── Analyse audio ─────────────────────────────────────────
  if (isPlaying && player && player.state === 'started') {
    bassEnergy = lerp(bassEnergy, normaliseFFT(fftLow) * cfg.sensBass, 0.25);
    midEnergy = lerp(midEnergy, normaliseFFT(fftMid) * cfg.sensMid, 0.2);
    trebleEnergy = lerp(trebleEnergy, normaliseFFT(fftHigh) * cfg.sensTreble, 0.22);
  } else {
    bassEnergy *= 0.95;
    midEnergy *= 0.95;
    trebleEnergy *= 0.95;
  }

  // ── Determine source image ────────────────────────────────
  const img = userImage || defaultImg;

  // ── Draw warped image via shader ──────────────────────────
  drawWarpedScene(img);
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
  feedbackGraphics.resizeCanvas(width, height);
}

// ── Audio initialisation ────────────────────────────────────────

async function initAudio(fileUrl) {
  await Tone.start();

  // Player
  player = new Tone.Player({
    url: fileUrl,
    loop: true,
    autostart: false,
  });

  // Gain
  gainNode = new Tone.Gain(cfg.masterVolume);

  // Filters + FFTs
  lowFilter = new Tone.Filter({ frequency: 150, type: 'lowpass', rolloff: -24 });
  midFilter = new Tone.Filter({ frequency: 400, type: 'bandpass', rolloff: -24 });
  midFilter.Q.value = 1.2;
  highFilter = new Tone.Filter({ frequency: 5000, type: 'highpass', rolloff: -24 });

  fftLow = new Tone.FFT(256);
  fftMid = new Tone.FFT(256);
  fftHigh = new Tone.FFT(256);

  // Route: player → gain → destination
  //        player → lowFilter → fftLow
  //        player → midFilter → fftMid
  //        player → highFilter → fftHigh
  player.connect(gainNode);
  gainNode.toDestination();

  player.connect(lowFilter);
  lowFilter.connect(fftLow);

  player.connect(midFilter);
  midFilter.connect(fftMid);

  player.connect(highFilter);
  highFilter.connect(fftHigh);

  // Wait for buffer to load
  await Tone.loaded();
  audioReady = true;
}

function normaliseFFT(fft) {
  const vals = fft.getValue(); // Float32Array of dB values (-Infinity to 0)
  let sum = 0;
  for (let i = 0; i < vals.length; i++) {
    // Convert dB to linear 0–1 range
    const db = vals[i];
    const lin = Math.pow(10, db / 20); // dB to amplitude
    sum += lin;
  }
  const avg = sum / vals.length;
  // Scale up; typical averages are small
  return Math.min(avg * 4.0, 1.0);
}

// ── Shader rendering ────────────────────────────────────────────

let warpShader = null;

function drawWarpedScene(img) {
  // Lazy-create shader
  if (!warpShader) {
    warpShader = createShader(vertSrc, fragSrc);
  }

  // Capture current canvas into feedback buffer (copy previous frame)
  feedbackGraphics.clear();
  feedbackGraphics.image(get(), -feedbackGraphics.width / 2, -feedbackGraphics.height / 2, feedbackGraphics.width, feedbackGraphics.height);

  shader(warpShader);
  warpShader.setUniform('uTexture', img);
  warpShader.setUniform('uFeedback', feedbackGraphics);
  warpShader.setUniform('uTime', millis() / 1000.0);
  warpShader.setUniform('uBass', bassEnergy);
  warpShader.setUniform('uMid', midEnergy);
  warpShader.setUniform('uTreble', trebleEnergy);
  warpShader.setUniform('uWarp', cfg.warpIntensity);
  warpShader.setUniform('uRotation', cfg.rotationSpeed * 0.05);
  warpShader.setUniform('uFeedbackAmt', cfg.feedback);
  warpShader.setUniform('uResolution', [width, height]);

  rect(0, 0, width, height);
}

// ── Default procedural image ────────────────────────────────────

function createDefaultImage() {
  const g = createGraphics(512, 512);
  g.colorMode(HSB, 360, 100, 100);
  g.noStroke();

  // Gradient + circles pattern
  for (let y = 0; y < 512; y += 4) {
    for (let x = 0; x < 512; x += 4) {
      const hue = (x + y) * 0.35 % 360;
      const sat = 70 + Math.sin(x * 0.02) * 20;
      const bri = 60 + Math.cos(y * 0.03) * 30;
      g.fill(hue, sat, bri);
      g.rect(x, y, 4, 4);
    }
  }

  // Overlay some circles
  for (let i = 0; i < 20; i++) {
    g.fill(Math.random() * 360, 80, 90, 0.3);
    const sz = 40 + Math.random() * 120;
    g.ellipse(Math.random() * 512, Math.random() * 512, sz, sz);
  }

  return g;
}

// ── DOM wiring ──────────────────────────────────────────────────

function wireDOM() {
  // Sidebar toggle
  const sidebar = document.getElementById('sidebar');
  document.getElementById('sidebar-toggle').addEventListener('click', () => {
    sidebar.classList.toggle('open');
  });

  // File upload
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

  // Sample track
  document.getElementById('use-sample-btn').addEventListener('click', () => {
    useSample = true;
    userFile = null;
    fileNameEl.textContent = 'Sample track selected';
    playBtn.disabled = false;
  });

  // Play
  playBtn.addEventListener('click', async () => {
    const splash = document.getElementById('splash');
    splash.classList.add('hidden');

    let url;
    if (useSample) {
      // Use a royalty-free sample — the Tone.js example piano loop
      url = 'https://tonejs.github.io/audio/berklee/guit_harmonics_01.mp3';
    } else if (userFile) {
      url = URL.createObjectURL(userFile);
    }

    try {
      await initAudio(url);
      player.start();
      isPlaying = true;
      // Open sidebar after start
      sidebar.classList.add('open');
    } catch (err) {
      console.error('Audio init error:', err);
      fileNameEl.textContent = 'Error loading audio. Try another file.';
      splash.classList.remove('hidden');
    }
  });

  // Pause / Stop
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

  // Sliders
  bindSlider('master-volume', (v) => {
    cfg.masterVolume = v;
    if (gainNode) gainNode.gain.value = v;
  });
  bindSlider('sens-bass', (v) => { cfg.sensBass = v; });
  bindSlider('sens-mid', (v) => { cfg.sensMid = v; });
  bindSlider('sens-treble', (v) => { cfg.sensTreble = v; });
  bindSlider('warp-intensity', (v) => { cfg.warpIntensity = v; });
  bindSlider('rotation-speed', (v) => { cfg.rotationSpeed = v; });
  bindSlider('feedback', (v) => { cfg.feedback = v; });

  // Image upload
  document.getElementById('img-upload').addEventListener('change', (e) => {
    if (e.target.files.length) {
      const file = e.target.files[0];
      document.getElementById('img-file-name').textContent = file.name;
      const url = URL.createObjectURL(file);
      loadImage(url, (img) => {
        userImage = img;
      });
    }
  });

  // Randomize
  document.getElementById('randomize-btn').addEventListener('click', randomize);
}

function bindSlider(id, cb) {
  const el = document.getElementById(id);
  el.addEventListener('input', () => cb(parseFloat(el.value)));
}

// ── Randomize ───────────────────────────────────────────────────

function randomize() {
  const rand = (min, max) => Math.random() * (max - min) + min;

  setSlider('sens-bass', rand(0.5, 2.5));
  setSlider('sens-mid', rand(0.5, 2.5));
  setSlider('sens-treble', rand(0.5, 2.5));
  setSlider('warp-intensity', rand(0.3, 1.8));
  setSlider('rotation-speed', rand(0.0, 1.5));
  setSlider('feedback', rand(0.5, 0.95));

  // Generate a fresh procedural image with random palette
  defaultImg = createRandomImage();
  if (!userImage) {
    // Only swap if no user image loaded
  }
}

function setSlider(id, value) {
  const el = document.getElementById(id);
  el.value = value;
  el.dispatchEvent(new Event('input'));
}

function createRandomImage() {
  const g = createGraphics(512, 512);
  g.colorMode(HSB, 360, 100, 100);
  g.noStroke();

  const hueBase = Math.random() * 360;
  const hueRange = 40 + Math.random() * 120;

  for (let y = 0; y < 512; y += 4) {
    for (let x = 0; x < 512; x += 4) {
      const hue = (hueBase + (x * y * 0.001) * hueRange / 512) % 360;
      const sat = 50 + Math.random() * 40;
      const bri = 40 + Math.sin(x * 0.03 + y * 0.02) * 40 + 20;
      g.fill(hue, sat, bri);
      g.rect(x, y, 4, 4);
    }
  }

  // Random shapes overlay
  const shapes = Math.floor(5 + Math.random() * 20);
  for (let i = 0; i < shapes; i++) {
    g.fill((hueBase + Math.random() * hueRange) % 360, 70 + Math.random() * 30, 70 + Math.random() * 30, 0.25);
    const sz = 20 + Math.random() * 180;
    if (Math.random() > 0.5) {
      g.ellipse(Math.random() * 512, Math.random() * 512, sz, sz);
    } else {
      g.rect(Math.random() * 512, Math.random() * 512, sz, sz * (0.5 + Math.random()));
    }
  }

  return g;
}
