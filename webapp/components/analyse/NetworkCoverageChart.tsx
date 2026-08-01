'use client';

import { useMemo } from 'react';

import { nlInt, nlPct } from '@/types/analyse';

export interface CoverageSeries {
  label: string;
  colour: string;
  /** Cumulative inhabitants covered after k picks, index 0 = before any pick. */
  cumulative: number[];
}

/**
 * Coverage against the number of points placed.
 *
 * Deliberately a plain SVG rather than a chart library: two monotone series
 * with a marker on the current slider position is the whole requirement, and
 * the axes carry more meaning as fixed 0–100% than as auto-scaled ones — the
 * gap to 100 is the point.
 */
export default function NetworkCoverageChart({
  series,
  total,
  n,
  maxPicks,
}: {
  series: CoverageSeries[];
  total: number;
  n: number;
  maxPicks: number;
}) {
  const width = 520;
  const height = 220;
  const padLeft = 44;
  const padBottom = 28;
  const padTop = 10;
  const padRight = 8;

  const plotWidth = width - padLeft - padRight;
  const plotHeight = height - padTop - padBottom;
  const steps = Math.max(1, maxPicks);

  const x = (i: number) => padLeft + (i / steps) * plotWidth;
  const y = (pct: number) => padTop + (1 - pct / 100) * plotHeight;

  const paths = useMemo(
    () =>
      series.map((s) => ({
        ...s,
        d: s.cumulative
          .map((value, i) => {
            const pct = total > 0 ? (value / total) * 100 : 0;
            return `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(pct).toFixed(1)}`;
          })
          .join(' '),
        current:
          total > 0
            ? ((s.cumulative[Math.min(n, s.cumulative.length - 1)] ?? 0) / total) * 100
            : 0,
        currentAbs: s.cumulative[Math.min(n, s.cumulative.length - 1)] ?? 0,
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [series, total, n, steps]
  );

  return (
    <div className="space-y-2">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label="Dekking tegen het aantal geplaatste punten"
        className="h-auto w-full"
      >
        {[0, 25, 50, 75, 100].map((pct) => (
          <g key={pct}>
            <line
              x1={padLeft}
              y1={y(pct)}
              x2={width - padRight}
              y2={y(pct)}
              stroke="var(--border)"
              strokeWidth="1"
            />
            <text
              x={padLeft - 6}
              y={y(pct) + 3}
              textAnchor="end"
              fontSize="9"
              fill="var(--muted-foreground)"
            >
              {pct}%
            </text>
          </g>
        ))}
        {[0, 0.25, 0.5, 0.75, 1].map((t) => (
          <text
            key={t}
            x={x(t * steps)}
            y={height - 10}
            textAnchor="middle"
            fontSize="9"
            fill="var(--muted-foreground)"
          >
            {Math.round(t * steps)}
          </text>
        ))}

        {/* Slider position */}
        <line
          x1={x(n)}
          y1={padTop}
          x2={x(n)}
          y2={padTop + plotHeight}
          stroke="var(--green-600)"
          strokeDasharray="3 3"
          strokeWidth="1.2"
        />

        {paths.map((p) => (
          <g key={p.label}>
            <path d={p.d} fill="none" stroke={p.colour} strokeWidth="2" />
            <circle cx={x(n)} cy={y(p.current)} r="3.5" fill={p.colour} />
          </g>
        ))}
      </svg>

      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
        {paths.map((p) => (
          <span key={p.label} className="flex items-center gap-1.5">
            <span
              className="inline-block h-0.5 w-4"
              style={{ background: p.colour }}
            />
            {p.label}:{' '}
            <span className="font-medium tabular-nums text-foreground">
              {nlPct(p.current)}%
            </span>
            <span className="text-muted-foreground">
              ({nlInt(Math.round(p.currentAbs))})
            </span>
          </span>
        ))}
        <span className="ml-auto text-muted-foreground">
          x-as: aantal geplaatste punten
        </span>
      </div>
    </div>
  );
}
