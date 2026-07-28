'use client';

import { useEffect, useRef, useState } from 'react';
import { Loader2Icon, MapPinIcon, SearchIcon, XIcon } from 'lucide-react';

import { Municipality } from '@/types/inleverpunten';
import { cn } from '@/lib/utils';

interface GeocodeResult {
  display_name: string;
  lat: string;
  lon: string;
  address?: {
    municipality?: string;
    city?: string;
    town?: string;
    village?: string;
    county?: string;
  };
}

interface Props {
  municipalities: Municipality[];
  onAddressSelected: (
    municipalitySlug: string,
    coordinates: { latitude: number; longitude: number },
    displayName: string
  ) => void;
}

/** Match a Nominatim result to one of our municipality slugs. */
function resolveMunicipality(
  result: GeocodeResult,
  municipalities: Municipality[]
): string | null {
  const address = result.address ?? {};
  const candidates = [
    address.municipality,
    address.city,
    address.town,
    address.village,
    address.county,
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    const needle = candidate.toLowerCase();
    const match = municipalities.find((m) => m.name.toLowerCase() === needle);
    if (match) return match.slug;
  }

  // Fall back to a loose contains-match; Nominatim sometimes returns a
  // neighbourhood where we expect a municipality.
  for (const candidate of candidates) {
    const needle = candidate.toLowerCase();
    const match = municipalities.find(
      (m) => m.name.toLowerCase().includes(needle) || needle.includes(m.name.toLowerCase())
    );
    if (match) return match.slug;
  }

  return null;
}

export default function AddressSearchInput({ municipalities, onAddressSelected }: Props) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<GeocodeResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, []);

  // Debounced search. Nominatim asks for at most one request per second, so we
  // wait for a pause in typing and cancel any request still in flight.
  useEffect(() => {
    const needle = query.trim();
    // Too short to search. Nothing to clear — `visibleResults` below derives
    // emptiness from the query, so stale hits cannot leak through.
    if (needle.length < 3) return;

    const timer = setTimeout(async () => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setLoading(true);
      setError(null);
      try {
        const response = await fetch(`/api/geocode?q=${encodeURIComponent(needle)}`, {
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data: GeocodeResult[] = await response.json();
        setResults(data);
        setOpen(true);
      } catch (err) {
        if ((err as Error).name !== 'AbortError') {
          setError('Zoeken mislukt. Probeer het opnieuw.');
          setResults([]);
        }
      } finally {
        setLoading(false);
      }
    }, 500);

    return () => clearTimeout(timer);
  }, [query]);

  // Only surface results once the query is long enough to have produced them.
  const searchable = query.trim().length >= 3;
  const visibleResults = searchable ? results : [];
  const visibleError = searchable ? error : null;

  const select = (result: GeocodeResult) => {
    const slug = resolveMunicipality(result, municipalities);
    if (!slug) {
      setError('Kon dit adres niet aan een gemeente koppelen.');
      return;
    }

    onAddressSelected(
      slug,
      { latitude: parseFloat(result.lat), longitude: parseFloat(result.lon) },
      result.display_name
    );
    setOpen(false);
    setQuery(result.display_name.split(',').slice(0, 2).join(',').trim());
  };

  return (
    <div ref={containerRef} className="relative">
      <div className="flex h-9 items-center gap-2 rounded-lg border border-input bg-background px-3 shadow-xs focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/40">
        <SearchIcon className="size-4 shrink-0 text-muted-foreground" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => visibleResults.length > 0 && setOpen(true)}
          placeholder="Zoek een adres of postcode..."
          className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        />
        {loading && <Loader2Icon className="size-4 shrink-0 animate-spin text-muted-foreground" />}
        {!loading && query && (
          <button
            type="button"
            onClick={() => {
              setQuery('');
              setResults([]);
              setOpen(false);
            }}
            aria-label="Zoekopdracht wissen"
            className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
          >
            <XIcon className="size-4" />
          </button>
        )}
      </div>

      {open && (visibleResults.length > 0 || visibleError) && (
        <div className="absolute left-0 top-[calc(100%+4px)] z-[1100] w-full min-w-[18rem] overflow-hidden rounded-lg border border-border bg-popover shadow-lg">
          {visibleError && (
            <p className="px-3 py-2.5 text-sm text-destructive">{visibleError}</p>
          )}
          <ul className="max-h-72 overflow-y-auto py-1">
            {visibleResults.map((result, index) => (
              <li key={`${result.lat}-${result.lon}-${index}`}>
                <button
                  type="button"
                  onClick={() => select(result)}
                  className={cn(
                    'flex w-full items-start gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-secondary'
                  )}
                >
                  <MapPinIcon className="mt-0.5 size-4 shrink-0 text-primary" />
                  <span className="line-clamp-2">{result.display_name}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
