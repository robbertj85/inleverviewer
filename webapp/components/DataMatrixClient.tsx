'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { ArrowDownIcon, ArrowUpIcon, DownloadIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { MERK_COLORS, MERK_LABELS, Merk } from '@/types/inleverpunten';
import { cn } from '@/lib/utils';

export interface MatrixRow {
  slug: string;
  gemeente: string;
  provincie: string;
  population: number;
  total: number;
  per10k: number;
  merken: Record<string, number>;
}

interface Props {
  rows: MatrixRow[];
  merken: Merk[];
  totals: Record<string, number>;
  grandTotal: number;
  generatedAt: string | null;
}

type SortKey = 'gemeente' | 'total' | 'per10k' | 'population' | Merk;

/**
 * Defined at module scope, not inside DataMatrixClient. A component created
 * during render is a brand-new type every pass, so React unmounts and remounts
 * the whole header row on every keystroke in the search box.
 */
function SortHeader({
  label,
  sortKey,
  activeKey,
  ascending,
  onSort,
  className,
  swatch,
}: {
  label: string;
  sortKey: SortKey;
  activeKey: SortKey;
  ascending: boolean;
  onSort: (key: SortKey) => void;
  className?: string;
  swatch?: string;
}) {
  const active = activeKey === sortKey;

  return (
    <th
      className={cn('whitespace-nowrap px-2 py-2 text-right font-medium', className)}
      aria-sort={active ? (ascending ? 'ascending' : 'descending') : 'none'}
    >
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className="inline-flex items-center gap-1 hover:text-primary"
      >
        {swatch && (
          <span
            className="size-2 shrink-0 rounded-full"
            style={{ background: swatch }}
            aria-hidden
          />
        )}
        {label}
        {active &&
          (ascending ? <ArrowUpIcon className="size-3" /> : <ArrowDownIcon className="size-3" />)}
      </button>
    </th>
  );
}

export default function DataMatrixClient({
  rows,
  merken,
  totals,
  grandTotal,
  generatedAt,
}: Props) {
  const [query, setQuery] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('total');
  const [ascending, setAscending] = useState(false);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const list = needle
      ? rows.filter(
          (row) =>
            row.gemeente.toLowerCase().includes(needle) ||
            row.provincie.toLowerCase().includes(needle)
        )
      : rows;

    const sorted = [...list].sort((a, b) => {
      let result: number;
      if (sortKey === 'gemeente') {
        result = a.gemeente.localeCompare(b.gemeente, 'nl');
      } else if (sortKey === 'total' || sortKey === 'per10k' || sortKey === 'population') {
        result = a[sortKey] - b[sortKey];
      } else {
        result = (a.merken[sortKey] ?? 0) - (b.merken[sortKey] ?? 0);
      }
      return ascending ? result : -result;
    });

    return sorted;
  }, [rows, query, sortKey, ascending]);

  const sortBy = (key: SortKey) => {
    if (key === sortKey) {
      setAscending((v) => !v);
    } else {
      setSortKey(key);
      // Names read best A-Z; counts read best highest-first.
      setAscending(key === 'gemeente');
    }
  };

  const exportCsv = () => {
    const header = ['gemeente', 'slug', 'provincie', 'inwoners', 'totaal', 'per_10k', ...merken];
    const lines = filtered.map((row) =>
      [
        `"${row.gemeente.replace(/"/g, '""')}"`,
        row.slug,
        `"${row.provincie}"`,
        row.population,
        row.total,
        row.per10k,
        ...merken.map((merk) => row.merken[merk] ?? 0),
      ].join(',')
    );

    const blob = new Blob([[header.join(','), ...lines].join('\n')], {
      type: 'text/csv;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'inleverpunten-matrix.csv';
    link.click();
    URL.revokeObjectURL(url);
  };

  if (rows.length === 0) {
    return (
      <div className="rounded-xl border border-border bg-card p-8 text-center">
        <p className="text-sm text-muted-foreground">
          Nog geen statistieken beschikbaar. Draai{' '}
          <code className="rounded bg-muted px-1 py-0.5 text-xs">
            python scripts/compute_statistics.py
          </code>
          .
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col items-start justify-between gap-3 sm:flex-row sm:items-center">
        <div>
          <h2 className="text-lg font-bold text-[var(--green-900)]">
            {grandTotal.toLocaleString('nl-NL')} inleverpunten
          </h2>
          <p className="text-sm text-muted-foreground">
            {rows.length} gemeenten
            {generatedAt &&
              ` · bijgewerkt ${new Date(generatedAt).toLocaleDateString('nl-NL')}`}
          </p>
        </div>
        <div className="flex w-full gap-2 sm:w-auto">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Zoek gemeente of provincie..."
            className="sm:w-64"
          />
          <Button variant="outline" onClick={exportCsv} className="shrink-0">
            <DownloadIcon />
            CSV
          </Button>
        </div>
      </div>

      <div className="overflow-x-auto rounded-xl border border-border bg-card">
        <table className="w-full min-w-[54rem] text-sm">
          <thead className="sticky top-0 border-b border-border bg-secondary text-xs text-muted-foreground">
            <tr>
              <th className="whitespace-nowrap px-3 py-2 text-left font-medium">
                <button
                  type="button"
                  onClick={() => sortBy('gemeente')}
                  className="inline-flex items-center gap-1 hover:text-primary"
                >
                  Gemeente
                  {sortKey === 'gemeente' &&
                    (ascending ? (
                      <ArrowUpIcon className="size-3" />
                    ) : (
                      <ArrowDownIcon className="size-3" />
                    ))}
                </button>
              </th>
              {merken.map((merk) => (
                <SortHeader
                  key={merk}
                  label={MERK_LABELS[merk].split(' ')[0]}
                  sortKey={merk}
                  activeKey={sortKey}
                  ascending={ascending}
                  onSort={sortBy}
                  swatch={MERK_COLORS[merk]}
                />
              ))}
              <SortHeader
                label="Totaal"
                sortKey="total"
                activeKey={sortKey}
                ascending={ascending}
                onSort={sortBy}
                className="font-semibold"
              />
              <SortHeader
                label="Per 10k"
                sortKey="per10k"
                activeKey={sortKey}
                ascending={ascending}
                onSort={sortBy}
              />
            </tr>
          </thead>

          <tbody className="divide-y divide-border">
            <tr className="bg-[var(--green-50)] font-semibold">
              <td className="px-3 py-2">Nederland</td>
              {merken.map((merk) => (
                <td key={merk} className="px-2 py-2 text-right tabular-nums">
                  {(totals[merk] ?? 0).toLocaleString('nl-NL')}
                </td>
              ))}
              <td className="px-2 py-2 text-right tabular-nums">
                {grandTotal.toLocaleString('nl-NL')}
              </td>
              <td className="px-2 py-2 text-right tabular-nums text-muted-foreground">—</td>
            </tr>

            {filtered.map((row) => (
              <tr key={row.slug} className="transition-colors hover:bg-secondary">
                <td className="px-3 py-1.5">
                  <Link
                    href={`/?gemeente=${row.slug}`}
                    className="font-medium hover:text-primary hover:underline"
                  >
                    {row.gemeente}
                  </Link>
                  <span className="ml-1.5 text-xs text-muted-foreground">{row.provincie}</span>
                </td>
                {merken.map((merk) => {
                  const value = row.merken[merk] ?? 0;
                  return (
                    <td
                      key={merk}
                      className={cn(
                        'px-2 py-1.5 text-right tabular-nums',
                        value === 0 && 'text-muted-foreground/50'
                      )}
                    >
                      {value.toLocaleString('nl-NL')}
                    </td>
                  );
                })}
                <td className="px-2 py-1.5 text-right font-semibold tabular-nums">
                  {row.total.toLocaleString('nl-NL')}
                </td>
                <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">
                  {row.per10k.toFixed(1)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {filtered.length === 0 && (
        <p className="py-6 text-center text-sm text-muted-foreground">Geen gemeente gevonden.</p>
      )}
    </div>
  );
}
