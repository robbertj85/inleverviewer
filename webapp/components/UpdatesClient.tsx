'use client';

import { useMemo } from 'react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { AlertTriangleIcon, CheckCircle2Icon, MinusIcon, TrendingDownIcon, TrendingUpIcon } from 'lucide-react';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ALL_MERKEN, MERK_COLORS, MERK_LABELS, Merk } from '@/types/inleverpunten';

const AXIS_INK = '#63705a';
const GRID_INK = '#e2e6dd';
const SURFACE = '#ffffff';

interface Snapshot {
  date: string;
  week_label: string;
  totals: { total: number; merken: Record<string, number> };
}

/** One row of the trend chart: a week, the national total, and one key per brand. */
type ChartRow = { week: string; total: number } & Record<Merk, number>;

export interface UpdatesPayload {
  summary: {
    generated_at: string;
    total_municipalities: number;
    total_points: number;
    unassigned_points: number;
    source_status: Record<string, { success: boolean; count: number }>;
    merk_totals: Record<string, number>;
  } | null;
  history: {
    updated_at: string;
    snapshots: Snapshot[];
    trend?: {
      period: { from: string; to: string; weeks: number };
      change: { total: number; merken: Record<string, number> };
    };
  } | null;
}

function TrendBadge({ change }: { change: number }) {
  if (change === 0) {
    return (
      <span className="inline-flex items-center gap-0.5 text-xs text-muted-foreground">
        <MinusIcon className="size-3" />0
      </span>
    );
  }
  const positive = change > 0;
  return (
    <span
      className={
        positive
          ? 'inline-flex items-center gap-0.5 text-xs font-medium text-[var(--green-700)]'
          : 'inline-flex items-center gap-0.5 text-xs font-medium text-destructive'
      }
    >
      {positive ? <TrendingUpIcon className="size-3" /> : <TrendingDownIcon className="size-3" />}
      {positive ? '+' : ''}
      {change.toLocaleString('nl-NL')}
    </span>
  );
}

export default function UpdatesClient({ summary, history }: UpdatesPayload) {
  const chartData = useMemo<ChartRow[]>(() => {
    if (!history?.snapshots?.length) return [];
    return history.snapshots.map((snapshot) => ({
      week: snapshot.week_label,
      total: snapshot.totals.total,
      ...Object.fromEntries(
        ALL_MERKEN.map((merk) => [merk, snapshot.totals.merken[merk] ?? 0])
      ),
    })) as ChartRow[];
  }, [history]);

  const singleSnapshot = chartData.length < 2;

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader>
          <CardTitle>Updatestatus</CardTitle>
          <p className="text-xs text-muted-foreground">
            De data wordt elke maandag om 02:00 UTC automatisch ververst via GitHub Actions.
          </p>
        </CardHeader>
        <CardContent>
          {!summary ? (
            <p className="text-sm text-muted-foreground">
              Nog geen updategegevens beschikbaar.
            </p>
          ) : (
            <>
              <div className="grid gap-3 sm:grid-cols-3">
                <div>
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">
                    Laatste update
                  </p>
                  <p className="text-sm font-semibold">
                    {new Date(summary.generated_at).toLocaleString('nl-NL', {
                      dateStyle: 'long',
                      timeStyle: 'short',
                    })}
                  </p>
                </div>
                <div>
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">
                    Gemeenten
                  </p>
                  <p className="text-sm font-semibold tabular-nums">
                    {summary.total_municipalities}
                  </p>
                </div>
                <div>
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">
                    Inleverpunten
                  </p>
                  <p className="text-sm font-semibold tabular-nums">
                    {summary.total_points.toLocaleString('nl-NL')}
                  </p>
                </div>
              </div>

              <table className="mt-4 w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-xs text-muted-foreground">
                    <th className="py-1.5 text-left font-medium">Bron</th>
                    <th className="py-1.5 text-right font-medium">Punten</th>
                    <th className="py-1.5 text-right font-medium">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {ALL_MERKEN.map((merk: Merk) => {
                    const status = summary.source_status?.[merk];
                    const ok = status?.success ?? false;
                    return (
                      <tr key={merk}>
                        <td className="flex items-center gap-2 py-1.5">
                          <span
                            className="size-2.5 shrink-0 rounded-full"
                            style={{ background: MERK_COLORS[merk] }}
                            aria-hidden
                          />
                          {MERK_LABELS[merk]}
                        </td>
                        <td className="py-1.5 text-right tabular-nums">
                          {(summary.merk_totals?.[merk] ?? 0).toLocaleString('nl-NL')}
                        </td>
                        <td className="py-1.5 text-right">
                          {ok ? (
                            <span className="inline-flex items-center gap-1 text-xs text-[var(--green-700)]">
                              <CheckCircle2Icon className="size-3.5" />
                              Bijgewerkt
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 text-xs text-amber-700">
                              <AlertTriangleIcon className="size-3.5" />
                              Vorige cache
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>

              {summary.unassigned_points > 0 && (
                <p className="mt-3 text-xs text-muted-foreground">
                  {summary.unassigned_points} punten vielen buiten elke gemeentegrens en zijn
                  weggelaten — meestal coördinaten net over de grens of op zee.
                </p>
              )}
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Historische ontwikkeling</CardTitle>
          {history?.trend && (
            <p className="text-xs text-muted-foreground">
              Sinds {history.trend.period.from}:{' '}
              <TrendBadge change={history.trend.change.total} /> inleverpunten
            </p>
          )}
        </CardHeader>
        <CardContent>
          {chartData.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nog geen historie beschikbaar. Na de eerste paar wekelijkse runs verschijnt hier een
              grafiek.
            </p>
          ) : singleSnapshot ? (
            <p className="text-sm text-muted-foreground">
              Er is nog maar één wekelijkse meting ({chartData[0].week},{' '}
              {chartData[0].total.toLocaleString('nl-NL')} punten). Vanaf de tweede run wordt hier
              een trendlijn getekend.
            </p>
          ) : (
            <>
              <ResponsiveContainer width="100%" height={280}>
                <LineChart data={chartData} margin={{ top: 8, right: 16, bottom: 4, left: 4 }}>
                  <CartesianGrid vertical={false} stroke={GRID_INK} strokeWidth={1} />
                  <XAxis
                    dataKey="week"
                    tick={{ fill: AXIS_INK, fontSize: 11 }}
                    stroke={GRID_INK}
                  />
                  <YAxis
                    tick={{ fill: AXIS_INK, fontSize: 11 }}
                    stroke={GRID_INK}
                    tickFormatter={(v: number) => v.toLocaleString('nl-NL')}
                  />
                  <Tooltip
                    contentStyle={{
                      borderRadius: 10,
                      border: `1px solid ${GRID_INK}`,
                      fontSize: 12,
                    }}
                    formatter={(value, name) => [
                      Number(value).toLocaleString('nl-NL'),
                      MERK_LABELS[name as Merk] ?? String(name),
                    ]}
                  />
                  {ALL_MERKEN.map((merk: Merk) => (
                    <Line
                      key={merk}
                      type="monotone"
                      dataKey={merk}
                      stroke={MERK_COLORS[merk]}
                      strokeWidth={2}
                      dot={{ r: 4, strokeWidth: 2, stroke: SURFACE }}
                      activeDot={{ r: 5, strokeWidth: 2, stroke: SURFACE }}
                    />
                  ))}
                </LineChart>
              </ResponsiveContainer>

              {/* Legend: identity never rests on colour alone. */}
              <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5">
                {ALL_MERKEN.map((merk: Merk) => (
                  <li key={merk} className="flex items-center gap-1.5 text-xs">
                    <span
                      className="h-0.5 w-4 shrink-0 rounded-full"
                      style={{ background: MERK_COLORS[merk] }}
                      aria-hidden
                    />
                    <span className="text-muted-foreground">{MERK_LABELS[merk]}</span>
                  </li>
                ))}
              </ul>

              <div className="mt-4 overflow-x-auto">
                <table className="w-full min-w-[36rem] text-sm">
                  <thead>
                    <tr className="border-b border-border text-xs text-muted-foreground">
                      <th className="py-1.5 text-left font-medium">Week</th>
                      {ALL_MERKEN.map((merk) => (
                        <th key={merk} className="py-1.5 text-right font-medium">
                          {MERK_LABELS[merk].split(' ')[0]}
                        </th>
                      ))}
                      <th className="py-1.5 text-right font-medium">Totaal</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {[...chartData].reverse().map((row) => (
                      <tr key={row.week}>
                        <td className="py-1.5">{row.week}</td>
                        {ALL_MERKEN.map((merk) => (
                          <td key={merk} className="py-1.5 text-right tabular-nums">
                            {row[merk].toLocaleString('nl-NL')}
                          </td>
                        ))}
                        <td className="py-1.5 text-right font-semibold tabular-nums">
                          {row.total.toLocaleString('nl-NL')}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
