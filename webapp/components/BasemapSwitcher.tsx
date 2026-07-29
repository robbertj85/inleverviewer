'use client';

import { useEffect, useRef, useState } from 'react';
import { CheckIcon, LayersIcon } from 'lucide-react';

import { BASEMAPS, getBasemap } from '@/lib/basemaps';
import { cn } from '@/lib/utils';

interface BasemapSwitcherProps {
  value: string;
  onChange: (id: string) => void;
}

/**
 * Background-map picker: a floating button on the map that opens the list.
 *
 * Sits over the map rather than above it — the six names are a secondary
 * control, and a permanent strip cost the map vertical space it uses better.
 *
 * The z-index has to clear Leaflet's panes (400-700) but stay under the
 * nearest-points panel at 1000, and the wrapper stops clicks and scroll
 * wheels from reaching the map underneath.
 */
export default function BasemapSwitcher({ value, onChange }: BasemapSwitcherProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const active = getBasemap(value);

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };

    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div
      ref={containerRef}
      className="absolute left-2.5 top-24 z-[900]"
      // Leaflet listens on the document for drags and wheel events; without
      // this, clicking the control pans the map and scrolling the list zooms it.
      onPointerDown={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        aria-label={`Achtergrondkaart: ${active.label}`}
        aria-expanded={open}
        aria-haspopup="true"
        title="Achtergrondkaart kiezen"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'flex size-10 items-center justify-center rounded-lg border border-border shadow-md transition-colors',
          'outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1',
          open ? 'bg-primary text-primary-foreground' : 'bg-card text-foreground hover:bg-accent'
        )}
      >
        <LayersIcon className="size-5" />
      </button>

      {open && (
        <div
          role="radiogroup"
          aria-label="Achtergrondkaart"
          className="absolute left-full top-0 ml-2 w-52 rounded-lg border border-border bg-popover p-1 shadow-xl"
        >
          {BASEMAPS.map((basemap) => {
            const selected = basemap.id === value;
            return (
              <button
                key={basemap.id}
                type="button"
                role="radio"
                aria-checked={selected}
                title={basemap.title}
                onClick={() => {
                  onChange(basemap.id);
                  setOpen(false);
                }}
                className={cn(
                  'flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-2 text-left text-sm transition-colors',
                  'outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  selected
                    ? 'bg-secondary font-medium text-secondary-foreground'
                    : 'hover:bg-muted'
                )}
              >
                {basemap.label}
                {selected && <CheckIcon className="size-4 shrink-0 text-primary" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
