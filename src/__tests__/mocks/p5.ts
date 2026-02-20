/**
 * Mock factories for P5Instance, P5Image, and CanvasRenderingContext2D
 */

export function createMockContext(): CanvasRenderingContext2D {
  return {
    save: vi.fn(),
    restore: vi.fn(),
    beginPath: vi.fn(),
    arc: vi.fn(),
    clip: vi.fn(),
    drawImage: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    closePath: vi.fn(),
    fillRect: vi.fn(),
    fillStyle: '',
  } as unknown as CanvasRenderingContext2D;
}

export function createMockP5Image(width = 200, height = 100): P5Image {
  return {
    width,
    height,
    canvas: { tagName: 'CANVAS' } as HTMLCanvasElement,
  };
}

export function createMockP5(ctx?: CanvasRenderingContext2D): P5Instance {
  const mockCtx = ctx ?? createMockContext();
  return {
    width: 800,
    height: 600,
    deltaTime: 16.667,
    millis: vi.fn(() => 1000),
    drawingContext: mockCtx,

    // Constants
    TWO_PI: Math.PI * 2,
    PI: Math.PI,
    HALF_PI: Math.PI / 2,
    HSB: 'hsb',
    RGB: 'rgb',
    CLOSE: 0,
    CENTER: 'center',

    // Setup/Lifecycle
    createCanvas: vi.fn(() => ({ parent: vi.fn() })),
    resizeCanvas: vi.fn(),
    pixelDensity: vi.fn(),
    frameRate: vi.fn(),

    // Drawing
    background: vi.fn(),
    push: vi.fn(),
    pop: vi.fn(),
    translate: vi.fn(),
    rotate: vi.fn(),
    scale: vi.fn(),

    // Shapes
    ellipse: vi.fn(),
    rect: vi.fn(),
    vertex: vi.fn(),
    beginShape: vi.fn(),
    endShape: vi.fn(),
    line: vi.fn(),

    // Style
    fill: vi.fn(),
    noFill: vi.fn(),
    stroke: vi.fn(),
    noStroke: vi.fn(),
    strokeWeight: vi.fn(),
    colorMode: vi.fn(),

    // Images
    loadImage: vi.fn(),
    image: vi.fn(),
    imageMode: vi.fn(),
    tint: vi.fn(),
    noTint: vi.fn(),

    // Math — use real implementations
    cos: Math.cos,
    sin: Math.sin,
    pow: Math.pow,
    map: (value: number, start1: number, stop1: number, start2: number, stop2: number) =>
      start2 + ((value - start1) / (stop1 - start1)) * (stop2 - start2),
    constrain: (n: number, low: number, high: number) => Math.min(Math.max(n, low), high),
    min: Math.min,
    max: Math.max,

    // Events
    windowResized: undefined,
    setup: undefined,
    draw: undefined,
  } as unknown as P5Instance;
}
