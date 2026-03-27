/**
 * Tests for tunnel visualization image drawing
 * Verifies that image is drawn across all concentric rings
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

let drawTunnel: typeof import('../tunnel').drawTunnel;
let OCTAVE_COUNT: number;

beforeAll(async () => {
  const mod = await import('../tunnel');
  drawTunnel = mod.drawTunnel;
  const constants = await import('../../utils/constants');
  OCTAVE_COUNT = constants.OCTAVE_COUNT;
});

beforeEach(() => {
  vi.clearAllMocks();
  mockGetUserImage.mockReturnValue(null);
});

describe('tunnel image drawing', () => {
  test('no ctx.drawImage when no image', () => {
    mockGetUserImage.mockReturnValue(null);
    const ctx = createMockContext();
    const p = createMockP5(ctx);

    drawTunnel(p);

    expect(ctx.drawImage).not.toHaveBeenCalled();
  });

  test('ctx.drawImage called once per octave ring with userImg.canvas', () => {
    const userImg = createMockP5Image(200, 100);
    mockGetUserImage.mockReturnValue(userImg);
    const ctx = createMockContext();
    const p = createMockP5(ctx);

    drawTunnel(p);

    expect(ctx.drawImage).toHaveBeenCalledTimes(OCTAVE_COUNT);
    // Every call should use the image's canvas
    for (const call of (ctx.drawImage as ReturnType<typeof vi.fn>).mock.calls) {
      expect(call[0]).toBe(userImg.canvas);
    }
  });

  test('save/restore called once per ring', () => {
    const userImg = createMockP5Image(200, 100);
    mockGetUserImage.mockReturnValue(userImg);
    const ctx = createMockContext();
    const p = createMockP5(ctx);

    drawTunnel(p);

    expect(ctx.save).toHaveBeenCalledTimes(OCTAVE_COUNT);
    expect(ctx.restore).toHaveBeenCalledTimes(OCTAVE_COUNT);
    expect(ctx.clip).toHaveBeenCalledTimes(OCTAVE_COUNT);
  });

  test('glow strokes drawn at ring boundaries', () => {
    const userImg = createMockP5Image(200, 100);
    mockGetUserImage.mockReturnValue(userImg);
    const ctx = createMockContext();
    const p = createMockP5(ctx);

    drawTunnel(p);

    expect(ctx.stroke).toHaveBeenCalledTimes(OCTAVE_COUNT);
  });
});
