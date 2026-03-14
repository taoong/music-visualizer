/**
 * Mobile swipe gestures — swipe left/right to change visualization
 */

const MIN_SWIPE_X = 50;  // minimum horizontal px to register as a swipe
const MAX_SWIPE_Y = 80;  // maximum vertical px before it's considered a scroll

/**
 * Initialize touch swipe listeners for viz switching.
 * Returns a cleanup function.
 */
export function initSwipeGestures(): () => void {
  let touchStartX = 0;
  let touchStartY = 0;

  const onTouchStart = (e: TouchEvent) => {
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
  };

  const onTouchEnd = (e: TouchEvent) => {
    const dx = e.changedTouches[0].clientX - touchStartX;
    const dy = e.changedTouches[0].clientY - touchStartY;

    if (Math.abs(dx) < MIN_SWIPE_X || Math.abs(dy) > MAX_SWIPE_Y) return;

    const vizSelect = document.getElementById('viz-selector') as HTMLSelectElement | null;
    if (!vizSelect) return;

    const options = Array.from(vizSelect.options).filter(o => !o.disabled);
    const currentIndex = options.findIndex(o => o.value === vizSelect.value);
    if (currentIndex === -1) return;

    // Swipe left → next viz; swipe right → previous viz
    const nextIndex = dx < 0
      ? (currentIndex + 1) % options.length
      : (currentIndex - 1 + options.length) % options.length;

    vizSelect.value = options[nextIndex].value;
    vizSelect.dispatchEvent(new Event('change'));
  };

  document.addEventListener('touchstart', onTouchStart, { passive: true });
  document.addEventListener('touchend', onTouchEnd, { passive: true });

  return () => {
    document.removeEventListener('touchstart', onTouchStart);
    document.removeEventListener('touchend', onTouchEnd);
  };
}
