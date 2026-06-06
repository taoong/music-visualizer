/**
 * Interactive mode — captures canvas touch/mouse/keyboard events and dispatches
 * them to the active visualization's `interact()` handler.
 *
 * Binding to the canvas element (not document) means sidebar, playback bar, and
 * splash screen interactions are unaffected.
 *
 * Event types:
 *   tap       — quick press-and-release without significant movement
 *   dragstart — first move > DRAG_THRESHOLD pixels after press
 *   drag      — subsequent moves while pressed
 *   dragend   — release after a drag
 *   hold      — press held for HOLD_MS without moving
 *   key       — printable keyboard character (when interactive mode is active)
 *
 * Coordinates are normalized to [0, 1] relative to the canvas.
 */
import { store } from '../state/store';
import { VIZ_REGISTRY } from '../visualizations/registry';
import type { InteractionEvent } from '../types';

const HOLD_MS = 500;
const DRAG_THRESHOLD = 8; // pixels before a press becomes a drag

export function initInteraction(canvas: HTMLCanvasElement): () => void {
  let active = false;       // is mouse/touch currently pressed?
  let isDragging = false;
  let holdTimer: ReturnType<typeof setTimeout> | null = null;
  let lastClientX = 0;
  let lastClientY = 0;
  let downClientX = 0;
  let downClientY = 0;

  function norm(clientX: number, clientY: number): [number, number] {
    const rect = canvas.getBoundingClientRect();
    return [
      Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)),
      Math.max(0, Math.min(1, (clientY - rect.top) / rect.height)),
    ];
  }

  function dispatch(event: InteractionEvent): void {
    if (!store.state.isInteractive) return;
    VIZ_REGISTRY[store.state.vizMode].interact?.(event);
  }

  function clearHold(): void {
    if (holdTimer !== null) {
      clearTimeout(holdTimer);
      holdTimer = null;
    }
  }

  function onPointerDown(clientX: number, clientY: number): void {
    active = true;
    isDragging = false;
    downClientX = clientX;
    downClientY = clientY;
    lastClientX = clientX;
    lastClientY = clientY;

    clearHold();
    const [x, y] = norm(clientX, clientY);
    holdTimer = setTimeout(() => {
      if (active && !isDragging) {
        dispatch({ type: 'hold', x, y });
      }
    }, HOLD_MS);
  }

  function onPointerMove(clientX: number, clientY: number): void {
    if (!active) return;

    const [x, y] = norm(clientX, clientY);
    const dx = (clientX - lastClientX) / canvas.width;
    const dy = (clientY - lastClientY) / canvas.height;

    if (!isDragging) {
      const ddx = clientX - downClientX;
      const ddy = clientY - downClientY;
      if (Math.sqrt(ddx * ddx + ddy * ddy) > DRAG_THRESHOLD) {
        clearHold();
        isDragging = true;
        dispatch({ type: 'dragstart', x, y, dx, dy });
      }
    } else {
      dispatch({ type: 'drag', x, y, dx, dy });
    }

    lastClientX = clientX;
    lastClientY = clientY;
  }

  function onPointerUp(clientX: number, clientY: number): void {
    if (!active) return;
    active = false;
    clearHold();

    const [x, y] = norm(clientX, clientY);
    if (isDragging) {
      dispatch({ type: 'dragend', x, y });
      isDragging = false;
    } else {
      dispatch({ type: 'tap', x, y });
    }
  }

  // ── Mouse ─────────────────────────────────────────────────────────────────

  const onMouseDown = (e: MouseEvent) => {
    if (e.button !== 0) return; // left button only
    onPointerDown(e.clientX, e.clientY);
  };
  const onMouseMove = (e: MouseEvent) => {
    if (e.buttons & 1) onPointerMove(e.clientX, e.clientY);
  };
  const onMouseUp = (e: MouseEvent) => {
    if (e.button !== 0) return;
    onPointerUp(e.clientX, e.clientY);
  };
  // Cancel drag if mouse leaves canvas while pressed
  const onMouseLeave = () => {
    if (active && isDragging) {
      const [x, y] = norm(lastClientX, lastClientY);
      dispatch({ type: 'dragend', x, y });
    }
    active = false;
    isDragging = false;
    clearHold();
  };

  // ── Touch ─────────────────────────────────────────────────────────────────

  const onTouchStart = (e: TouchEvent) => {
    e.preventDefault(); // prevent scroll and mouse event emulation
    const t = e.touches[0];
    onPointerDown(t.clientX, t.clientY);
  };
  const onTouchMove = (e: TouchEvent) => {
    e.preventDefault();
    const t = e.touches[0];
    onPointerMove(t.clientX, t.clientY);
  };
  const onTouchEnd = (e: TouchEvent) => {
    e.preventDefault();
    const t = e.changedTouches[0];
    onPointerUp(t.clientX, t.clientY);
  };
  const onTouchCancel = () => {
    active = false;
    isDragging = false;
    clearHold();
  };

  // ── Keyboard ──────────────────────────────────────────────────────────────
  // In interactive mode, printable keys are routed to the viz instead of
  // triggering visualization-switching shortcuts.

  const onKeyDown = (e: KeyboardEvent) => {
    if (!store.state.isInteractive) return;
    // Ignore if typing in an input field
    if (
      e.target instanceof HTMLInputElement ||
      e.target instanceof HTMLTextAreaElement ||
      e.target instanceof HTMLSelectElement
    ) return;
    // Only capture printable single chars without modifiers
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.stopPropagation();
      dispatch({ type: 'key', x: 0.5, y: 0.5, key: e.key });
    }
  };

  // ── Bind ──────────────────────────────────────────────────────────────────

  canvas.addEventListener('mousedown', onMouseDown);
  canvas.addEventListener('mousemove', onMouseMove);
  canvas.addEventListener('mouseup', onMouseUp);
  canvas.addEventListener('mouseleave', onMouseLeave);
  canvas.addEventListener('touchstart', onTouchStart, { passive: false });
  canvas.addEventListener('touchmove', onTouchMove, { passive: false });
  canvas.addEventListener('touchend', onTouchEnd, { passive: false });
  canvas.addEventListener('touchcancel', onTouchCancel);
  // Use capture so we intercept before the viz-switching keyboard handler
  document.addEventListener('keydown', onKeyDown, { capture: true });

  // Show pointer cursor on canvas when interactive mode is active
  const unsubInteractive = store.on('interactiveChange', (active) => {
    canvas.style.cursor = active ? 'crosshair' : '';
  });

  return () => {
    clearHold();
    canvas.removeEventListener('mousedown', onMouseDown);
    canvas.removeEventListener('mousemove', onMouseMove);
    canvas.removeEventListener('mouseup', onMouseUp);
    canvas.removeEventListener('mouseleave', onMouseLeave);
    canvas.removeEventListener('touchstart', onTouchStart);
    canvas.removeEventListener('touchmove', onTouchMove);
    canvas.removeEventListener('touchend', onTouchEnd);
    canvas.removeEventListener('touchcancel', onTouchCancel);
    document.removeEventListener('keydown', onKeyDown, { capture: true });
    unsubInteractive();
  };
}
