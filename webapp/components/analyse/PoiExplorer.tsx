'use client';

import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { CircleMarker, MapContainer, Pane, Popup, TileLayer } from 'react-leaflet';
import L from 'leaflet';

import { AnalyseBasemapSwitcher, FitBounds } from '@/components/analyse/MapChrome';

import { MAX_ZOOM, getBasemap } from '@/lib/basemaps';
import {
  getBasemapSnapshot,
  getServerBasemapSnapshot,
  subscribeBasemap,
} from '@/lib/basemapStore';
import {
  getMunicipalitySnapshot,
  getServerMunicipalitySnapshot,
  setStoredMunicipality,
  subscribeMunicipality,
} from '@/lib/municipalityStore';
import { cn } from '@/lib/utils';
import { MERK_COLORS, type Merk } from '@/types/inleverpunten';
import { nlInt } from '@/types/analyse';

interface CategoryMeta {
  slug: string;
  label: string;
  group: string;
  color: string;
  icon: string;
  count: number;
}

interface PoiFeature {
  type: 'Feature';
  geometry: { type: 'Point'; coordinates: [number, number] };
  properties: { category: string; name: string; operator: string; osm_id?: string };
}

interface Bundle {
  type: 'FeatureCollection';
  metadata: {
    gemeente: string;
    slug: string;
    total: number;
    by_category: Record<string, number>;
  };
  features: PoiFeature[];
}

interface MunicipalityIndexEntry {
  gemeente: string;
  total: number;
  by_category: Record<string, number>;
}

interface ExistingPoint {
  lat: number;
  lon: number;
  merk: Merk;
  naam: string;
  puntType: string;
}

const GROUP_LABELS: Record<string, string> = {
  ov: 'OV-locaties',
  afval: 'Afval & inzameling',
  publiek: 'Publieke gebouwen',
  onderwijs: 'Onderwijs',
  voorzieningen: 'Voorzieningen',
};

const GROUP_ORDER = ['afval', 'voorzieningen', 'ov', 'publiek', 'onderwijs'];

/**
 * Categories a new inleverpunt could plausibly live at, pre-selected so the
 * map opens on something useful rather than on 8.000 glass containers.
 */
const DEFAULT_CATEGORIES = ['supermarkt', 'winkelcentrum', 'milieustraat', 'bouwmarkt'];

/** Any inleverpunt within this distance of a POI counts as "already served". */
const SERVED_RADIUS_M = 100;

/** Metres between two WGS84 points. Equirectangular is plenty at city scale
 * and avoids a trig-heavy haversine in a loop over thousands of pairs. */
function metresBetween(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const meanLat = ((aLat + bLat) / 2) * (Math.PI / 180);
  const dx = (bLon - aLon) * 111_320 * Math.cos(meanLat);
  const dy = (bLat - aLat) * 110_540;
  return Math.hypot(dx, dy);
}

export default function PoiExplorer() {
  const basemapId = useSyncExternalStore(
    subscribeBasemap,
    getBasemapSnapshot,
    getServerBasemapSnapshot
  );
  const basemap = getBasemap(basemapId);

  const storedSlug = useSyncExternalStore(
    subscribeMunicipality,
    getMunicipalitySnapshot,
    getServerMunicipalitySnapshot
  );

  const [indexes, setIndexes] = useState<{
    categories: CategoryMeta[];
    municipalities: Record<string, MunicipalityIndexEntry>;
  } | null>(null);
  const [chosenSlug, setChosenSlug] = useState<string | null>(null);
  // Keyed by slug so `loading` is derived rather than a second state that has
  // to be kept in step with the fetch.
  const [loaded, setLoaded] = useState<{
    slug: string;
    bundle: Bundle;
    existing: ExistingPoint[];
  } | null>(null);
  const [active, setActive] = useState<Set<string>>(new Set(DEFAULT_CATEGORIES));
  const [showExisting, setShowExisting] = useState(true);
  const [onlyUnserved, setOnlyUnserved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetch('/data/poi/index.json').then((r) => r.json()),
      fetch('/data/poi/by-municipality/index.json').then((r) => r.json()),
    ])
      .then(([catIndex, muni]) => {
        if (cancelled) return;
        setIndexes({
          categories: catIndex.categories ?? [],
          municipalities: muni ?? {},
        });
      })
      .catch(() => {
        if (!cancelled) setError('De POI-index kon niet worden geladen.');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const availableSlugs = useMemo(
    () => Object.keys(indexes?.municipalities ?? {}).sort(),
    [indexes]
  );

  // Explicit choice wins, then the shared sticky selection, then the first
  // municipality that has a bundle. Derived, so no effect has to sync it.
  const slug =
    (chosenSlug && availableSlugs.includes(chosenSlug) && chosenSlug) ||
    (storedSlug && availableSlugs.includes(storedSlug) && storedSlug) ||
    availableSlugs[0] ||
    '';

  useEffect(() => {
    if (!slug) return;
    let cancelled = false;
    setStoredMunicipality(slug);

    Promise.all([
      fetch(`/data/poi/by-municipality/${slug}.geojson`).then((r) => {
        if (!r.ok) throw new Error('bundle');
        return r.json();
      }),
      // Existing inleverpunten for the same municipality, so you can see which
      // candidate locations already have one. This replaces the carrier
      // pain-point overlay from the sister project, which has no counterpart
      // in this domain.
      fetch(`/data/${slug}.geojson`)
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null),
    ])
      .then(([poiBundle, municipality]) => {
        if (cancelled) return;
        const points: ExistingPoint[] = [];
        for (const feature of municipality?.features ?? []) {
          if (feature.properties?.type !== 'inleverpunt') continue;
          points.push({
            lat: feature.geometry.coordinates[1],
            lon: feature.geometry.coordinates[0],
            merk: feature.properties.merk,
            naam: feature.properties.locatieNaam,
            puntType: feature.properties.puntType,
          });
        }
        setLoaded({ slug, bundle: poiBundle as Bundle, existing: points });
        setError(null);
      })
      .catch(() => {
        if (!cancelled) setError(`Geen POI-bundel voor ${slug}.`);
      });

    return () => {
      cancelled = true;
    };
  }, [slug]);

  const bundle = loaded?.slug === slug ? loaded.bundle : null;
  const existing = useMemo(
    () => (loaded?.slug === slug ? loaded.existing : []),
    [loaded, slug]
  );
  const loading = !error && (!indexes || bundle === null);

  const categories = useMemo(() => indexes?.categories ?? [], [indexes]);

  const categoryBySlug = useMemo(
    () => new Map(categories.map((c) => [c.slug, c])),
    [categories]
  );

  const municipalityOptions = useMemo(
    () =>
      Object.entries(indexes?.municipalities ?? {})
        .map(([s, entry]) => ({ slug: s, name: entry.gemeente, total: entry.total }))
        .sort((a, b) => a.name.localeCompare(b.name, 'nl')),
    [indexes]
  );

  /** POIs of the active categories, each tagged with whether an inleverpunt
   * already sits within SERVED_RADIUS_M. */
  const visible = useMemo(() => {
    if (!bundle) return [];
    const selected = bundle.features.filter((f) => active.has(f.properties.category));
    return selected.map((feature) => {
      const [lon, lat] = feature.geometry.coordinates;
      let nearest = Infinity;
      for (const point of existing) {
        // Cheap degree-box reject before the metric distance.
        if (Math.abs(point.lat - lat) > 0.002 || Math.abs(point.lon - lon) > 0.004) {
          continue;
        }
        nearest = Math.min(nearest, metresBetween(lat, lon, point.lat, point.lon));
      }
      return { feature, lat, lon, nearest };
    });
  }, [bundle, active, existing]);

  const mapBounds = useMemo(
    () =>
      bundle?.features.length
        ? L.latLngBounds(
            bundle.features.map(
              (f) =>
                [f.geometry.coordinates[1], f.geometry.coordinates[0]] as [number, number]
            )
          )
        : null,
    [bundle]
  );

  const shown = onlyUnserved ? visible.filter((v) => v.nearest > SERVED_RADIUS_M) : visible;
  const servedCount = visible.filter((v) => v.nearest <= SERVED_RADIUS_M).length;

  const groups = useMemo(() => {
    const byGroup = new Map<string, CategoryMeta[]>();
    for (const category of categories) {
      if (!byGroup.has(category.group)) byGroup.set(category.group, []);
      byGroup.get(category.group)!.push(category);
    }
    return GROUP_ORDER.filter((g) => byGroup.has(g)).map((g) => ({
      key: g,
      label: GROUP_LABELS[g] ?? g,
      categories: byGroup.get(g)!,
    }));
  }, [categories]);

  const toggle = (categorySlug: string) =>
    setActive((prev) => {
      const next = new Set(prev);
      if (next.has(categorySlug)) next.delete(categorySlug);
      else next.add(categorySlug);
      return next;
    });

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-bold text-[var(--green-900)]">Publieke POI&apos;s</h2>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          Kandidaat-locaties voor een inleverpunt uit OpenStreetMap: supermarkten,
          bouwmarkten, drogisterijen, milieustraten, OV-haltes en publieke gebouwen.
          De bestaande inleverpunten liggen eroverheen, zodat direct zichtbaar is
          welke locaties er al één hebben en welke niet.
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-[20rem_1fr]">
        {/* Sidebar */}
        <div className="space-y-3">
          <div className="space-y-2 rounded-lg border border-border bg-card p-3">
            <label
              htmlFor="poi-gemeente"
              className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground"
            >
              Gemeente
            </label>
            <select
              id="poi-gemeente"
              value={slug}
              onChange={(e) => setChosenSlug(e.target.value)}
              className="min-h-10 w-full rounded-md border border-border bg-card px-2 text-sm"
            >
              {municipalityOptions.map((m) => (
                <option key={m.slug} value={m.slug}>
                  {m.name} ({nlInt(m.total)})
                </option>
              ))}
            </select>
            {municipalityOptions.length > 0 && municipalityOptions.length < 20 && (
              <p className="text-xs text-muted-foreground">
                {municipalityOptions.length} gemeenten beschikbaar — de POI-bundels
                zijn eerst voor de pilotset gegenereerd. Draai{' '}
                <code className="font-mono">
                  split_pois_by_municipality.py
                </code>{' '}
                zonder <code className="font-mono">--only</code> voor heel Nederland.
              </p>
            )}
          </div>

          <div className="space-y-2 rounded-lg border border-border bg-card p-3">
            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={showExisting}
                onChange={(e) => setShowExisting(e.target.checked)}
                className="size-3.5 accent-[var(--green-600)]"
              />
              Bestaande inleverpunten ({nlInt(existing.length)})
            </label>
            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={onlyUnserved}
                onChange={(e) => setOnlyUnserved(e.target.checked)}
                className="size-3.5 accent-[var(--green-600)]"
              />
              Alleen POI&apos;s zonder inleverpunt
            </label>
            <p className="text-xs text-muted-foreground">
              {nlInt(servedCount)} van {nlInt(visible.length)}{' '}
              getoonde POI&apos;s heeft
              al een inleverpunt binnen {SERVED_RADIUS_M} m.
            </p>
          </div>

          <div className="space-y-3 rounded-lg border border-border bg-card p-3">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Lagen
              </span>
              <button
                type="button"
                onClick={() => setActive(new Set())}
                className="text-xs text-muted-foreground hover:text-foreground"
              >
                Wis alles
              </button>
            </div>
            {groups.map((group) => (
              <div key={group.key}>
                <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {group.label}
                </h3>
                <ul className="space-y-0.5">
                  {group.categories.map((category) => {
                    const inBundle = bundle?.metadata.by_category[category.slug] ?? 0;
                    return (
                      <li key={category.slug}>
                        <label
                          className={cn(
                            'flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-sm hover:bg-muted',
                            inBundle === 0 && 'opacity-45'
                          )}
                        >
                          <input
                            type="checkbox"
                            checked={active.has(category.slug)}
                            onChange={() => toggle(category.slug)}
                            className="size-3.5 accent-[var(--green-600)]"
                          />
                          <span
                            className="inline-block size-2.5 shrink-0 rounded-full"
                            style={{ background: category.color }}
                          />
                          <span className="flex-1">{category.label}</span>
                          <span className="tabular-nums text-xs text-muted-foreground">
                            {nlInt(inBundle)}
                          </span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </div>
        </div>

        {/* Map */}
        <div className="relative h-[32rem] overflow-hidden rounded-lg border border-border lg:h-[42rem]">
          {(loading || error) && (
            <div className="absolute inset-0 z-[500] flex items-center justify-center bg-card/80 text-sm text-muted-foreground">
              {error ?? 'Kaart laden…'}
            </div>
          )}
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
            <FitBounds bounds={mapBounds} padding={[30, 30]} />

            {/* Existing points sit under the candidates: they are context. */}
            <Pane name="existing" style={{ zIndex: 420 }}>
              {showExisting &&
                existing.map((point, i) => (
                  <CircleMarker
                    key={`e${i}`}
                    center={[point.lat, point.lon]}
                    radius={3}
                    pathOptions={{
                      color: MERK_COLORS[point.merk] ?? 'var(--muted-foreground)',
                      weight: 1,
                      fillOpacity: 0.5,
                    }}
                  >
                    <Popup>
                      <strong>{point.naam}</strong>
                      <br />
                      {point.merk} · {point.puntType}
                    </Popup>
                  </CircleMarker>
                ))}
            </Pane>

            <Pane name="candidates" style={{ zIndex: 440 }}>
              {shown.map(({ feature, lat, lon, nearest }, i) => {
                const meta = categoryBySlug.get(feature.properties.category);
                const served = nearest <= SERVED_RADIUS_M;
                return (
                  <CircleMarker
                    key={`${feature.properties.osm_id || i}`}
                    center={[lat, lon]}
                    radius={5}
                    pathOptions={{
                      color: meta?.color ?? '#475569',
                      // A filled ring means "already has an inleverpunt"; the
                      // hollow ones are the opportunity.
                      fillColor: served ? meta?.color ?? '#475569' : '#ffffff',
                      weight: 2,
                      fillOpacity: served ? 0.85 : 0.9,
                    }}
                  >
                    <Popup>
                      <strong>{feature.properties.name || meta?.label}</strong>
                      <br />
                      {meta?.label}
                      {feature.properties.operator && ` · ${feature.properties.operator}`}
                      <br />
                      {served
                        ? `Inleverpunt op ${Math.round(nearest)} m`
                        : 'Geen inleverpunt binnen 100 m'}
                    </Popup>
                  </CircleMarker>
                );
              })}
            </Pane>
          </MapContainer>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-4 rounded-lg border border-border bg-card px-4 py-3 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span className="inline-block size-3 rounded-full border-2 border-[var(--green-700)] bg-white" />
          POI zonder inleverpunt
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block size-3 rounded-full border-2 border-[var(--green-700)] bg-[var(--green-700)]" />
          POI met inleverpunt binnen {SERVED_RADIUS_M} m
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block size-2 rounded-full bg-[var(--merk-statiegeld)]" />
          bestaand inleverpunt (kleur = merk)
        </span>
        <span className="ml-auto">Bron: OpenStreetMap via Overpass API</span>
      </div>
    </div>
  );
}
