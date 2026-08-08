import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

/**
 * Shared jsdom setup for the frontend suite. Two things the app relies on that jsdom doesn't
 * implement, both of which would otherwise throw during a normal render:
 *   - matchMedia, read by the reduced-motion preference hook on mount;
 *   - Element.scrollIntoView, called by the chat list's scroll-to-bottom layout effect.
 * We stub rather than guard in the components, because in a real browser both always exist and
 * defensive checks there would just hide bugs.
 */
if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function scrollIntoView(): void {
    /* no-op in jsdom */
  };
}

// Unmount every tree between tests so a leaked effect from one case can't perturb the next —
// which matters a great deal here, since several tests assert on driver lifecycle.
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
