'use client';

import { Suspense, useEffect, useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import { useSearchParams } from 'next/navigation';

import {
  ALL_CATEGORIEEN,
  ALL_MATERIALEN,
  ALL_MERKEN,
  Filters,
  InleverpuntData,
} from '@/types/inleverpunten';

const MapView = dynamic(() => import('@/components/Map'), {
  ssr: false,
  loading: () => (
    <div className="flex h-full w-full items-center justify-center bg-muted">
      <p className="text-sm text-muted-foreground">Kaart laden...</p>
    </div>
  ),
});

function EmbedContent() {
  const searchParams = useSearchParams();
  const raw = searchParams.get('gemeente') || 'zwolle';
  const gemeente = raw === 'alle-gemeenten' ? 'nederland' : raw;

  // 'idle' until the fetch for the current municipality settles, so the status
  // bar can be derived rather than driven by a flag set inside the effect.
  const [result, setResult] = useState<{
    slug: string;
    data: InleverpuntData | null;
  } | null>(null);

  const loading = result?.slug !== gemeente;
  const failed = !loading && result?.data === null;
  const data = result?.slug === gemeente ? result.data : null;

  // The embed is a read-only view: no filter panel, so everything is on and
  // the coverage rings stay off to keep the picture legible at small sizes.
  const filters = useMemo<Filters>(
    () => ({
      merken: [...ALL_MERKEN],
      materialen: [...ALL_MATERIALEN],
      categorieen: [...ALL_CATEGORIEEN],
      showBuffer300: false,
      showBuffer400: false,
      showBuffer500: false,
      showBufferFill: false,
      bufferMerged: false,
      showBoundary: false,
      useSimpleMarkers: gemeente === 'nederland',
      onlyVrijToegankelijk: false,
      showOnlySharedLocations: false,
    }),
    [gemeente]
  );

  useEffect(() => {
    let cancelled = false;

    fetch(`/data/${gemeente}.geojson`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((payload: InleverpuntData) => {
        if (!cancelled) setResult({ slug: gemeente, data: payload });
      })
      .catch(() => {
        if (!cancelled) setResult({ slug: gemeente, data: null });
      });

    return () => {
      cancelled = true;
    };
  }, [gemeente]);

  const name = data?.metadata?.gemeente ?? gemeente;
  const urlSlug = gemeente === 'nederland' ? 'alle-gemeenten' : gemeente;

  return (
    <div className="relative h-screen w-full">
      <MapView data={data} filters={filters} />

      <div className="absolute inset-x-0 bottom-0 z-[1000] flex items-center justify-between gap-2 border-t border-border bg-card/90 px-3 py-1.5 backdrop-blur-sm">
        <span className="truncate text-[11px] text-muted-foreground">
          {loading
            ? 'Laden...'
            : failed
              ? 'Kon de data voor deze gemeente niet laden'
              : `${name} — ${data?.metadata.total_points.toLocaleString('nl-NL') ?? 0} inleverpunten`}
        </span>
        <a
          href={`/?gemeente=${urlSlug}`}
          target="_blank"
          rel="noopener noreferrer"
          className="shrink-0 text-[11px] font-medium text-primary hover:underline"
        >
          Open in Inleverpuntenviewer
        </a>
      </div>
    </div>
  );
}

export default function EmbedPage() {
  return (
    <Suspense
      fallback={
        <div className="flex h-screen w-full items-center justify-center bg-muted">
          <p className="text-sm text-muted-foreground">Laden...</p>
        </div>
      }
    >
      <EmbedContent />
    </Suspense>
  );
}
