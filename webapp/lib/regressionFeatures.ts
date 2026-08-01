/**
 * The variable catalogue behind the Schatting tab.
 *
 * Lives in its own module rather than beside the report component because the
 * server page imports it to decide which columns to ship to the client, and a
 * `'use client'` module exports only component references across that
 * boundary — everything else arrives undefined.
 */

export interface FeatureDef {
  key: string;
  label: string;
  group: 'omvang' | 'welvaart' | 'dichtheid' | 'voorzieningen';
  unit?: string;
  /** Rounding applied before the value is shipped to the client. */
  digits?: number;
}

export const FEATURE_DEFS: FeatureDef[] = [
  { key: 'population', label: 'Inwoners', group: 'omvang', digits: 0 },
  { key: 'area_km2', label: 'Oppervlakte', group: 'omvang', unit: 'km²', digits: 3 },
  { key: 'avg_income_household', label: 'Gem. huishoudinkomen', group: 'welvaart', unit: '× €1.000', digits: 1 },
  { key: 'pct_low_income_household', label: 'Aandeel laag inkomen', group: 'welvaart', unit: '%', digits: 1 },
  { key: 'pct_high_income_household', label: 'Aandeel hoog inkomen', group: 'welvaart', unit: '%', digits: 1 },
  { key: 'avg_woz_value', label: 'Gem. WOZ-waarde', group: 'welvaart', unit: '× €1.000', digits: 0 },
  { key: 'ses_woa_total', label: 'SES-WOA totaal', group: 'welvaart', digits: 3 },
  { key: 'ses_woa_welvaart', label: 'SES-WOA welvaart', group: 'welvaart', digits: 3 },
  { key: 'ses_woa_arbeid', label: 'SES-WOA arbeid', group: 'welvaart', digits: 3 },
  { key: 'oad', label: 'Omgevingsadressendichtheid', group: 'dichtheid', unit: '/km²', digits: 0 },
  { key: 'urbanity', label: 'Stedelijkheidsklasse', group: 'dichtheid', digits: 0 },
  { key: 'pct_age_25_45', label: 'Aandeel 25–45 jaar', group: 'dichtheid', unit: '%', digits: 1 },
  { key: 'pct_single_hh', label: 'Aandeel eenpersoons', group: 'dichtheid', unit: '%', digits: 1 },
  { key: 'pct_multi_family', label: 'Aandeel meergezins', group: 'dichtheid', unit: '%', digits: 1 },
  { key: 'pct_owner_occupied', label: 'Aandeel koopwoningen', group: 'dichtheid', unit: '%', digits: 0 },
  { key: 'supermarket_1km', label: 'Supermarkten < 1 km', group: 'voorzieningen', digits: 1 },
  { key: 'horeca_1km', label: 'Horeca < 1 km', group: 'voorzieningen', digits: 1 },
  { key: 'station_km', label: 'Afstand tot station', group: 'voorzieningen', unit: 'km', digits: 2 },
  { key: 'highway_km', label: 'Afstand tot snelweg', group: 'voorzieningen', unit: 'km', digits: 2 },
];

export const FEATURE_BY_KEY = new Map(FEATURE_DEFS.map((f) => [f.key, f]));

export const FEATURE_GROUP_LABELS: Record<FeatureDef['group'], string> = {
  omvang: 'Omvang',
  welvaart: 'Welvaart',
  dichtheid: 'Dichtheid & huishoudens',
  voorzieningen: 'Voorzieningen',
};

/**
 * Presets mirroring the feature sets the Python pipeline fits, so the panel
 * starts from a model whose cross-validated score the user has already seen.
 */
export const FEATURE_PRESETS: { name: string; keys: string[]; note: string }[] = [
  {
    name: 'Basis',
    keys: ['population', 'area_km2'],
    note: 'Twee variabelen. Het referentiemodel.',
  },
  {
    name: 'Uitgebreid',
    keys: ['population', 'area_km2', 'avg_income_household', 'ses_woa_total'],
    note: 'Basis plus welvaart. Voegt op cross-validatie niets toe.',
  },
  {
    name: 'Ruim',
    keys: [
      'population', 'area_km2', 'oad', 'pct_single_hh', 'pct_multi_family',
      'pct_owner_occupied', 'supermarket_1km', 'horeca_1km',
    ],
    note: 'Dichtheid, huishoudsamenstelling en winkelaanbod erbij.',
  },
  {
    name: 'Alleen dichtheid',
    keys: ['oad', 'pct_multi_family'],
    note: 'Hoe ver kom je met stedelijkheid alleen?',
  },
];
