declare global {
  interface P5Image {
    width: number;
    height: number;
    canvas: HTMLCanvasElement;
  }

  interface P5Graphics {
    width: number;
    height: number;
    pixels: Uint8ClampedArray;
    loadPixels(): void;
    updatePixels(): void;
    noSmooth(): void;
    remove(): void;
    background(color: number | string): void;
    background(r: number, g: number, b: number, a?: number): void;
    fill(color: number | string): void;
    fill(r: number, g: number, b: number, a?: number): void;
    noFill(): void;
    noStroke(): void;
    stroke(color: number | string): void;
    stroke(r: number, g: number, b: number, a?: number): void;
    strokeWeight(weight: number): void;
    rect(x: number, y: number, w: number, h?: number): void;
    rectMode(mode: string): void;
    line(x1: number, y1: number, x2: number, y2: number): void;
    ellipse(x: number, y: number, w: number, h?: number): void;
    circle(x: number, y: number, d: number): void;
    point(x: number, y: number): void;
    push(): void;
    pop(): void;
    translate(x: number, y: number): void;
    rotate(angle: number): void;
    scale(x: number, y?: number): void;
    beginShape(): void;
    endShape(mode?: number): void;
    vertex(x: number, y: number): void;
    colorMode(mode: string | number, max1?: number, max2?: number, max3?: number, maxA?: number): void;
    blendMode(mode: number): void;
    clear(): void;
    drawingContext: CanvasRenderingContext2D;
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
    PIE: number;
    CHORD: number;
    CENTER: string;
    CORNER: string;
    CORNERS: string;
    LEFT: string;
    RIGHT: string;
    ADD: number;
    BLEND: number;
    SQUARE: string;
    ROUND: string;
    PROJECT: string;
    MITER: string;
    BEVEL: string;

    // Setup/Lifecycle
    createCanvas(w: number, h: number): { parent(id: string): void };
    resizeCanvas(w: number, h: number): void;
    pixelDensity(d: number): void;
    frameRate(fps: number): void;
    frameCount: number;
    createGraphics(w: number, h: number): P5Graphics;
    noSmooth(): void;
    smooth(): void;
    noise(x: number, y?: number, z?: number): number;
    noiseSeed(seed: number): void;

    // Drawing
    background(color: number | string): void;
    background(r: number, g: number, b: number, a?: number): void;
    blendMode(mode: number): void;
    push(): void;
    pop(): void;
    translate(x: number, y: number): void;
    rotate(angle: number): void;
    scale(x: number, y?: number): void;

    // Shapes
    circle(x: number, y: number, d: number): void;
    ellipse(x: number, y: number, w: number, h?: number): void;
    rect(x: number, y: number, w: number, h?: number, tl?: number, tr?: number, br?: number, bl?: number): void;
    rectMode(mode: string): void;
    triangle(x1: number, y1: number, x2: number, y2: number, x3: number, y3: number): void;
    vertex(x: number, y: number): void;
    bezierVertex(cx1: number, cy1: number, cx2: number, cy2: number, x: number, y: number): void;
    beginShape(): void;
    endShape(mode?: number): void;
    line(x1: number, y1: number, x2: number, y2: number): void;
    quad(x1: number, y1: number, x2: number, y2: number, x3: number, y3: number, x4: number, y4: number): void;
    arc(x: number, y: number, w: number, h: number, start: number, stop: number, mode?: number): void;
    point(x: number, y: number): void;
    curveVertex(x: number, y: number): void;

    // Style
    fill(color: number | string): void;
    fill(r: number, g: number, b: number, a?: number): void;
    noFill(): void;
    stroke(color: number | string, s?: number, b?: number): void;
    stroke(r: number, g: number, b: number, a: number): void;
    noStroke(): void;
    strokeWeight(weight: number): void;
    strokeCap(cap: string | number): void;
    strokeJoin(join: string | number): void;
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

  // Minimal structural shapes for the Tone.js instances the codebase touches.
  // `tone` ships its own real types now (imported directly); these interfaces
  // just describe what engine.ts's own fields need, structurally satisfied
  // by the real Tone.Player/Gain/FFT/Analyser/UserMedia instances.
  interface TonePlayer {
    state: string;
    loop: boolean;
    buffer: { duration: number; get?(): AudioBuffer | undefined } | null;
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

  interface ToneAnalyser {
    getValue(): Float32Array;
    dispose(): void;
    connect(destination: unknown): void;
  }

  interface ToneUserMedia {
    open(): Promise<unknown>;
    close(): void;
    dispose(): void;
    connect(destination: unknown): void;
    state: string;
  }
}

export {};
