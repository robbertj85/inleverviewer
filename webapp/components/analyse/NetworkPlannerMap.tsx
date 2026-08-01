'use client';

import { useMemo, useSyncExternalStore } from 'react';
import { CircleMarker, MapContainer, Pane, Popup, TileLayer } from 'react-leaflet';
import L from 'leaflet';

import { AnalyseBasemapSwitcher, FitBounds } from '@/components/analyse/MapChrome';

import { MAX_ZOOM, getBasemap } from '@/lib/basemaps';
import {
  getBasemapSnapshot,
  getServerBasemapSnapshot,
  subscribeBasemap,
} from '@/lib/basemapStore';
import type { NetworkCandidate, NetworkPayload, TypeMeta } from '@/lib/inleverpuntNetwork';
import { FLAG_LABELS } from '@/lib/inleverpuntNetwork';
import { nlInt } from '@/types/analyse';

export interface PickMarker {
  candidate: NetworkCandidate;
  rank: number;
  /** Primary gain shown in the popup. */
  gain: number;
  /** Combi mode only. */
  gainPakket?: number;
  synergie?: number;
}

interface Props {
  payload: NetworkPayload;
  /** Per cell: 0 = covered at the start, k = covered by pick k, -1 = never. */
  cellRank: number[];
  /** How many picks the slider currently allows. */
  n: number;
  picks: PickMarker[];
  showCells: boolean;
  showCandidates: boolean;
  showExisting: boolean;
  /** Existing inleverpunten, fetched separately so the payload stays small. */
  existing?: { lat: number; lon: number; naam: string; merk: string }[];
  /** Combi mode draws the parcel-point layer too. */
  pakketpunten?: { lat: number; lon: number }[];
  showPakketpunten?: boolean;
}

/**
 * Cell states, and why these colours.
 *
 * Covered-at-start and newly-covered have to be distinguishable at a glance,
 * because the whole point of the slider is watching the second eat into the
 * third. Warm green is the house colour and carries "already served"; the new
 * picks get the series blue, which clears the green under both protanopia and
 * deuteranopia. Uncovered is a neutral grey rather than red — a white spot is
 * a finding, not an error.
 */
const CELL_COVERED = '#8fb75c';
const CELL_NEW = '#2a78d6';
const CELL_UNCOVERED = '#b9bdb4';

export default function NetworkPlannerMap({
  payload,
  cellRank,
  n,
  picks,
  showCells,
  showCandidates,
  showExisting,
  existing = [],
  pakketpunten = [],
  showPakketpunten = false,
}: Props) {
  const basemapId = useSyncExternalStore(
    subscribeBasemap,
    getBasemapSnapshot,
    getServerBasemapSnapshot
  );
  const basemap = getBasemap(basemapId);

  const { cells, candidates, type_meta: typeMeta } = payload;

  const bounds = useMemo(
    () =>
      cells.lat.length
        ? L.latLngBounds(cells.lat.map((v, i) => [v, cells.lon[i]] as [number, number]))
        : null,
    [cells]
  );

  /** Which picks are currently placed, so their candidates can be hidden. */
  const placed = useMemo(
    () => new Set(picks.slice(0, n).map((p) => p.candidate)),
    [picks, n]
  );

  const cellColours = useMemo(
    () =>
      cellRank.map((rank) => {
        if (rank === 0) return CELL_COVERED;
        if (rank > 0 && rank <= n) return CELL_NEW;
        return CELL_UNCOVERED;
      }),
    [cellRank, n]
  );

  return (
    <>
      <AnalyseBasemapSwitcher />
      <MapContainer
        center={[52.15, 5.3]}
        zoom={8}
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
      <FitBounds bounds={bounds} padding={[24, 24]} />

      {/* Demand grid, bottom of the stack. */}
      <Pane name="cells" style={{ zIndex: 410 }}>
        {showCells &&
          cells.lat.map((lat, i) => (
            <CircleMarker
              key={`c${i}`}
              center={[lat, cells.lon[i]]}
              radius={3}
              pathOptions={{
                stroke: false,
                fillColor: cellColours[i],
                fillOpacity: 0.55,
              }}
              interactive={false}
            />
          ))}
      </Pane>

      {/* Existing networks. */}
      <Pane name="existing" style={{ zIndex: 420 }}>
        {showExisting &&
          existing.map((point, i) => (
            <CircleMarker
              key={`i${i}`}
              center={[point.lat, point.lon]}
              radius={3}
              pathOptions={{ color: '#436325', weight: 1, fillOpacity: 0.55 }}
            >
              <Popup>
                <strong>{point.naam}</strong>
                <br />
                bestaand inleverpunt · {point.merk}
              </Popup>
            </CircleMarker>
          ))}
        {showPakketpunten &&
          pakketpunten.map((point, i) => (
            <CircleMarker
              key={`p${i}`}
              center={[point.lat, point.lon]}
              radius={3}
              pathOptions={{ color: '#eb6834', weight: 1, fillOpacity: 0.6 }}
            >
              <Popup>Bestaand pakketpunt</Popup>
            </CircleMarker>
          ))}
      </Pane>

      {/* Unused candidates: where the planner could still go. */}
      <Pane name="candidates" style={{ zIndex: 430 }}>
        {showCandidates &&
          candidates.map((candidate, i) => {
            if (placed.has(candidate)) return null;
            const meta: TypeMeta | undefined = typeMeta[candidate.type];
            return (
              <CircleMarker
                key={`k${i}`}
                center={[candidate.lat, candidate.lon]}
                radius={3}
                pathOptions={{
                  color: meta?.kleur ?? '#475569',
                  weight: 1,
                  fillOpacity: 0.15,
                  opacity: 0.5,
                }}
              >
                <Popup>
                  <strong>{candidate.naam || meta?.label}</strong>
                  <br />
                  {meta?.label} — niet geselecteerd
                </Popup>
              </CircleMarker>
            );
          })}
      </Pane>

      {/* The chosen network, on top and numbered. */}
      <Pane name="picks" style={{ zIndex: 460 }}>
        {picks.slice(0, n).map((pick) => {
          const meta: TypeMeta | undefined = typeMeta[pick.candidate.type];
          return (
            <CircleMarker
              key={`s${pick.rank}`}
              center={[pick.candidate.lat, pick.candidate.lon]}
              radius={8}
              pathOptions={{
                color: '#ffffff',
                weight: 2,
                fillColor: meta?.kleur ?? '#475569',
                fillOpacity: 0.95,
              }}
            >
              <Popup>
                <strong>
                  #{pick.rank} · {pick.candidate.naam || meta?.label}
                </strong>
                <br />
                {meta?.label}
                <br />
                {pick.gainPakket == null ? (
                  <>+{nlInt(pick.gain)} inwoners bereikt</>
                ) : (
                  <>
                    inleveren +{nlInt(pick.gain)} · pakketten +{nlInt(pick.gainPakket)}
                    <br />
                    synergie {pick.synergie?.toFixed(2)}
                  </>
                )}
                {pick.candidate.flags.length > 0 && (
                  <>
                    <br />
                    <span style={{ fontSize: '0.85em' }}>
                      {pick.candidate.flags
                        .map((f) => FLAG_LABELS[f] ?? f)
                        .join(' · ')}
                    </span>
                  </>
                )}
              </Popup>
            </CircleMarker>
          );
        })}
        </Pane>
      </MapContainer>
    </>
  );
}
