import { promises as fs } from 'fs';
import path from 'path';

import RegressionReport, {
  type RegressionPayload,
  type ScatterPoint,
} from '@/components/analyse/RegressionReport';
import { FEATURE_DEFS } from '@/lib/regressionFeatures';
import type { ModelTarget, Pc4StatsPayload } from '@/types/analyse';

export const metadata = {
  title: 'Schatting inleverpunten — Inleverpunten',
  description:
    'Hoeveel inleverpunten zou je per PC4 verwachten, en waar wijkt de werkelijkheid af?',
};

const TARGETS: ModelTarget[] = ['alles', 'statiegeld', 'batterijen', 'elektro'];

function round(value: unknown, digits = 2): number | null {
  if (typeof value !== 'number' || Number.isNaN(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/**
 * Slim the 5 MB stats file down to what the client needs.
 *
 * The full table carries per-brand breakdowns and three predictions per target
 * per PC4; the scatter plot and the in-browser regression need the feature
 * columns and the actual counts, nothing else. Shipping the lot would put
 * megabytes into the RSC payload for no gain.
 */
async function getPayload(): Promise<RegressionPayload | null> {
  let stats: Pc4StatsPayload;
  try {
    const file = path.join(process.cwd(), 'public', 'data', 'pc4_stats.json');
    stats = JSON.parse(await fs.readFile(file, 'utf-8')) as Pc4StatsPayload;
  } catch {
    return null;
  }

  const { min_population: minPop, min_area_km2: minArea } =
    stats.model_meta.training_filters;

  const scatter: ScatterPoint[] = [];
  for (const [pc4, entry] of Object.entries(stats.stats)) {
    if (entry.population < minPop || entry.area_km2 < minArea) continue;
    const point: ScatterPoint = {
      pc4,
      municipality: entry.municipality,
      population: entry.population,
      area_km2: round(entry.area_km2, 3) ?? 0,
      actual: {} as ScatterPoint['actual'],
      predicted: {} as ScatterPoint['predicted'],
      features: {},
    };
    for (const target of TARGETS) {
      const block = entry.model?.[target];
      point.actual[target] = block?.actual ?? entry.inleverpunten.by_subset[target] ?? 0;
      point.predicted[target] = {
        base: round(block?.base ?? null),
        extended: round(block?.extended ?? null),
        ruim: round(block?.ruim ?? null),
      };
    }
    for (const def of FEATURE_DEFS) {
      const raw =
        def.key === 'population'
          ? entry.population
          : def.key === 'area_km2'
            ? entry.area_km2
            : (entry as unknown as Record<string, unknown>)[def.key];
      point.features[def.key] = round(raw, def.digits ?? 2);
    }
    scatter.push(point);
  }

  return {
    generated_from: stats.generated_from,
    models: stats.models,
    model_meta: stats.model_meta,
    scatter,
  };
}

export default async function SchattingPage() {
  const payload = await getPayload();

  if (!payload) {
    return (
      <div className="rounded-lg border border-amber-200 bg-amber-50 p-6 text-amber-900">
        <h2 className="mb-2 font-semibold">pc4_stats.json ontbreekt</h2>
        <p className="text-sm">
          Genereer de dataset met{' '}
          <code className="rounded bg-amber-100 px-1 font-mono">
            python scripts/build_pc4_stats.py
          </code>{' '}
          gevolgd door{' '}
          <code className="rounded bg-amber-100 px-1 font-mono">
            python scripts/fit_pc4_model.py
          </code>
          .
        </p>
      </div>
    );
  }

  return <RegressionReport payload={payload} />;
}
