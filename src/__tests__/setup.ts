/// <reference types="vitest/globals" />
/**
 * Global test setup — stub browser globals that constants.ts accesses at import time
 */

// constants.ts lines 7-9 access navigator.userAgent, navigator.maxTouchPoints, window.innerWidth
if (typeof globalThis.navigator === 'undefined') {
  Object.defineProperty(globalThis, 'navigator', {
    value: { userAgent: 'node-test', maxTouchPoints: 0 },
    writable: true,
  });
}

if (typeof globalThis.window === 'undefined') {
  Object.defineProperty(globalThis, 'window', {
    value: { innerWidth: 1920 },
    writable: true,
  });
}
