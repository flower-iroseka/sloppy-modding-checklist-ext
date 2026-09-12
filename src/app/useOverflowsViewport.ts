import { useEffect, useState } from 'react';

/**
 * Whether the content is taller than one screen.
 *
 * "Jump to a zone" and "back to top" should only show up when there's something to jump to;
 * on a short list they're pure noise. Listens to `resize` and `ResizeObserver` both: a window
 * resize needs a recompute, and so do content changes (adding or removing entries, expanding
 * the note editor, crossing zones in a drag), which `resize` alone would miss.
 *
 * @returns true when the page is taller than the viewport
 */
export function useOverflowsViewport(): boolean {
  const [overflows, setOverflows] = useState(false);

  useEffect(() => {
    const measure = () => {
      const el = document.documentElement;
      // The +1 is headroom for subpixel heights: no need to pop up when it's exactly one screen
      setOverflows(el.scrollHeight > window.innerHeight + 1);
    };

    measure();
    window.addEventListener('resize', measure);
    const observer = new ResizeObserver(measure);
    observer.observe(document.body);
    return () => {
      window.removeEventListener('resize', measure);
      observer.disconnect();
    };
  }, []);

  return overflows;
}
