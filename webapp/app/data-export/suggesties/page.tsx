import { promises as fs } from 'fs';
import path from 'path';

import PlacementSuggestionsReport, {
  type PlacementSuggestionsPayload,
} from '@/components/analyse/PlacementSuggestionsReport';

export const metadata = {
  title: 'Plaatsingsadvies — Inleverpunten',
  description:
    'Welke postcodegebieden verdienen als eerste een extra inleverpunt, en waar precies?',
};

async function getPayload(): Promise<PlacementSuggestionsPayload | null> {
  try {
    const file = path.join(
      process.cwd(), 'public', 'data', 'placement_suggestions.json'
    );
    return JSON.parse(await fs.readFile(file, 'utf-8')) as PlacementSuggestionsPayload;
  } catch {
    return null;
  }
}

export default async function SuggestiesPage() {
  const payload = await getPayload();

  if (!payload) {
    return (
      <div className="rounded-lg border border-amber-200 bg-amber-50 p-6 text-amber-900">
        <h2 className="mb-2 font-semibold">placement_suggestions.json ontbreekt</h2>
        <p className="text-sm">
          Genereer de dataset met{' '}
          <code className="rounded bg-amber-100 px-1 font-mono">
            python scripts/suggest_placements.py --only pilot
          </code>
          . Dat vereist eerst{' '}
          <code className="rounded bg-amber-100 px-1 font-mono">build_pc4_stats.py</code>,{' '}
          <code className="rounded bg-amber-100 px-1 font-mono">fit_pc4_model.py</code> en{' '}
          <code className="rounded bg-amber-100 px-1 font-mono">
            compute_population_coverage.py
          </code>
          .
        </p>
      </div>
    );
  }

  return <PlacementSuggestionsReport payload={payload} />;
}
