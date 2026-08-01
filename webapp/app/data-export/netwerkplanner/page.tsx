import { promises as fs } from 'fs';
import path from 'path';

import NetworkPlanner from '@/components/analyse/NetworkPlanner';
import type { NetworkIndexEntry } from '@/lib/inleverpuntNetwork';

export const metadata = {
  title: 'Netwerkplanner — Inleverpunten',
  description:
    'Waar zou je inleverpunten neerzetten om zoveel mogelijk inwoners binnen loopafstand te brengen?',
};

async function getIndex(): Promise<Record<string, NetworkIndexEntry> | null> {
  try {
    const file = path.join(
      process.cwd(), 'public', 'data', 'inleverpunt_network', 'index.json'
    );
    return JSON.parse(await fs.readFile(file, 'utf-8'));
  } catch {
    return null;
  }
}

export default async function NetwerkplannerPage() {
  const index = await getIndex();

  if (!index || Object.keys(index).length === 0) {
    return (
      <div className="rounded-lg border border-amber-200 bg-amber-50 p-6 text-amber-900">
        <h2 className="mb-2 font-semibold">Nog geen netwerkdata</h2>
        <p className="text-sm">
          Genereer de netwerken met{' '}
          <code className="rounded bg-amber-100 px-1 font-mono">
            python scripts/plan_inleverpunt_network.py --only pilot
          </code>{' '}
          en herlaad deze pagina.
        </p>
      </div>
    );
  }

  const slugs = Object.keys(index).sort();
  const defaultSlug = slugs.includes('zwolle') ? 'zwolle' : slugs[0];

  return <NetworkPlanner index={index} defaultSlug={defaultSlug} />;
}
