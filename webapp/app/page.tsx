'use client';

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import {
  CodeIcon,
  DownloadIcon,
  FilterIcon,
  InfoIcon,
  MenuIcon,
  NavigationIcon,
  Share2Icon,
  XIcon,
} from 'lucide-react';

import AboutModal from '@/components/AboutModal';
import AddressSearchInput from '@/components/AddressSearchInput';
import BasemapSwitcher from '@/components/BasemapSwitcher';
import FilterPanel from '@/components/FilterPanel';
import MunicipalitySelector from '@/components/MunicipalitySelector';
import NearestPointsFinder from '@/components/NearestPointsFinder';
import ShareModal from '@/components/ShareModal';
import StatsPanel from '@/components/StatsPanel';
import { Button } from '@/components/ui/button';
import {
  ALL_CATEGORIEEN,
  ALL_MATERIALEN,
  ALL_MERKEN,
  Filters,
  InleverpuntData,
  InleverpuntFeature,
  InleverpuntProperties,
  Merk,
  Municipality,
  isInleverpunt,
} from '@/types/inleverpunten';
import { BoundaryLoadProgress, loadProvincialBoundaries } from '@/utils/boundaryLoader';
import {
  getBasemapSnapshot,
  getServerBasemapSnapshot,
  setStoredBasemap,
  subscribeBasemap,
} from '@/lib/basemapStore';
import { cn } from '@/lib/utils';

const MapView = dynamic(() => import('@/components/Map'), {
  ssr: false,
  loading: () => (
    <div className="flex h-full w-full items-center justify-center bg-muted">
      <p className="text-sm text-muted-foreground">Kaart laden...</p>
    </div>
  ),
});

const DEFAULT_MUNICIPALITY = 'zwolle';

function defaultFilters(isNational: boolean, merken: Merk[]): Filters {
  return {
    merken: merken.length > 0 ? merken : [...ALL_MERKEN],
    materialen: [...ALL_MATERIALEN],
    categorieen: [...ALL_CATEGORIEEN],
    // Coverage rings start off nationally: 33.000 points would paint the
    // country solid green, and the merge is skipped above the threshold anyway.
    showBuffer300: !isNational,
    showBuffer400: false,
    showBuffer500: false,
    showBufferFill: false,
    bufferMerged: true,
    showBoundary: false,
    useSimpleMarkers: isNational,
    onlyVrijToegankelijk: false,
    showOnlySharedLocations: false,
  };
}

export default function Home() {
  const [municipalities, setMunicipalities] = useState<Municipality[]>([]);
  const [selected, setSelected] = useState('');
  const [data, setData] = useState<InleverpuntData | null>(null);
  // Which slug the loaded data belongs to. Deriving `loading` from this rather
  // than flipping a flag inside the effect avoids a cascading re-render on
  // every municipality change.
  const [loadedSlug, setLoadedSlug] = useState<string | null>(null);
  const [tilesLoading, setTilesLoading] = useState(false);
  const loading = selected !== '' && loadedSlug !== selected;

  const basemapId = useSyncExternalStore(
    subscribeBasemap,
    getBasemapSnapshot,
    getServerBasemapSnapshot
  );

  const [showAbout, setShowAbout] = useState(false);
  const [showShare, setShowShare] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [nearestOpen, setNearestOpen] = useState(false);

  const [targetCoordinates, setTargetCoordinates] = useState<{
    latitude: number;
    longitude: number;
  } | null>(null);
  const [searchLocationMarker, setSearchLocationMarker] = useState<{
    latitude: number;
    longitude: number;
  } | null>(null);
  const [highlightedPoints, setHighlightedPoints] = useState<Set<string> | null>(null);
  const [lastAddressSearch, setLastAddressSearch] = useState<{
    coordinates: { latitude: number; longitude: number };
    displayName: string;
  } | null>(null);

  const [boundariesLoaded, setBoundariesLoaded] = useState(false);
  const [boundariesLoading, setBoundariesLoading] = useState(false);
  const [boundaryProgress, setBoundaryProgress] = useState<BoundaryLoadProgress | null>(null);

  const [filters, setFilters] = useState<Filters>(() => defaultFilters(false, []));
  const isNational = selected === 'nederland';

  // ---- Load the municipality index -------------------------------------
  useEffect(() => {
    fetch('/municipalities.json')
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((list: Municipality[]) => {
        // Nederland sorts last: it is a roll-up, not a municipality.
        const sorted = [...list].sort((a, b) => {
          if (a.slug === 'nederland') return 1;
          if (b.slug === 'nederland') return -1;
          return a.name.localeCompare(b.name, 'nl');
        });
        setMunicipalities(sorted);

        const params = new URLSearchParams(window.location.search);
        const raw = params.get('gemeente');
        const fromUrl = raw === 'alle-gemeenten' ? 'nederland' : raw;
        const remembered = localStorage.getItem('lastSelectedMunicipality');

        if (fromUrl && sorted.some((m) => m.slug === fromUrl)) {
          setSelected(fromUrl);
        } else if (remembered && sorted.some((m) => m.slug === remembered)) {
          setSelected(remembered);
        } else if (sorted.some((m) => m.slug === DEFAULT_MUNICIPALITY)) {
          setSelected(DEFAULT_MUNICIPALITY);
        } else if (sorted.length > 0) {
          setSelected(sorted[0].slug);
        }
      })
      .catch((error) => console.error('Kon gemeentelijst niet laden:', error));
  }, []);

  // ---- Keep the URL and localStorage in step ---------------------------
  useEffect(() => {
    if (!selected || municipalities.length === 0) return;

    localStorage.setItem('lastSelectedMunicipality', selected);
    const url = new URL(window.location.href);
    url.searchParams.set('gemeente', selected === 'nederland' ? 'alle-gemeenten' : selected);
    window.history.replaceState({}, '', url.toString());
  }, [selected, municipalities]);

  // ---- Load the selected municipality ----------------------------------
  useEffect(() => {
    if (!selected) return;

    let cancelled = false;

    fetch(`/data/${selected}.geojson`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((payload: InleverpuntData) => {
        if (cancelled) return;
        setData(payload);
        setBoundariesLoaded(false);
        setFilters(defaultFilters(selected === 'nederland', payload.metadata.merken ?? []));
        setLoadedSlug(selected);
      })
      .catch((error) => {
        if (cancelled) return;
        console.error(`Kon data voor '${selected}' niet laden:`, error);
        // Mark it loaded anyway, so the spinner does not run forever on a
        // municipality whose file is missing.
        setLoadedSlug(selected);
      });

    return () => {
      cancelled = true;
    };
  }, [selected]);

  /**
   * Fetch the 342 municipal outlines for the national view.
   *
   * Driven by the checkbox rather than an effect: the twelve provincial files
   * are a deliberate, user-initiated download, and tying it to the click keeps
   * it out of the render cycle.
   */
  const handleFiltersChange = useCallback(
    (next: Filters) => {
      setFilters(next);

      const shouldLoad =
        next.showBoundary &&
        selected === 'nederland' &&
        !boundariesLoaded &&
        !boundariesLoading;

      if (!shouldLoad) return;

      setBoundariesLoading(true);
      setBoundaryProgress(null);

      loadProvincialBoundaries(setBoundaryProgress)
        .then((loaded) => {
          setData((current) =>
            current
              ? { ...current, features: [...current.features, ...loaded.features] }
              : current
          );
          setBoundariesLoaded(true);
        })
        .catch((error) => console.error('Kon gemeentegrenzen niet laden:', error))
        .finally(() => {
          setBoundariesLoading(false);
          setBoundaryProgress(null);
        });
    },
    [selected, boundariesLoaded, boundariesLoading]
  );

  // ---- Derived counts --------------------------------------------------
  const allPoints = useMemo(() => {
    if (!data) return [] as InleverpuntFeature[];
    return data.features.filter((f) => isInleverpunt(f.properties));
  }, [data]);

  /**
   * Counts shown next to each filter option.
   *
   * Each dimension is counted with the *other* dimensions applied but not its
   * own, so a checkbox always shows how many points ticking it would add back
   * rather than collapsing to zero the moment you untick it.
   */
  const { merkCounts, categorieCounts, materiaalCounts, visibleCount, sharedLocationCount } =
    useMemo(() => {
      const merk: Record<string, number> = {};
      const categorie: Record<string, number> = {};
      const materiaal: Record<string, number> = {};
      let visible = 0;

      const matchesMerk = (p: InleverpuntProperties) => filters.merken.includes(p.merk);
      const matchesCategorie = (p: InleverpuntProperties) =>
        filters.categorieen.includes(p.puntType);
      const matchesMateriaal = (p: InleverpuntProperties) =>
        (p.materialen ?? []).some((m) => filters.materialen.includes(m));
      const matchesAccess = (p: InleverpuntProperties) =>
        !filters.onlyVrijToegankelijk || p.vrijToegankelijk;

      const visibleFeatures: InleverpuntFeature[] = [];

      for (const feature of allPoints) {
        const props = feature.properties as InleverpuntProperties;

        if (matchesCategorie(props) && matchesMateriaal(props) && matchesAccess(props)) {
          merk[props.merk] = (merk[props.merk] ?? 0) + 1;
        }
        if (matchesMerk(props) && matchesMateriaal(props) && matchesAccess(props)) {
          categorie[props.puntType] = (categorie[props.puntType] ?? 0) + 1;
        }
        if (matchesMerk(props) && matchesCategorie(props) && matchesAccess(props)) {
          for (const m of props.materialen ?? []) {
            materiaal[m] = (materiaal[m] ?? 0) + 1;
          }
        }

        if (
          matchesMerk(props) &&
          matchesCategorie(props) &&
          matchesMateriaal(props) &&
          matchesAccess(props)
        ) {
          visible += 1;
          visibleFeatures.push(feature);
        }
      }

      // Shared locations: two or more distinct brands at the same coordinate.
      const brandsAt = new Map<string, Set<Merk>>();
      const sizeAt = new Map<string, number>();
      for (const feature of visibleFeatures) {
        const [lon, lat] = feature.geometry.coordinates as [number, number];
        const key = `${lat.toFixed(5)},${lon.toFixed(5)}`;
        const brands = brandsAt.get(key) ?? new Set<Merk>();
        brands.add((feature.properties as InleverpuntProperties).merk);
        brandsAt.set(key, brands);
        sizeAt.set(key, (sizeAt.get(key) ?? 0) + 1);
      }

      let shared = 0;
      brandsAt.forEach((brands, key) => {
        if (brands.size >= 2) shared += sizeAt.get(key) ?? 0;
      });

      return {
        merkCounts: merk,
        categorieCounts: categorie,
        materiaalCounts: materiaal,
        visibleCount: visible,
        sharedLocationCount: shared,
      };
    }, [allPoints, filters]);

  // ---- Handlers --------------------------------------------------------
  const handleAddressSelected = useCallback(
    (slug: string, coordinates: { latitude: number; longitude: number }, displayName: string) => {
      setNearestOpen(false);
      setHighlightedPoints(null);
      setSearchLocationMarker(coordinates);
      setLastAddressSearch({ coordinates, displayName });
      setTargetCoordinates(coordinates);
      setSelected(slug);
    },
    []
  );

  const handleMunicipalityChange = useCallback((slug: string) => {
    setNearestOpen(false);
    setSearchLocationMarker(null);
    setHighlightedPoints(null);
    setLastAddressSearch(null);
    setTargetCoordinates(null);
    setSelected(slug);
    setMobileSidebarOpen(false);
  }, []);

  const clearTarget = useCallback(() => setTargetCoordinates(null), []);

  // Close overlays on Escape.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setMobileMenuOpen(false);
      setMobileSidebarOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  const selectedName = municipalities.find((m) => m.slug === selected)?.name ?? selected;

  const navLinks = (
    <>
      <Button variant="subtle" size="sm" asChild>
        <Link href="/data-export">
          <DownloadIcon />
          Data
        </Link>
      </Button>
      <Button variant="subtle" size="sm" asChild>
        <Link href="/api/v1/docs" target="_blank" rel="noopener noreferrer">
          <CodeIcon />
          API
        </Link>
      </Button>
      <Button variant="subtle" size="sm" onClick={() => setShowShare(true)}>
        <Share2Icon />
        Delen
      </Button>
      <Button variant="subtle" size="sm" onClick={() => setShowAbout(true)}>
        <InfoIcon />
        Over
      </Button>
    </>
  );

  return (
    <div className="flex h-screen flex-col">
      <header className="z-20 border-b border-border bg-card shadow-sm">
        <div className="flex items-center gap-2 px-3 py-2 md:gap-4 md:px-4 md:py-2.5">
          <h1 className="flex shrink-0 items-center gap-1.5 text-base font-bold text-[var(--green-900)] md:text-lg">
            <span aria-hidden>♻️</span>
            <span className="hidden sm:inline">Inleverpunten</span>
          </h1>

          <div className="min-w-0 max-w-[200px] flex-1 sm:max-w-xs md:max-w-sm">
            <MunicipalitySelector
              municipalities={municipalities}
              selected={selected}
              onChange={handleMunicipalityChange}
            />
          </div>

          <div className="hidden max-w-md flex-1 md:block">
            <AddressSearchInput
              municipalities={municipalities}
              onAddressSelected={handleAddressSelected}
            />
          </div>

          <Button
            variant={nearestOpen ? 'default' : lastAddressSearch ? 'secondary' : 'subtle'}
            size="icon"
            className="hidden md:inline-flex"
            title="Dichtstbijzijnde inleverpunten zoeken"
            aria-label="Dichtstbijzijnde inleverpunten zoeken"
            onClick={() => {
              if (nearestOpen) {
                setNearestOpen(false);
                setHighlightedPoints(null);
              } else {
                setNearestOpen(true);
              }
            }}
          >
            <NavigationIcon />
          </Button>

          {loading && (
            <span className="hidden text-xs text-muted-foreground sm:inline">Laden...</span>
          )}

          <div className="ml-auto hidden gap-1.5 lg:flex">{navLinks}</div>

          <Button
            variant="ghost"
            size="icon"
            className="ml-auto lg:hidden"
            aria-label="Menu openen"
            onClick={() => setMobileMenuOpen((v) => !v)}
          >
            {mobileMenuOpen ? <XIcon /> : <MenuIcon />}
          </Button>
        </div>

        {mobileMenuOpen && (
          <div className="border-t border-border lg:hidden">
            <div className="border-b border-border px-3 py-2 md:hidden">
              <AddressSearchInput
                municipalities={municipalities}
                onAddressSelected={(slug, coordinates, displayName) => {
                  handleAddressSelected(slug, coordinates, displayName);
                  setMobileMenuOpen(false);
                }}
              />
            </div>
            <div className="flex flex-wrap gap-1.5 px-3 py-2">
              <Button
                variant="subtle"
                size="sm"
                onClick={() => {
                  setNearestOpen(true);
                  setMobileMenuOpen(false);
                }}
              >
                <NavigationIcon />
                Dichtstbijzijnde
              </Button>
              {navLinks}
            </div>
          </div>
        )}
      </header>

      <div className="relative flex flex-1 overflow-hidden">
        {mobileSidebarOpen && (
          <div
            className="fixed inset-0 z-30 bg-black/50 md:hidden"
            onClick={() => setMobileSidebarOpen(false)}
            aria-hidden
          />
        )}

        <aside
          className={cn(
            'fixed inset-y-0 left-0 z-40 w-[85vw] max-w-[320px] space-y-3 overflow-y-auto bg-muted p-3',
            'transition-transform duration-300 ease-in-out',
            'md:relative md:z-auto md:w-80 md:translate-x-0 md:shadow-none',
            mobileSidebarOpen ? 'translate-x-0 shadow-xl' : '-translate-x-full'
          )}
        >
          <div className="mb-1 flex items-center justify-between border-b border-border pb-2 md:hidden">
            <h2 className="text-sm font-semibold">Filters &amp; statistieken</h2>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Sluiten"
              onClick={() => setMobileSidebarOpen(false)}
            >
              <XIcon />
            </Button>
          </div>

          {data && (
            <>
              <StatsPanel
                data={data}
                visibleCount={visibleCount}
                categorieCounts={categorieCounts}
              />
              <FilterPanel
                filters={filters}
                onChange={handleFiltersChange}
                availableMerken={data.metadata.merken ?? []}
                merkCounts={merkCounts}
                categorieCounts={categorieCounts}
                materiaalCounts={materiaalCounts}
                sharedLocationCount={sharedLocationCount}
                totalPoints={allPoints.length}
                isNational={isNational}
                boundariesLoading={boundariesLoading}
                boundaryProgress={boundaryProgress}
              />
            </>
          )}
        </aside>

        {/* `isolate` traps Leaflet's panes (z-index 400-700) in their own
            stacking context. Without it they paint over the mobile drawer and
            its overlay, which sit outside this element at much lower z. */}
        <main className="relative isolate min-w-0 flex-1">
          <MapView
            data={data}
            filters={filters}
            targetCoordinates={targetCoordinates}
            onZoomedToTarget={clearTarget}
            searchLocationMarker={searchLocationMarker}
            highlightedPoints={highlightedPoints}
            onTilesLoading={setTilesLoading}
            basemapId={basemapId}
          />

          <BasemapSwitcher value={basemapId} onChange={setStoredBasemap} />

          {(loading || tilesLoading) && (
            <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-background/50">
              <span className="text-sm font-medium text-muted-foreground">Laden...</span>
            </div>
          )}

          <NearestPointsFinder
            isOpen={nearestOpen}
            onClose={() => {
              setNearestOpen(false);
              setHighlightedPoints(null);
            }}
            municipalities={municipalities}
            data={data}
            filters={filters}
            onMunicipalityChange={setSelected}
            onSearchLocationChange={setSearchLocationMarker}
            onHighlightedPointsChange={setHighlightedPoints}
            onPointSelect={setTargetCoordinates}
            initialSearch={lastAddressSearch}
          />

          {/* z-index has to clear Leaflet's panes, which sit at 400-700 and
              share this stacking context — anything lower disappears behind
              the map. */}
          <Button
            size="icon"
            className="fixed bottom-16 left-4 z-[900] size-12 rounded-full shadow-lg md:hidden"
            aria-label="Filters openen"
            onClick={() => setMobileSidebarOpen(true)}
          >
            <FilterIcon className="size-5" />
          </Button>
        </main>
      </div>

      <footer className="border-t border-border bg-card px-3 py-1.5 md:px-4">
        <div className="mx-auto flex max-w-7xl flex-col items-center justify-between gap-1 text-[11px] text-muted-foreground sm:flex-row sm:gap-0">
          <button
            type="button"
            onClick={() => setShowAbout(true)}
            className="text-primary hover:underline"
          >
            Info over databronnen
          </button>
          {data && (
            <p>
              Bijgewerkt:{' '}
              {new Date(data.metadata.generated_at).toLocaleDateString('nl-NL', {
                day: 'numeric',
                month: 'long',
                year: 'numeric',
              })}
            </p>
          )}
        </div>
      </footer>

      <AboutModal isOpen={showAbout} onClose={() => setShowAbout(false)} />
      <ShareModal
        isOpen={showShare}
        onClose={() => setShowShare(false)}
        municipality={selected}
        municipalityName={selectedName}
      />
    </div>
  );
}
