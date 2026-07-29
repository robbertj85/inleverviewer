/**
 * The chosen background map, kept in localStorage.
 *
 * Exposed as an external store rather than as state seeded from an effect:
 * reading localStorage during render would make the server markup and the
 * first client render disagree, and setting it from an effect costs a
 * cascading render (and trips the lint rule that says so). `useSyncExternal-
 * Store` is the sanctioned way in — with the bonus that a change in one tab
 * lands in the others through the `storage` event.
 */

import { BASEMAPS, DEFAULT_BASEMAP_ID } from './basemaps';

const STORAGE_KEY = 'basemap';

const listeners = new Set<() => void>();

export function subscribeBasemap(onChange: () => void): () => void {
  listeners.add(onChange);
  window.addEventListener('storage', onChange);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener('storage', onChange);
  };
}

export function getBasemapSnapshot(): string {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && BASEMAPS.some((b) => b.id === stored)) return stored;
  } catch {
    // Private mode or a blocked cookie policy: fall through to the default.
  }
  return DEFAULT_BASEMAP_ID;
}

export function getServerBasemapSnapshot(): string {
  return DEFAULT_BASEMAP_ID;
}

export function setStoredBasemap(id: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // Not persisting is survivable; the listeners below still fire.
  }
  listeners.forEach((listener) => listener());
}
