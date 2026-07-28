'use client';

import { useMemo, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import MunicipalitySelector from '@/components/MunicipalitySelector';
import {
  ALL_CATEGORIEEN,
  ALL_MATERIALEN,
  ALL_MERKEN,
  CATEGORIE_LABELS,
  MATERIAAL_LABELS,
  MERK_COLORS,
  MERK_LABELS,
  Materiaal,
  Merk,
  Municipality,
  PuntCategorie,
} from '@/types/inleverpunten';
import { cn } from '@/lib/utils';

const RADII = ['300', '400', '500'] as const;

// Chart ink. Text never wears the series colour; the coloured mark beside it
// carries identity.
const AXIS_INK = '#63705a';
const GRID_INK = '#e2e6dd';

export interface MunicipalityStats {
  slug: string;
  gemeente: string;
  provincie: string;
  code: string | null;
  population: number;
  area_km2: number;
  total: number;
  per_10k_inwoners: number;
  per_km2: number;
  merken: Record<string, number>;
  categorieen: Record<string, number>;
  materialen: Record<string, number>;
  dekking: Record<string, number>;
}

export interface StatisticsPayload {
  generated_at: string;
  national: {
    total: number;
    population: number;
    area_km2: number;
    merken: Record<string, number>;
    categorieen: Record<string, number>;
    materialen: Record<string, number>;
    dekking: Record<string, number>;
  };
  municipalities: MunicipalityStats[];
}

function formatNumber(value: number): string {
  return value.toLocaleString('nl-NL');
}

function ChartTooltip({
  active,
  payload,
  label,
  suffix,
}: {
  active?: boolean;
  payload?: { value: number; payload: { label: string } }[];
  label?: string;
  suffix?: string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-border bg-popover px-2.5 py-1.5 text-xs shadow-md">
      <p className="font-medium">{payload[0].payload.label ?? label}</p>
      <p className="tabular-nums text-muted-foreground">
        {formatNumber(payload[0].value)}
        {suffix ?? ''}
      </p>
    </div>
  );
}

/** Horizontal bar chart with a legend-free single series and labelled ticks. */
function RankedBars({
  data,
  suffix,
  color,
}: {
  data: { label: string; value: number; color?: string }[];
  suffix?: string;
  color?: string;
}) {
  if (data.length === 0) {
    return <p className="py-6 text-center text-sm text-muted-foreground">Geen data.</p>;
  }

  return (
    <ResponsiveContainer width="100%" height={Math.max(160, data.length * 30)}>
      <BarChart data={data} layout="vertical" margin={{ top: 4, right: 48, bottom: 4, left: 4 }}>
        <CartesianGrid horizontal={false} stroke={GRID_INK} strokeWidth={1} />
        <XAxis
          type="number"
          tick={{ fill: AXIS_INK, fontSize: 11 }}
          stroke={GRID_INK}
          tickFormatter={formatNumber}
        />
        <YAxis
          type="category"
          dataKey="label"
          width={150}
          tick={{ fill: AXIS_INK, fontSize: 11 }}
          stroke={GRID_INK}
        />
        <Tooltip
          cursor={{ fill: 'rgba(0,0,0,0.03)' }}
          content={<ChartTooltip suffix={suffix} />}
        />
        <Bar dataKey="value" radius={[0, 4, 4, 0]} maxBarSize={20}>
          {data.map((entry, index) => (
            <Cell key={index} fill={entry.color ?? color ?? 'var(--green-600)'} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

/** Values in a table, so nothing is gated behind a low-contrast fill. */
function ValueTable({
  rows,
  valueLabel,
  suffix,
}: {
  rows: { label: string; value: number; color?: string }[];
  valueLabel: string;
  suffix?: string;
}) {
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-border text-xs text-muted-foreground">
          <th className="py-1.5 text-left font-medium">Categorie</th>
          <th className="py-1.5 text-right font-medium">{valueLabel}</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-border">
        {rows.map((row) => (
          <tr key={row.label}>
            <td className="flex items-center gap-2 py-1.5">
              {row.color && (
                <span
                  className="size-2.5 shrink-0 rounded-full"
                  style={{ background: row.color }}
                  aria-hidden
                />
              )}
              {row.label}
            </td>
            <td className="py-1.5 text-right tabular-nums">
              {formatNumber(row.value)}
              {suffix ?? ''}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function CoverageBars({ dekking }: { dekking: Record<string, number> }) {
  return (
    <div className="space-y-2.5">
      {RADII.map((radius) => {
        const share = (dekking[radius] ?? 0) * 100;
        return (
          <div key={radius}>
            <div className="mb-1 flex items-baseline justify-between text-xs">
              <span className="text-muted-foreground">Binnen {radius} meter</span>
              <span className="font-semibold tabular-nums text-[var(--green-900)]">
                {share.toFixed(1)}%
              </span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-primary"
                style={{ width: `${Math.min(share, 100)}%` }}
              />
            </div>
          </div>
        );
      })}
      <p className="pt-1 text-[11px] text-muted-foreground">
        Aandeel van het gemeenteoppervlak binnen deze hemelsbrede afstand van een inleverpunt.
      </p>
    </div>
  );
}

export default function StatisticsClient({ statistics }: { statistics: StatisticsPayload }) {
  const [selectedSlug, setSelectedSlug] = useState<string>('');
  const [query, setQuery] = useState('');
  const [rankMetric, setRankMetric] = useState<'per_10k_inwoners' | 'total' | 'dekking'>(
    'per_10k_inwoners'
  );

  const municipalities: Municipality[] = useMemo(
    () =>
      statistics.municipalities.map((m) => ({
        name: m.gemeente,
        slug: m.slug,
        province: m.provincie,
        population: m.population,
        code: m.code,
      })),
    [statistics]
  );

  const selected = useMemo(
    () => statistics.municipalities.find((m) => m.slug === selectedSlug) ?? null,
    [statistics, selectedSlug]
  );

  const scope = selected ?? statistics.national;
  const scopeName = selected ? selected.gemeente : 'Nederland';

  const merkRows = useMemo(
    () =>
      ALL_MERKEN.map((merk: Merk) => ({
        label: MERK_LABELS[merk],
        value: scope.merken[merk] ?? 0,
        color: MERK_COLORS[merk],
      })).filter((row) => row.value > 0),
    [scope]
  );

  const categorieRows = useMemo(
    () =>
      ALL_CATEGORIEEN.map((categorie: PuntCategorie) => ({
        label: CATEGORIE_LABELS[categorie],
        value: scope.categorieen[categorie] ?? 0,
      })).filter((row) => row.value > 0),
    [scope]
  );

  const materiaalRows = useMemo(
    () =>
      ALL_MATERIALEN.map((materiaal: Materiaal) => ({
        label: MATERIAAL_LABELS[materiaal],
        value: scope.materialen[materiaal] ?? 0,
      })).filter((row) => row.value > 0),
    [scope]
  );

  const ranking = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const list = needle
      ? statistics.municipalities.filter(
          (m) =>
            m.gemeente.toLowerCase().includes(needle) ||
            m.provincie.toLowerCase().includes(needle)
        )
      : statistics.municipalities;

    const scored = list.map((m) => ({
      slug: m.slug,
      label: m.gemeente,
      value:
        rankMetric === 'dekking'
          ? Math.round((m.dekking['300'] ?? 0) * 1000) / 10
          : m[rankMetric],
    }));

    return [...scored].sort((a, b) => b.value - a.value);
  }, [statistics, query, rankMetric]);

  const rankSuffix =
    rankMetric === 'dekking' ? '%' : rankMetric === 'per_10k_inwoners' ? ' per 10k' : '';

  return (
    <div className="space-y-6">
      <div className="flex flex-col items-start justify-between gap-3 sm:flex-row sm:items-center">
        <div>
          <h2 className="text-lg font-bold text-[var(--green-900)]">Statistieken</h2>
          <p className="text-sm text-muted-foreground">
            Bijgewerkt {new Date(statistics.generated_at).toLocaleDateString('nl-NL')}
          </p>
        </div>
        <div className="w-full sm:w-72">
          <MunicipalitySelector
            municipalities={[
              { name: 'Nederland (totaal)', slug: '', province: '', population: 0, code: null },
              ...municipalities,
            ]}
            selected={selectedSlug}
            onChange={setSelectedSlug}
          />
        </div>
      </div>

      {/* Headline figures */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardContent className="p-4">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Inleverpunten</p>
            <p className="mt-1 text-2xl font-bold tabular-nums text-[var(--green-900)]">
              {formatNumber(scope.total)}
            </p>
            <p className="text-xs text-muted-foreground">{scopeName}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">
              Per 10.000 inwoners
            </p>
            <p className="mt-1 text-2xl font-bold tabular-nums text-[var(--green-900)]">
              {selected
                ? selected.per_10k_inwoners.toFixed(1)
                : ((statistics.national.total / statistics.national.population) * 10_000).toFixed(1)}
            </p>
            <p className="text-xs text-muted-foreground">
              {formatNumber(selected ? selected.population : statistics.national.population)} inwoners
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Oppervlakte</p>
            <p className="mt-1 text-2xl font-bold tabular-nums text-[var(--green-900)]">
              {formatNumber(Math.round(selected ? selected.area_km2 : statistics.national.area_km2))}
            </p>
            <p className="text-xs text-muted-foreground">km²</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">
              Dekking 300 m
            </p>
            <p className="mt-1 text-2xl font-bold tabular-nums text-[var(--green-900)]">
              {((scope.dekking['300'] ?? 0) * 100).toFixed(1)}%
            </p>
            <p className="text-xs text-muted-foreground">van het oppervlak</p>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Inleverpunten per bron — {scopeName}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <RankedBars data={merkRows} />
            <ValueTable rows={merkRows} valueLabel="Aantal" />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Dekkingsgraad — {scopeName}</CardTitle>
          </CardHeader>
          <CardContent>
            <CoverageBars dekking={scope.dekking} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Type inleverpunt — {scopeName}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <RankedBars data={categorieRows} color="var(--green-600)" />
            <ValueTable rows={categorieRows} valueLabel="Aantal" />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Materiaalstromen — {scopeName}</CardTitle>
            <p className="text-xs text-muted-foreground">
              Een punt telt mee bij elke stroom die het accepteert, dus de som ligt boven het totaal.
            </p>
          </CardHeader>
          <CardContent className="space-y-3">
            <RankedBars data={materiaalRows} color="var(--green-500)" />
            <ValueTable rows={materiaalRows} valueLabel="Aantal punten" />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <div className="flex flex-col items-start justify-between gap-2 sm:flex-row sm:items-center">
            <CardTitle>Ranglijst gemeenten</CardTitle>
            <div className="flex w-full flex-wrap gap-1.5 sm:w-auto">
              {(
                [
                  ['per_10k_inwoners', 'Per 10k inwoners'],
                  ['total', 'Totaal'],
                  ['dekking', 'Dekking 300 m'],
                ] as const
              ).map(([key, label]) => (
                <Button
                  key={key}
                  size="sm"
                  variant={rankMetric === key ? 'default' : 'outline'}
                  onClick={() => setRankMetric(key)}
                >
                  {label}
                </Button>
              ))}
            </div>
          </div>
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Zoek gemeente of provincie..."
            className="mt-2"
          />
        </CardHeader>
        <CardContent>
          <div className="max-h-[30rem] overflow-y-auto rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-secondary text-xs text-muted-foreground">
                <tr>
                  <th className="w-10 px-2 py-2 text-right font-medium">#</th>
                  <th className="px-2 py-2 text-left font-medium">Gemeente</th>
                  <th className="px-2 py-2 text-right font-medium">Waarde</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {ranking.map((row, index) => (
                  <tr
                    key={row.slug}
                    className={cn(
                      'transition-colors hover:bg-secondary',
                      row.slug === selectedSlug && 'bg-[var(--green-50)]'
                    )}
                  >
                    <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">
                      {index + 1}
                    </td>
                    <td className="px-2 py-0.5">
                      <button
                        type="button"
                        onClick={() => setSelectedSlug(row.slug)}
                        className="flex min-h-9 w-full items-center text-left font-medium hover:text-primary hover:underline"
                      >
                        {row.label}
                      </button>
                    </td>
                    <td className="px-2 py-1.5 text-right font-semibold tabular-nums">
                      {rankMetric === 'total'
                        ? formatNumber(row.value)
                        : row.value.toFixed(1)}
                      {rankSuffix}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {ranking.length === 0 && (
            <p className="py-6 text-center text-sm text-muted-foreground">
              Geen gemeente gevonden.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
