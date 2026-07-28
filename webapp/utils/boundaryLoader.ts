/**
 * Load municipal boundaries for the national view.
 *
 * All 342 outlines together are too much for one request to feel responsive,
 * so they are split into twelve provincial files that load in parallel with a
 * progress callback driving the UI indicator.
 */

import { InleverpuntFeature } from '@/types/inleverpunten';

export interface BoundaryLoadProgress {
  loaded: number;
  total: number;
  percentage: number;
}

interface ProvinceIndexEntry {
  provincie: string;
  slug: string;
  file: string;
  boundaries: number;
}

interface BoundaryIndex {
  generated_at: string;
  total_provinces: number;
  total_boundaries: number;
  provinces: ProvinceIndexEntry[];
}

export interface LoadedBoundaries {
  features: InleverpuntFeature[];
  metadata: {
    total_boundaries: number;
    provinces_loaded: number;
  };
}

const INDEX_URL = '/data/boundaries/index.json';
const BASE_URL = '/data/boundaries';

export async function loadProvincialBoundaries(
  onProgress?: (progress: BoundaryLoadProgress) => void
): Promise<LoadedBoundaries> {
  const indexResponse = await fetch(INDEX_URL);
  if (!indexResponse.ok) {
    throw new Error(`Kon boundary-index niet laden (HTTP ${indexResponse.status})`);
  }

  const index: BoundaryIndex = await indexResponse.json();
  const total = index.provinces.length;
  let loaded = 0;

  const report = () => {
    onProgress?.({
      loaded,
      total,
      percentage: total === 0 ? 100 : Math.round((loaded / total) * 100),
    });
  };

  report();

  const results = await Promise.all(
    index.provinces.map(async (province) => {
      try {
        const response = await fetch(`${BASE_URL}/${province.file}`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        return (data.features ?? []) as InleverpuntFeature[];
      } catch (error) {
        // One missing province should degrade the overlay, not break it.
        console.error(`Kon ${province.provincie} niet laden:`, error);
        return [] as InleverpuntFeature[];
      } finally {
        loaded += 1;
        report();
      }
    })
  );

  const features = results.flat();

  return {
    features,
    metadata: {
      total_boundaries: features.length,
      provinces_loaded: results.filter((r) => r.length > 0).length,
    },
  };
}
