'use client';

import { useMemo, useState } from 'react';
import { ArrowDownIcon, ArrowUpIcon, DownloadIcon, InfoIcon } from 'lucide-react';

import { cn } from '@/lib/utils';

/** A row of mutually exclusive choices. Wraps rather than scrolls, so a long
 * subset list stays fully visible on a phone instead of hiding options. */
export function SegControl<T extends string>({
  options,
  value,
  onChange,
  label,
  size = 'md',
}: {
  options: { value: T; label: string; title?: string }[];
  value: T;
  onChange: (value: T) => void;
  label?: string;
  size?: 'sm' | 'md';
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      {label && (
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          {label}
        </span>
      )}
      <div className="flex flex-wrap gap-1 rounded-lg bg-muted p-1">
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            title={option.title}
            aria-pressed={value === option.value}
            onClick={() => onChange(option.value)}
            className={cn(
              'rounded-md font-medium transition-colors',
              size === 'sm' ? 'px-2 py-1 text-xs' : 'min-h-9 px-3 py-1.5 text-sm',
              value === option.value
                ? 'bg-card text-[var(--green-900)] shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            )}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Horizontal meter for a percentage. The number is always shown next to it —
 * the bar is the comparison aid, not the value. */
export function PctBar({ pct, tone }: { pct: number; tone?: string }) {
  return (
    <div className="flex items-center gap-2">
      <div className="h-2 w-16 shrink-0 overflow-hidden rounded-full bg-muted sm:w-24">
        <div
          className="h-full rounded-full"
          style={{
            width: `${Math.max(0, Math.min(100, pct))}%`,
            background: tone ?? 'var(--green-500)',
          }}
        />
      </div>
      <span className="tabular-nums">
        {pct.toLocaleString('nl-NL', {
          minimumFractionDigits: 1,
          maximumFractionDigits: 1,
        })}
        %
      </span>
    </div>
  );
}

export type SortDir = 'asc' | 'desc';

export function compareValues(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (a == null) return b == null ? 0 : -1;
  if (b == null) return 1;
  return String(a).localeCompare(String(b), 'nl');
}

export function SortHeader<K extends string>({
  label,
  sortKey,
  activeKey,
  dir,
  onToggle,
  align = 'left',
  title,
}: {
  label: string;
  sortKey: K;
  activeKey: K;
  dir: SortDir;
  onToggle: (key: K) => void;
  align?: 'left' | 'right';
  title?: string;
}) {
  const active = activeKey === sortKey;
  return (
    // aria-sort belongs on the header cell, not on the button inside it — the
    // implicit `button` role does not support it and screen readers drop it.
    <th
      scope="col"
      aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}
      className={cn(
        'whitespace-nowrap px-2 py-2 font-semibold',
        align === 'right' ? 'text-right' : 'text-left'
      )}
    >
      <button
        type="button"
        title={title}
        onClick={() => onToggle(sortKey)}
        className={cn(
          'inline-flex items-center gap-1 hover:text-[var(--green-800)]',
          active ? 'text-[var(--green-900)]' : 'text-muted-foreground'
        )}
      >
        {label}
        {active &&
          (dir === 'asc' ? (
            <ArrowUpIcon className="size-3" />
          ) : (
            <ArrowDownIcon className="size-3" />
          ))}
      </button>
    </th>
  );
}

/** Sorting state plus a comparator, shared by every table in these tabs. */
export function useSort<K extends string>(initialKey: K, initialDir: SortDir = 'desc') {
  const [key, setKey] = useState<K>(initialKey);
  const [dir, setDir] = useState<SortDir>(initialDir);
  const toggle = (next: K) => {
    if (next === key) {
      setDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setKey(next);
      // Numbers are almost always more interesting large-first; names are not.
      setDir('desc');
    }
  };
  return { key, dir, toggle, setKey, setDir };
}

function csvCell(value: unknown): string {
  if (value == null) return '';
  const text = String(value);
  return /[",;\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Semicolon-separated, BOM-prefixed — what Dutch Excel opens without a wizard. */
export function downloadCsv(
  filename: string,
  rows: (string | number | null | undefined)[][]
) {
  const body = rows.map((row) => row.map(csvCell).join(';')).join('\n');
  const blob = new Blob([`﻿${body}`], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export function CsvButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex min-h-9 items-center gap-1.5 rounded-md border border-border bg-card px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:border-[var(--green-300)] hover:text-[var(--green-800)]"
    >
      <DownloadIcon className="size-3.5" />
      {label}
    </button>
  );
}

/** A collapsible methodology block. Every modelled tab needs one, and burying
 * it behind a toggle keeps it out of the way without hiding it. */
export function MethodologyNote({
  title = 'Hoe is dit berekend?',
  children,
}: {
  title?: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-lg border border-border bg-card">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex min-h-11 w-full items-center gap-2 px-4 text-left text-sm font-medium text-[var(--green-900)]"
      >
        <InfoIcon className="size-4 shrink-0 text-[var(--green-600)]" />
        {title}
        <span className="ml-auto text-xs text-muted-foreground">
          {open ? 'verbergen' : 'tonen'}
        </span>
      </button>
      {open && (
        <div className="space-y-2 border-t border-border px-4 py-3 text-sm text-muted-foreground">
          {children}
        </div>
      )}
    </div>
  );
}

/** Amber notice for the beta tabs — these are models, not measurements. */
export function BetaNotice({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
      {children}
    </div>
  );
}

export function StatTile({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div
        className="mt-0.5 text-xl font-bold tabular-nums"
        style={{ color: tone ?? 'var(--green-900)' }}
      >
        {value}
      </div>
      {hint && <div className="mt-0.5 text-xs text-muted-foreground">{hint}</div>}
    </div>
  );
}

/** Filter a municipality list to a cohort. G4 and the next tier cover most
 * "how do the big cities compare" questions without a manual multi-select. */
export type Cohort = 'alle' | 'g4' | 'g40' | 'overig';

export const G4_NAMES = new Set([
  'Amsterdam',
  'Rotterdam',
  "'s-Gravenhage",
  'Utrecht',
]);

export const G40_NAMES = new Set([
  'Alkmaar', 'Almelo', 'Almere', 'Alphen aan den Rijn', 'Amersfoort', 'Apeldoorn',
  'Arnhem', 'Assen', 'Breda', 'Delft', 'Deventer', 'Dordrecht', 'Ede', 'Eindhoven',
  'Emmen', 'Enschede', 'Gouda', 'Groningen', 'Haarlem', 'Haarlemmermeer',
  'Heerlen', 'Helmond', 'Hengelo', 'Hengelo (O)', 'Hilversum', "'s-Hertogenbosch",
  'Leeuwarden', 'Leiden', 'Lelystad', 'Maastricht', 'Nijmegen', 'Oss', 'Roosendaal',
  'Schiedam', 'Sittard-Geleen', 'Tilburg', 'Venlo', 'Vlaardingen', 'Zaanstad',
  'Zoetermeer', 'Zwolle',
]);

export const COHORT_LABELS: Record<Cohort, string> = {
  alle: 'Alle',
  g4: 'G4',
  g40: 'G40',
  overig: 'Overig',
};

export function inCohort(name: string, cohort: Cohort): boolean {
  switch (cohort) {
    case 'g4':
      return G4_NAMES.has(name);
    case 'g40':
      return G40_NAMES.has(name);
    case 'overig':
      return !G4_NAMES.has(name) && !G40_NAMES.has(name);
    default:
      return true;
  }
}

/** Client-side pagination for the long PC4 table. */
export function usePaged<T>(items: T[], pageSize: number) {
  const [page, setPage] = useState(0);
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
  const clamped = Math.min(page, pageCount - 1);
  const slice = useMemo(
    () => items.slice(clamped * pageSize, (clamped + 1) * pageSize),
    [items, clamped, pageSize]
  );
  return { page: clamped, pageCount, slice, setPage };
}

export function Pager({
  page,
  pageCount,
  onChange,
  total,
}: {
  page: number;
  pageCount: number;
  onChange: (page: number) => void;
  total: number;
}) {
  if (pageCount <= 1) return null;
  return (
    <div className="flex items-center justify-between gap-2 border-t border-border px-3 py-2 text-xs text-muted-foreground">
      <span>
        {total.toLocaleString('nl-NL')} rijen · pagina {page + 1} van {pageCount}
      </span>
      <div className="flex gap-1">
        <button
          type="button"
          disabled={page === 0}
          onClick={() => onChange(page - 1)}
          className="min-h-8 rounded border border-border px-2 disabled:opacity-40"
        >
          Vorige
        </button>
        <button
          type="button"
          disabled={page >= pageCount - 1}
          onClick={() => onChange(page + 1)}
          className="min-h-8 rounded border border-border px-2 disabled:opacity-40"
        >
          Volgende
        </button>
      </div>
    </div>
  );
}
