/**
 * Tests for tunnel visualization image drawing
 * Verifies that ctx.drawImage receives userImg.canvas (not .elt)
 */
import { createMockP5, createMockP5Image, createMockContext } from '../../__tests__/mocks/p5';
import { expectCallSequence } from '../../__tests__/helpers/callOrder';

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

beforeAll(async () => {
  const mod = await import('../tunnel');
  drawTunnel = mod.drawTunnel;
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

  test('ctx.drawImage called with userImg.canvas', () => {
    const userImg = createMockP5Image(200, 100);
    mockGetUserImage.mockReturnValue(userImg);
    const ctx = createMockContext();
    const p = createMockP5(ctx);

    drawTunnel(p);

    expect(ctx.drawImage).toHaveBeenCalledTimes(1);
    expect(ctx.drawImage).toHaveBeenCalledWith(
      userImg.canvas,
      expect.any(Number),
      expect.any(Number),
      expect.any(Number),
      expect.any(Number),
    );
  });

  test('correct save/clip/drawImage/restore sequence', () => {
    const userImg = createMockP5Image(200, 100);
    mockGetUserImage.mockReturnValue(userImg);
    const ctx = createMockContext();
    const p = createMockP5(ctx);

    drawTunnel(p);

    expectCallSequence([
      { name: 'save', mock: ctx.save as ReturnType<typeof vi.fn> },
      { name: 'beginPath', mock: ctx.beginPath as ReturnType<typeof vi.fn> },
      { name: 'arc', mock: ctx.arc as ReturnType<typeof vi.fn> },
      { name: 'clip', mock: ctx.clip as ReturnType<typeof vi.fn> },
      { name: 'drawImage', mock: ctx.drawImage as ReturnType<typeof vi.fn> },
      { name: 'restore', mock: ctx.restore as ReturnType<typeof vi.fn> },
    ]);
  });

  test('clips to center radius (minDim * 0.06)', () => {
    const userImg = createMockP5Image(200, 100);
    mockGetUserImage.mockReturnValue(userImg);
    const ctx = createMockContext();
    const p = createMockP5(ctx);
    // p.width=800, p.height=600 → minDim=600, centerRadius = 600 * 0.06 = 36

    drawTunnel(p);

    expect(ctx.arc).toHaveBeenCalledWith(
      0,
      0,
      36, // minDim * 0.06
      0,
      Math.PI * 2,
    );
  });
});
