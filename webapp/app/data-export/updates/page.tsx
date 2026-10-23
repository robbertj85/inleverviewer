import fs from 'fs/promises';

import UpdatesClient, { UpdatesPayload } from '@/components/UpdatesClient';
import { dataFile } from '@/lib/dataPaths';

// Read from disk per request: the worker rewrites the data weekly without a
// rebuild, and the Docker build has no data to prerender from.
export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Updates — Inleverpuntenviewer',
  description: 'Wekelijkse updatestatus en historische ontwikkeling per bron.',
};

async function readJson<T>(...segments: string[]): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(dataFile(...segments), 'utf-8'));
  } catch {
    return null;
  }
}

export default async function UpdatesPage() {
  const [summary, history] = await Promise.all([
    readJson<UpdatesPayload['summary']>('summary.json'),
    readJson<UpdatesPayload['history']>('totals_history.json'),
  ]);

  return <UpdatesClient summary={summary} history={history} />;
}
