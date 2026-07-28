'use client';

import { useMemo } from 'react';
import { MapPinIcon } from 'lucide-react';

import {
  ALL_CATEGORIEEN,
  CATEGORIE_LABELS,
  InleverpuntData,
  InleverpuntProperties,
  isInleverpunt,
} from '@/types/inleverpunten';

interface Props {
  data: InleverpuntData;
  visibleCount: number;
  categorieCounts: Record<string, number>;
}

export default function StatsPanel({ data, visibleCount, categorieCounts }: Props) {
  const total = useMemo(
    () =>
      data.features.filter((f) => isInleverpunt(f.properties as InleverpuntProperties))
        .length,
    [data]
  );

  const filtered = visibleCount !== total;

  return (
    <div className="rounded-xl border border-border bg-card p-3 shadow-sm">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="truncate text-sm font-semibold text-[var(--green-900)]">
          {data.metadata.gemeente}
        </h2>
        {data.metadata.municipalities && (
          <span className="shrink-0 text-[11px] text-muted-foreground">
            {data.metadata.municipalities} gemeenten
          </span>
        )}
      </div>

      <p className="mt-1.5 flex items-center gap-1.5 text-2xl font-bold tabular-nums text-primary">
        <MapPinIcon className="size-5" />
        {visibleCount.toLocaleString('nl-NL')}
      </p>
      <p className="text-xs text-muted-foreground">
        {filtered ? (
          <>
            zichtbaar van {total.toLocaleString('nl-NL')} inleverpunten
          </>
        ) : (
          <>inleverpunten</>
        )}
      </p>

      <dl className="mt-2.5 grid grid-cols-2 gap-1.5 border-t border-border pt-2.5">
        {ALL_CATEGORIEEN.map((categorie) => {
          const count = categorieCounts[categorie] ?? 0;
          if (count === 0) return null;
          return (
            <div key={categorie} className="rounded-md bg-secondary px-2 py-1.5">
              <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">
                {CATEGORIE_LABELS[categorie]}
              </dt>
              <dd className="text-sm font-semibold tabular-nums text-[var(--green-900)]">
                {count.toLocaleString('nl-NL')}
              </dd>
            </div>
          );
        })}
      </dl>
    </div>
  );
}
