/**
 * The last municipality the user looked at, kept in localStorage and shared
 * across the analysis tabs — pick Zwolle on the netwerkplanner and the
 * plaatsingsadvies opens on Zwolle too.
 *
 * An external store rather than state seeded from an effect, for the same
 * reason as `basemapStore`: reading localStorage during render would make the
 * server markup and the first client render disagree, and setting it from an
 * effect costs a cascading render (and trips the lint rule that says so).
 */

const STORAGE_KEY = 'lastSelectedMunicipality';

const listeners = new Set<() => void>();

export function subscribeMunicipality(onChange: () => void): () => void {
  listeners.add(onChange);
  window.addEventListener('storage', onChange);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener('storage', onChange);
  };
}

export function getMunicipalitySnapshot(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    // Private mode or a blocked cookie policy: no sticky selection.
    return null;
  }
}

/** Always null on the server, so the first client render matches the markup. */
export function getServerMunicipalitySnapshot(): string | null {
  return null;
}

export function setStoredMunicipality(slug: string): void {
  try {
    if (localStorage.getItem(STORAGE_KEY) === slug) return;
    localStorage.setItem(STORAGE_KEY, slug);
  } catch {
    // Not persisting is survivable; the listeners below still fire.
  }
  listeners.forEach((listener) => listener());
}
