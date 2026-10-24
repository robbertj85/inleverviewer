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
import {
  EIGENDOM_COLOURS,
  EIGENDOM_LABELS,
  type Eigendom,
} from '@/lib/inleverpuntNetwork';
import { nlInt, nlNum, nlPct } from '@/types/analyse';
import { withBase } from '@/lib/basePath';

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
  poi_eigendom: Eigendom | null;
  poi_eigendom_bron: string | null;
  /** Newly reached inhabitants per network, unweighted. */
  gain_by_layer: Record<string, number>;
}

export type Terrain = 'mix' | 'publiek' | 'privaat';

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
  /** The PC4 ranking does not depend on the terrain choice; the spots do. */
  suggestions: Record<Terrain, Suggestion[]>;
}

/** One stream (or all streams), with or without parcel points. */
export interface VariantBlock {
  layers: string[];
  pc4_count_evaluated: number;
  existing: Record<string, number>;
  pc4s: Pc4Record[];
}

export interface MunicipalitySuggestions {
  slug: string;
  gemeente: string;
  hosts_by_eigendom: Record<Eigendom, number>;
  /** Keyed `<stream>` or `<stream>+pakket`. */
  variants: Record<string, VariantBlock>;
}

export interface PlacementSuggestionsIndex {
  generated_at: string;
  weights: Record<WeightKey, number>;
  streams: string[];
  terrains: Terrain[];
  top_n_per_municipality: number;
  suggestions_per_pc4: number;
  buffer_m: number;
  poi_snap_radius_m: number;
  poi_snap_max_m: number;
  poi_report_radius_m: number;
  poi_snap_tiers: Record<string, Record<string, number>>;
  pakket_hosts: string[];
  min_pc4_population: number;
  methodology: Record<string, string>;
  municipalities: Record<string, { gemeente: string; variants: string[] }>;
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
  alle: 'Alle stromen',
};

/** Short names for the networks a variant counts, in gain breakdowns. */
const LAYER_LABELS: Record<string, string> = {
  statiegeld: 'statiegeld',
  batterijen: 'batterijen',
  elektro: 'elektro',
  pakket: 'pakketpunt',
};

const TERRAIN_HINTS: Record<Terrain, string> = {
  mix: 'Elke geschikte gastheer, ongeacht wie erover beslist.',
  publiek: 'Alleen gastheren op openbare grond of van de overheid: de gemeente beslist zelf.',
  privaat: 'Alleen gastheren op privaat terrein: de eigenaar beslist, de gemeente kan alleen vragen.',
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

const variantKey = (stream: string, pakket: boolean) =>
  pakket ? `${stream}+pakket` : stream;

function poiLabel(suggestion: Suggestion): string | null {
  if (!suggestion.poi_category) return null;
  const type = POI_LABELS[suggestion.poi_category] ?? suggestion.poi_category;
  return suggestion.poi_naam ? `${type} ${suggestion.poi_naam}` : type;
}

export default function PlacementSuggestionsReport({
  index,
}: {
  index: PlacementSuggestionsIndex;
}) {
  const [stream, setStream] = useState(index.streams[0] ?? 'statiegeld');
  const [pakket, setPakket] = useState(false);
  const [terrain, setTerrain] = useState<Terrain>('mix');
  const key = variantKey(stream, pakket);

  const slugs = useMemo(
    () =>
      Object.entries(index.municipalities)
        .filter(([, entry]) => entry.variants.includes(key))
        .sort(([, a], [, b]) => a.gemeente.localeCompare(b.gemeente, 'nl'))
        .map(([slug]) => slug),
    [index.municipalities, key]
  );

  const storedSlug = useSyncExternalStore(
    subscribeMunicipality,
    getMunicipalitySnapshot,
    getServerMunicipalitySnapshot
  );
  const [chosenSlug, setChosenSlug] = useState<string | null>(null);
  // Explicit choice wins, then the shared sticky selection, then the first
  // municipality that has advice for this variant. Derived, so switching
  // variant cannot leave the select pointing at a municipality without one.
  const slug =
    (chosenSlug && slugs.includes(chosenSlug) && chosenSlug) ||
    (storedSlug && slugs.includes(storedSlug) && storedSlug) ||
    slugs[0] ||
    '';

  const [weights, setWeights] = useState<Record<WeightKey, number>>(index.weights);
  const [selectedPc4, setSelectedPc4] = useState<string | null>(null);
  // Keyed by slug so a stale response can be told apart from the current one.
  const [loaded, setLoaded] = useState<{
    slug: string;
    data: MunicipalitySuggestions | null;
    points: { lat: number; lon: number; naam: string }[];
  } | null>(null);

  useEffect(() => {
    if (!slug) return;
    setStoredMunicipality(slug);
    let cancelled = false;
    Promise.all([
      fetch(withBase(`/data/placement_suggestions/${slug}.json`))
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null),
      fetch(withBase(`/data/${slug}.geojson`))
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null),
    ]).then(([data, geojson]) => {
      if (cancelled) return;
      const points: { lat: number; lon: number; naam: string }[] = [];
      for (const feature of geojson?.features ?? []) {
        if (feature.properties?.type !== 'inleverpunt') continue;
        points.push({
          lat: feature.geometry.coordinates[1],
          lon: feature.geometry.coordinates[0],
          naam: feature.properties.locatieNaam,
        });
      }
      setLoaded({ slug, data, points });
    });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  const current = loaded?.slug === slug ? loaded : null;
  const existing = useMemo(() => current?.points ?? [], [current]);
  const block = current?.data?.variants[key] ?? null;
  const loading = Boolean(slug) && !current;

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
        spots: record.suggestions[terrain] ?? [],
        score:
          weights.underservice * record.z_underservice +
          weights.uncovered_pop * record.z_uncovered_pop +
          weights.density * record.z_density +
          weights.overlap_penalty * record.z_overlap_penalty,
      }))
      .sort((a, b) => b.score - a.score);
  }, [block, weights, terrain]);

  const active = useMemo(
    () => ranked.find((r) => r.pc4 === selectedPc4) ?? ranked[0] ?? null,
    [ranked, selectedPc4]
  );

  const markers: SuggestionMarker[] = useMemo(
    () =>
      (active?.spots ?? []).map((suggestion) => ({
        rank: suggestion.rank,
        lat: suggestion.lat,
        lon: suggestion.lon,
        preSnapLat: suggestion.pre_snap_lat,
        preSnapLon: suggestion.pre_snap_lon,
        snapped: suggestion.snapped,
        poiLabel: poiLabel(suggestion),
        poiDistance: suggestion.poi_distance_m,
        terrain: suggestion.poi_eigendom ? EIGENDOM_LABELS[suggestion.poi_eigendom] : null,
        estNewPop: suggestion.est_new_pop_within_400m,
      })),
    [active]
  );

  const totals = useMemo(() => {
    const suggestions = ranked.flatMap((r) => r.spots);
    return {
      spots: suggestions.length,
      snapped: suggestions.filter((s) => s.snapped).length,
      newPop: suggestions.reduce((sum, s) => sum + s.est_new_pop_within_400m, 0),
    };
  }, [ranked]);

  const layers = block?.layers ?? [];

  function exportCsv() {
    const rows: (string | number | null)[][] = [
      [
        'gemeente', 'stroom', 'pc4', 'prioriteit', 'inwoners', 'werkelijk',
        'voorspeld', 'onderbediening', 'inwoners_buiten_bereik', 'dichtheid',
        'dekking_400m_pct', 'plek', 'lat', 'lon', 'nieuw_bereikte_inwoners',
        'gesnapt', 'gastheer', 'gastheer_afstand_m', 'gastheer_terrein',
        'gastheer_terrein_bron', 'variant', 'terreinkeuze',
        ...layers.map((layer) => `nieuw_${layer}`),
      ],
    ];
    for (const record of ranked) {
      for (const suggestion of record.spots) {
        rows.push([
          current?.data?.gemeente ?? slug, stream, record.pc4,
          Number(record.score.toFixed(3)), record.population, record.actual,
          record.predicted, record.underservice, record.uncovered_pop,
          record.density, record.coverage_pct_400m, suggestion.rank,
          suggestion.lat, suggestion.lon, suggestion.est_new_pop_within_400m,
          suggestion.snapped ? 'ja' : 'nee', poiLabel(suggestion),
          suggestion.poi_distance_m, suggestion.poi_eigendom,
          suggestion.poi_eigendom_bron, key, terrain,
          ...layers.map((layer) => suggestion.gain_by_layer?.[layer] ?? null),
        ]);
      }
    }
    downloadCsv(`plaatsingsadvies-${slug}-${key.replace('+', '-')}-${terrain}.csv`, rows);
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
          {index.suggestions_per_pc4} concrete plekken afgeleid uit de bewoonde witte
          vlekken. Kies één stroom of een locatie voor alle stromen tegelijk, eventueel
          gecombineerd met een pakketpunt.
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-x-6 gap-y-3 rounded-lg border border-border bg-card p-4">
        <SegControl
          label="Stroom"
          value={stream}
          onChange={setStream}
          options={index.streams.map((s) => ({
            value: s,
            label: STREAM_LABELS[s] ?? s,
            title:
              s === 'alle'
                ? 'Eén locatie die statiegeld, batterijen en elektro tegelijk inneemt.'
                : undefined,
          }))}
        />
        <SegControl
          label="Pakketpunten"
          value={pakket ? 'ja' : 'nee'}
          onChange={(v) => setPakket(v === 'ja')}
          options={[
            { value: 'nee', label: 'Alleen inleveren' },
            {
              value: 'ja',
              label: 'Inleverpunt + pakketpunt',
              title:
                'Telt ook inwoners zonder pakketpunt binnen loopafstand, en kiest alleen gastheren die ook een pakketbalie of -kluis kunnen huisvesten.',
            },
          ]}
        />
        <SegControl
          label="Locaties"
          value={terrain}
          onChange={setTerrain}
          options={[
            { value: 'mix', label: 'Publiek + privaat', title: TERRAIN_HINTS.mix },
            {
              value: 'publiek',
              label: current?.data
                ? `Publiek terrein (${nlInt(current.data.hosts_by_eigendom.publiek ?? 0)})`
                : 'Publiek terrein',
              title: TERRAIN_HINTS.publiek,
            },
            {
              value: 'privaat',
              label: current?.data
                ? `Privaat terrein (${nlInt(current.data.hosts_by_eigendom.privaat ?? 0)})`
                : 'Privaat terrein',
              title: TERRAIN_HINTS.privaat,
            },
          ]}
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
            {slugs.map((s) => (
              <option key={s} value={s}>
                {index.municipalities[s].gemeente}
              </option>
            ))}
          </select>
        </div>
        <CsvButton onClick={exportCsv} label="CSV" />
      </div>

      <p className="-mt-2 text-xs text-muted-foreground">
        {TERRAIN_HINTS[terrain]} Publiek of privaat gaat over het terrein onder de
        gastheer (OSM-tags, het type locatie of het BGT-object op die plek), niet over
        juridisch eigendom. De ranking van de PC4&apos;s verandert er niet door, alleen
        waar de plekken landen.
        {pakket && (
          <>
            {' '}Pakketpunten komen uit de pakketpuntenviewer en worden wekelijks
            opgehaald; die tellen ook over de gemeentegrens.
          </>
        )}
      </p>

      {loading ? (
        <div className="rounded-lg border border-border bg-card p-8 text-center text-sm text-muted-foreground">
          Advies laden…
        </div>
      ) : !block ? (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          Geen advies voor deze combinatie.
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatTile
              label="PC4's beoordeeld"
              value={nlInt(block.pc4_count_evaluated)}
              hint={`top ${index.top_n_per_municipality} uitgewerkt`}
            />
            <StatTile
              label="Bestaande punten"
              value={nlInt(
                layers
                  .filter((layer) => layer !== 'pakket')
                  .reduce((sum, layer) => sum + (block.existing[layer] ?? 0), 0)
              )}
              hint={layers
                .map((layer) => `${nlInt(block.existing[layer] ?? 0)} ${LAYER_LABELS[layer] ?? layer}`)
                .join(' · ')}
            />
            <StatTile label="Voorgestelde plekken" value={nlInt(totals.spots)} hint={`${nlInt(totals.snapped)} gesnapt naar een gastheer`} />
            <StatTile
              label="Nieuw bereik samen"
              value={nlInt(totals.newPop)}
              hint={
                layers.length > 1
                  ? `gewogen over ${layers.length} netwerken, binnen ${index.buffer_m} m`
                  : `inwoners binnen ${index.buffer_m} m`
              }
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
                onClick={() => setWeights(index.weights)}
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
                          {record.spots.length}
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
                  bufferM={index.buffer_m}
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
                    {active.spots.map((suggestion) => (
                      <li key={suggestion.rank} className="rounded border border-border p-2">
                        <div className="flex items-baseline justify-between gap-2">
                          <span className="font-medium">Plek {suggestion.rank}</span>
                          <span className="text-xs tabular-nums text-muted-foreground">
                            +{nlInt(suggestion.est_new_pop_within_400m)} inwoners
                          </span>
                        </div>
                        {layers.length > 1 && (
                          <p className="mt-0.5 text-[11px] text-muted-foreground">
                            {layers
                              .map(
                                (layer) =>
                                  `${LAYER_LABELS[layer] ?? layer} +${nlInt(suggestion.gain_by_layer?.[layer] ?? 0)}`
                              )
                              .join(' · ')}
                          </p>
                        )}
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {suggestion.snapped ? (
                            <>
                              Gesnapt naar{' '}
                              <span className="text-foreground">{poiLabel(suggestion)}</span>{' '}
                              ({suggestion.poi_distance_m} m)
                              {suggestion.poi_eigendom && (
                                <TerrainBadge
                                  eigendom={suggestion.poi_eigendom}
                                  bron={suggestion.poi_eigendom_bron}
                                />
                              )}
                            </>
                          ) : suggestion.poi_category ? (
                            <>
                              Geen {terrain === 'mix' ? '' : `${EIGENDOM_LABELS[terrain]}-`}gastheer binnen {index.poi_snap_max_m} m —
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
                    {active.spots.length === 0 && (
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
            {Object.entries(index.methodology).map(([name, value]) => (
              <p key={name}>
                <span className="font-medium text-foreground">
                  {name.replace(/_/g, ' ')}:
                </span>{' '}
                {value}
              </p>
            ))}
            <p>
              Gegenereerd op{' '}
              {new Date(index.generated_at).toLocaleString('nl-NL', {
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

function TerrainBadge({ eigendom, bron }: { eigendom: Eigendom; bron: string | null }) {
  return (
    <span
      className="ml-1 inline-block rounded px-1 text-[10px] font-semibold uppercase tracking-wide"
      style={{
        color: EIGENDOM_COLOURS[eigendom],
        border: `1px solid ${EIGENDOM_COLOURS[eigendom]}`,
      }}
      title={bron ?? undefined}
    >
      {eigendom}
    </span>
  );
}
