'use client';

import { useMemo, useState } from 'react';

import {
  CsvButton,
  MethodologyNote,
  Pager,
  SegControl,
  SortHeader,
  StatTile,
  compareValues,
  downloadCsv,
  usePaged,
  useSort,
} from '@/components/analyse/AnalyseUI';
import { fitOls, varianceInflationFactors } from '@/lib/ols';
import {
  FEATURE_BY_KEY,
  FEATURE_DEFS,
  FEATURE_GROUP_LABELS,
  FEATURE_PRESETS,
  type FeatureDef,
} from '@/lib/regressionFeatures';
import {
  FEATURE_SETS,
  FeatureSet,
  MODEL_TARGETS,
  ModelTarget,
  ModelsByTarget,
  Pc4StatsPayload,
  nlInt,
  nlNum,
} from '@/types/analyse';

// ---------------------------------------------------------------------------

export interface ScatterPoint {
  pc4: string;
  municipality: string | null;
  population: number;
  area_km2: number;
  actual: Record<ModelTarget, number>;
  predicted: Record<ModelTarget, Record<FeatureSet, number | null>>;
  features: Record<string, number | null>;
}

export interface RegressionPayload {
  generated_from: Record<string, unknown>;
  models: ModelsByTarget;
  model_meta: Pc4StatsPayload['model_meta'];
  scatter: ScatterPoint[];
}

const FEATURE_SET_SHORT: Record<FeatureSet, string> = {
  base: 'Basis',
  extended: 'Uitgebreid',
  ruim: 'Ruim',
};

type SortKey = 'pc4' | 'municipality' | 'population' | 'actual' | 'predicted' | 'delta';

const PAGE_SIZE = 40;

/** Density bands for the scatter. Sequential — dark is dense, not "bad". */
function densityTone(oad: number | null): string {
  if (oad == null) return 'var(--muted-foreground)';
  if (oad >= 2500) return 'var(--green-900)';
  if (oad >= 1500) return 'var(--green-700)';
  if (oad >= 1000) return 'var(--green-500)';
  if (oad >= 500) return 'var(--green-400)';
  return 'var(--green-300)';
}

const DENSITY_LEGEND: { label: string; tone: string }[] = [
  { label: '< 500', tone: 'var(--green-300)' },
  { label: '500–1.000', tone: 'var(--green-400)' },
  { label: '1.000–1.500', tone: 'var(--green-500)' },
  { label: '1.500–2.500', tone: 'var(--green-700)' },
  { label: '≥ 2.500', tone: 'var(--green-900)' },
];

export default function RegressionReport({ payload }: { payload: RegressionPayload }) {
  const [target, setTarget] = useState<ModelTarget>('alles');
  const [featureSet, setFeatureSet] = useState<FeatureSet>('ruim');
  const [selected, setSelected] = useState<string[]>(FEATURE_PRESETS[0].keys);
  const [query, setQuery] = useState('');
  const [focused, setFocused] = useState<ScatterPoint | null>(null);
  const sort = useSort<SortKey>('delta', 'asc');

  const modelsForTarget = payload.models[target] ?? {};
  const model = modelsForTarget[featureSet] ?? null;
  const recommended = modelsForTarget.recommended;

  // ---- Rows with a prediction for the current (target, feature set) ----
  const rows = useMemo(
    () =>
      payload.scatter
        .map((point) => {
          const predicted = point.predicted[target]?.[featureSet];
          return {
            point,
            pc4: point.pc4,
            municipality: point.municipality ?? '—',
            population: point.population,
            actual: point.actual[target] ?? 0,
            predicted,
            delta: predicted == null ? null : (point.actual[target] ?? 0) - predicted,
            oad: point.features.oad ?? null,
          };
        })
        .filter((r) => r.predicted != null),
    [payload.scatter, target, featureSet]
  );

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const list = needle
      ? rows.filter(
          (r) =>
            r.pc4.includes(needle) || r.municipality.toLowerCase().includes(needle)
        )
      : rows;
    const factor = sort.dir === 'asc' ? 1 : -1;
    return [...list].sort((a, b) => factor * compareValues(a[sort.key], b[sort.key]));
  }, [rows, query, sort.key, sort.dir]);

  const paged = usePaged(filtered, PAGE_SIZE);

  // ---- Client-side regression on the user's own variable selection ----
  const customFit = useMemo(() => {
    if (selected.length === 0) return null;
    const design: number[][] = [];
    const y: number[] = [];
    for (const point of payload.scatter) {
      const values = selected.map((key) => point.features[key]);
      if (values.some((v) => v == null)) continue;
      design.push(values as number[]);
      y.push(point.actual[target] ?? 0);
    }
    if (design.length < 50) return null;
    const fit = fitOls(design, y);
    if (!fit) return null;
    return { fit, vifs: varianceInflationFactors(design) };
  }, [selected, payload.scatter, target]);

  // ---- Scatter geometry ----
  const scatterGeom = useMemo(() => {
    const points = rows.filter((r) => r.predicted != null);
    if (points.length === 0) return null;
    const maxActual = Math.max(...points.map((r) => r.actual));
    const maxPredicted = Math.max(...points.map((r) => r.predicted as number));
    // A shared axis maximum keeps the diagonal at 45°, which is the whole
    // point of an actual-vs-predicted plot.
    const max = Math.max(maxActual, maxPredicted, 1);
    return { points, max };
  }, [rows]);

  function exportCsv() {
    const header = [
      'pc4', 'gemeente', 'inwoners', 'oppervlakte_km2',
      `werkelijk_${target}`, `voorspeld_${target}_${featureSet}`, 'verschil',
      ...FEATURE_DEFS.map((f) => f.key),
    ];
    const csvRows: (string | number | null)[][] = [header];
    for (const r of filtered) {
      csvRows.push([
        r.pc4, r.municipality, r.population, r.point.area_km2,
        r.actual, r.predicted ?? null, r.delta ?? null,
        ...FEATURE_DEFS.map((f) => r.point.features[f.key] ?? null),
      ]);
    }
    downloadCsv(`inleverpunten-schatting-${target}-${featureSet}.csv`, csvRows);
  }

  const underserved = [...rows]
    .filter((r) => r.delta != null)
    .sort((a, b) => (a.delta as number) - (b.delta as number))
    .slice(0, 5);
  const overserved = [...rows]
    .filter((r) => r.delta != null)
    .sort((a, b) => (b.delta as number) - (a.delta as number))
    .slice(0, 5);

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-bold text-[var(--green-900)]">
          Schatting inleverpunten per PC4
        </h2>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          Hoeveel inleverpunten zou je in een postcodegebied verwachten op grond van
          inwonertal, oppervlakte en CBS-kenmerken — en waar wijkt de werkelijkheid
          daarvan af? De drie materiaalstromen zijn apart gemodelleerd: een
          statiegeldautomaat volgt de detailhandel, een milieustraat volgt gemeentelijk
          beleid, en één model over beide voorspelt geen van beide goed.
        </p>
      </div>

      {/* Model choice */}
      <div className="space-y-3 rounded-lg border border-border bg-card p-4">
        <SegControl
          label="Stroom"
          value={target}
          onChange={setTarget}
          options={MODEL_TARGETS.map((t) => ({
            value: t,
            label: payload.model_meta.targets[t],
          }))}
        />
        <SegControl
          label="Variabelen"
          value={featureSet}
          onChange={setFeatureSet}
          options={FEATURE_SETS.map((f) => ({
            value: f,
            label:
              FEATURE_SET_SHORT[f] + (recommended === f ? ' ★' : ''),
            title: payload.model_meta.feature_sets[f],
          }))}
        />
        {recommended && (
          <p className="text-xs text-muted-foreground">
            ★ = beste op cross-validatie voor deze stroom.
          </p>
        )}
      </div>

      {/* Model card */}
      {model ? (
        <section className="space-y-3 rounded-lg border border-border bg-card p-4">
          <h3 className="text-lg font-semibold text-[var(--green-900)]">
            {model.label}
          </h3>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatTile
              label="R² (cross-validatie)"
              value={nlNum(model.r2_cv_mean, 3)}
              hint={`± ${nlNum(model.r2_cv_std, 3)} over ${model.cv_folds} folds`}
            />
            <StatTile
              label="R² (trainingsset)"
              value={nlNum(model.r2, 3)}
              hint="stijgt altijd bij méér variabelen"
            />
            <StatTile label="Trainings-PC4's" value={nlInt(model.training_size)} hint={`${nlNum(model.coverage_pct, 1)}% dekking`} />
            <StatTile label="Constante" value={nlNum(model.intercept, 2)} />
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[30rem] text-sm">
              <thead className="border-b border-border text-xs text-muted-foreground">
                <tr>
                  <th className="px-2 py-1.5 text-left font-semibold">Variabele</th>
                  <th className="px-2 py-1.5 text-right font-semibold">Coëfficiënt</th>
                  <th className="px-2 py-1.5 text-right font-semibold" title="Variance inflation factor: boven 5 delen variabelen hun variantie.">
                    VIF
                  </th>
                </tr>
              </thead>
              <tbody>
                {model.features.map((key) => {
                  const def = FEATURE_BY_KEY.get(key);
                  const vif = model.vif[key];
                  return (
                    <tr key={key} className="border-b border-border/60 last:border-0">
                      <td className="px-2 py-1.5">
                        {def?.label ?? key}
                        {def?.unit && (
                          <span className="ml-1 text-xs text-muted-foreground">
                            ({def.unit})
                          </span>
                        )}
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums">
                        {model.coefficients[key] >= 0 ? '+' : ''}
                        {nlNum(model.coefficients[key], 6)}
                      </td>
                      <td
                        className="px-2 py-1.5 text-right tabular-nums"
                        style={{ color: vif > 10 ? 'var(--destructive)' : undefined }}
                      >
                        {Number.isFinite(vif) ? nlNum(vif, 2) : '∞'}
                        {vif > 5 && Number.isFinite(vif) ? ' ⚠' : ''}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-muted-foreground">
            {payload.model_meta.cv.note}
          </p>
        </section>
      ) : (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          Voor deze combinatie is geen model gefit — te weinig PC4&apos;s met alle
          variabelen ingevuld.
        </div>
      )}

      {/* Scatter */}
      {scatterGeom && (
        <section className="space-y-3 rounded-lg border border-border bg-card p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="text-lg font-semibold text-[var(--green-900)]">
              Werkelijk versus voorspeld
            </h3>
            <span className="text-xs text-muted-foreground">
              {nlInt(scatterGeom.points.length)}{' '}
              PC4&apos;s · kleur = adressendichtheid
            </span>
          </div>
          <div className="overflow-x-auto">
            <svg
              viewBox="0 0 420 340"
              role="img"
              aria-label="Spreidingsdiagram van werkelijk versus voorspeld aantal inleverpunten per PC4"
              className="h-auto w-full min-w-[20rem] max-w-2xl"
            >
              {/* Axes */}
              <line x1="46" y1="292" x2="404" y2="292" stroke="var(--border)" />
              <line x1="46" y1="16" x2="46" y2="292" stroke="var(--border)" />
              {/* y = x reference */}
              <line
                x1="46" y1="292" x2="404" y2="16"
                stroke="var(--green-600)" strokeDasharray="4 3" strokeWidth="1.2"
              />
              {[0, 0.25, 0.5, 0.75, 1].map((t) => (
                <g key={t}>
                  <text x="42" y={292 - t * 276 + 4} textAnchor="end" fontSize="9" fill="var(--muted-foreground)">
                    {nlNum(t * scatterGeom.max, 0)}
                  </text>
                  <text x={46 + t * 358} y="306" textAnchor="middle" fontSize="9" fill="var(--muted-foreground)">
                    {nlNum(t * scatterGeom.max, 0)}
                  </text>
                </g>
              ))}
              <text x="225" y="324" textAnchor="middle" fontSize="10" fill="var(--muted-foreground)">
                voorspeld aantal
              </text>
              <text x="12" y="154" textAnchor="middle" fontSize="10" fill="var(--muted-foreground)" transform="rotate(-90 12 154)">
                werkelijk aantal
              </text>
              {scatterGeom.points.map((r) => (
                <circle
                  key={r.pc4}
                  cx={46 + ((r.predicted as number) / scatterGeom.max) * 358}
                  cy={292 - (r.actual / scatterGeom.max) * 276}
                  r={focused?.pc4 === r.pc4 ? 4.5 : 2}
                  fill={densityTone(r.oad)}
                  fillOpacity={focused?.pc4 === r.pc4 ? 1 : 0.55}
                  stroke={focused?.pc4 === r.pc4 ? 'var(--foreground)' : 'none'}
                  strokeWidth="1"
                  onMouseEnter={() => setFocused(r.point)}
                  onFocus={() => setFocused(r.point)}
                  tabIndex={-1}
                >
                  <title>{`${r.pc4} ${r.municipality}: werkelijk ${r.actual}, voorspeld ${nlNum(r.predicted as number, 1)}`}</title>
                </circle>
              ))}
            </svg>
          </div>
          <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
            <span>Adressendichtheid per km²:</span>
            {DENSITY_LEGEND.map((band) => (
              <span key={band.label} className="flex items-center gap-1">
                <span
                  className="inline-block size-2.5 rounded-full"
                  style={{ background: band.tone }}
                />
                {band.label}
              </span>
            ))}
            <span className="flex items-center gap-1">
              <span className="inline-block h-px w-4 border-t border-dashed border-[var(--green-600)]" />
              perfecte voorspelling
            </span>
          </div>
          {focused && (
            <p className="text-xs text-muted-foreground">
              <span className="font-mono text-foreground">{focused.pc4}</span>{' '}
              {focused.municipality} · {nlInt(focused.population)} inwoners ·{' '}
              werkelijk {focused.actual[target]}, voorspeld{' '}
              {nlNum(focused.predicted[target]?.[featureSet] ?? 0, 1)}
            </p>
          )}
        </section>
      )}

      {/* Extremes */}
      <div className="grid gap-4 lg:grid-cols-2">
        {[
          { title: 'Grootste onderbediening', rows: underserved, hint: 'minder punten dan verwacht' },
          { title: 'Grootste overbediening', rows: overserved, hint: 'meer punten dan verwacht' },
        ].map((block) => (
          <section key={block.title} className="rounded-lg border border-border bg-card p-4">
            <h3 className="text-sm font-semibold text-[var(--green-900)]">{block.title}</h3>
            <p className="mb-2 text-xs text-muted-foreground">{block.hint}</p>
            <ul className="space-y-1 text-sm">
              {block.rows.map((r) => (
                <li key={r.pc4} className="flex items-baseline justify-between gap-2">
                  <span>
                    <span className="font-mono">{r.pc4}</span>{' '}
                    <span className="text-muted-foreground">{r.municipality}</span>
                  </span>
                  <span className="tabular-nums">
                    {r.actual} vs {nlNum(r.predicted as number, 1)}{' '}
                    <span className="text-muted-foreground">
                      ({(r.delta as number) > 0 ? '+' : ''}
                      {nlNum(r.delta as number, 1)})
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>

      {/* Custom regression builder */}
      <section className="space-y-3 rounded-lg border border-border bg-card p-4">
        <div>
          <h3 className="text-lg font-semibold text-[var(--green-900)]">
            Kies zelf variabelen
          </h3>
          <p className="text-sm text-muted-foreground">
            De regressie draait in de browser op dezelfde PC4-set. Let op de
            cross-validatiescore, niet op R² van de trainingsset — die stijgt hoe dan
            ook als je een variabele toevoegt.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {FEATURE_PRESETS.map((preset) => (
            <button
              key={preset.name}
              type="button"
              title={preset.note}
              onClick={() => setSelected(preset.keys)}
              className="min-h-9 rounded-md border border-border px-2.5 text-xs font-medium text-muted-foreground hover:border-[var(--green-300)] hover:text-[var(--green-800)]"
            >
              {preset.name}
            </button>
          ))}
          <button
            type="button"
            onClick={() => setSelected([])}
            className="min-h-9 rounded-md px-2.5 text-xs text-muted-foreground hover:text-foreground"
          >
            Wis selectie
          </button>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {(Object.keys(FEATURE_GROUP_LABELS) as FeatureDef['group'][]).map((group) => (
            <div key={group}>
              <h4 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                {FEATURE_GROUP_LABELS[group]}
              </h4>
              <ul className="space-y-1">
                {FEATURE_DEFS.filter((f) => f.group === group).map((def) => (
                  <li key={def.key}>
                    <label className="flex cursor-pointer items-start gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={selected.includes(def.key)}
                        onChange={(e) =>
                          setSelected((prev) =>
                            e.target.checked
                              ? [...prev, def.key]
                              : prev.filter((k) => k !== def.key)
                          )
                        }
                        className="mt-1 size-3.5 accent-[var(--green-600)]"
                      />
                      <span>
                        {def.label}
                        {def.unit && (
                          <span className="ml-1 text-xs text-muted-foreground">
                            ({def.unit})
                          </span>
                        )}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        {customFit ? (
          <div className="space-y-3 rounded-lg bg-muted/50 p-3">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <StatTile
                label="R² (cross-validatie)"
                value={nlNum(customFit.fit.r2cv, 3)}
                hint={`± ${nlNum(customFit.fit.r2cvStd, 3)}`}
              />
              <StatTile label="R² (trainingsset)" value={nlNum(customFit.fit.r2, 3)} />
              <StatTile label="PC4's" value={nlInt(customFit.fit.n)} />
              <StatTile label="Variabelen" value={nlInt(selected.length)} />
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[28rem] text-sm">
                <thead className="border-b border-border text-xs text-muted-foreground">
                  <tr>
                    <th className="px-2 py-1 text-left font-semibold">Variabele</th>
                    <th className="px-2 py-1 text-right font-semibold">Coëfficiënt</th>
                    <th className="px-2 py-1 text-right font-semibold">VIF</th>
                  </tr>
                </thead>
                <tbody>
                  {selected.map((key, i) => (
                    <tr key={key} className="border-b border-border/60 last:border-0">
                      <td className="px-2 py-1">{FEATURE_BY_KEY.get(key)?.label ?? key}</td>
                      <td className="px-2 py-1 text-right tabular-nums">
                        {customFit.fit.coefficients[i] >= 0 ? '+' : ''}
                        {nlNum(customFit.fit.coefficients[i], 6)}
                      </td>
                      <td className="px-2 py-1 text-right tabular-nums">
                        {Number.isFinite(customFit.vifs[i])
                          ? nlNum(customFit.vifs[i], 2)
                          : '∞'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : (
          <p className="rounded-lg bg-muted/50 p-3 text-sm text-muted-foreground">
            {selected.length === 0
              ? 'Kies minstens één variabele.'
              : 'Te weinig PC4’s met alle gekozen variabelen ingevuld — CBS onderdrukt cellen voor kleine gebieden.'}
          </p>
        )}
      </section>

      {/* Table */}
      <section className="overflow-hidden rounded-lg border border-border bg-card">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
          <div>
            <h3 className="text-lg font-semibold text-[var(--green-900)]">Per PC4</h3>
            <p className="text-xs text-muted-foreground">
              Verschil = werkelijk minus voorspeld. Negatief is onderbediend.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Zoek PC4 of gemeente…"
              className="min-h-9 w-full rounded-md border border-border bg-card px-3 text-sm sm:w-56"
            />
            <CsvButton onClick={exportCsv} label="CSV" />
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[36rem] text-sm">
            <thead className="border-b border-border bg-muted/50 text-xs">
              <tr>
                <SortHeader label="PC4" sortKey="pc4" activeKey={sort.key} dir={sort.dir} onToggle={sort.toggle} />
                <SortHeader label="Gemeente" sortKey="municipality" activeKey={sort.key} dir={sort.dir} onToggle={sort.toggle} />
                <SortHeader label="Inwoners" sortKey="population" activeKey={sort.key} dir={sort.dir} onToggle={sort.toggle} align="right" />
                <SortHeader label="Werkelijk" sortKey="actual" activeKey={sort.key} dir={sort.dir} onToggle={sort.toggle} align="right" />
                <SortHeader label="Voorspeld" sortKey="predicted" activeKey={sort.key} dir={sort.dir} onToggle={sort.toggle} align="right" />
                <SortHeader label="Verschil" sortKey="delta" activeKey={sort.key} dir={sort.dir} onToggle={sort.toggle} align="right" />
              </tr>
            </thead>
            <tbody>
              {paged.slice.map((r) => (
                <tr
                  key={r.pc4}
                  className="border-b border-border/60 last:border-0 hover:bg-muted/40"
                  onMouseEnter={() => setFocused(r.point)}
                >
                  <td className="px-2 py-1.5 font-mono">{r.pc4}</td>
                  <td className="px-2 py-1.5">{r.municipality}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{nlInt(r.population)}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{r.actual}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">
                    {nlNum(r.predicted as number, 1)}
                  </td>
                  <td
                    className="px-2 py-1.5 text-right font-medium tabular-nums"
                    style={{
                      color:
                        (r.delta as number) < 0
                          ? 'var(--destructive)'
                          : 'var(--green-700)',
                    }}
                  >
                    {(r.delta as number) > 0 ? '+' : ''}
                    {nlNum(r.delta as number, 1)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <Pager page={paged.page} pageCount={paged.pageCount} onChange={paged.setPage} total={filtered.length} />
      </section>

      <MethodologyNote>
        <p>
          Model: kleinste-kwadraten (OLS) op PC4-niveau, getraind op gebieden met
          minstens {payload.model_meta.training_filters.min_population} inwoners en{' '}
          {payload.model_meta.training_filters.min_area_km2} km² oppervlakte.
        </p>
        <p>{payload.model_meta.cv.note}</p>
        <p>
          Landelijke kengetallen ter controle:{' '}
          {MODEL_TARGETS.map((t) => {
            const rate = payload.model_meta.nationwide_rates[t];
            return `${payload.model_meta.targets[t]} ${nlInt(rate.points)} punten`;
          }).join(' · ')}
          .
        </p>
        <p>
          De NDW-laad-/losplaatsen, emissiezones en ongevalscijfers uit de
          pakketpuntenvariant zitten hier bewust niet in: die verklaren
          vrachtverkeer, en wie een krat flesjes inlevert komt lopend of met de
          fiets.
        </p>
      </MethodologyNote>
    </div>
  );
}
