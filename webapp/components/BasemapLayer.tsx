'use client';

import { useEffect } from 'react';
import { TileLayer, useMap } from 'react-leaflet';
import { setWorkerUrl } from 'maplibre-gl';
import { MaplibreGL } from '@maplibre/maplibre-gl-leaflet';
import 'maplibre-gl/dist/maplibre-gl.css';

import { withBase } from '@/lib/basePath';
import { MAX_ZOOM, type Basemap, type VectorBasemap } from '@/lib/basemaps';

// MapLibre 6 looks for its worker next to its own (bundler-renamed) module and
// 404s; serve it from public/ instead (copied there by predev/prebuild).
setWorkerUrl(withBase('/maplibre-gl-worker.mjs'));

/**
 * The background map, raster or vector (see lib/basemaps.ts).
 *
 * Keyed on the id so switching replaces the layer outright: Leaflet reads url,
 * subdomains and className once, at construction, and a GL style is cheaper to
 * rebuild than to diff.
 */
export default function BasemapLayer({ basemap }: { basemap: Basemap }) {
  if (basemap.kind === 'vector') {
    return <VectorBasemapLayer key={basemap.id} basemap={basemap} />;
  }

  return (
    <TileLayer
      key={basemap.id}
      attribution={basemap.attribution}
      url={basemap.url}
      subdomains={basemap.subdomains ?? 'abc'}
      maxZoom={MAX_ZOOM}
      maxNativeZoom={basemap.maxNativeZoom}
      className={basemap.inverted ? 'basemap-inverted' : undefined}
    />
  );
}

function VectorBasemapLayer({ basemap }: { basemap: VectorBasemap }) {
  const map = useMap();

  useEffect(() => {
    // The binding never shows MapLibre's own control; it hands
    // `customAttribution` to Leaflet's, where the raster credits also go.
    // (Leaflet's usual `attribution` option is ignored by this layer.)
    const layer = new MaplibreGL({
      style: basemap.styleUrl,
      attributionControl: { customAttribution: basemap.attribution },
    });
    layer.addTo(map);
    return () => {
      layer.remove();
    };
  }, [map, basemap]);

  return null;
}
