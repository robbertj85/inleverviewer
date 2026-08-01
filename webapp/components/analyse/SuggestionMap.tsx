'use client';

import { Fragment, useMemo, useSyncExternalStore } from 'react';
import { Circle, CircleMarker, MapContainer, Popup, TileLayer } from 'react-leaflet';
import L from 'leaflet';

import { AnalyseBasemapSwitcher, FitBounds } from '@/components/analyse/MapChrome';

import { MAX_ZOOM, getBasemap } from '@/lib/basemaps';
import {
  getBasemapSnapshot,
  getServerBasemapSnapshot,
  subscribeBasemap,
} from '@/lib/basemapStore';
import { nlInt } from '@/types/analyse';

export interface SuggestionMarker {
  rank: number;
  lat: number;
  lon: number;
  preSnapLat: number;
  preSnapLon: number;
  snapped: boolean;
  poiLabel: string | null;
  poiDistance: number | null;
  estNewPop: number;
}

export default function SuggestionMap({
  markers,
  existing,
  bufferM,
}: {
  markers: SuggestionMarker[];
  existing: { lat: number; lon: number; naam: string }[];
  bufferM: number;
}) {
  const basemapId = useSyncExternalStore(
    subscribeBasemap,
    getBasemapSnapshot,
    getServerBasemapSnapshot
  );
  const basemap = getBasemap(basemapId);

  const bounds = useMemo(
    () =>
      markers.length
        ? L.latLngBounds(markers.map((m) => [m.lat, m.lon] as [number, number]))
        : null,
    [markers]
  );

  return (
    <>
      <AnalyseBasemapSwitcher />
      <MapContainer
        center={[52.15, 5.3]}
        zoom={12}
        maxZoom={MAX_ZOOM}
        scrollWheelZoom
        className="size-full"
      >
      <TileLayer
        url={basemap.url}
        attribution={basemap.attribution}
        maxNativeZoom={basemap.maxNativeZoom}
        maxZoom={MAX_ZOOM}
        subdomains={basemap.subdomains ?? 'abc'}
        className={basemap.inverted ? 'basemap-inverted' : undefined}
      />
      <FitBounds bounds={bounds} padding={[60, 60]} maxZoom={15} />

      {existing.map((point, i) => (
        <CircleMarker
          key={`e${i}`}
          center={[point.lat, point.lon]}
          radius={3}
          pathOptions={{ color: '#63705a', weight: 1, fillOpacity: 0.4 }}
        >
          <Popup>{point.naam} — bestaand inleverpunt</Popup>
        </CircleMarker>
      ))}

      {markers.map((marker) => (
        // Fragment, not a div: a plain element inside MapContainer lands in
        // the map's DOM as a stray child, while the layers below register
        // through context either way.
        <Fragment key={marker.rank}>
          {/* The ring it would serve — the whole claim of the suggestion. */}
          <Circle
            center={[marker.lat, marker.lon]}
            radius={bufferM}
            pathOptions={{
              color: 'var(--green-600)',
              weight: 1,
              fillColor: 'var(--green-500)',
              fillOpacity: 0.1,
            }}
          />
          {/* When the point was snapped, show where it started, so the move
              is visible rather than implied. */}
          {marker.snapped && (
            <CircleMarker
              center={[marker.preSnapLat, marker.preSnapLon]}
              radius={4}
              pathOptions={{
                color: 'var(--muted-foreground)',
                weight: 1,
                dashArray: '2 2',
                fillOpacity: 0,
              }}
            >
              <Popup>Bevolkingszwaartepunt vóór snapping</Popup>
            </CircleMarker>
          )}
          <CircleMarker
            center={[marker.lat, marker.lon]}
            radius={9}
            pathOptions={{
              color: '#ffffff',
              weight: 2,
              fillColor: marker.snapped ? 'var(--green-700)' : '#2a78d6',
              fillOpacity: 0.95,
            }}
          >
            <Popup>
              <strong>Plek {marker.rank}</strong>
              <br />+{nlInt(marker.estNewPop)} inwoners binnen {bufferM} m
              <br />
              {marker.snapped
                ? `Gesnapt naar ${marker.poiLabel} (${marker.poiDistance} m)`
                : marker.poiLabel
                  ? `Geen gastheer binnen loopafstand — dichtstbij: ${marker.poiLabel} op ${marker.poiDistance} m`
                  : 'Geen geschikte gastheer in de buurt'}
            </Popup>
          </CircleMarker>
        </Fragment>
      ))}
      </MapContainer>
    </>
  );
}
