import fs from 'fs/promises';
import path from 'path';

import DataMatrixClient, { MatrixRow } from '@/components/DataMatrixClient';
import { ALL_MERKEN, Merk } from '@/types/inleverpunten';

export const metadata = {
  title: 'Data matrix — Inleverpuntenviewer',
  description: 'Vergelijk het aantal inleverpunten per gemeente en per bron.',
};

interface StatisticsFile {
  generated_at: string;
  national: {
    total: number;
    merken: Record<string, number>;
  };
  municipalities: {
    slug: string;
    gemeente: string;
    provincie: string;
    population: number;
    total: number;
    merken: Record<string, number>;
    per_10k_inwoners: number;
  }[];
}

/**
 * The matrix reads the precomputed statistics file rather than parsing 342
 * GeoJSON files at request time — the numbers are identical and the page
 * renders in milliseconds instead of seconds.
 */
async function loadMatrix(): Promise<{
  rows: MatrixRow[];
  merken: Merk[];
  totals: Record<string, number>;
  grandTotal: number;
  generatedAt: string | null;
}> {
  const statsPath = path.join(process.cwd(), 'public', 'data', 'statistics.json');

  try {
    const stats: StatisticsFile = JSON.parse(await fs.readFile(statsPath, 'utf-8'));

    const rows: MatrixRow[] = stats.municipalities.map((m) => ({
      slug: m.slug,
      gemeente: m.gemeente,
      provincie: m.provincie,
      population: m.population,
      total: m.total,
      per10k: m.per_10k_inwoners,
      merken: m.merken,
    }));

    return {
      rows,
      merken: [...ALL_MERKEN],
      totals: stats.national.merken,
      grandTotal: stats.national.total,
      generatedAt: stats.generated_at,
    };
  } catch {
    return { rows: [], merken: [...ALL_MERKEN], totals: {}, grandTotal: 0, generatedAt: null };
  }
}

export default async function DataMatrixPage() {
  const { rows, merken, totals, grandTotal, generatedAt } = await loadMatrix();

  return (
    <DataMatrixClient
      rows={rows}
      merken={merken}
      totals={totals}
      grandTotal={grandTotal}
      generatedAt={generatedAt}
    />
  );
}
