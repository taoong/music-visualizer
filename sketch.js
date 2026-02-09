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
let currentObjectUrl = null;
let currentImageUrl = null;
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
  sensBass: 1.5,
  sensMid: 1.3,
  sensTreble: 1.2,
  warpIntensity: 1.2,
  rotationSpeed: 0.5,
  feedback: 0.55,
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

  // HSV to RGB conversion
  vec3 hsv2rgb(vec3 c) {
    vec4 K = vec4(1.0, 2.0/3.0, 1.0/3.0, 3.0);
    vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
    return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
  }

  void main() {
    vec2 uv = vUv;
    vec2 center = vec2(0.5);

    // ── Bass → dramatic zoom pulse ──────────────────────────
    float scale = 1.0 - uBass * 0.45 * uWarp;
    uv = center + (uv - center) * scale;

    // ── Rotation (bass‑modulated) ───────────────────────────
    float rotAngle = uRotation * uTime + uBass * 0.8 * uWarp;
    uv = center + rotate2d(uv - center, rotAngle);

    // ── Vocals → sine‑wave warp distortion (much stronger) ─
    float wave  = sin(uv.y * 10.0 + uTime * 3.0) * uMid * 0.15 * uWarp;
    float wave2 = cos(uv.x * 8.0  + uTime * 2.2) * uMid * 0.12 * uWarp;
    float wave3 = sin(uv.y * 20.0 + uv.x * 15.0 + uTime * 4.0) * uMid * 0.06 * uWarp;
    uv.x += wave + wave3 * 0.5;
    uv.y += wave2 + wave3 * 0.5;

    // ── Treble → noise displacement (much stronger) ─────────
    float n = noise(uv * 6.0 + uTime * 0.8) - 0.5;
    float n2 = noise(uv * 14.0 - uTime * 1.2) - 0.5;
    uv += (n * 0.14 + n2 * 0.06) * uTreble * uWarp;

    // Mirror‑repeat UVs
    uv = abs(mod(uv, 2.0) - 1.0);

    // ── Sample texture ──────────────────────────────────────
    vec4 tex = texture2D(uTexture, uv);

    // ── Treble → heavy chromatic aberration ─────────────────
    float aberr = uTreble * 0.05 * uWarp;
    float r = texture2D(uTexture, uv + vec2(aberr, aberr * 0.5)).r;
    float g = tex.g;
    float b = texture2D(uTexture, uv - vec2(aberr, aberr * 0.5)).b;
    vec4 color = vec4(r, g, b, 1.0);

    // ── Bass → brightness pulse (flash on kicks) ────────────
    float bassPulse = uBass * uBass * 0.8;
    color.rgb += bassPulse;

    // ── Mids → hue shift / color rotation ───────────────────
    float hueShift = uMid * 0.4 + uTime * 0.05;
    float cosH = cos(hueShift);
    float sinH = sin(hueShift);
    mat3 hueRotMat = mat3(
      0.299 + 0.701*cosH + 0.168*sinH,  0.587 - 0.587*cosH + 0.330*sinH,  0.114 - 0.114*cosH - 0.497*sinH,
      0.299 - 0.299*cosH - 0.328*sinH,  0.587 + 0.413*cosH + 0.035*sinH,  0.114 - 0.114*cosH + 0.292*sinH,
      0.299 - 0.300*cosH + 1.250*sinH,  0.587 - 0.588*cosH - 1.050*sinH,  0.114 + 0.886*cosH - 0.203*sinH
    );
    color.rgb = hueRotMat * color.rgb;

    // ── Treble → scanline grain + glitch lines ──────────────
    float grain = hash(uv * uResolution + uTime) * uTreble * 0.25;
    float scanline = step(0.98, hash(vec2(floor(vUv.y * uResolution.y * 0.5), uTime))) * uTreble * 0.6;
    color.rgb += grain + scanline;

    // ── Treble → saturation boost ───────────────────────────
    float grey = dot(color.rgb, vec3(0.299, 0.587, 0.114));
    color.rgb = mix(vec3(grey), color.rgb, 1.0 + uTreble * 0.8);

    // ── Feedback blend (motion trails) ──────────────────────
    vec4 fb = texture2D(uFeedback, vUv);
    color = mix(color, fb, uFeedbackAmt);

    // ── Vignette (bass‑reactive — opens up on kicks) ────────
    float d = distance(vUv, center);
    float vignetteEdge = 0.35 + uBass * 0.25;
    color.rgb *= smoothstep(0.9, vignetteEdge, d);

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
    const rawBass = normaliseFFT(fftLow) * cfg.sensBass;
    const rawMid = normaliseFFT(fftMid) * cfg.sensMid;
    const rawTreble = normaliseFFT(fftHigh) * cfg.sensTreble;

    // Attack/release envelope: fast attack for punchy transients, slow release for smooth decay
    bassEnergy = rawBass > bassEnergy
      ? lerp(bassEnergy, rawBass, 0.7)    // fast attack
      : lerp(bassEnergy, rawBass, 0.08);  // slow release
    midEnergy = rawMid > midEnergy
      ? lerp(midEnergy, rawMid, 0.65)
      : lerp(midEnergy, rawMid, 0.10);
    trebleEnergy = rawTreble > trebleEnergy
      ? lerp(trebleEnergy, rawTreble, 0.75)  // treble fastest attack
      : lerp(trebleEnergy, rawTreble, 0.12);
  } else {
    bassEnergy *= 0.92;
    midEnergy *= 0.92;
    trebleEnergy *= 0.92;
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
  disposeAudio();
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
  audioReady = false;
}

function normaliseFFT(fft) {
  const vals = fft.getValue(); // Float32Array of dB values (-Infinity to 0)
  let sum = 0;
  let peak = 0;
  for (let i = 0; i < vals.length; i++) {
    const db = vals[i];
    const lin = Math.pow(10, db / 20); // dB to amplitude
    sum += lin;
    if (lin > peak) peak = lin;
  }
  const avg = sum / vals.length;
  // Blend average with peak for punch — peak detection catches transients
  const blended = avg * 0.4 + peak * 0.6;
  // Scale up aggressively so typical music reaches 0.6–1.0
  return Math.min(blended * 6.0, 1.0);
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
  warpShader.setUniform('uRotation', cfg.rotationSpeed * 0.15);
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
      if (currentObjectUrl) URL.revokeObjectURL(currentObjectUrl);
      currentObjectUrl = URL.createObjectURL(userFile);
      url = currentObjectUrl;
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
    disposeAudio();
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
      if (currentImageUrl) URL.revokeObjectURL(currentImageUrl);
      currentImageUrl = URL.createObjectURL(file);
      loadImage(currentImageUrl, (img) => {
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
  setSlider('feedback', rand(0.3, 0.75));

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
