import fs from 'fs/promises';
import path from 'path';

import UpdatesClient, { UpdatesPayload } from '@/components/UpdatesClient';

export const metadata = {
  title: 'Updates — Inleverpuntenviewer',
  description: 'Wekelijkse updatestatus en historische ontwikkeling per bron.',
};

async function readJson<T>(...segments: string[]): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(path.join(process.cwd(), ...segments), 'utf-8'));
  } catch {
    return null;
  }
}

export default async function UpdatesPage() {
  const [summary, history] = await Promise.all([
    readJson<UpdatesPayload['summary']>('public', 'data', 'summary.json'),
    readJson<UpdatesPayload['history']>('public', 'data', 'totals_history.json'),
  ]);

  return <UpdatesClient summary={summary} history={history} />;
}
