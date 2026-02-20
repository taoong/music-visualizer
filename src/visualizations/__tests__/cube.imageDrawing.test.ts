/**
 * Tests for cube visualization image drawing
 * Verifies that ctx.drawImage receives userImg.canvas (not .elt)
 * and that polygon clipping (moveTo/lineTo/closePath) is used instead of arc
 */
import { createMockP5, createMockP5Image, createMockContext } from '../../__tests__/mocks/p5';

const { mockGetUserImage } = vi.hoisted(() => ({
  mockGetUserImage: vi.fn<() => P5Image | null>(),
}));

vi.mock('../userImage', () => ({
  getUserImage: mockGetUserImage,
}));

vi.mock('../../state/store', async () => {
  const { createMockStoreState: create } = await import('../../__tests__/mocks/store');
  return { store: create() };
});

vi.mock('../../audio/engine', () => ({
  audioEngine: {
    getPlaybackPosition: vi.fn(() => 0),
    getStemSmoothed: vi.fn(() => null),
  },
}));

let drawCube: typeof import('../cube').drawCube;
let resetCube: typeof import('../cube').resetCube;

beforeAll(async () => {
  const mod = await import('../cube');
  drawCube = mod.drawCube;
  resetCube = mod.resetCube;
});

beforeEach(() => {
  vi.clearAllMocks();
  mockGetUserImage.mockReturnValue(null);
  resetCube();
});

describe('cube image drawing', () => {
  test('no ctx.drawImage when no image', () => {
    mockGetUserImage.mockReturnValue(null);
    const ctx = createMockContext();
    const p = createMockP5(ctx);

    drawCube(p, 1.0);

    expect(ctx.drawImage).not.toHaveBeenCalled();
  });

  test('ctx.drawImage called with userImg.canvas for each face', () => {
    const userImg = createMockP5Image(200, 200);
    mockGetUserImage.mockReturnValue(userImg);
    const ctx = createMockContext();
    const p = createMockP5(ctx);

    drawCube(p, 1.0);

    // Cube has 6 faces, all get image drawn
    expect((ctx.drawImage as ReturnType<typeof vi.fn>).mock.calls.length).toBe(6);

    // Every call uses userImg.canvas as the first argument
    for (const call of (ctx.drawImage as ReturnType<typeof vi.fn>).mock.calls) {
      expect(call[0]).toBe(userImg.canvas);
    }
  });

  test('uses moveTo/lineTo/closePath/clip polygon pattern (not arc)', () => {
    const userImg = createMockP5Image(200, 200);
    mockGetUserImage.mockReturnValue(userImg);
    const ctx = createMockContext();
    const p = createMockP5(ctx);

    drawCube(p, 1.0);

    // Each face: beginPath → moveTo → 3x lineTo → closePath → clip
    expect((ctx.moveTo as ReturnType<typeof vi.fn>).mock.calls.length).toBe(6);
    expect((ctx.lineTo as ReturnType<typeof vi.fn>).mock.calls.length).toBe(18); // 3 per face × 6 faces
    expect((ctx.closePath as ReturnType<typeof vi.fn>).mock.calls.length).toBe(6);
    expect((ctx.clip as ReturnType<typeof vi.fn>).mock.calls.length).toBe(6);

    // No arc calls for cube (unlike circle/tunnel)
    expect(ctx.arc).not.toHaveBeenCalled();
  });

  test('applies color tint overlay (fillStyle + fillRect) after drawImage', () => {
    const userImg = createMockP5Image(200, 200);
    mockGetUserImage.mockReturnValue(userImg);
    const ctx = createMockContext();
    const p = createMockP5(ctx);

    drawCube(p, 1.0);

    // fillRect called once per face for tint overlay
    expect((ctx.fillRect as ReturnType<typeof vi.fn>).mock.calls.length).toBe(6);
  });

  test('each face bracketed by save/restore', () => {
    const userImg = createMockP5Image(200, 200);
    mockGetUserImage.mockReturnValue(userImg);
    const ctx = createMockContext();
    const p = createMockP5(ctx);

    drawCube(p, 1.0);

    // 6 faces = 6 save/restore pairs
    expect((ctx.save as ReturnType<typeof vi.fn>).mock.calls.length).toBe(6);
    expect((ctx.restore as ReturnType<typeof vi.fn>).mock.calls.length).toBe(6);

    // Each save should come before its corresponding restore
    const saveOrders = (ctx.save as ReturnType<typeof vi.fn>).mock.invocationCallOrder;
    const restoreOrders = (ctx.restore as ReturnType<typeof vi.fn>).mock.invocationCallOrder;
    for (let i = 0; i < 6; i++) {
      expect(restoreOrders[i]).toBeGreaterThan(saveOrders[i]);
    }
  });
});
