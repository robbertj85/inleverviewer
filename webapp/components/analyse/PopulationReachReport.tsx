'use client';

import { useMemo, useState } from 'react';

import {
  COHORT_LABELS,
  Cohort,
  CsvButton,
  MethodologyNote,
  Pager,
  PctBar,
  SegControl,
  SortHeader,
  StatTile,
  compareValues,
  downloadCsv,
  inCohort,
  usePaged,
  useSort,
} from '@/components/analyse/AnalyseUI';
import {
  DISTANCES,
  Distance,
  MunicipalityCoverage,
  PopulationCoveragePayload,
  SCOPE_HINTS,
  SCOPE_LABELS,
  SUBSET_AXES,
  SUBSET_LABELS,
  SUBSET_SHORT,
  Scope,
  Subset,
  coverageTone,
  nlInt,
  nlPct,
} from '@/types/analyse';

const PC4_PAGE_SIZE = 50;

type MuniRow = MunicipalityCoverage & { slug: string };

type MuniSortKey =
  | 'name'
  | 'population'
  | 'points'
  | 'pct'
  | 'covered'
  | 'delta';

type Pc4SortKey = 'pc4' | 'municipality' | 'population' | 'pct' | 'covered';

export default function PopulationReachReport({
  payload,
}: {
  payload: PopulationCoveragePayload;
}) {
  const [subset, setSubset] = useState<Subset>('alles');
  const [distance, setDistance] = useState<Distance>('400m');
  const [scope, setScope] = useState<Scope>('national');
  const [cohort, setCohort] = useState<Cohort>('alle');
  const [query, setQuery] = useState('');

  const muniSort = useSort<MuniSortKey>('pct');
  const pc4Sort = useSort<Pc4SortKey>('population');

  const national = payload.national[subset]?.[distance];

  const municipalities = useMemo<MuniRow[]>(
    () =>
      Object.entries(payload.municipalities).map(([slug, entry]) => ({
        ...entry,
        slug,
      })),
    [payload.municipalities]
  );

  const muniRows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const rows = municipalities
      .filter((m) => inCohort(m.name, cohort))
      .filter((m) => !needle || m.name.toLowerCase().includes(needle))
      .map((m) => {
        const active = m[scope][subset]?.[distance];
        const other = m[scope === 'national' ? 'strict' : 'national'][subset]?.[distance];
        return {
          row: m,
          name: m.name,
          population: m.population,
          points: m.points[subset] ?? 0,
          pct: active?.pct ?? 0,
          covered: active?.covered ?? 0,
          // The gap between the two scopes is the reach a municipality gets
          // from its neighbours — negative means it exports reach.
          delta: (m.national[subset]?.[distance]?.pct ?? 0) - (m.strict[subset]?.[distance]?.pct ?? 0),
          otherPct: other?.pct ?? 0,
        };
      });
    const factor = muniSort.dir === 'asc' ? 1 : -1;
    return rows.sort(
      (a, b) => factor * compareValues(a[muniSort.key], b[muniSort.key])
    );
  }, [municipalities, cohort, query, scope, subset, distance, muniSort.key, muniSort.dir]);

  const pc4Rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const rows = Object.entries(payload.pc4)
      .map(([pc4, entry]) => {
        const block = entry[subset] as
          | Record<Distance, { pct: number; covered: number }>
          | undefined;
        return {
          pc4,
          municipality: entry.municipality ?? '—',
          population: entry.population,
          pct: block?.[distance]?.pct ?? 0,
          covered: block?.[distance]?.covered ?? 0,
        };
      })
      .filter((r) => r.population > 0)
      .filter((r) => inCohort(r.municipality, cohort))
      .filter(
        (r) =>
          !needle ||
          r.pc4.includes(needle) ||
          r.municipality.toLowerCase().includes(needle)
      );
    const factor = pc4Sort.dir === 'asc' ? 1 : -1;
    return rows.sort((a, b) => factor * compareValues(a[pc4Sort.key], b[pc4Sort.key]));
  }, [payload.pc4, subset, distance, cohort, query, pc4Sort.key, pc4Sort.dir]);

  const paged = usePaged(pc4Rows, PC4_PAGE_SIZE);

  // The two extremes of the current selection, which is what people actually
  // scan a 342-row table for.
  const best = muniRows.length
    ? muniRows.reduce((a, b) => (b.pct > a.pct ? b : a))
    : null;
  const worst = muniRows.length
    ? muniRows.reduce((a, b) => (b.pct < a.pct ? b : a))
    : null;

  function exportMunicipalities() {
    const header = ['gemeente', 'inwoners', `punten_${subset}`];
    for (const s of payload.subsets) {
      for (const d of DISTANCES) {
        header.push(`${s}_${d}_pct_landelijk`, `${s}_${d}_pct_strikt`);
      }
    }
    const rows: (string | number)[][] = [header];
    for (const m of municipalities) {
      const row: (string | number)[] = [m.name, m.population, m.points[subset] ?? 0];
      for (const s of payload.subsets) {
        for (const d of DISTANCES) {
          row.push(m.national[s]?.[d]?.pct ?? 0, m.strict[s]?.[d]?.pct ?? 0);
        }
      }
      rows.push(row);
    }
    downloadCsv('inleverpunten-bereik-gemeenten.csv', rows);
  }

  function exportPc4() {
    const header = ['pc4', 'gemeente', 'inwoners', 'oppervlakte_km2'];
    for (const s of payload.subsets) {
      for (const d of DISTANCES) header.push(`${s}_${d}_pct`);
    }
    const rows: (string | number)[][] = [header];
    for (const [pc4, entry] of Object.entries(payload.pc4)) {
      const row: (string | number)[] = [
        pc4,
        entry.municipality ?? '',
        entry.population,
        entry.area_km2,
      ];
      for (const s of payload.subsets) {
        const block = entry[s] as Record<Distance, { pct: number }> | undefined;
        for (const d of DISTANCES) row.push(block?.[d]?.pct ?? 0);
      }
      rows.push(row);
    }
    downloadCsv('inleverpunten-bereik-pc4.csv', rows);
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-bold text-[var(--green-900)]">Bereik van inwoners</h2>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          Hoeveel inwoners wonen binnen loopafstand van een inleverpunt? Teller én
          noemer komen uit het CBS-vierkantstatistiekraster van 100 m, dus lege
          ruimte — water, park, bedrijventerrein, landbouw — telt niet mee als
          onbereikte bevolking.
        </p>
      </div>

      {/* Controls */}
      <div className="space-y-3 rounded-lg border border-border bg-card p-4">
        {SUBSET_AXES.map((axis) => (
          <SegControl
            key={axis.key}
            label={axis.label}
            value={subset}
            onChange={setSubset}
            options={axis.subsets.map((s) => ({
              value: s,
              label: SUBSET_SHORT[s],
              title: SUBSET_LABELS[s],
            }))}
          />
        ))}
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <SegControl
            label="Loopafstand"
            value={distance}
            onChange={setDistance}
            options={DISTANCES.map((d) => ({ value: d, label: d }))}
          />
          <SegControl
            label="Scope"
            value={scope}
            onChange={setScope}
            options={[
              { value: 'national', label: 'Landelijk', title: SCOPE_HINTS.national },
              { value: 'strict', label: 'Strikt', title: SCOPE_HINTS.strict },
            ]}
          />
          <SegControl
            label="Selectie"
            value={cohort}
            onChange={setCohort}
            options={(Object.keys(COHORT_LABELS) as Cohort[]).map((c) => ({
              value: c,
              label: COHORT_LABELS[c],
            }))}
          />
        </div>
        <p className="text-xs text-muted-foreground">{SCOPE_HINTS[scope]}</p>
      </div>

      {/* National summary */}
      <section className="space-y-3 rounded-lg border border-border bg-card p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-lg font-semibold text-[var(--green-900)]">
            Landelijk — {SUBSET_LABELS[subset]}
          </h3>
          <span className="text-xs text-muted-foreground">
            {nlInt(payload.national.population)} inwoners in het raster
          </span>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {DISTANCES.map((d) => {
            const metric = payload.national[subset]?.[d];
            return (
              <StatTile
                key={d}
                label={`Binnen ${d}`}
                value={`${nlPct(metric?.pct ?? 0)}%`}
                hint={`${nlInt(metric?.covered ?? 0)} inwoners`}
                tone={coverageTone(metric?.pct ?? 0)}
              />
            );
          })}
          {best && (
            <StatTile
              label={`Hoogste (${distance})`}
              value={`${nlPct(best.pct)}%`}
              hint={best.name}
            />
          )}
          {worst && (
            <StatTile
              label={`Laagste (${distance})`}
              value={`${nlPct(worst.pct)}%`}
              hint={worst.name}
            />
          )}
          <StatTile
            label="Gemeenten in selectie"
            value={nlInt(muniRows.length)}
            hint={COHORT_LABELS[cohort]}
          />
        </div>
        {national && subset === 'milieustraat' && (
          <p className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
            Milieustraten zijn alleen toegankelijk voor inwoners van de gemeenten in
            hun <code>gemeenteBeperking</code>. Ze tellen daarom niet mee over de
            gemeentegrens heen, ook niet in de landelijke scope — vandaar het lage
            percentage.
          </p>
        )}
      </section>

      {/* Search */}
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Zoek gemeente of PC4…"
          className="min-h-10 w-full rounded-md border border-border bg-card px-3 text-sm sm:w-72"
        />
        <div className="flex gap-2">
          <CsvButton onClick={exportMunicipalities} label="Gemeenten (CSV)" />
          <CsvButton onClick={exportPc4} label="PC4 (CSV)" />
        </div>
      </div>

      {/* Municipality table */}
      <section className="overflow-hidden rounded-lg border border-border bg-card">
        <div className="border-b border-border px-4 py-3">
          <h3 className="text-lg font-semibold text-[var(--green-900)]">Per gemeente</h3>
          <p className="text-xs text-muted-foreground">
            {SUBSET_LABELS[subset]} · {distance} · {SCOPE_LABELS[scope]}
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[42rem] text-sm">
            <thead className="border-b border-border bg-muted/50 text-xs">
              <tr>
                <SortHeader label="Gemeente" sortKey="name" activeKey={muniSort.key} dir={muniSort.dir} onToggle={muniSort.toggle} />
                <SortHeader label="Inwoners" sortKey="population" activeKey={muniSort.key} dir={muniSort.dir} onToggle={muniSort.toggle} align="right" />
                <SortHeader label="Punten" sortKey="points" activeKey={muniSort.key} dir={muniSort.dir} onToggle={muniSort.toggle} align="right" />
                <SortHeader label="Bereik" sortKey="pct" activeKey={muniSort.key} dir={muniSort.dir} onToggle={muniSort.toggle} />
                <SortHeader label="Inwoners bereikt" sortKey="covered" activeKey={muniSort.key} dir={muniSort.dir} onToggle={muniSort.toggle} align="right" />
                <SortHeader
                  label="Δ buren"
                  sortKey="delta"
                  activeKey={muniSort.key}
                  dir={muniSort.dir}
                  onToggle={muniSort.toggle}
                  align="right"
                  title="Landelijke scope minus strikte scope: het bereik dat deze gemeente van punten net over de grens krijgt."
                />
              </tr>
            </thead>
            <tbody>
              {muniRows.map((r) => (
                <tr key={r.row.slug} className="border-b border-border/60 last:border-0">
                  <td className="px-2 py-1.5 font-medium">{r.name}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{nlInt(r.population)}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{nlInt(r.points)}</td>
                  <td className="px-2 py-1.5">
                    <PctBar pct={r.pct} tone={coverageTone(r.pct)} />
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{nlInt(r.covered)}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">
                    {r.delta > 0.05 ? '+' : ''}
                    {nlPct(r.delta)}
                  </td>
                </tr>
              ))}
              {muniRows.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-2 py-6 text-center text-muted-foreground">
                    Geen gemeenten in deze selectie.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* PC4 table */}
      <section className="overflow-hidden rounded-lg border border-border bg-card">
        <div className="border-b border-border px-4 py-3">
          <h3 className="text-lg font-semibold text-[var(--green-900)]">Per PC4</h3>
          <p className="text-xs text-muted-foreground">
            Altijd landelijke scope — een PC4 kent geen bestuurlijke grens aan zijn
            bewoners.
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[36rem] text-sm">
            <thead className="border-b border-border bg-muted/50 text-xs">
              <tr>
                <SortHeader label="PC4" sortKey="pc4" activeKey={pc4Sort.key} dir={pc4Sort.dir} onToggle={pc4Sort.toggle} />
                <SortHeader label="Gemeente" sortKey="municipality" activeKey={pc4Sort.key} dir={pc4Sort.dir} onToggle={pc4Sort.toggle} />
                <SortHeader label="Inwoners" sortKey="population" activeKey={pc4Sort.key} dir={pc4Sort.dir} onToggle={pc4Sort.toggle} align="right" />
                <SortHeader label="Bereik" sortKey="pct" activeKey={pc4Sort.key} dir={pc4Sort.dir} onToggle={pc4Sort.toggle} />
                <SortHeader label="Bereikt" sortKey="covered" activeKey={pc4Sort.key} dir={pc4Sort.dir} onToggle={pc4Sort.toggle} align="right" />
              </tr>
            </thead>
            <tbody>
              {paged.slice.map((r) => (
                <tr key={r.pc4} className="border-b border-border/60 last:border-0">
                  <td className="px-2 py-1.5 font-mono">{r.pc4}</td>
                  <td className="px-2 py-1.5">{r.municipality}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{nlInt(r.population)}</td>
                  <td className="px-2 py-1.5">
                    <PctBar pct={r.pct} tone={coverageTone(r.pct)} />
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{nlInt(r.covered)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <Pager
          page={paged.page}
          pageCount={paged.pageCount}
          onChange={paged.setPage}
          total={pc4Rows.length}
        />
      </section>

      <MethodologyNote>
        {Object.entries(payload.methodology).map(([key, value]) => (
          <p key={key}>
            <span className="font-medium text-foreground">{key.replace(/_/g, ' ')}:</span>{' '}
            {String(value)}
          </p>
        ))}
        <p className="pt-1">
          Bronnen:{' '}
          {Object.entries(payload.sources)
            .map(([k, v]) => `${k.replace(/_/g, ' ')} — ${v}`)
            .join(' · ')}
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
    </div>
  );
}
