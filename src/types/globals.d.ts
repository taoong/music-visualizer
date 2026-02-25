/**
 * Global type declarations for CDN-loaded libraries
 */

declare global {
  // p5.js type stubs for CDN usage
  const p5: {
    new (sketch: (p: P5Instance) => void): P5Instance;
    prototype: P5Instance;
  };

  interface P5Image {
    width: number;
    height: number;
    canvas: HTMLCanvasElement;
  }

  interface P5Instance {
    // Core properties
    width: number;
    height: number;
    deltaTime: number;
    millis(): number;
    drawingContext: CanvasRenderingContext2D;

    // Constants (accessed via bracket notation)
    TWO_PI: number;
    PI: number;
    HALF_PI: number;
    HSB: string;
    RGB: string;
    CLOSE: number;
    CENTER: string;

    // Setup/Lifecycle
    createCanvas(w: number, h: number): { parent(id: string): void };
    resizeCanvas(w: number, h: number): void;
    pixelDensity(d: number): void;
    frameRate(fps: number): void;

    // Drawing
    background(color: number | string): void;
    push(): void;
    pop(): void;
    translate(x: number, y: number): void;
    rotate(angle: number): void;
    scale(x: number, y?: number): void;

    // Shapes
    ellipse(x: number, y: number, w: number, h?: number): void;
    rect(x: number, y: number, w: number, h?: number): void;
    vertex(x: number, y: number): void;
    beginShape(): void;
    endShape(mode?: number): void;
    line(x1: number, y1: number, x2: number, y2: number): void;
    point(x: number, y: number): void;
    curveVertex(x: number, y: number): void;

    // Style
    fill(color: number | string): void;
    noFill(): void;
    stroke(color: number | string, s?: number, b?: number): void;
    noStroke(): void;
    strokeWeight(weight: number): void;
    colorMode(mode: string | number, max1?: number, max2?: number, max3?: number, maxA?: number): void;
    text(str: string, x: number, y: number): void;
    textSize(size: number): void;
    textAlign(h: string | number, v?: string | number): void;
    textStyle(style: string): void;
    textWidth(str: string): number;

    // Images
    loadImage(path: string, successCallback?: (img: P5Image) => void, failureCallback?: () => void): P5Image;
    image(img: P5Image, x: number, y: number, w?: number, h?: number): void;
    imageMode(mode: string): void;
    tint(v1: number, v2?: number, v3?: number, alpha?: number): void;
    noTint(): void;

    // Math
    cos(angle: number): number;
    sin(angle: number): number;
    pow(base: number, exp: number): number;
    map(value: number, start1: number, stop1: number, start2: number, stop2: number): number;
    constrain(n: number, low: number, high: number): number;
    min(...values: number[]): number;
    max(...values: number[]): number;

    // Events
    windowResized: (() => void) | undefined;
    setup: (() => void) | undefined;
    draw: (() => void) | undefined;
  }

  // Tone.js type stubs for CDN usage
  const Tone: {
    // Core
    context: { sampleRate: number };
    now(): number;
    start(): Promise<void>;
    loaded(): Promise<void>;

    // Classes
    Player: (new (options: { url: string; loop?: boolean; autostart?: boolean }) => TonePlayer) &
      (new (buffer: AudioBuffer) => TonePlayer);

    Gain: new (value?: number) => ToneGain;
    FFT: new (size?: number) => ToneFFT;
  };

  interface TonePlayer {
    state: string;
    buffer: { duration: number; get?(): AudioBuffer } | null;
    start(time?: string, offset?: number): void;
    stop(): void;
    dispose(): void;
    connect(destination: unknown): void;
  }

  interface ToneGain {
    gain: { value: number };
    toDestination(): void;
    dispose(): void;
    connect(destination: unknown): void;
  }

  interface ToneFFT {
    getValue(): Float32Array;
    dispose(): void;
    connect(destination: unknown): void;
  }
}

export {};
