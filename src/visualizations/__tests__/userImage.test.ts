/**
 * Tests for userImage module lifecycle
 */

const { mockEmit, mockOn } = vi.hoisted(() => ({
  mockEmit: vi.fn(),
  mockOn: vi.fn(() => vi.fn()),
}));

vi.mock('../../state/store', () => ({
  store: { emit: mockEmit, on: mockOn },
}));

import { loadUserImage, clearUserImage, getUserImage, hasUserImage } from '../userImage';

// Track all object URLs created and revoked
let createdUrls: string[];
let revokedUrls: string[];

beforeEach(() => {
  createdUrls = [];
  revokedUrls = [];
  vi.clearAllMocks();

  // Reset module-scoped state by clearing + reloading isn't practical,
  // so we clear via clearUserImage between tests
  clearUserImage();
  mockEmit.mockClear();

  // Stub URL.createObjectURL / revokeObjectURL
  globalThis.URL = {
    ...globalThis.URL,
    createObjectURL: vi.fn((_blob: Blob) => {
      const url = `blob:test-${createdUrls.length}`;
      createdUrls.push(url);
      return url;
    }),
    revokeObjectURL: vi.fn((url: string) => {
      revokedUrls.push(url);
    }),
  } as unknown as typeof URL;
});

describe('userImage', () => {
  test('getUserImage() returns null initially', () => {
    expect(getUserImage()).toBeNull();
  });

  test('hasUserImage() returns false initially', () => {
    expect(hasUserImage()).toBe(false);
  });

  test('loadUserImage calls p.loadImage with an object URL', () => {
    const mockP5 = { loadImage: vi.fn() } as unknown as P5Instance;
    const file = new File(['test'], 'photo.png', { type: 'image/png' });

    loadUserImage(mockP5, file);

    expect(URL.createObjectURL).toHaveBeenCalledWith(file);
    expect(mockP5.loadImage).toHaveBeenCalledWith(
      createdUrls[0],
      expect.any(Function),
      expect.any(Function),
    );
  });

  test('on success callback, getUserImage() returns the image and emits imageChange', () => {
    const mockP5 = { loadImage: vi.fn() } as unknown as P5Instance;
    const file = new File(['test'], 'photo.png', { type: 'image/png' });
    const fakeImage = { width: 100, height: 50, canvas: {} } as P5Image;

    loadUserImage(mockP5, file);

    // Extract and call the success callback
    const successCallback = (mockP5.loadImage as ReturnType<typeof vi.fn>).mock.calls[0][1];
    successCallback(fakeImage);

    expect(getUserImage()).toBe(fakeImage);
    expect(hasUserImage()).toBe(true);
    expect(mockEmit).toHaveBeenCalledWith('imageChange', true);
  });

  test('on failure callback, image stays null and object URL is revoked', () => {
    const mockP5 = { loadImage: vi.fn() } as unknown as P5Instance;
    const file = new File(['test'], 'photo.png', { type: 'image/png' });

    loadUserImage(mockP5, file);

    // Extract and call the failure callback
    const failureCallback = (mockP5.loadImage as ReturnType<typeof vi.fn>).mock.calls[0][2];
    failureCallback();

    expect(getUserImage()).toBeNull();
    expect(revokedUrls).toContain(createdUrls[0]);
  });

  test('clearUserImage() resets state, revokes URL, emits imageChange false', () => {
    const mockP5 = { loadImage: vi.fn() } as unknown as P5Instance;
    const file = new File(['test'], 'photo.png', { type: 'image/png' });
    const fakeImage = { width: 100, height: 50, canvas: {} } as P5Image;

    loadUserImage(mockP5, file);
    const successCallback = (mockP5.loadImage as ReturnType<typeof vi.fn>).mock.calls[0][1];
    successCallback(fakeImage);
    mockEmit.mockClear();

    clearUserImage();

    expect(getUserImage()).toBeNull();
    expect(hasUserImage()).toBe(false);
    expect(revokedUrls).toContain(createdUrls[0]);
    expect(mockEmit).toHaveBeenCalledWith('imageChange', false);
  });

  test('loading a second image revokes the previous object URL', () => {
    const mockP5 = { loadImage: vi.fn() } as unknown as P5Instance;
    const file1 = new File(['a'], 'a.png', { type: 'image/png' });
    const file2 = new File(['b'], 'b.png', { type: 'image/png' });

    loadUserImage(mockP5, file1);
    const firstUrl = createdUrls[0];

    loadUserImage(mockP5, file2);

    expect(revokedUrls).toContain(firstUrl);
  });
});
