'use client';

import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import dynamic from 'next/dynamic';

import {
  CsvButton,
  MethodologyNote,
  SegControl,
  StatTile,
  downloadCsv,
} from '@/components/analyse/AnalyseUI';
import type { SuggestionMarker } from '@/components/analyse/SuggestionMap';
import {
  getMunicipalitySnapshot,
  getServerMunicipalitySnapshot,
  setStoredMunicipality,
  subscribeMunicipality,
} from '@/lib/municipalityStore';
import { nlInt, nlNum, nlPct } from '@/types/analyse';

const SuggestionMap = dynamic(() => import('@/components/analyse/SuggestionMap'), {
  ssr: false,
  loading: () => (
    <div className="flex size-full items-center justify-center bg-muted text-sm text-muted-foreground">
      Kaart laden…
    </div>
  ),
});

export interface Suggestion {
  rank: number;
  lat: number;
  lon: number;
  pre_snap_lat: number;
  pre_snap_lon: number;
  white_spot_area_m2: number;
  est_new_pop_within_400m: number;
  snapped: boolean;
  poi_category: string | null;
  poi_naam: string | null;
  poi_distance_m: number | null;
}

export interface Pc4Record {
  pc4: string;
  priority: number;
  population: number;
  actual: number;
  predicted: number;
  underservice: number;
  uncovered_pop: number;
  density: number;
  overlap_pct: number;
  coverage_pct_400m: number;
  z_underservice: number;
  z_uncovered_pop: number;
  z_density: number;
  z_overlap_penalty: number;
  suggestions: Suggestion[];
}

export interface MunicipalityBlock {
  gemeente: string;
  pc4_count_evaluated: number;
  existing_points: number;
  pc4s: Pc4Record[];
}

export interface PlacementSuggestionsPayload {
  generated_at: string;
  weights: Record<WeightKey, number>;
  streams: string[];
  top_n_per_municipality: number;
  suggestions_per_pc4: number;
  buffer_m: number;
  poi_snap_radius_m: number;
  poi_snap_max_m: number;
  poi_report_radius_m: number;
  poi_snap_tiers: Record<string, Record<string, number>>;
  min_pc4_population: number;
  min_white_spot_area_m2: number;
  methodology: Record<string, string>;
  by_stream: Record<string, Record<string, MunicipalityBlock>>;
}

type WeightKey = 'underservice' | 'uncovered_pop' | 'density' | 'overlap_penalty';

const WEIGHT_LABELS: Record<WeightKey, string> = {
  underservice: 'Onderbediening t.o.v. model',
  uncovered_pop: 'Inwoners buiten bereik',
  density: 'Adressendichtheid',
  overlap_penalty: 'Al gedekt (strafterm)',
};

const WEIGHT_HINTS: Record<WeightKey, string> = {
  underservice:
    'Voorspeld minus werkelijk aantal punten uit de regressie op de Schatting-tab.',
  uncovered_pop: 'Inwoners van dit PC4 die buiten 400 m van elk punt in deze stroom wonen.',
  density: 'Omgevingsadressendichtheid — waar de vraag zich concentreert.',
  overlap_penalty:
    'Aandeel van het PC4 dat al binnen 400 m van een bestaand punt ligt. Negatief gewicht: hoe meer overlap, hoe lager de prioriteit.',
};

const WEIGHT_KEYS: WeightKey[] = [
  'underservice',
  'uncovered_pop',
  'density',
  'overlap_penalty',
];

const STREAM_LABELS: Record<string, string> = {
  statiegeld: 'Statiegeld',
  batterijen: 'Batterijen & lampen',
  elektro: 'Elektrische apparaten',
};

const POI_LABELS: Record<string, string> = {
  supermarkt: 'Supermarkt',
  winkelcentrum: 'Winkelcentrum',
  milieustraat: 'Milieustraat',
  bouwmarkt: 'Bouwmarkt',
  drogisterij: 'Drogisterij',
  bibliotheek: 'Bibliotheek',
  gemeentehuis: 'Gemeentehuis',
  ns_station: 'NS-station',
  metro_station: 'Metrostation',
  ov_knooppunt: 'OV-knooppunt',
  parkeergarage: 'Parkeergarage',
  glasbak: 'Glas-/textielcontainer',
};

function poiLabel(suggestion: Suggestion): string | null {
  if (!suggestion.poi_category) return null;
  const type = POI_LABELS[suggestion.poi_category] ?? suggestion.poi_category;
  return suggestion.poi_naam ? `${type} ${suggestion.poi_naam}` : type;
}

export default function PlacementSuggestionsReport({
  payload,
}: {
  payload: PlacementSuggestionsPayload;
}) {
  const [stream, setStream] = useState(payload.streams[0] ?? 'statiegeld');
  const slugsForStream = useMemo(
    () => Object.keys(payload.by_stream[stream] ?? {}).sort(),
    [payload.by_stream, stream]
  );

  const storedSlug = useSyncExternalStore(
    subscribeMunicipality,
    getMunicipalitySnapshot,
    getServerMunicipalitySnapshot
  );
  const [chosenSlug, setChosenSlug] = useState<string | null>(null);
  // Explicit choice wins, then the shared sticky selection, then the first
  // municipality that has advice for this stream. Derived, so switching
  // stream cannot leave the select pointing at a municipality that is missing
  // from the new stream.
  const slug =
    (chosenSlug && slugsForStream.includes(chosenSlug) && chosenSlug) ||
    (storedSlug && slugsForStream.includes(storedSlug) && storedSlug) ||
    slugsForStream[0] ||
    '';

  const [weights, setWeights] = useState<Record<WeightKey, number>>(payload.weights);
  const [selectedPc4, setSelectedPc4] = useState<string | null>(null);
  const [loadedExisting, setLoadedExisting] = useState<{
    slug: string;
    points: { lat: number; lon: number; naam: string }[];
  } | null>(null);

  useEffect(() => {
    if (!slug) return;
    setStoredMunicipality(slug);
    let cancelled = false;
    fetch(`/data/${slug}.geojson`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled) return;
        const points: { lat: number; lon: number; naam: string }[] = [];
        for (const feature of data?.features ?? []) {
          if (feature.properties?.type !== 'inleverpunt') continue;
          points.push({
            lat: feature.geometry.coordinates[1],
            lon: feature.geometry.coordinates[0],
            naam: feature.properties.locatieNaam,
          });
        }
        setLoadedExisting({ slug, points });
      })
      .catch(() => {
        if (!cancelled) setLoadedExisting({ slug, points: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  const existing = useMemo(
    () => (loadedExisting?.slug === slug ? loadedExisting.points : []),
    [loadedExisting, slug]
  );

  const block = payload.by_stream[stream]?.[slug] ?? null;

  /**
   * Recompute priority from the shipped z-scores. Because those were
   * normalised within the municipality server-side, Σ wᵢ·zᵢ reproduces the
   * server ranking exactly at the default weights — the sliders only re-sort
   * the ten PC4s that were already snapped, they cannot pull in an eleventh.
   */
  const ranked = useMemo(() => {
    if (!block) return [];
    return [...block.pc4s]
      .map((record) => ({
        ...record,
        score:
          weights.underservice * record.z_underservice +
          weights.uncovered_pop * record.z_uncovered_pop +
          weights.density * record.z_density +
          weights.overlap_penalty * record.z_overlap_penalty,
      }))
      .sort((a, b) => b.score - a.score);
  }, [block, weights]);

  const active = useMemo(
    () => ranked.find((r) => r.pc4 === selectedPc4) ?? ranked[0] ?? null,
    [ranked, selectedPc4]
  );

  const markers: SuggestionMarker[] = useMemo(
    () =>
      (active?.suggestions ?? []).map((suggestion) => ({
        rank: suggestion.rank,
        lat: suggestion.lat,
        lon: suggestion.lon,
        preSnapLat: suggestion.pre_snap_lat,
        preSnapLon: suggestion.pre_snap_lon,
        snapped: suggestion.snapped,
        poiLabel: poiLabel(suggestion),
        poiDistance: suggestion.poi_distance_m,
        estNewPop: suggestion.est_new_pop_within_400m,
      })),
    [active]
  );

  const totals = useMemo(() => {
    const suggestions = ranked.flatMap((r) => r.suggestions);
    return {
      spots: suggestions.length,
      snapped: suggestions.filter((s) => s.snapped).length,
      newPop: suggestions.reduce((sum, s) => sum + s.est_new_pop_within_400m, 0),
    };
  }, [ranked]);

  function exportCsv() {
    const rows: (string | number | null)[][] = [
      [
        'gemeente', 'stroom', 'pc4', 'prioriteit', 'inwoners', 'werkelijk',
        'voorspeld', 'onderbediening', 'inwoners_buiten_bereik', 'dichtheid',
        'dekking_400m_pct', 'plek', 'lat', 'lon', 'nieuw_bereikte_inwoners',
        'gesnapt', 'gastheer', 'gastheer_afstand_m',
      ],
    ];
    for (const record of ranked) {
      for (const suggestion of record.suggestions) {
        rows.push([
          block?.gemeente ?? slug, stream, record.pc4,
          Number(record.score.toFixed(3)), record.population, record.actual,
          record.predicted, record.underservice, record.uncovered_pop,
          record.density, record.coverage_pct_400m, suggestion.rank,
          suggestion.lat, suggestion.lon, suggestion.est_new_pop_within_400m,
          suggestion.snapped ? 'ja' : 'nee', poiLabel(suggestion),
          suggestion.poi_distance_m,
        ]);
      }
    }
    downloadCsv(`plaatsingsadvies-${slug}-${stream}.csv`, rows);
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-bold text-[var(--green-900)]">Plaatsingsadvies</h2>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          Welke postcodegebieden verdienen als eerste een extra inleverpunt, en waar in
          dat gebied precies? De ranking combineert onderbediening ten opzichte van het
          regressiemodel, inwoners buiten loopafstand, adressendichtheid en een
          strafterm voor gebied dat al gedekt is. Per gebied worden tot{' '}
          {payload.suggestions_per_pc4} concrete plekken afgeleid uit de bewoonde witte
          vlekken.
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-4 rounded-lg border border-border bg-card p-4">
        <SegControl
          label="Stroom"
          value={stream}
          onChange={setStream}
          options={payload.streams.map((s) => ({
            value: s,
            label: STREAM_LABELS[s] ?? s,
          }))}
        />
        <div>
          <label
            htmlFor="ps-gemeente"
            className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-muted-foreground"
          >
            Gemeente
          </label>
          <select
            id="ps-gemeente"
            value={slug}
            onChange={(e) => {
              setChosenSlug(e.target.value);
              setSelectedPc4(null);
            }}
            className="min-h-10 rounded-md border border-border bg-card px-2 text-sm"
          >
            {slugsForStream.map((s) => (
              <option key={s} value={s}>
                {payload.by_stream[stream][s].gemeente}
              </option>
            ))}
          </select>
        </div>
        <CsvButton onClick={exportCsv} label="CSV" />
      </div>

      {!block ? (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          Geen advies voor deze combinatie.
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatTile
              label="PC4's beoordeeld"
              value={nlInt(block.pc4_count_evaluated)}
              hint={`top ${payload.top_n_per_municipality} uitgewerkt`}
            />
            <StatTile
              label="Bestaande punten"
              value={nlInt(block.existing_points)}
              hint={STREAM_LABELS[stream] ?? stream}
            />
            <StatTile label="Voorgestelde plekken" value={nlInt(totals.spots)} hint={`${nlInt(totals.snapped)} gesnapt naar een gastheer`} />
            <StatTile
              label="Nieuw bereik samen"
              value={nlInt(totals.newPop)}
              hint={`inwoners binnen ${payload.buffer_m} m`}
            />
          </div>

          {/* Weights */}
          <section className="space-y-3 rounded-lg border border-border bg-card p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="text-lg font-semibold text-[var(--green-900)]">
                Weeg de signalen
              </h3>
              <button
                type="button"
                onClick={() => setWeights(payload.weights)}
                className="text-xs text-muted-foreground hover:text-foreground"
              >
                Terug naar standaard
              </button>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              {WEIGHT_KEYS.map((key) => (
                <div key={key}>
                  <div className="flex items-baseline justify-between gap-2">
                    <label htmlFor={`w-${key}`} className="text-sm" title={WEIGHT_HINTS[key]}>
                      {WEIGHT_LABELS[key]}
                    </label>
                    <span className="text-sm font-medium tabular-nums">
                      {nlNum(weights[key], 2)}
                    </span>
                  </div>
                  <input
                    id={`w-${key}`}
                    type="range"
                    min={-1}
                    max={1}
                    step={0.05}
                    value={weights[key]}
                    onChange={(e) =>
                      setWeights((prev) => ({ ...prev, [key]: Number(e.target.value) }))
                    }
                    className="w-full accent-[var(--green-600)]"
                  />
                  <p className="text-xs text-muted-foreground">{WEIGHT_HINTS[key]}</p>
                </div>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              De schuiven hersorteren de tien uitgewerkte PC4&apos;s; ze kunnen er geen
              elfde bij halen. Voor een andere top-10 moet{' '}
              <code className="font-mono">suggest_placements.py</code> opnieuw draaien
              met andere <code className="font-mono">--w-</code>-waarden.
            </p>
          </section>

          <div className="grid gap-4 xl:grid-cols-[1fr_24rem]">
            {/* Ranking */}
            <section className="overflow-hidden rounded-lg border border-border bg-card">
              <div className="border-b border-border px-4 py-3">
                <h3 className="text-lg font-semibold text-[var(--green-900)]">Ranking</h3>
                <p className="text-xs text-muted-foreground">
                  Klik een rij om de voorgestelde plekken op de kaart te zien.
                </p>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[38rem] text-sm">
                  <thead className="border-b border-border bg-muted/50 text-xs text-muted-foreground">
                    <tr>
                      <th className="px-2 py-2 text-left font-semibold">PC4</th>
                      <th className="px-2 py-2 text-right font-semibold">Score</th>
                      <th className="px-2 py-2 text-right font-semibold">Inwoners</th>
                      <th className="px-2 py-2 text-right font-semibold" title="Werkelijk aantal punten versus wat het model voorspelt">
                        Nu / verwacht
                      </th>
                      <th className="px-2 py-2 text-right font-semibold">Dekking</th>
                      <th className="px-2 py-2 text-right font-semibold">Plekken</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ranked.map((record) => (
                      <tr
                        key={record.pc4}
                        onClick={() => setSelectedPc4(record.pc4)}
                        className={`cursor-pointer border-b border-border/60 last:border-0 hover:bg-muted/40 ${
                          active?.pc4 === record.pc4 ? 'bg-[var(--green-50)]' : ''
                        }`}
                      >
                        <td className="px-2 py-1.5 font-mono">{record.pc4}</td>
                        <td className="px-2 py-1.5 text-right font-medium tabular-nums">
                          {nlNum(record.score, 2)}
                        </td>
                        <td className="px-2 py-1.5 text-right tabular-nums">
                          {nlInt(record.population)}
                        </td>
                        <td className="px-2 py-1.5 text-right tabular-nums">
                          {record.actual} / {nlNum(record.predicted, 1)}
                        </td>
                        <td className="px-2 py-1.5 text-right tabular-nums">
                          {nlPct(record.coverage_pct_400m)}%
                        </td>
                        <td className="px-2 py-1.5 text-right tabular-nums">
                          {record.suggestions.length}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            {/* Detail */}
            <div className="space-y-3">
              {/* `relative` is load-bearing: the basemap switcher inside the
                  map is absolutely positioned and would otherwise anchor to
                  the page and land on top of the tab strip. */}
              <div className="relative h-72 overflow-hidden rounded-lg border border-border">
                <SuggestionMap
                  markers={markers}
                  existing={existing}
                  bufferM={payload.buffer_m}
                />
              </div>
              {active && (
                <div className="rounded-lg border border-border bg-card p-3">
                  <h3 className="text-sm font-semibold text-[var(--green-900)]">
                    PC4 {active.pc4} — voorgestelde plekken
                  </h3>
                  <dl className="mt-1 grid grid-cols-2 gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                    <dt>Onderbediening</dt>
                    <dd className="text-right tabular-nums text-foreground">
                      {nlNum(active.underservice, 1)}
                    </dd>
                    <dt>Buiten bereik</dt>
                    <dd className="text-right tabular-nums text-foreground">
                      {nlInt(active.uncovered_pop)} inw.
                    </dd>
                    <dt>Al gedekt</dt>
                    <dd className="text-right tabular-nums text-foreground">
                      {nlPct(active.overlap_pct)}%
                    </dd>
                  </dl>
                  <ol className="mt-2 space-y-2 text-sm">
                    {active.suggestions.map((suggestion) => (
                      <li key={suggestion.rank} className="rounded border border-border p-2">
                        <div className="flex items-baseline justify-between gap-2">
                          <span className="font-medium">Plek {suggestion.rank}</span>
                          <span className="text-xs tabular-nums text-muted-foreground">
                            +{nlInt(suggestion.est_new_pop_within_400m)} inwoners
                          </span>
                        </div>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {suggestion.snapped ? (
                            <>
                              Gesnapt naar{' '}
                              <span className="text-foreground">{poiLabel(suggestion)}</span>{' '}
                              ({suggestion.poi_distance_m} m)
                            </>
                          ) : suggestion.poi_category ? (
                            <>
                              Geen gastheer binnen {payload.poi_snap_max_m} m —
                              dichtstbij: {poiLabel(suggestion)} op{' '}
                              {suggestion.poi_distance_m} m. Dit vraagt om een
                              zelfstandige unit.
                            </>
                          ) : (
                            'Geen geschikte gastheer in de buurt gevonden.'
                          )}
                        </p>
                        <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">
                          {suggestion.lat.toFixed(5)}, {suggestion.lon.toFixed(5)}
                        </p>
                      </li>
                    ))}
                    {active.suggestions.length === 0 && (
                      <li className="text-xs text-muted-foreground">
                        Geen bewoonde witte vlek gevonden in dit PC4.
                      </li>
                    )}
                  </ol>
                </div>
              )}
            </div>
          </div>

          <MethodologyNote>
            {Object.entries(payload.methodology).map(([key, value]) => (
              <p key={key}>
                <span className="font-medium text-foreground">
                  {key.replace(/_/g, ' ')}:
                </span>{' '}
                {value}
              </p>
            ))}
            <p>
              Gegenereerd op{' '}
              {new Date(payload.generated_at).toLocaleString('nl-NL', {
                dateStyle: 'long',
                timeStyle: 'short',
              })}
              .
            </p>
          </MethodologyNote>
        </>
      )}
    </div>
  );
}
