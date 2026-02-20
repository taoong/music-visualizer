/**
 * Tests for circle visualization image drawing
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

vi.mock('../../audio/engine', () => ({
  audioEngine: {
    getPlaybackPosition: vi.fn(() => 0),
    getStemSmoothed: vi.fn(() => null),
  },
}));

// Import helpers that also use store — mock them to avoid transitive issues
vi.mock('../helpers', () => ({
  getBandData: vi.fn(() => ({ amp: 0.5, tMult: 1.0, delta: 0 })),
}));

import { drawSpikeCircle } from '../circle';

beforeEach(() => {
  vi.clearAllMocks();
  mockGetUserImage.mockReturnValue(null);
});

describe('circle image drawing', () => {
  test('no ctx.drawImage call when getUserImage() returns null', () => {
    mockGetUserImage.mockReturnValue(null);
    const ctx = createMockContext();
    const p = createMockP5(ctx);

    drawSpikeCircle(p);

    expect(ctx.drawImage).not.toHaveBeenCalled();
  });

  test('ctx.drawImage is called with userImg.canvas', () => {
    const userImg = createMockP5Image(200, 100);
    mockGetUserImage.mockReturnValue(userImg);
    const ctx = createMockContext();
    const p = createMockP5(ctx);

    drawSpikeCircle(p);

    expect(ctx.drawImage).toHaveBeenCalledTimes(1);
    expect(ctx.drawImage).toHaveBeenCalledWith(
      userImg.canvas,
      expect.any(Number),
      expect.any(Number),
      expect.any(Number),
      expect.any(Number),
    );
  });

  test('call sequence: save → beginPath → arc → clip → drawImage → restore', () => {
    const userImg = createMockP5Image(200, 100);
    mockGetUserImage.mockReturnValue(userImg);
    const ctx = createMockContext();
    const p = createMockP5(ctx);

    drawSpikeCircle(p);

    expectCallSequence([
      { name: 'save', mock: ctx.save as ReturnType<typeof vi.fn> },
      { name: 'beginPath', mock: ctx.beginPath as ReturnType<typeof vi.fn> },
      { name: 'arc', mock: ctx.arc as ReturnType<typeof vi.fn> },
      { name: 'clip', mock: ctx.clip as ReturnType<typeof vi.fn> },
      { name: 'drawImage', mock: ctx.drawImage as ReturnType<typeof vi.fn> },
      { name: 'restore', mock: ctx.restore as ReturnType<typeof vi.fn> },
    ]);
  });

  test('draw dimensions reflect landscape aspect ratio', () => {
    const userImg = createMockP5Image(400, 200); // landscape: aspect 2.0
    mockGetUserImage.mockReturnValue(userImg);
    const ctx = createMockContext();
    const p = createMockP5(ctx);

    drawSpikeCircle(p);

    const [, , , drawW, drawH] = (ctx.drawImage as ReturnType<typeof vi.fn>).mock.calls[0];
    // Landscape: drawH = r*2, drawW = drawH * aspect
    // So drawW should be > drawH
    expect(drawW).toBeGreaterThan(drawH);
    expect(drawW / drawH).toBeCloseTo(2.0, 1);
  });

  test('draw dimensions correct for portrait images', () => {
    const userImg = createMockP5Image(100, 400); // portrait: aspect 0.25
    mockGetUserImage.mockReturnValue(userImg);
    const ctx = createMockContext();
    const p = createMockP5(ctx);

    drawSpikeCircle(p);

    const [, , , drawW, drawH] = (ctx.drawImage as ReturnType<typeof vi.fn>).mock.calls[0];
    // Portrait: drawW = r*2, drawH = drawW / aspect
    // So drawH should be > drawW
    expect(drawH).toBeGreaterThan(drawW);
    expect(drawW / drawH).toBeCloseTo(0.25, 1);
  });
});
