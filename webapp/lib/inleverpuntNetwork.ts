/**
 * Types and the capacity model for the Netwerkplanner
 * (inleverpunt_network/{slug}.json, produced by
 * scripts/plan_inleverpunt_network.py).
 */

export interface TypeMeta {
  label: string;
  prioriteit: number;
  buiten_24_7: boolean;
  /** 0 = aandachtspunt, 2 = hoge sociale controle. */
  sociale_controle: number;
  /** Can this location host a pakketpunt as well as an inleverpunt? */
  combi_geschikt: boolean;
  /** In the default candidate pool? Bus and tram stops are not. */
  standaard_actief: boolean;
  kleur: string;
  stromen: string[];
}

/**
 * Capacity inputs. Unlike the parcel side, where ACM publishes a national
 * parcel count, there is no published figure for returns per inhabitant per
 * stream — so `status` is 'aanname' and every `bron` is null until confirmed.
 * The UI must say so wherever these numbers appear.
 */
export interface CapacityDefaults {
  status: string;
  toelichting: string;
  bronnen_te_raadplegen: string[];
  retourvolume_liter_pp_jaar: Record<
    string,
    { waarde: number; bron: string | null }
  >;
  container_liter: number;
  bezetting_max: number;
  legingen_per_week_max: number;
}

export interface NetworkCandidate {
  lat: number;
  lon: number;
  type: string;
  naam: string;
  flags: string[];
}

export interface NetworkPick {
  /** Index into candidates[]. */
  c: number;
  gain: number;
  cum: number;
}

export interface NetworkScenario {
  start_covered: number;
  picks: NetworkPick[];
  /** Per cell: 0 = covered at the start, k = first covered by pick k, -1 = never. */
  cell_rank: number[];
}

export interface CombiPick {
  c: number;
  /** Inhabitants newly reached for the inleverpunten network. */
  gain_i: number;
  /** Inhabitants newly reached for the pakketpunten network. */
  gain_p: number;
  cum_i: number;
  cum_p: number;
  /** 2·min(gain_i, gain_p)/(gain_i + gain_p) — 1 serves both equally, 0 only one. */
  synergie: number;
}

export interface CombiScenario {
  rule: 'gewogen' | 'synergie';
  alpha: number | null;
  start_covered_i: number;
  start_covered_p: number;
  picks: CombiPick[];
  cell_rank_i: number[];
  cell_rank_p: number[];
}

export interface NetworkPayload {
  generated_at: string;
  slug: string;
  gemeente: string;
  methodology: Record<string, string>;
  params: {
    distances: number[];
    starts: string[];
    mode: string;
    alpha: number;
    kandidaat_types: string[];
    min_gain: number;
    min_spacing_m: number;
    dedupe_m: number;
    max_picks: number;
  };
  type_meta: Record<string, TypeMeta>;
  capacity_defaults: CapacityDefaults;
  materiaal_stromen: Record<string, string[]>;
  population_total: number;
  cells: { lat: number[]; lon: number[]; pop: number[] };
  candidates: NetworkCandidate[];
  existing: Record<string, number>;
  existing_pakketpunten: number;
  /** Parcel-point coordinates, so the combi map can draw what it reasons about. */
  pakketpunten: { lat: number[]; lon: number[] };
  pakketpunten_snapshot: {
    source_repo?: string;
    snapshot_date?: string;
    note?: string;
    total_points?: number;
  } | null;
  scenarios: Record<string, NetworkScenario>;
  combi_scenarios: Record<string, CombiScenario>;
}

export interface NetworkIndexEntry {
  gemeente: string;
  population_total: number;
  candidates: number;
  has_combi: boolean;
  generated_at: string;
}

export const START_LABELS: Record<string, string> = {
  greenfield: 'Lege kaart (greenfield)',
  automaten: 'Bestaande inleverautomaten',
  'alle-punten': 'Alle bestaande inleverpunten',
  statiegeld: 'Bestaande statiegeldpunten',
  batterijen: 'Bestaande batterijpunten',
  elektro: 'Bestaande elektropunten',
};

export const FLAG_LABELS: Record<string, string> = {
  ov: 'OV-nabij',
  sociale_controle: 'Sociale controle',
  '24_7': '24/7 buitenruimte',
  aandachtspunt_sociale_veiligheid: 'Aandachtspunt sociale veiligheid',
  combi_geschikt: 'Kan ook pakketpunt zijn',
};

export type CombiRule = 'gewogen' | 'synergie';

export const COMBI_RULE_LABELS: Record<CombiRule, string> = {
  gewogen: 'Gewogen (totale dekkingswinst)',
  synergie: 'Synergie (alleen dubbelfunctie)',
};

export const COMBI_RULE_HINTS: Record<CombiRule, string> = {
  gewogen:
    'Kiest per stap de locatie met de hoogste α·winst_inleveren + (1−α)·winst_pakketten. Maximaliseert totale dekking; een locatie die maar één netwerk dient kan winnen.',
  synergie:
    'Kiest per stap de locatie met de hoogste min(winst_inleveren, winst_pakketten), en alleen types die beide fysiek kunnen huisvesten. Dit is de dubbelfunctie-vraag.',
};

export function scenarioKey(distance: number, start: string): string {
  return `${distance}|${start}`;
}

export function combiKey(distance: number, rule: CombiRule): string {
  return `${distance}|combi-${rule}`;
}

// ---------------------------------------------------------------------------
// Capacity model
// ---------------------------------------------------------------------------

/**
 * Litres per year flowing through a point serving `inhabitants`, for one
 * material stream at a given participation share (0..1).
 *
 * Every input here is an assumption, not a measurement — see the note on
 * CapacityDefaults. Treat the output as an order of magnitude.
 */
export function litresPerYear(
  inhabitants: number,
  cap: CapacityDefaults,
  stream: string,
  participation: number
): number {
  const perCapita = cap.retourvolume_liter_pp_jaar[stream]?.waarde ?? 0;
  return inhabitants * perCapita * participation;
}

/** Containers needed to absorb that flow at the maximum emptying frequency. */
export function containersNeeded(
  litres: number,
  cap: CapacityDefaults
): number {
  const perContainerPerYear =
    cap.container_liter * cap.bezetting_max * cap.legingen_per_week_max * 52;
  if (perContainerPerYear <= 0) return 0;
  return Math.max(1, Math.ceil(litres / perContainerPerYear));
}

/** Emptyings per week for a given container count and annual volume. */
export function emptyingsPerWeek(
  litres: number,
  containers: number,
  cap: CapacityDefaults
): number {
  const capacityPerEmptying = containers * cap.container_liter * cap.bezetting_max;
  if (capacityPerEmptying <= 0) return 0;
  return litres / 52 / capacityPerEmptying;
}

/** Aggregate the capacity implication over the first `n` picks. */
export function networkCapacity(
  picks: { gain: number }[],
  n: number,
  cap: CapacityDefaults,
  stream: string,
  participation: number
): { litres: number; containers: number; emptyings: number } {
  let litres = 0;
  let containers = 0;
  let emptyings = 0;
  for (let i = 0; i < Math.min(n, picks.length); i++) {
    const l = litresPerYear(picks[i].gain, cap, stream, participation);
    const c = containersNeeded(l, cap);
    litres += l;
    containers += c;
    emptyings += emptyingsPerWeek(l, c, cap);
  }
  return { litres, containers, emptyings };
}
