'use client';

import { useEffect, useSyncExternalStore } from 'react';
import { useMap } from 'react-leaflet';
import type { LatLngBoundsExpression } from 'leaflet';

import BasemapSwitcher from '@/components/BasemapSwitcher';
import {
  getBasemapSnapshot,
  getServerBasemapSnapshot,
  setStoredBasemap,
  subscribeBasemap,
} from '@/lib/basemapStore';

/**
 * The background-map picker, on the analysis maps too.
 *
 * The choice is shared with the main map through localStorage, which is what
 * makes it necessary here rather than merely nice: land on the netwerkplanner
 * with a dark basemap selected and the grey "witte vlek" cells all but
 * disappear. Without a control on these maps there is no way back.
 *
 * Renders as a sibling of the MapContainer, inside the same positioned
 * wrapper — it is absolutely positioned and must not be a Leaflet child.
 */
export function AnalyseBasemapSwitcher() {
  const basemapId = useSyncExternalStore(
    subscribeBasemap,
    getBasemapSnapshot,
    getServerBasemapSnapshot
  );
  return <BasemapSwitcher value={basemapId} onChange={setStoredBasemap} />;
}

/**
 * Fit the map to a set of bounds, once the container has a size.
 *
 * `fitBounds` computes the zoom from the container's measured dimensions. When
 * the map mounts inside a grid or flex cell — as all three analysis maps do —
 * that measurement can still be stale on the first effect tick, and Leaflet
 * then picks a zoom for a container it thinks is tiny. The visible result is a
 * map centred somewhere near, but not on, the data.
 *
 * So: invalidate the cached size first, then fit, and repeat once on the next
 * frame to catch the case where layout had not settled at all.
 */
export function FitBounds({
  bounds,
  padding = [30, 30],
  maxZoom,
}: {
  bounds: LatLngBoundsExpression | null;
  padding?: [number, number];
  maxZoom?: number;
}) {
  const map = useMap();

  useEffect(() => {
    if (!bounds) return;
    let frame = 0;

    const apply = () => {
      map.invalidateSize({ animate: false });
      map.fitBounds(bounds, { padding, maxZoom, animate: false });
    };

    apply();
    frame = requestAnimationFrame(apply);
    return () => cancelAnimationFrame(frame);
    // `padding` is a literal at every call site; including it would refit on
    // every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bounds, map, maxZoom]);

  return null;
}
