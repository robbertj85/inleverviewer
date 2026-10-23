'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

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
 *
 * Drawn at the container's real pixel width, not scaled from a viewBox: a
 * 520-wide viewBox stretched to a 1.400 px column blew the 9 px labels up to
 * 24 px, and squeezed onto a phone shrank them to 6 px.
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
  const wrapper = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(520);
  useEffect(() => {
    const element = wrapper.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      setWidth(Math.max(240, Math.round(entry.contentRect.width)));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const height = width < 480 ? 180 : 220;
  const padLeft = 40;
  const padBottom = 24;
  const padTop = 10;
  const padRight = 10;

  const plotWidth = width - padLeft - padRight;
  const plotHeight = height - padTop - padBottom;
  const steps = Math.max(1, maxPicks);

  const x = (i: number) => padLeft + (i / steps) * plotWidth;
  const xTicks = niceTicks(steps, width < 480 ? 4 : 8);
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
    // x and y are recreated each render; their inputs are the width, height
    // and step count, so those are the real dependencies.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [series, total, n, steps, width, height]
  );

  return (
    <div className="space-y-2">
      <div ref={wrapper} className="w-full">
      <svg
        width={width}
        height={height}
        role="img"
        aria-label="Dekking tegen het aantal geplaatste punten"
        className="block"
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
              fontSize="11"
              fill="var(--muted-foreground)"
            >
              {pct}%
            </text>
          </g>
        ))}
        {xTicks.map((tick) => (
          <text
            key={tick}
            x={x(tick)}
            y={height - 6}
            textAnchor="middle"
            fontSize="11"
            fill="var(--muted-foreground)"
          >
            {tick}
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
      </div>

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

/** Whole-number ticks at a round step (1, 2, 5, 10, 20, …), always ending on max. */
function niceTicks(max: number, target: number): number[] {
  const raw = max / Math.max(1, target);
  const magnitude = 10 ** Math.floor(Math.log10(Math.max(1, raw)));
  const step = [1, 2, 5, 10].map((m) => m * magnitude).find((s) => s >= raw) ?? magnitude * 10;
  const ticks: number[] = [];
  for (let t = 0; t <= max; t += step) ticks.push(t);
  // Drop a last regular tick that would crowd the max label.
  if (ticks.length > 1 && max - ticks[ticks.length - 1] < step / 2) ticks.pop();
  ticks.push(max);
  return ticks;
}
