/**
 * Shared types for the analysis layers (bereik, schatting, plaatsingsadvies,
 * netwerkplanner).
 *
 * Kept in step with `normalize.py` and `analysis.py` in the Python backend —
 * those define the subsets, this mirrors them for the webapp. A subset added
 * on one side and not the other silently drops out of the UI.
 */

/** The two axes the analysis layers slice the point set along. */
export type Subset =
  | 'alles'
  // material stream
  | 'statiegeld'
  | 'batterijen'
  | 'elektro'
  // facility type
  | 'automaat'
  | 'balie'
  | 'inzamelbak'
  | 'milieustraat';

export const SUBSETS: Subset[] = [
  'alles',
  'statiegeld',
  'batterijen',
  'elektro',
  'automaat',
  'balie',
  'inzamelbak',
  'milieustraat',
];

export const SUBSET_LABELS: Record<Subset, string> = {
  alles: 'Alle inleverpunten',
  statiegeld: 'Statiegeld',
  batterijen: 'Batterijen & lampen',
  elektro: 'Elektrische apparaten',
  automaat: 'Inleverautomaat',
  balie: 'Balie / winkel',
  inzamelbak: 'Inzamelbak',
  milieustraat: 'Milieustraat',
};

/** Short labels for tight table headers and segmented controls. */
export const SUBSET_SHORT: Record<Subset, string> = {
  alles: 'Alle',
  statiegeld: 'Statiegeld',
  batterijen: 'Batterijen',
  elektro: 'Elektro',
  automaat: 'Automaat',
  balie: 'Balie',
  inzamelbak: 'Bak',
  milieustraat: 'Milieustr.',
};

/**
 * The subsets grouped by axis, each starting from `alles`. The two axes are
 * deliberately not crossed — `statiegeld × automaat` would be 12 mostly empty
 * combinations. Use the map filters for that.
 */
export const SUBSET_AXES: { key: string; label: string; subsets: Subset[] }[] = [
  {
    key: 'materiaal',
    label: 'Materiaalstroom',
    subsets: ['alles', 'statiegeld', 'batterijen', 'elektro'],
  },
  {
    key: 'punttype',
    label: 'Punttype',
    subsets: ['alles', 'automaat', 'balie', 'inzamelbak', 'milieustraat'],
  },
];

export type Distance = '300m' | '400m' | '500m';
export const DISTANCES: Distance[] = ['300m', '400m', '500m'];

/** Buffer union scope. See the methodology block in population_coverage.json. */
export type Scope = 'national' | 'strict';

export const SCOPE_LABELS: Record<Scope, string> = {
  national: 'Landelijk (grensoverschrijdend)',
  strict: 'Strikt (alleen eigen gemeente)',
};

export const SCOPE_HINTS: Record<Scope, string> = {
  national:
    'Een inleverpunt net over de gemeentegrens telt mee voor de inwoners ernaast.',
  strict:
    'Alleen punten binnen de gemeente zelf tellen mee — de bestuurlijke blik.',
};

// ---------------------------------------------------------------------------
// population_coverage.json
// ---------------------------------------------------------------------------

export interface CoverageMetric {
  covered: number;
  pct: number;
}

export type CoverageBySubset = Record<Subset, Record<Distance, CoverageMetric>>;

export interface MunicipalityCoverage {
  name: string;
  population: number;
  pc4_count: number;
  points: Record<Subset, number>;
  national: CoverageBySubset;
  strict: CoverageBySubset;
}

export interface Pc4Coverage {
  municipality: string | null;
  municipality_slug: string | null;
  population: number;
  area_km2: number;
  // One entry per subset; each maps a distance to { pct, covered }.
  [subset: string]: unknown;
}

export interface PopulationCoveragePayload {
  generated_at: string;
  subsets: Subset[];
  subset_labels: Record<Subset, string>;
  buffer_distances_m: number[];
  methodology: Record<string, string | number>;
  sources: Record<string, string>;
  national: { population: number } & CoverageBySubset;
  municipalities: Record<string, MunicipalityCoverage>;
  pc4: Record<string, Pc4Coverage>;
}

// ---------------------------------------------------------------------------
// pc4_stats.json
// ---------------------------------------------------------------------------

/** The regression targets, modelled separately — see fit_pc4_model.py. */
export type ModelTarget = 'alles' | 'statiegeld' | 'batterijen' | 'elektro';
export const MODEL_TARGETS: ModelTarget[] = [
  'alles',
  'statiegeld',
  'batterijen',
  'elektro',
];

export type FeatureSet = 'base' | 'extended' | 'ruim';
export const FEATURE_SETS: FeatureSet[] = ['base', 'extended', 'ruim'];

export interface ModelMeta {
  type: string;
  label: string;
  features: string[];
  target: string;
  /** In-sample R². Cannot fall when a feature is added — do not compare on it. */
  r2: number;
  /** 5-fold cross-validated R². This is the one that says something. */
  r2_cv_mean: number;
  r2_cv_std: number;
  cv_folds: number;
  intercept: number;
  coefficients: Record<string, number>;
  vif: Record<string, number>;
  training_size: number;
  coverage_pct: number;
}

export type ModelsByTarget = Record<
  ModelTarget,
  Partial<Record<FeatureSet, ModelMeta | null>> & { recommended?: FeatureSet }
>;

export interface Pc4ModelBlock {
  actual: number;
  base: number | null;
  delta_base: number | null;
  extended: number | null;
  delta_extended: number | null;
  ruim: number | null;
  delta_ruim: number | null;
  simple_rate: number;
}

export interface Pc4Stats {
  area_km2: number;
  population: number;
  municipality: string | null;
  municipality_slug: string | null;
  inleverpunten: {
    total: number;
    by_subset: Record<Subset, number>;
    by_merk: Record<string, Partial<Record<Subset, number>>>;
  };
  points_per_km2?: number | null;
  points_per_1000_inw?: number | null;
  model?: Record<ModelTarget, Pc4ModelBlock>;
  // CBS enrichments; null wherever CBS suppressed the cell.
  avg_income_household?: number | null;
  pct_low_income_household?: number | null;
  pct_high_income_household?: number | null;
  avg_woz_value?: number | null;
  ses_woa_total?: number | null;
  ses_woa_welvaart?: number | null;
  ses_woa_arbeid?: number | null;
  urbanity?: number | null;
  oad?: number | null;
  pct_age_25_45?: number | null;
  pct_single_hh?: number | null;
  pct_multi_family?: number | null;
  pct_owner_occupied?: number | null;
  horeca_1km?: number | null;
  supermarket_1km?: number | null;
  station_km?: number | null;
  highway_km?: number | null;
}

export interface Pc4StatsPayload {
  generated_from: Record<string, unknown>;
  subsets: Subset[];
  merken: string[];
  stats: Record<string, Pc4Stats>;
  models: ModelsByTarget;
  model_meta: {
    targets: Record<ModelTarget, string>;
    feature_sets: Record<FeatureSet, string>;
    training_filters: { min_population: number; min_area_km2: number };
    cv: { folds: number; seed: number; note: string };
    nationwide_rates: Record<
      ModelTarget,
      { points: number; per_inhabitant: number | null; per_km2: number | null }
    >;
  };
}

// ---------------------------------------------------------------------------
// Formatting helpers, shared by every analysis view
// ---------------------------------------------------------------------------

export const nlInt = (n: number) =>
  n.toLocaleString('nl-NL', { maximumFractionDigits: 0 });

export const nlPct = (n: number, digits = 1) =>
  n.toLocaleString('nl-NL', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });

export const nlNum = (n: number, digits = 2) =>
  n.toLocaleString('nl-NL', {
    minimumFractionDigits: 0,
    maximumFractionDigits: digits,
  });

/**
 * Coverage bands. Sequential, not a red-amber-green judgement: 40% coverage
 * for milieustraten is normal and 40% for statiegeld is not, so the colour
 * ramps with the number and the reading is left to the reader.
 */
export function coverageTone(pct: number): string {
  if (pct >= 80) return 'var(--green-700)';
  if (pct >= 60) return 'var(--green-500)';
  if (pct >= 40) return 'var(--green-400)';
  if (pct >= 20) return 'var(--green-300)';
  return 'var(--green-200)';
}
