import fs from 'fs/promises';
import path from 'path';

import StatisticsClient, { StatisticsPayload } from '@/components/StatisticsClient';

export const metadata = {
  title: 'Statistieken — Inleverpuntenviewer',
  description:
    'Inleverpunten per gemeente: verdeling per bron, materiaalstroom en type, plus de dekkingsgraad binnen 300, 400 en 500 meter.',
};

async function loadStatistics(): Promise<StatisticsPayload | null> {
  try {
    const filePath = path.join(process.cwd(), 'public', 'data', 'statistics.json');
    return JSON.parse(await fs.readFile(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

export default async function StatisticsPage() {
  const statistics = await loadStatistics();

  if (!statistics) {
    return (
      <div className="rounded-xl border border-border bg-card p-8 text-center">
        <p className="text-sm text-muted-foreground">
          Nog geen statistieken beschikbaar. Draai{' '}
          <code className="rounded bg-muted px-1 py-0.5 text-xs">
            python scripts/compute_statistics.py
          </code>
          .
        </p>
      </div>
    );
  }

  return <StatisticsClient statistics={statistics} />;
}
