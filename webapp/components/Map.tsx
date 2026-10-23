'use client';

/**
 * The map.
 *
 * Renders up to ~34.000 points, so it adapts to dataset size rather than
 * drawing everything the same way:
 *
 *  - Simple mode (auto-enabled nationally) draws plain dots straight onto one
 *    canvas with Leaflet, bypassing React (see `SimplePoints`).
 *  - Detailed mode draws divIcon pins with a category glyph.
 *  - Overlapping points are spread in a ring at high zoom, so two brands at
 *    the same supermarket are both clickable.
 *  - Coverage rings at 300/400/500 m are computed live with Turf in a Web
 *    Worker, merged into a union below a point threshold and drawn per-point
 *    above it.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import {
  Circle,
  CircleMarker,
  GeoJSON,
  MapContainer,
  Marker,
  Popup,
  useMap,
} from 'react-leaflet';
import L from 'leaflet';
import type { Feature, MultiPolygon, Polygon } from 'geojson';

import {
  CATEGORIE_LABELS,
  DAY_LABELS,
  Filters,
  InleverpuntData,
  InleverpuntFeature,
  InleverpuntProperties,
  MATERIAAL_LABELS,
  MERK_LABELS,
  UITBETALING_LABELS,
  getPointColor,
  isInleverpunt,
} from '@/types/inleverpunten';
import BasemapLayer from '@/components/BasemapLayer';
import { DEFAULT_BASEMAP_ID, MAX_ZOOM, getBasemap } from '@/lib/basemaps';

// Above this many points a merged coverage union costs more than it is worth,
// so we fall back to per-point circles (or nothing, in simple mode).
const MERGE_THRESHOLD = 3000;

// Spread coincident markers apart from this zoom level onwards.
const SPIDERFY_ZOOM = 15;

const NL_CENTER: [number, number] = [52.15, 5.4];
const NL_ZOOM = 8;

const BUFFER_STYLES = {
  300: { color: 'var(--green-700)', weight: 1.5 },
  400: { color: 'var(--green-500)', weight: 1.25 },
  500: { color: 'var(--green-400)', weight: 1 },
} as const;

interface MapProps {
  data: InleverpuntData | null;
  filters: Filters;
  targetCoordinates?: { latitude: number; longitude: number } | null;
  onZoomedToTarget?: () => void;
  searchLocationMarker?: { latitude: number; longitude: number } | null;
  highlightedPoints?: Set<string> | null;
  onTilesLoading?: (loading: boolean) => void;
  /** Id from `lib/basemaps`; falls back to Voyager when unknown. */
  basemapId?: string;
}

/** Stable identity for a point, used for highlighting and React keys. */
function pointKey(props: InleverpuntProperties): string {
  return `${props.merk}:${props.bronId}`;
}

// --------------------------------------------------------------------------
// Map helpers
// --------------------------------------------------------------------------

/** Fit the map to the dataset whenever a new municipality loads. */
function FitBounds({ data }: { data: InleverpuntData | null }) {
  const map = useMap();
  const lastSlug = useRef<string | null>(null);

  useEffect(() => {
    if (!data?.metadata) return;
    // Only refit when the municipality actually changes; refitting on every
    // filter change would yank the viewport out from under the user.
    if (lastSlug.current === data.metadata.slug) return;
    lastSlug.current = data.metadata.slug;

    const bounds = data.metadata.bounds;
    if (bounds && bounds.length === 4) {
      const [minX, minY, maxX, maxY] = bounds;
      map.fitBounds(
        [
          [minY, minX],
          [maxY, maxX],
        ],
        { padding: [30, 30] }
      );
    } else {
      map.setView(NL_CENTER, NL_ZOOM);
    }
  }, [data, map]);

  return null;
}

/** Fly to a searched address, then tell the parent it can clear the target. */
function FlyToTarget({
  coordinates,
  onDone,
}: {
  coordinates?: { latitude: number; longitude: number } | null;
  onDone?: () => void;
}) {
  const map = useMap();

  useEffect(() => {
    if (!coordinates) return;
    map.flyTo([coordinates.latitude, coordinates.longitude], 16, { duration: 1 });
    const timer = setTimeout(() => onDone?.(), 1100);
    return () => clearTimeout(timer);
  }, [coordinates, map, onDone]);

  return null;
}

/** Track zoom so the rest of the component can react to it. */
function ZoomWatcher({ onZoom }: { onZoom: (zoom: number) => void }) {
  const map = useMap();

  useEffect(() => {
    const handler = () => onZoom(map.getZoom());
    handler();
    map.on('zoomend', handler);
    return () => {
      map.off('zoomend', handler);
    };
  }, [map, onZoom]);

  return null;
}

/**
 * Mark the container as dark while a dark basemap is active.
 *
 * Done imperatively because MapContainer captures its `className` at mount and
 * ignores later changes; without this the pale container colour flashes
 * through every tile gap on a dark map.
 */
function DarkContainer({ dark }: { dark: boolean }) {
  const map = useMap();

  useEffect(() => {
    const element = map.getContainer();
    element.classList.toggle('basemap-dark', dark);
    return () => element.classList.remove('basemap-dark');
  }, [map, dark]);

  return null;
}

/** Report tile loading so the parent can show a spinner. */
function TileWatcher({ onLoading }: { onLoading?: (loading: boolean) => void }) {
  const map = useMap();

  useEffect(() => {
    if (!onLoading) return;
    const start = () => onLoading(true);
    const stop = () => onLoading(false);
    map.on('loading', start);
    map.on('load', stop);
    return () => {
      map.off('loading', start);
      map.off('load', stop);
    };
  }, [map, onLoading]);

  return null;
}

// --------------------------------------------------------------------------
// Icons
// --------------------------------------------------------------------------

const CATEGORY_GLYPHS: Record<string, string> = {
  automaat: 'A',
  balie: 'B',
  inzamelbak: 'I',
  milieustraat: 'M',
};

const iconCache = new Map<string, L.DivIcon>();

function markerIcon(props: InleverpuntProperties, size: number, highlighted: boolean) {
  const color = getPointColor(props);
  const glyph = CATEGORY_GLYPHS[props.puntType] ?? '•';
  const key = `${color}:${glyph}:${size}:${highlighted}`;

  const cached = iconCache.get(key);
  if (cached) return cached;

  const ring = highlighted ? 'box-shadow:0 0 0 3px #ffffff,0 0 0 6px #f2a413;' : 'box-shadow:0 1px 4px rgba(0,0,0,.35);';
  const icon = L.divIcon({
    className: '',
    html: `<div style="width:${size}px;height:${size}px;border-radius:50%;background:${color};border:2px solid #fff;${ring}display:flex;align-items:center;justify-content:center;color:#fff;font-size:${Math.round(size * 0.45)}px;font-weight:700;font-family:var(--font-geist-sans),system-ui,sans-serif;">${glyph}</div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
    popupAnchor: [0, -size / 2],
  });

  iconCache.set(key, icon);
  return icon;
}

// --------------------------------------------------------------------------
// Popup
// --------------------------------------------------------------------------

function OpeningHours({ hours }: { hours: InleverpuntProperties['openingstijden'] }) {
  if (!hours) return null;

  if (typeof hours === 'string') {
    return <p className="mt-1.5 text-[11px] text-neutral-600">{hours}</p>;
  }

  const entries = Object.entries(hours).filter(([, value]) => value);
  if (entries.length === 0) return null;

  return (
    <div className="mt-1.5 border-t border-neutral-200 pt-1.5">
      <p className="mb-1 text-[11px] font-semibold text-neutral-700">Openingstijden</p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-[11px] text-neutral-600">
        {entries.map(([day, value]) => (
          <div key={day} className="contents">
            <dt className="font-medium">{DAY_LABELS[day] ?? day}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function PointPopup({ props }: { props: InleverpuntProperties }) {
  const address = [props.straatNaam, props.straatNr].filter(Boolean).join(' ');
  const place = [props.postcode, props.plaats].filter(Boolean).join(' ');

  return (
    <div className="min-w-[220px] max-w-[300px]">
      <p className="text-sm font-semibold text-[var(--green-900)]">{props.locatieNaam}</p>

      <p className="mt-0.5 flex items-center gap-1.5 text-[11px] text-neutral-600">
        <span
          className="inline-block size-2.5 shrink-0 rounded-full"
          style={{ background: getPointColor(props) }}
        />
        {MERK_LABELS[props.merk]} · {CATEGORIE_LABELS[props.puntType]}
      </p>

      {(address || place) && (
        <p className="mt-1 text-[11px] text-neutral-600">
          {address}
          {address && place ? <br /> : null}
          {place || props.gemeente}
        </p>
      )}

      {props.materialen?.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {props.materialen.map((m) => (
            <span
              key={m}
              className="rounded bg-[var(--green-100)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--green-900)]"
            >
              {MATERIAAL_LABELS[m]}
            </span>
          ))}
        </div>
      )}

      {props.uitbetaling?.length > 0 && (
        <p className="mt-1.5 text-[11px] text-neutral-600">
          <span className="font-medium">Uitbetaling: </span>
          {props.uitbetaling.map((u) => UITBETALING_LABELS[u] ?? u).join(', ')}
        </p>
      )}

      {props.gemeenteBeperking && props.gemeenteBeperking.length > 0 && (
        <p className="mt-1.5 rounded bg-amber-50 px-1.5 py-1 text-[11px] text-amber-900">
          Alleen voor inwoners van {Array.from(new Set(props.gemeenteBeperking)).join(', ')}
        </p>
      )}

      <OpeningHours hours={props.openingstijden} />
    </div>
  );
}

// --------------------------------------------------------------------------
// Coverage rings
// --------------------------------------------------------------------------

/**
 * The merged coverage ring for a set of points, computed in a Web Worker.
 *
 * Returns null until the worker answers, and whenever the answer belongs to an
 * older point set: a ring that trails a filter change by a second is fine, one
 * that shows the previous filter's coverage is not. `id` changes with every
 * result, because react-leaflet's <GeoJSON> reads its data once at mount and
 * has to be re-keyed to pick up a new shape.
 */
function useMergedBuffer(
  points: InleverpuntFeature[],
  enabled: boolean,
  radiusKm: number
): { feature: Feature<Polygon | MultiPolygon>; id: number } | null {
  const [result, setResult] = useState<{
    points: InleverpuntFeature[];
    feature: Feature<Polygon | MultiPolygon> | null;
    id: number;
  } | null>(null);

  useEffect(() => {
    if (!enabled || points.length === 0 || points.length > MERGE_THRESHOLD) return;

    // One worker per request, terminated when the input changes: a stale
    // union is abandoned mid-way instead of queueing ahead of the new one.
    const worker = new Worker(new URL('./coverageUnion.worker.ts', import.meta.url), {
      type: 'module',
    });
    worker.onmessage = (event: MessageEvent<Feature<Polygon | MultiPolygon> | null>) => {
      setResult((previous) => ({ points, feature: event.data, id: (previous?.id ?? 0) + 1 }));
      worker.terminate();
    };
    worker.onerror = () => worker.terminate();
    worker.postMessage({
      coordinates: points.map((feature) => feature.geometry.coordinates as [number, number]),
      radiusKm,
    });
    return () => worker.terminate();
  }, [points, enabled, radiusKm]);

  if (!enabled || !result || result.points !== points || !result.feature) return null;
  return { feature: result.feature, id: result.id };
}

// --------------------------------------------------------------------------
// Simple markers
// --------------------------------------------------------------------------

interface PositionedPoint {
  feature: InleverpuntFeature;
  lat: number;
  lon: number;
  spread: boolean;
}

/**
 * Plain dots drawn straight onto one canvas, outside React.
 *
 * Nationally that is ~34.000 points. As <CircleMarker>s, each with its own
 * <Popup>, they were ~68.000 React components and froze the page for 6.5 s
 * before the first dot appeared; built directly in Leaflet the same dots take
 * ~50 ms. One popup is shared and filled on click, so PointPopup renders only
 * for the point someone actually opens.
 */
function SimplePoints({
  positioned,
  dotRadius,
  highlightedPoints,
}: {
  positioned: PositionedPoint[];
  dotRadius: number;
  highlightedPoints?: Set<string> | null;
}) {
  const map = useMap();
  const renderer = useMemo(() => L.canvas(), []);

  // The shared popup and the React root inside it, for the map's lifetime.
  const popupRef = useRef<{ popup: L.Popup; root: Root | null } | null>(null);
  useEffect(() => {
    const state: { popup: L.Popup; root: Root | null } = { popup: L.popup(), root: null };
    state.popup.on('remove', () => {
      // Unmounting synchronously inside Leaflet's handler is fine: the root is
      // ours alone and nothing else renders into it.
      state.root?.unmount();
      state.root = null;
    });
    popupRef.current = state;
    return () => {
      state.popup.remove();
      popupRef.current = null;
    };
  }, []);

  useEffect(() => {
    const propsOf = new WeakMap<L.Layer, InleverpuntProperties>();
    // Built off-map and added in one go; adding 34k layers to a group that is
    // already on the map redraws per layer.
    const group = L.featureGroup();
    const highlighted: L.CircleMarker[] = [];

    for (const { feature, lat, lon } of positioned) {
      const props = feature.properties as InleverpuntProperties;
      const isHighlighted = highlightedPoints?.has(pointKey(props)) ?? false;
      const marker = L.circleMarker([lat, lon], {
        renderer,
        radius: isHighlighted ? dotRadius + 2 : dotRadius,
        color: isHighlighted ? '#f2a413' : '#ffffff',
        weight: isHighlighted ? 2 : 0.75,
        fillColor: getPointColor(props),
        fillOpacity: 0.95,
      });
      propsOf.set(marker, props);
      if (isHighlighted) highlighted.push(marker);
      else group.addLayer(marker);
    }
    // Highlighted last, so they are drawn on top.
    for (const marker of highlighted) group.addLayer(marker);

    group.on('click', (event: L.LeafletMouseEvent) => {
      const props = propsOf.get(event.layer as L.Layer);
      const state = popupRef.current;
      if (!props || !state) return;

      state.root?.unmount();
      const container = document.createElement('div');
      state.root = createRoot(container);
      // Leaflet measures the content when it opens the popup, so it must be
      // rendered by then.
      flushSync(() => state.root?.render(<PointPopup props={props} />));
      state.popup
        .setLatLng((event.layer as L.CircleMarker).getLatLng())
        .setContent(container)
        .openOn(map);
    });

    group.addTo(map);
    return () => {
      group.remove();
    };
  }, [map, renderer, positioned, dotRadius, highlightedPoints]);

  return null;
}

// --------------------------------------------------------------------------
// Main component
// --------------------------------------------------------------------------

export default function MapView({
  data,
  filters,
  targetCoordinates,
  onZoomedToTarget,
  searchLocationMarker,
  highlightedPoints,
  onTilesLoading,
  basemapId = DEFAULT_BASEMAP_ID,
}: MapProps) {
  const [zoom, setZoom] = useState(NL_ZOOM);
  const basemap = getBasemap(basemapId);

  // ---- Filtering -------------------------------------------------------
  const { points, boundaries } = useMemo(() => {
    const pts: InleverpuntFeature[] = [];
    const bounds: InleverpuntFeature[] = [];

    if (!data) return { points: pts, boundaries: bounds };

    for (const feature of data.features) {
      if (feature.properties.type === 'boundary') {
        bounds.push(feature);
        continue;
      }
      if (!isInleverpunt(feature.properties)) continue;

      const props = feature.properties;

      if (!filters.merken.includes(props.merk)) continue;
      if (!filters.categorieen.includes(props.puntType)) continue;
      if (filters.onlyVrijToegankelijk && !props.vrijToegankelijk) continue;

      // A point matches the material filter if it accepts at least one of the
      // selected materials. Points with no material data are hidden once the
      // user narrows the selection, since we cannot claim they qualify.
      const materials = props.materialen ?? [];
      if (!materials.some((m) => filters.materialen.includes(m))) continue;

      pts.push(feature);
    }

    return { points: pts, boundaries: bounds };
  }, [data, filters]);

  // ---- Shared-location filter -----------------------------------------
  const visiblePoints = useMemo(() => {
    if (!filters.showOnlySharedLocations) return points;

    const groups = new Map<string, InleverpuntFeature[]>();
    for (const feature of points) {
      const [lon, lat] = feature.geometry.coordinates as [number, number];
      const key = `${lat.toFixed(5)},${lon.toFixed(5)}`;
      const bucket = groups.get(key);
      if (bucket) bucket.push(feature);
      else groups.set(key, [feature]);
    }

    const shared: InleverpuntFeature[] = [];
    groups.forEach((group) => {
      // "Shared" means more than one distinct brand at the same spot, not
      // simply two records from the same source.
      const brands = new Set(group.map((f) => (f.properties as InleverpuntProperties).merk));
      if (brands.size >= 2) shared.push(...group);
    });

    return shared;
  }, [points, filters.showOnlySharedLocations]);

  /**
   * Draw order: biggest source first, so it ends up underneath.
   *
   * Nationally Stibat contributes 18.400 of 33.700 points. Left in source
   * order it paints over everything else and the map reads as if only one
   * network exists. Sorting by descending brand frequency keeps the smaller
   * networks visible without hiding anything.
   */
  const drawOrdered = useMemo(() => {
    const frequency = new Map<string, number>();
    for (const feature of visiblePoints) {
      const merk = (feature.properties as InleverpuntProperties).merk;
      frequency.set(merk, (frequency.get(merk) ?? 0) + 1);
    }

    return [...visiblePoints].sort((a, b) => {
      const merkA = (a.properties as InleverpuntProperties).merk;
      const merkB = (b.properties as InleverpuntProperties).merk;
      return (frequency.get(merkB) ?? 0) - (frequency.get(merkA) ?? 0);
    });
  }, [visiblePoints]);

  // ---- Spiderfy coincident markers ------------------------------------
  const positioned = useMemo(() => {
    const result: PositionedPoint[] = [];

    if (zoom < SPIDERFY_ZOOM) {
      for (const feature of drawOrdered) {
        const [lon, lat] = feature.geometry.coordinates as [number, number];
        result.push({ feature, lat, lon, spread: false });
      }
      return result;
    }

    const groups = new Map<string, InleverpuntFeature[]>();
    for (const feature of drawOrdered) {
      const [lon, lat] = feature.geometry.coordinates as [number, number];
      const key = `${lat.toFixed(5)},${lon.toFixed(5)}`;
      const bucket = groups.get(key);
      if (bucket) bucket.push(feature);
      else groups.set(key, [feature]);
    }

    // Spread further apart as we zoom in, so the ring keeps a constant
    // on-screen size rather than shrinking with the scale.
    const radiusDeg = 0.00012 * Math.pow(2, Math.max(0, 18 - zoom));

    groups.forEach((group) => {
      if (group.length === 1) {
        const [lon, lat] = group[0].geometry.coordinates as [number, number];
        result.push({ feature: group[0], lat, lon, spread: false });
        return;
      }

      const [baseLon, baseLat] = group[0].geometry.coordinates as [number, number];
      const latScale = Math.cos((baseLat * Math.PI) / 180) || 1;

      group.forEach((feature, index) => {
        const angle = (2 * Math.PI * index) / group.length;
        result.push({
          feature,
          lat: baseLat + radiusDeg * Math.sin(angle),
          lon: baseLon + (radiusDeg * Math.cos(angle)) / latScale,
          spread: true,
        });
      });
    });

    return result;
  }, [drawOrdered, zoom]);

  // ---- Coverage rings --------------------------------------------------
  const merged300 = useMergedBuffer(visiblePoints, filters.bufferMerged && filters.showBuffer300, 0.3);
  const merged400 = useMergedBuffer(visiblePoints, filters.bufferMerged && filters.showBuffer400, 0.4);
  const merged500 = useMergedBuffer(visiblePoints, filters.bufferMerged && filters.showBuffer500, 0.5);

  const simple = filters.useSimpleMarkers;
  const iconSize = zoom >= 16 ? 30 : zoom >= 14 ? 26 : 22;
  const dotRadius = zoom >= 15 ? 6 : zoom >= 12 ? 4.5 : 3.5;

  const slug = data?.metadata?.slug ?? 'none';

  return (
    <MapContainer
      center={NL_CENTER}
      zoom={NL_ZOOM}
      maxZoom={MAX_ZOOM}
      className="h-full w-full"
      preferCanvas={simple}
      scrollWheelZoom
    >
      <BasemapLayer basemap={basemap} />

      <DarkContainer dark={Boolean(basemap.dark)} />
      <FitBounds data={data} />
      <FlyToTarget coordinates={targetCoordinates} onDone={onZoomedToTarget} />
      <ZoomWatcher onZoom={setZoom} />
      <TileWatcher onLoading={onTilesLoading} />

      {/* Coverage rings, widest first so the tighter ones sit on top */}
      {filters.showBuffer500 &&
        (filters.bufferMerged && merged500 ? (
          <GeoJSON
            key={`b500-${merged500.id}-${filters.showBufferFill}`}
            data={merged500.feature}
            style={{
              color: BUFFER_STYLES[500].color,
              weight: BUFFER_STYLES[500].weight,
              fillOpacity: filters.showBufferFill ? 0.1 : 0,
            }}
          />
        ) : !filters.bufferMerged ? (
          visiblePoints.map((feature, index) => {
            const [lon, lat] = feature.geometry.coordinates as [number, number];
            return (
              <Circle
                key={`b500-${index}`}
                center={[lat, lon]}
                radius={500}
                pathOptions={{
                  color: BUFFER_STYLES[500].color,
                  weight: BUFFER_STYLES[500].weight,
                  fillOpacity: filters.showBufferFill ? 0.06 : 0,
                }}
              />
            );
          })
        ) : null)}

      {filters.showBuffer400 &&
        (filters.bufferMerged && merged400 ? (
          <GeoJSON
            key={`b400-${merged400.id}-${filters.showBufferFill}`}
            data={merged400.feature}
            style={{
              color: BUFFER_STYLES[400].color,
              weight: BUFFER_STYLES[400].weight,
              fillOpacity: filters.showBufferFill ? 0.1 : 0,
            }}
          />
        ) : !filters.bufferMerged ? (
          visiblePoints.map((feature, index) => {
            const [lon, lat] = feature.geometry.coordinates as [number, number];
            return (
              <Circle
                key={`b400-${index}`}
                center={[lat, lon]}
                radius={400}
                pathOptions={{
                  color: BUFFER_STYLES[400].color,
                  weight: BUFFER_STYLES[400].weight,
                  fillOpacity: filters.showBufferFill ? 0.06 : 0,
                }}
              />
            );
          })
        ) : null)}

      {filters.showBuffer300 &&
        (filters.bufferMerged && merged300 ? (
          <GeoJSON
            key={`b300-${merged300.id}-${filters.showBufferFill}`}
            data={merged300.feature}
            style={{
              color: BUFFER_STYLES[300].color,
              weight: BUFFER_STYLES[300].weight,
              fillOpacity: filters.showBufferFill ? 0.12 : 0,
            }}
          />
        ) : !filters.bufferMerged ? (
          visiblePoints.map((feature, index) => {
            const [lon, lat] = feature.geometry.coordinates as [number, number];
            return (
              <Circle
                key={`b300-${index}`}
                center={[lat, lon]}
                radius={300}
                pathOptions={{
                  color: BUFFER_STYLES[300].color,
                  weight: BUFFER_STYLES[300].weight,
                  fillOpacity: filters.showBufferFill ? 0.08 : 0,
                }}
              />
            );
          })
        ) : null)}

      {/* Municipality outlines */}
      {filters.showBoundary &&
        boundaries.map((feature, index) => (
          <GeoJSON
            key={`boundary-${slug}-${index}`}
            data={feature}
            style={{
              color: 'var(--green-800)',
              weight: 1.5,
              fillOpacity: 0,
              dashArray: '8, 6',
            }}
          />
        ))}

      {/* Points */}
      {simple && (
        <SimplePoints
          positioned={positioned}
          dotRadius={dotRadius}
          highlightedPoints={highlightedPoints}
        />
      )}
      {!simple && positioned.map(({ feature, lat, lon, spread }, index) => {
        const props = feature.properties as InleverpuntProperties;
        const key = pointKey(props);
        const highlighted = highlightedPoints?.has(key) ?? false;

        return (
          <Marker
            key={`p-${key}-${index}`}
            position={[lat, lon]}
            icon={markerIcon(props, spread ? iconSize - 2 : iconSize, highlighted)}
          >
            <Popup>
              <PointPopup props={props} />
            </Popup>
          </Marker>
        );
      })}

      {/* Searched address */}
      {searchLocationMarker && (
        <CircleMarker
          center={[searchLocationMarker.latitude, searchLocationMarker.longitude]}
          radius={9}
          pathOptions={{
            color: '#ffffff',
            weight: 3,
            fillColor: '#c0392b',
            fillOpacity: 1,
          }}
        >
          <Popup>Gezochte locatie</Popup>
        </CircleMarker>
      )}
    </MapContainer>
  );
}
