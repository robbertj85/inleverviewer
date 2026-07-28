'use client';

import { useEffect, useMemo, useState } from 'react';
import { CrosshairIcon, Loader2Icon, XIcon } from 'lucide-react';

import AddressSearchInput from '@/components/AddressSearchInput';
import { Button } from '@/components/ui/button';
import { formatDistance, haversineMeters } from '@/utils/distanceUtils';
import {
  CATEGORIE_LABELS,
  Filters,
  InleverpuntData,
  InleverpuntFeature,
  InleverpuntProperties,
  MATERIAAL_LABELS,
  MERK_LABELS,
  Municipality,
  getPointColor,
  isInleverpunt,
} from '@/types/inleverpunten';

const RESULT_LIMIT = 10;

interface Props {
  isOpen: boolean;
  onClose: () => void;
  municipalities: Municipality[];
  data: InleverpuntData | null;
  filters: Filters;
  onMunicipalityChange: (slug: string) => void;
  onSearchLocationChange: (coords: { latitude: number; longitude: number } | null) => void;
  onHighlightedPointsChange: (keys: Set<string> | null) => void;
  onPointSelect: (coords: { latitude: number; longitude: number }) => void;
  initialSearch?: {
    coordinates: { latitude: number; longitude: number };
    displayName: string;
  } | null;
}

interface Ranked {
  feature: InleverpuntFeature;
  props: InleverpuntProperties;
  distance: number;
  key: string;
}

export default function NearestPointsFinder({
  isOpen,
  onClose,
  municipalities,
  data,
  filters,
  onMunicipalityChange,
  onSearchLocationChange,
  onHighlightedPointsChange,
  onPointSelect,
  initialSearch,
}: Props) {
  const [locating, setLocating] = useState(false);
  const [geoError, setGeoError] = useState<string | null>(null);

  /**
   * A search made inside this panel, plus the header search it was made
   * against. Copying `initialSearch` into state on every change would be a
   * prop-sync effect; recording what the local search superseded lets us
   * derive the winner instead.
   */
  const [localOrigin, setLocalOrigin] = useState<{
    coordinates: { latitude: number; longitude: number };
    displayName: string;
    supersedes: string | null;
  } | null>(null);

  const originKey = (coords: { latitude: number; longitude: number }) =>
    `${coords.latitude},${coords.longitude}`;

  const headerKey = initialSearch ? originKey(initialSearch.coordinates) : null;

  // The local search wins until the header produces a *different* address,
  // at which point the newer header search takes over again.
  const origin =
    localOrigin && localOrigin.supersedes === headerKey
      ? localOrigin
      : (initialSearch ?? localOrigin);

  const setOrigin = (
    coordinates: { latitude: number; longitude: number },
    displayName: string
  ) => setLocalOrigin({ coordinates, displayName, supersedes: headerKey });

  const nearest = useMemo<Ranked[]>(() => {
    if (!origin || !data) return [];

    const ranked: Ranked[] = [];

    for (const feature of data.features) {
      if (!isInleverpunt(feature.properties)) continue;
      const props = feature.properties;

      // Respect the same filters the map is showing, so the list never
      // recommends a point the user has filtered away.
      if (!filters.merken.includes(props.merk)) continue;
      if (!filters.categorieen.includes(props.puntType)) continue;
      if (filters.onlyVrijToegankelijk && !props.vrijToegankelijk) continue;
      if (!(props.materialen ?? []).some((m) => filters.materialen.includes(m))) continue;

      const [lon, lat] = feature.geometry.coordinates as [number, number];
      ranked.push({
        feature,
        props,
        distance: haversineMeters(
          origin.coordinates.latitude,
          origin.coordinates.longitude,
          lat,
          lon
        ),
        key: `${props.merk}:${props.bronId}`,
      });
    }

    ranked.sort((a, b) => a.distance - b.distance);
    return ranked.slice(0, RESULT_LIMIT);
  }, [origin, data, filters]);

  // Keep the map's highlight set in step with the list.
  useEffect(() => {
    if (!isOpen || nearest.length === 0) {
      onHighlightedPointsChange(null);
      return;
    }
    onHighlightedPointsChange(new Set(nearest.map((r) => r.key)));
  }, [isOpen, nearest, onHighlightedPointsChange]);

  const useMyLocation = () => {
    if (!navigator.geolocation) {
      setGeoError('Je browser ondersteunt geen locatiebepaling.');
      return;
    }

    setLocating(true);
    setGeoError(null);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const coordinates = {
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
        };
        setOrigin(coordinates, 'Mijn locatie');
        onSearchLocationChange(coordinates);
        onPointSelect(coordinates);
        setLocating(false);
      },
      () => {
        setGeoError('Kon je locatie niet bepalen. Sta locatietoegang toe of zoek een adres.');
        setLocating(false);
      },
      { enableHighAccuracy: true, timeout: 10_000 }
    );
  };

  if (!isOpen) return null;

  return (
    <aside className="absolute right-0 top-0 z-[1000] flex h-full w-[min(22rem,90vw)] flex-col border-l border-border bg-card shadow-xl">
      <header className="flex items-center justify-between gap-2 border-b border-border px-3 py-2.5">
        <h2 className="text-sm font-semibold text-[var(--green-900)]">
          Dichtstbijzijnde inleverpunten
        </h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Sluiten"
          className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
        >
          <XIcon className="size-4" />
        </button>
      </header>

      <div className="space-y-2 border-b border-border px-3 py-2.5">
        <AddressSearchInput
          municipalities={municipalities}
          onAddressSelected={(slug, coordinates, displayName) => {
            setOrigin(coordinates, displayName);
            onSearchLocationChange(coordinates);
            onMunicipalityChange(slug);
            onPointSelect(coordinates);
          }}
        />
        <Button
          variant="outline"
          size="sm"
          className="w-full"
          onClick={useMyLocation}
          disabled={locating}
        >
          {locating ? (
            <Loader2Icon className="size-4 animate-spin" />
          ) : (
            <CrosshairIcon className="size-4" />
          )}
          Gebruik mijn locatie
        </Button>
        {geoError && <p className="text-[11px] text-destructive">{geoError}</p>}
        {origin && (
          <p className="truncate text-[11px] text-muted-foreground" title={origin.displayName}>
            Vanaf: {origin.displayName}
          </p>
        )}
      </div>

      <div className="flex-1 overflow-y-auto">
        {!origin && (
          <p className="px-3 py-6 text-center text-sm text-muted-foreground">
            Zoek een adres of gebruik je locatie om de tien dichtstbijzijnde inleverpunten te zien.
          </p>
        )}

        {origin && nearest.length === 0 && (
          <p className="px-3 py-6 text-center text-sm text-muted-foreground">
            Geen inleverpunten gevonden met de huidige filters.
          </p>
        )}

        <ol className="divide-y divide-border">
          {nearest.map((result, index) => (
            <li key={result.key}>
              <button
                type="button"
                onClick={() =>
                  onPointSelect({
                    latitude: result.props.latitude,
                    longitude: result.props.longitude,
                  })
                }
                className="flex w-full items-start gap-2.5 px-3 py-2.5 text-left transition-colors hover:bg-secondary"
              >
                <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-semibold tabular-nums text-muted-foreground">
                  {index + 1}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span
                      className="size-2.5 shrink-0 rounded-full"
                      style={{ background: getPointColor(result.props) }}
                      aria-hidden
                    />
                    <span className="truncate text-sm font-medium">
                      {result.props.locatieNaam}
                    </span>
                  </span>
                  <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
                    {MERK_LABELS[result.props.merk]} · {CATEGORIE_LABELS[result.props.puntType]}
                  </span>
                  {result.props.materialen?.length > 0 && (
                    <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
                      {result.props.materialen
                        .slice(0, 3)
                        .map((m) => MATERIAAL_LABELS[m])
                        .join(', ')}
                      {result.props.materialen.length > 3 &&
                        ` +${result.props.materialen.length - 3}`}
                    </span>
                  )}
                </span>
                <span className="shrink-0 text-xs font-semibold tabular-nums text-primary">
                  {formatDistance(result.distance)}
                </span>
              </button>
            </li>
          ))}
        </ol>
      </div>
    </aside>
  );
}
