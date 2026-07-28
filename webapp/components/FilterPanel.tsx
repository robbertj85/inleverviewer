'use client';

import { useState } from 'react';
import { ChevronDownIcon, InfoIcon } from 'lucide-react';

import { Checkbox } from '@/components/ui/checkbox';
import {
  ALL_CATEGORIEEN,
  ALL_MATERIALEN,
  ALL_MERKEN,
  CATEGORIE_LABELS,
  Filters,
  MATERIAAL_GROEPEN,
  MATERIAAL_LABELS,
  Materiaal,
  Merk,
  MERK_COLORS,
  MERK_LABELS,
  PuntCategorie,
} from '@/types/inleverpunten';
import { cn } from '@/lib/utils';

interface Props {
  filters: Filters;
  onChange: (filters: Filters) => void;
  availableMerken: Merk[];
  merkCounts: Record<string, number>;
  categorieCounts: Record<string, number>;
  materiaalCounts: Record<string, number>;
  sharedLocationCount: number;
  totalPoints: number;
  isNational: boolean;
  boundariesLoading?: boolean;
  boundaryProgress?: { loaded: number; total: number; percentage: number } | null;
}

function Section({
  title,
  children,
  defaultOpen = true,
  action,
}: {
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
  action?: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="border-b border-border pb-3 last:border-b-0 last:pb-0">
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex flex-1 items-center gap-1.5 py-1.5 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground transition-colors hover:text-foreground"
        >
          <ChevronDownIcon
            className={cn('size-3.5 transition-transform', !open && '-rotate-90')}
          />
          {title}
        </button>
        {action}
      </div>
      {open && <div className="mt-1 space-y-1.5">{children}</div>}
    </div>
  );
}

function ToggleRow({
  checked,
  onCheckedChange,
  label,
  count,
  swatch,
  id,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: string;
  count?: number;
  swatch?: string;
  id: string;
}) {
  return (
    <label
      htmlFor={id}
      className="flex cursor-pointer items-center gap-2 rounded-md px-1 py-1 transition-colors hover:bg-secondary"
    >
      <Checkbox
        id={id}
        checked={checked}
        onCheckedChange={(value) => onCheckedChange(value === true)}
      />
      {swatch && (
        <span
          className="size-2.5 shrink-0 rounded-full"
          style={{ background: swatch }}
          aria-hidden
        />
      )}
      <span className="flex-1 truncate text-sm">{label}</span>
      {count !== undefined && (
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
          {count.toLocaleString('nl-NL')}
        </span>
      )}
    </label>
  );
}

/** Small "alles / geen" control so a 12-item list stays workable. */
function SelectAll({
  onAll,
  onNone,
}: {
  onAll: () => void;
  onNone: () => void;
}) {
  return (
    <span className="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
      <button type="button" onClick={onAll} className="hover:text-primary hover:underline">
        alles
      </button>
      <span aria-hidden>·</span>
      <button type="button" onClick={onNone} className="hover:text-primary hover:underline">
        geen
      </button>
    </span>
  );
}

export default function FilterPanel({
  filters,
  onChange,
  availableMerken,
  merkCounts,
  categorieCounts,
  materiaalCounts,
  sharedLocationCount,
  totalPoints,
  isNational,
  boundariesLoading,
  boundaryProgress,
}: Props) {
  const set = (patch: Partial<Filters>) => onChange({ ...filters, ...patch });

  const toggle = <T,>(list: T[], value: T): T[] =>
    list.includes(value) ? list.filter((v) => v !== value) : [...list, value];

  const merken = ALL_MERKEN.filter((m) => availableMerken.includes(m));

  return (
    <div className="space-y-3 rounded-xl border border-border bg-card p-3 shadow-sm">
      <Section
        title="Bron"
        action={
          <SelectAll
            onAll={() => set({ merken: [...merken] })}
            onNone={() => set({ merken: [] })}
          />
        }
      >
        {merken.map((merk) => (
          <ToggleRow
            key={merk}
            id={`merk-${merk}`}
            checked={filters.merken.includes(merk)}
            onCheckedChange={() => set({ merken: toggle(filters.merken, merk) })}
            label={MERK_LABELS[merk]}
            count={merkCounts[merk] ?? 0}
            swatch={MERK_COLORS[merk]}
          />
        ))}
        {merken.length === 0 && (
          <p className="px-1 text-xs text-muted-foreground">Geen bronnen in deze gemeente.</p>
        )}
      </Section>

      <Section
        title="Wat kun je inleveren"
        action={
          <SelectAll
            onAll={() => set({ materialen: [...ALL_MATERIALEN] })}
            onNone={() => set({ materialen: [] })}
          />
        }
      >
        {MATERIAAL_GROEPEN.map((group) => {
          const groupTotal = group.materialen.reduce(
            (sum, m) => sum + (materiaalCounts[m] ?? 0),
            0
          );
          if (groupTotal === 0) return null;

          return (
            <div key={group.label} className="pt-0.5">
              <p className="px-1 pb-0.5 text-[11px] font-medium text-muted-foreground">
                {group.label}
              </p>
              {group.materialen.map((materiaal: Materiaal) => {
                const count = materiaalCounts[materiaal] ?? 0;
                if (count === 0) return null;
                return (
                  <ToggleRow
                    key={materiaal}
                    id={`mat-${materiaal}`}
                    checked={filters.materialen.includes(materiaal)}
                    onCheckedChange={() =>
                      set({ materialen: toggle(filters.materialen, materiaal) })
                    }
                    label={MATERIAAL_LABELS[materiaal]}
                    count={count}
                  />
                );
              })}
            </div>
          );
        })}
      </Section>

      <Section title="Type inleverpunt">
        {ALL_CATEGORIEEN.map((categorie: PuntCategorie) => (
          <ToggleRow
            key={categorie}
            id={`cat-${categorie}`}
            checked={filters.categorieen.includes(categorie)}
            onCheckedChange={() =>
              set({ categorieen: toggle(filters.categorieen, categorie) })
            }
            label={CATEGORIE_LABELS[categorie]}
            count={categorieCounts[categorie] ?? 0}
          />
        ))}
      </Section>

      <Section title="Dekking" defaultOpen={false}>
        <ToggleRow
          id="buffer-300"
          checked={filters.showBuffer300}
          onCheckedChange={(v) => set({ showBuffer300: v })}
          label="300 meter"
          swatch="var(--green-700)"
        />
        <ToggleRow
          id="buffer-400"
          checked={filters.showBuffer400}
          onCheckedChange={(v) => set({ showBuffer400: v })}
          label="400 meter"
          swatch="var(--green-500)"
        />
        <ToggleRow
          id="buffer-500"
          checked={filters.showBuffer500}
          onCheckedChange={(v) => set({ showBuffer500: v })}
          label="500 meter"
          swatch="var(--green-400)"
        />
        <ToggleRow
          id="buffer-merged"
          checked={filters.bufferMerged}
          onCheckedChange={(v) => set({ bufferMerged: v })}
          label="Samengevoegd gebied"
        />
        <ToggleRow
          id="buffer-fill"
          checked={filters.showBufferFill}
          onCheckedChange={(v) => set({ showBufferFill: v })}
          label="Gebied inkleuren"
        />

        {totalPoints > 3000 && filters.bufferMerged && (
          <p className="mt-1 flex items-start gap-1.5 rounded-md bg-amber-50 px-2 py-1.5 text-[11px] text-amber-900">
            <InfoIcon className="mt-px size-3.5 shrink-0" />
            Bij meer dan 3.000 punten wordt het samengevoegde gebied niet berekend.
            Zet &lsquo;samengevoegd&rsquo; uit of filter verder.
          </p>
        )}
      </Section>

      <Section title="Weergave" defaultOpen={false}>
        <ToggleRow
          id="boundary"
          checked={filters.showBoundary}
          onCheckedChange={(v) => set({ showBoundary: v })}
          label={isNational ? 'Gemeentegrenzen' : 'Gemeentegrens'}
        />
        {boundariesLoading && (
          <div className="px-1 pb-1">
            <p className="text-[11px] text-muted-foreground">
              Grenzen laden: {boundaryProgress?.loaded ?? 0}/{boundaryProgress?.total ?? 12} provincies
            </p>
            <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-muted">
              <div
                className="h-full bg-primary transition-all"
                style={{ width: `${boundaryProgress?.percentage ?? 0}%` }}
              />
            </div>
          </div>
        )}
        <ToggleRow
          id="simple-markers"
          checked={filters.useSimpleMarkers}
          onCheckedChange={(v) => set({ useSimpleMarkers: v })}
          label="Snelle weergave (stippen)"
        />
        <ToggleRow
          id="vrij-toegankelijk"
          checked={filters.onlyVrijToegankelijk}
          onCheckedChange={(v) => set({ onlyVrijToegankelijk: v })}
          label="Alleen vrij toegankelijk"
        />
        <ToggleRow
          id="shared"
          checked={filters.showOnlySharedLocations}
          onCheckedChange={(v) => set({ showOnlySharedLocations: v })}
          label="Alleen gedeelde locaties"
          count={sharedLocationCount}
        />
      </Section>
    </div>
  );
}
