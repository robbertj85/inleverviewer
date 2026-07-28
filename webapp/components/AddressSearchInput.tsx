'use client';

import { useEffect, useRef, useState } from 'react';
import { Loader2Icon, MapPinIcon, SearchIcon, XIcon } from 'lucide-react';

import { Municipality } from '@/types/inleverpunten';
import { cn } from '@/lib/utils';

interface Suggestion {
  id: string;
  displayName: string;
  type: string;
}

interface LookupResult {
  displayName: string;
  municipality: string | null;
  coordinates: { latitude: number; longitude: number } | null;
}

interface Props {
  municipalities: Municipality[];
  onAddressSelected: (
    municipalitySlug: string,
    coordinates: { latitude: number; longitude: number },
    displayName: string
  ) => void;
}

/**
 * Match PDOK's `gemeentenaam` to one of our slugs.
 *
 * Both sides come from the same register, so this is an exact comparison by
 * design — no normalisation, no contains-matching. If it ever stops matching,
 * the two datasets have drifted, and that is worth surfacing rather than
 * papering over with a fuzzy fallback that silently picks the wrong gemeente.
 */
function resolveMunicipality(
  gemeentenaam: string | null,
  municipalities: Municipality[]
): string | null {
  if (!gemeentenaam) return null;
  const needle = gemeentenaam.trim().toLowerCase();
  return municipalities.find((m) => m.name.trim().toLowerCase() === needle)?.slug ?? null;
}

export default function AddressSearchInput({ municipalities, onAddressSelected }: Props) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Suggestion[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(-1);
  const containerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const suggestAbortRef = useRef<AbortController | null>(null);
  const lookupAbortRef = useRef<AbortController | null>(null);
  // Set when a suggestion is chosen, so the resulting setQuery does not
  // immediately fire a fresh search for the text we just filled in.
  const suppressSearchRef = useRef(false);

  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, []);

  // Debounced autocomplete. Any request still in flight is aborted, so a slow
  // response for "amst" can never overwrite the results for "amsterdam".
  useEffect(() => {
    if (suppressSearchRef.current) {
      suppressSearchRef.current = false;
      return;
    }

    const needle = query.trim();
    if (needle.length < 3) return;

    const timer = setTimeout(async () => {
      suggestAbortRef.current?.abort();
      const controller = new AbortController();
      suggestAbortRef.current = controller;

      setLoading(true);
      setError(null);
      try {
        const response = await fetch(`/api/geocode?q=${encodeURIComponent(needle)}`, {
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        setResults(data.results ?? []);
        setActiveIndex(-1);
        setOpen(true);
      } catch (err) {
        if ((err as Error).name !== 'AbortError') {
          setError('Zoeken mislukt. Probeer het opnieuw.');
          setResults([]);
        }
      } finally {
        setLoading(false);
      }
    }, 300);

    return () => clearTimeout(timer);
  }, [query]);

  // Keep the highlighted option in view during keyboard navigation.
  useEffect(() => {
    if (activeIndex < 0) return;
    const active = listRef.current?.children[activeIndex] as HTMLElement | undefined;
    active?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  // Only surface results once the query is long enough to have produced them.
  const searchable = query.trim().length >= 3;
  const visibleResults = searchable ? results : [];
  const visibleError = searchable ? error : null;

  const select = async (suggestion: Suggestion) => {
    lookupAbortRef.current?.abort();
    const controller = new AbortController();
    lookupAbortRef.current = controller;

    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/geocode?id=${encodeURIComponent(suggestion.id)}`, {
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data: LookupResult = await response.json();

      if (!data.coordinates) {
        setError('Dit resultaat heeft geen coördinaten.');
        return;
      }

      const slug = resolveMunicipality(data.municipality, municipalities);
      if (!slug) {
        setError(
          data.municipality
            ? `Gemeente ${data.municipality} zit niet in de dataset.`
            : 'Kon dit adres niet aan een gemeente koppelen.'
        );
        return;
      }

      suppressSearchRef.current = true;
      setQuery(data.displayName);
      setOpen(false);
      setResults([]);
      onAddressSelected(slug, data.coordinates, data.displayName);
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        setError('Adres ophalen mislukt. Probeer het opnieuw.');
      }
    } finally {
      setLoading(false);
    }
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (!open || visibleResults.length === 0) return;

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, visibleResults.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, -1));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const choice = visibleResults[activeIndex] ?? visibleResults[0];
      if (choice) void select(choice);
    } else if (event.key === 'Escape') {
      setOpen(false);
    }
  };

  return (
    <div ref={containerRef} className="relative">
      <div className="flex h-9 items-center gap-2 rounded-lg border border-input bg-background px-3 shadow-xs focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/40">
        <SearchIcon className="size-4 shrink-0 text-muted-foreground" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => visibleResults.length > 0 && setOpen(true)}
          onKeyDown={onKeyDown}
          placeholder="Zoek een adres of postcode..."
          autoComplete="off"
          role="combobox"
          aria-expanded={open}
          aria-autocomplete="list"
          aria-controls="adres-listbox"
          aria-activedescendant={activeIndex >= 0 ? `adres-optie-${activeIndex}` : undefined}
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
              setError(null);
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
          <ul
            ref={listRef}
            id="adres-listbox"
            role="listbox"
            className="max-h-72 overflow-y-auto py-1"
          >
            {visibleResults.map((result, index) => (
              <li key={result.id}>
                <button
                  type="button"
                  id={`adres-optie-${index}`}
                  role="option"
                  aria-selected={index === activeIndex}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => void select(result)}
                  className={cn(
                    'flex w-full items-start gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-secondary',
                    index === activeIndex && 'bg-secondary'
                  )}
                >
                  <MapPinIcon className="mt-0.5 size-4 shrink-0 text-primary" />
                  <span className="line-clamp-2">{result.displayName}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
