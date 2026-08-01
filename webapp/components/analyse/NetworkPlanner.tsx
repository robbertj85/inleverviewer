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
import NetworkCoverageChart from '@/components/analyse/NetworkCoverageChart';
import type { PickMarker } from '@/components/analyse/NetworkPlannerMap';
import {
  COMBI_RULE_HINTS,
  COMBI_RULE_LABELS,
  CombiRule,
  FLAG_LABELS,
  NetworkIndexEntry,
  NetworkPayload,
  START_LABELS,
  combiKey,
  containersNeeded,
  emptyingsPerWeek,
  litresPerYear,
  scenarioKey,
} from '@/lib/inleverpuntNetwork';
import {
  getMunicipalitySnapshot,
  getServerMunicipalitySnapshot,
  setStoredMunicipality,
  subscribeMunicipality,
} from '@/lib/municipalityStore';
import { nlInt, nlNum, nlPct } from '@/types/analyse';

const NetworkPlannerMap = dynamic(
  () => import('@/components/analyse/NetworkPlannerMap'),
  {
    ssr: false,
    loading: () => (
      <div className="flex size-full items-center justify-center bg-muted text-sm text-muted-foreground">
        Kaart laden…
      </div>
    ),
  }
);

type Mode = 'inleveren' | 'combi';

interface ExistingPoint {
  lat: number;
  lon: number;
  naam: string;
  merk: string;
}

const COLOUR_INLEVEREN = '#436325';
const COLOUR_PAKKETTEN = '#eb6834';

export default function NetworkPlanner({
  index,
  defaultSlug,
}: {
  index: Record<string, NetworkIndexEntry>;
  defaultSlug: string;
}) {
  const storedSlug = useSyncExternalStore(
    subscribeMunicipality,
    getMunicipalitySnapshot,
    getServerMunicipalitySnapshot
  );
  const [chosenSlug, setChosenSlug] = useState<string | null>(null);
  // Explicit choice wins, then the shared sticky selection, then the default.
  // Derived rather than synced from an effect.
  const slug =
    (chosenSlug && index[chosenSlug] && chosenSlug) ||
    (storedSlug && index[storedSlug] && storedSlug) ||
    defaultSlug;

  // Keyed by slug, so `loading` is derived instead of a second state that has
  // to be kept in step with the fetch.
  const [loaded, setLoaded] = useState<{
    slug: string;
    payload: NetworkPayload;
    existing: ExistingPoint[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [mode, setMode] = useState<Mode>('inleveren');
  const [distance, setDistance] = useState(400);
  const [start, setStart] = useState('alle-punten');
  const [combiRule, setCombiRule] = useState<CombiRule>('synergie');
  const [rawN, setN] = useState(0);
  const [stream, setStream] = useState('statiegeld');
  const [participation, setParticipation] = useState(60);

  const [showCells, setShowCells] = useState(true);
  const [showCandidates, setShowCandidates] = useState(false);
  const [showExisting, setShowExisting] = useState(false);
  const [showPakketpunten, setShowPakketpunten] = useState(true);

  const municipalities = useMemo(
    () =>
      Object.entries(index)
        .map(([s, entry]) => ({ slug: s, ...entry }))
        .sort((a, b) => a.gemeente.localeCompare(b.gemeente, 'nl')),
    [index]
  );

  useEffect(() => {
    if (!slug) return;
    let cancelled = false;
    setStoredMunicipality(slug);

    Promise.all([
      fetch(`/data/inleverpunt_network/${slug}.json`).then((r) => {
        if (!r.ok) throw new Error('network');
        return r.json();
      }),
      fetch(`/data/${slug}.geojson`)
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null),
    ])
      .then(([network, municipality]) => {
        if (cancelled) return;
        const points: ExistingPoint[] = [];
        for (const feature of municipality?.features ?? []) {
          if (feature.properties?.type !== 'inleverpunt') continue;
          points.push({
            lat: feature.geometry.coordinates[1],
            lon: feature.geometry.coordinates[0],
            naam: feature.properties.locatieNaam,
            merk: feature.properties.merk,
          });
        }
        setLoaded({ slug, payload: network as NetworkPayload, existing: points });
        setError(null);
      })
      .catch(() => {
        if (!cancelled) setError(`Geen netwerkdata voor ${slug}.`);
      });

    return () => {
      cancelled = true;
    };
  }, [slug]);

  const payload = loaded?.slug === slug ? loaded.payload : null;
  const existing = useMemo(
    () => (loaded?.slug === slug ? loaded.existing : []),
    [loaded, slug]
  );
  const loading = !payload && !error;

  // ---- Current scenario ----
  const scenario = payload
    ? payload.scenarios[scenarioKey(distance, start)] ?? null
    : null;
  const combi = payload
    ? payload.combi_scenarios[combiKey(distance, combiRule)] ?? null
    : null;

  const active = mode === 'combi' ? combi : scenario;
  const maxPicks = active
    ? mode === 'combi'
      ? combi!.picks.length
      : scenario!.picks.length
    : 0;

  // The slider position is clamped on read rather than reset from an effect,
  // so switching scenario keeps the count where it was when the new scenario
  // is long enough to hold it.
  const n = Math.min(rawN, maxPicks);

  const picks: PickMarker[] = useMemo(() => {
    if (!payload) return [];
    if (mode === 'combi' && combi) {
      return combi.picks.map((pick, i) => ({
        candidate: payload.candidates[pick.c],
        rank: i + 1,
        gain: pick.gain_i,
        gainPakket: pick.gain_p,
        synergie: pick.synergie,
      }));
    }
    if (scenario) {
      return scenario.picks.map((pick, i) => ({
        candidate: payload.candidates[pick.c],
        rank: i + 1,
        gain: pick.gain,
      }));
    }
    return [];
  }, [payload, mode, combi, scenario]);

  const cellRank =
    mode === 'combi' ? combi?.cell_rank_i ?? [] : scenario?.cell_rank ?? [];

  // ---- Coverage series for the chart ----
  const chartSeries = useMemo(() => {
    if (!payload) return [];
    if (mode === 'combi' && combi) {
      const inleveren = [combi.start_covered_i];
      const pakketten = [combi.start_covered_p];
      for (const pick of combi.picks) {
        inleveren.push(pick.cum_i);
        pakketten.push(pick.cum_p);
      }
      return [
        { label: 'Inleverpunt binnen ' + distance + ' m', colour: COLOUR_INLEVEREN, cumulative: inleveren },
        { label: 'Pakketpunt binnen ' + distance + ' m', colour: COLOUR_PAKKETTEN, cumulative: pakketten },
      ];
    }
    if (scenario) {
      const cumulative = [scenario.start_covered];
      for (const pick of scenario.picks) cumulative.push(pick.cum);
      return [
        { label: 'Inwoners bereikt', colour: COLOUR_INLEVEREN, cumulative },
      ];
    }
    return [];
  }, [payload, mode, combi, scenario, distance]);

  // ---- Capacity, from stated assumptions ----
  const capacity = useMemo(() => {
    if (!payload) return null;
    const gains =
      mode === 'combi'
        ? (combi?.picks ?? []).slice(0, n).map((p) => p.gain_i)
        : (scenario?.picks ?? []).slice(0, n).map((p) => p.gain);
    let litres = 0;
    let containers = 0;
    let emptyings = 0;
    for (const gain of gains) {
      const l = litresPerYear(gain, payload.capacity_defaults, stream, participation / 100);
      const c = containersNeeded(l, payload.capacity_defaults);
      litres += l;
      containers += c;
      emptyings += emptyingsPerWeek(l, c, payload.capacity_defaults);
    }
    return { litres, containers, emptyings };
  }, [payload, mode, combi, scenario, n, stream, participation]);

  const total = payload?.population_total ?? 0;
  const coveredNow =
    mode === 'combi'
      ? combi
        ? (n === 0 ? combi.start_covered_i : combi.picks[n - 1].cum_i)
        : 0
      : scenario
        ? (n === 0 ? scenario.start_covered : scenario.picks[n - 1].cum)
        : 0;
  const coveredPakket =
    mode === 'combi' && combi
      ? n === 0
        ? combi.start_covered_p
        : combi.picks[n - 1].cum_p
      : null;

  function exportPicks() {
    if (!payload) return;
    const header =
      mode === 'combi'
        ? ['rang', 'type', 'naam', 'lat', 'lon', 'winst_inleveren', 'winst_pakketten', 'synergie', 'kenmerken']
        : ['rang', 'type', 'naam', 'lat', 'lon', 'winst_inwoners', 'cumulatief', 'kenmerken'];
    const rows: (string | number)[][] = [header];
    picks.slice(0, n || picks.length).forEach((pick, i) => {
      const meta = payload.type_meta[pick.candidate.type];
      const base = [
        pick.rank,
        meta?.label ?? pick.candidate.type,
        pick.candidate.naam,
        pick.candidate.lat,
        pick.candidate.lon,
      ];
      if (mode === 'combi') {
        rows.push([
          ...base,
          pick.gain,
          pick.gainPakket ?? 0,
          pick.synergie ?? 0,
          pick.candidate.flags.map((f) => FLAG_LABELS[f] ?? f).join(' | '),
        ]);
      } else {
        rows.push([
          ...base,
          pick.gain,
          scenario?.picks[i]?.cum ?? 0,
          pick.candidate.flags.map((f) => FLAG_LABELS[f] ?? f).join(' | '),
        ]);
      }
    });
    downloadCsv(`netwerkplanner-${slug}-${mode}-${distance}m.csv`, rows);
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-bold text-[var(--green-900)]">Netwerkplanner</h2>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          Waar zou je inleverpunten neerzetten om zoveel mogelijk inwoners binnen
          loopafstand te brengen? De planner kiest telkens de locatie die de meeste
          nog-onbereikte inwoners toevoegt. Schuif het aantal punten omhoog en kijk de
          witte vlekken dicht lopen. In de combi-modus telt hij tegelijk mee wat een
          locatie voor het pakketpuntennetwerk oplevert.
        </p>
      </div>

      {/* Municipality + mode */}
      <div className="flex flex-wrap items-end gap-4 rounded-lg border border-border bg-card p-4">
        <div>
          <label
            htmlFor="np-gemeente"
            className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-muted-foreground"
          >
            Gemeente
          </label>
          <select
            id="np-gemeente"
            value={slug}
            onChange={(e) => setChosenSlug(e.target.value)}
            className="min-h-10 rounded-md border border-border bg-card px-2 text-sm"
          >
            {municipalities.map((m) => (
              <option key={m.slug} value={m.slug}>
                {m.gemeente}
              </option>
            ))}
          </select>
        </div>
        <SegControl
          label="Modus"
          value={mode}
          onChange={setMode}
          options={[
            { value: 'inleveren', label: 'Alleen inleverpunten' },
            {
              value: 'combi',
              label: 'Inleverpunt + pakketpunt',
              title: 'Combineert deze dataset met een momentopname van de pakketpuntenviewer.',
            },
          ]}
        />
        {municipalities.length < 20 && (
          <p className="text-xs text-muted-foreground">
            {municipalities.length} gemeenten gepland (pilotset). Draai{' '}
            <code className="font-mono">plan_inleverpunt_network.py --only all</code>{' '}
            voor heel Nederland.
          </p>
        )}
      </div>

      {loading && (
        <div className="rounded-lg border border-border bg-card p-8 text-center text-sm text-muted-foreground">
          Netwerk laden…
        </div>
      )}
      {error && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          {error}
        </div>
      )}

      {payload && active && (
        <>
          {mode === 'combi' && payload.pakketpunten_snapshot && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
              De pakketpuntendata is een <strong>momentopname</strong> uit de
              convenant-pakketpuntenviewer van{' '}
              {payload.pakketpunten_snapshot.snapshot_date ?? 'onbekende datum'} (
              {nlInt(payload.pakketpunten_snapshot.total_points ?? 0)} punten landelijk,{' '}
              {nlInt(payload.existing_pakketpunten)} in deze gemeente). Geen live
              koppeling: bij een verversing moet het bestand opnieuw worden gekopieerd.
            </div>
          )}

          {/* Scenario controls */}
          <div className="flex flex-wrap items-center gap-x-6 gap-y-3 rounded-lg border border-border bg-card p-4">
            <SegControl
              label="Loopafstand"
              value={String(distance)}
              onChange={(v) => setDistance(Number(v))}
              options={payload.params.distances.map((d) => ({
                value: String(d),
                label: `${d} m`,
              }))}
            />
            {mode === 'inleveren' ? (
              <SegControl
                label="Startsituatie"
                value={start}
                onChange={setStart}
                options={payload.params.starts.map((s) => ({
                  value: s,
                  label: START_LABELS[s] ?? s,
                }))}
              />
            ) : (
              <SegControl
                label="Selectieregel"
                value={combiRule}
                onChange={setCombiRule}
                options={(['synergie', 'gewogen'] as CombiRule[]).map((r) => ({
                  value: r,
                  label: COMBI_RULE_LABELS[r],
                  title: COMBI_RULE_HINTS[r],
                }))}
              />
            )}
          </div>
          {mode === 'combi' && (
            <p className="-mt-2 text-xs text-muted-foreground">
              {COMBI_RULE_HINTS[combiRule]}
              {combiRule === 'gewogen' && combi?.alpha != null && (
                <> α = {nlNum(combi.alpha, 2)} (ingesteld bij het genereren).</>
              )}
            </p>
          )}

          {/* Slider */}
          <div className="space-y-3 rounded-lg border border-border bg-card p-4">
            <div className="flex flex-wrap items-center gap-3">
              <label htmlFor="np-count" className="text-sm font-medium">
                Aantal nieuwe punten
              </label>
              <input
                id="np-count"
                type="range"
                min={0}
                max={maxPicks}
                value={n}
                onChange={(e) => setN(Number(e.target.value))}
                className="min-w-40 flex-1 accent-[var(--green-600)]"
              />
              <span className="w-12 text-right text-lg font-bold tabular-nums text-[var(--green-900)]">
                {n}
              </span>
              <span className="text-xs text-muted-foreground">van {maxPicks}</span>
            </div>

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <StatTile
                label="Inwoners in gemeente"
                value={nlInt(total)}
                hint="CBS 100 m-raster"
              />
              <StatTile
                label={`Bereikt binnen ${distance} m`}
                value={`${nlPct(total ? (coveredNow / total) * 100 : 0)}%`}
                hint={`${nlInt(coveredNow)} inwoners`}
              />
              {coveredPakket != null ? (
                <StatTile
                  label="Pakketpunt binnen bereik"
                  value={`${nlPct(total ? (coveredPakket / total) * 100 : 0)}%`}
                  hint={`${nlInt(coveredPakket)} inwoners`}
                  tone={COLOUR_PAKKETTEN}
                />
              ) : (
                <StatTile
                  label="Bestaande punten"
                  value={nlInt(payload.existing.alles ?? 0)}
                  hint={`${nlInt(payload.existing.automaat ?? 0)} automaten`}
                />
              )}
              <StatTile
                label="Kandidaat-locaties"
                value={nlInt(payload.candidates.length)}
                hint={`${payload.params.kandidaat_types.length} types`}
              />
            </div>

            <NetworkCoverageChart
              series={chartSeries}
              total={total}
              n={n}
              maxPicks={maxPicks}
            />
          </div>

          {/* Map + list */}
          <div className="grid gap-4 xl:grid-cols-[1fr_22rem]">
            <div className="relative h-[30rem] overflow-hidden rounded-lg border border-border xl:h-[40rem]">
              <NetworkPlannerMap
                payload={payload}
                cellRank={cellRank}
                n={n}
                picks={picks}
                showCells={showCells}
                showCandidates={showCandidates}
                showExisting={showExisting}
                existing={existing}
                pakketpunten={(payload.pakketpunten?.lat ?? []).map(
                  (lat: number, i: number) => ({
                    lat,
                    lon: payload.pakketpunten.lon[i],
                  })
                )}
                showPakketpunten={mode === 'combi' && showPakketpunten}
              />
            </div>

            <div className="space-y-3">
              <div className="space-y-1.5 rounded-lg border border-border bg-card p-3 text-sm">
                <label className="flex cursor-pointer items-center gap-2">
                  <input type="checkbox" checked={showCells} onChange={(e) => setShowCells(e.target.checked)} className="size-3.5 accent-[var(--green-600)]" />
                  Bewoonde cellen
                </label>
                <label className="flex cursor-pointer items-center gap-2">
                  <input type="checkbox" checked={showCandidates} onChange={(e) => setShowCandidates(e.target.checked)} className="size-3.5 accent-[var(--green-600)]" />
                  Niet-gekozen kandidaten
                </label>
                <label className="flex cursor-pointer items-center gap-2">
                  <input type="checkbox" checked={showExisting} onChange={(e) => setShowExisting(e.target.checked)} className="size-3.5 accent-[var(--green-600)]" />
                  Bestaande inleverpunten ({nlInt(existing.length)})
                </label>
                {mode === 'combi' && (
                  <label className="flex cursor-pointer items-center gap-2">
                    <input type="checkbox" checked={showPakketpunten} onChange={(e) => setShowPakketpunten(e.target.checked)} className="size-3.5 accent-[var(--green-600)]" />
                    Bestaande pakketpunten ({nlInt(payload.existing_pakketpunten)})
                  </label>
                )}
                <div className="flex flex-wrap gap-x-3 gap-y-1 border-t border-border pt-2 text-xs text-muted-foreground">
                  <span className="flex items-center gap-1"><span className="inline-block size-2.5 rounded-full bg-[#8fb75c]" />al bereikt</span>
                  <span className="flex items-center gap-1"><span className="inline-block size-2.5 rounded-full bg-[#2a78d6]" />nieuw bereikt</span>
                  <span className="flex items-center gap-1"><span className="inline-block size-2.5 rounded-full bg-[#b9bdb4]" />witte vlek</span>
                </div>
              </div>

              <div className="overflow-hidden rounded-lg border border-border bg-card">
                <div className="border-b border-border px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="text-sm font-semibold text-[var(--green-900)]">
                      {mode === 'combi' ? 'Dubbelfunctie-locaties' : 'Gekozen locaties'}
                    </h3>
                    <CsvButton onClick={exportPicks} label="CSV" />
                  </div>
                  {/*
                    Placement order, not synergy order. Pick k's gains depend on
                    picks 1..k-1, so re-sorting the list would leave the numbers
                    describing a sequence that is no longer shown.
                  */}
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {mode === 'combi'
                      ? 'Op volgorde van plaatsing; het getal rechts is de synergie-index (1 = dient beide netwerken evenveel).'
                      : 'Op volgorde van plaatsing: elke stap voegt de meeste nog-onbereikte inwoners toe.'}
                  </p>
                </div>
                <ol className="max-h-[26rem] divide-y divide-border overflow-y-auto text-sm">
                  {picks.slice(0, Math.max(n, 10)).map((pick) => {
                    const meta = payload.type_meta[pick.candidate.type];
                    const placed = pick.rank <= n;
                    return (
                      <li
                        key={pick.rank}
                        className={`flex gap-2 px-3 py-2 ${placed ? '' : 'opacity-45'}`}
                      >
                        <span
                          className="mt-1 inline-block size-2.5 shrink-0 rounded-full"
                          style={{ background: meta?.kleur ?? '#475569' }}
                        />
                        <div className="min-w-0 flex-1">
                          <div className="truncate font-medium">
                            {pick.rank}. {pick.candidate.naam || meta?.label}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {meta?.label}
                            {mode === 'combi' ? (
                              <>
                                {' '}· inleveren +{nlInt(pick.gain)} · pakketten +
                                {nlInt(pick.gainPakket ?? 0)}
                              </>
                            ) : (
                              <> · +{nlInt(pick.gain)} inwoners</>
                            )}
                          </div>
                        </div>
                        {mode === 'combi' && (
                          <span
                            className="shrink-0 self-center rounded px-1.5 py-0.5 text-xs font-semibold tabular-nums"
                            style={{
                              background: 'var(--green-50)',
                              color: 'var(--green-800)',
                            }}
                            title="Synergie-index: 1 = dient beide netwerken evenveel"
                          >
                            {(pick.synergie ?? 0).toFixed(2)}
                          </span>
                        )}
                      </li>
                    );
                  })}
                  {picks.length === 0 && (
                    <li className="px-3 py-6 text-center text-muted-foreground">
                      Geen locaties gevonden die genoeg toevoegen.
                    </li>
                  )}
                </ol>
              </div>
            </div>
          </div>

          {/* Capacity */}
          <section className="space-y-3 rounded-lg border border-border bg-card p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="text-lg font-semibold text-[var(--green-900)]">
                Capaciteit — indicatief
              </h3>
              <span className="rounded border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-800">
                aanname
              </span>
            </div>
            <p className="text-sm text-muted-foreground">
              {payload.capacity_defaults.toelichting}
            </p>
            <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
              <SegControl
                label="Stroom"
                value={stream}
                onChange={setStream}
                options={Object.keys(
                  payload.capacity_defaults.retourvolume_liter_pp_jaar
                ).map((s) => ({ value: s, label: s }))}
              />
              <div className="flex items-center gap-2">
                <label htmlFor="np-part" className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Deelname
                </label>
                <input
                  id="np-part"
                  type="range"
                  min={10}
                  max={100}
                  step={5}
                  value={participation}
                  onChange={(e) => setParticipation(Number(e.target.value))}
                  className="w-36 accent-[var(--green-600)]"
                />
                <span className="w-10 text-sm font-medium tabular-nums">
                  {participation}%
                </span>
              </div>
            </div>
            {capacity && (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <StatTile
                  label="Retourvolume per jaar"
                  value={`${nlInt(capacity.litres)} l`}
                  hint={`over ${n} nieuwe punten`}
                />
                <StatTile label="Containers nodig" value={nlInt(capacity.containers)} hint={`${payload.capacity_defaults.container_liter} l per stuk`} />
                <StatTile label="Legingen per week" value={nlNum(capacity.emptyings, 1)} hint={`max ${payload.capacity_defaults.legingen_per_week_max} per container`} />
                <StatTile
                  label="Liter per inwoner/jaar"
                  value={nlNum(
                    payload.capacity_defaults.retourvolume_liter_pp_jaar[stream]?.waarde ?? 0,
                    1
                  )}
                  hint="aanname — bron nog vast te stellen"
                />
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              Nog te raadplegen bronnen:{' '}
              {payload.capacity_defaults.bronnen_te_raadplegen.join(' · ')}.
            </p>
          </section>

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
              Kandidaat-types in deze run:{' '}
              {payload.params.kandidaat_types
                .map((t) => payload.type_meta[t]?.label ?? t)
                .join(', ')}
              . Bus- en tramhaltes staan standaard uit: ze vormen veruit het dichtste
              kandidatenraster, waardoor een greedy die alleen op bereik optimaliseert
              vrijwel niets anders meer kiest — terwijl er geen statiegeldautomaat of
              balie op past.
            </p>
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
