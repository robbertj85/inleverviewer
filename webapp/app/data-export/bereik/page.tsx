import { promises as fs } from 'fs';
import path from 'path';

import PopulationReachReport from '@/components/analyse/PopulationReachReport';
import type { PopulationCoveragePayload } from '@/types/analyse';

export const metadata = {
  title: 'Bereik inwoners — Inleverpunten',
  description:
    'Hoeveel inwoners wonen binnen 300, 400 of 500 meter van een inleverpunt?',
};

async function getPayload(): Promise<PopulationCoveragePayload | null> {
  try {
    const file = path.join(process.cwd(), 'public', 'data', 'population_coverage.json');
    return JSON.parse(await fs.readFile(file, 'utf-8')) as PopulationCoveragePayload;
  } catch {
    return null;
  }
}

export default async function BereikPage() {
  const payload = await getPayload();

  if (!payload) {
    return (
      <div className="rounded-lg border border-amber-200 bg-amber-50 p-6 text-amber-900">
        <h2 className="mb-2 font-semibold">population_coverage.json ontbreekt</h2>
        <p className="text-sm">
          Genereer de dataset met{' '}
          <code className="rounded bg-amber-100 px-1 font-mono">
            python scripts/compute_population_coverage.py
          </code>{' '}
          en herlaad deze pagina.
        </p>
      </div>
    );
  }

  return <PopulationReachReport payload={payload} />;
}
