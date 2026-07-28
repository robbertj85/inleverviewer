/**
 * Shared types for the inleverpunten dataset.
 *
 * Kept in step with normalize.py in the Python backend — that module defines
 * the vocabulary, this one mirrors it for the webapp.
 */

export interface Municipality {
  name: string;
  slug: string;
  province: string;
  population: number;
  code: string | null;
}

/** The five data sources. */
export type Merk =
  | 'StatiegeldNederland'
  | 'StichtingOPEN'
  | 'Stibat'
  | 'Droppie'
  | 'StatieDrive';

/** What you can hand in at a point. */
export type Materiaal =
  | 'pet-groot'
  | 'pet-klein'
  | 'blik'
  | 'glas'
  | 'krat'
  | 'batterijen'
  | 'elektro-klein'
  | 'elektro-middel'
  | 'elektro-groot'
  | 'lampen'
  | 'tl-buizen'
  | 'armaturen';

/** What kind of facility it is. */
export type PuntCategorie = 'automaat' | 'balie' | 'inzamelbak' | 'milieustraat';

/** How you get your deposit back. */
export type Uitbetaling =
  | 'bonnetje'
  | 'donatie'
  | 'tikkie'
  | 'droppie'
  | 'retourpinnen'
  | 'contant';

/** Per-day hours, a single free-text string, or null when unknown. */
export type OpeningHours =
  | string
  | {
      ma?: string;
      di?: string;
      wo?: string;
      do?: string;
      vr?: string;
      za?: string;
      zo?: string;
    };

export interface InleverpuntProperties {
  type: 'inleverpunt';
  locatieNaam: string;
  straatNaam: string;
  straatNr: string;
  postcode: string;
  plaats: string;
  merk: Merk;
  puntType: PuntCategorie;
  materialen: Materiaal[];
  uitbetaling: Uitbetaling[];
  vrijToegankelijk: boolean;
  /** Municipal recycling centres are restricted to residents of these municipalities. */
  gemeenteBeperking: string[] | null;
  openingstijden?: OpeningHours | null;
  latitude: number;
  longitude: number;
  bronId: string;
  /** Only present in the national (reduced) file. */
  gemeente?: string;
}

export interface BoundaryProperties {
  type: 'boundary';
  gemeente: string;
  slug?: string;
  code?: string | null;
  provincie?: string;
}

export type FeatureProperties = InleverpuntProperties | BoundaryProperties;

export interface InleverpuntFeature {
  type: 'Feature';
  geometry: {
    type: 'Point' | 'Polygon' | 'MultiPolygon';
    coordinates: number[] | number[][] | number[][][];
  };
  properties: FeatureProperties;
}

export interface InleverpuntData {
  type: 'FeatureCollection';
  metadata: {
    gemeente: string;
    slug: string;
    generated_at: string;
    total_points: number;
    merken: Merk[];
    bounds: [number, number, number, number] | [];
    municipalities?: number;
    /** The national file omits address, hours and payout detail to stay small. */
    reduced?: boolean;
  };
  features: InleverpuntFeature[];
}

export interface Filters {
  merken: Merk[];
  materialen: Materiaal[];
  categorieen: PuntCategorie[];
  showBuffer300: boolean;
  showBuffer400: boolean;
  showBuffer500: boolean;
  showBufferFill: boolean;
  bufferMerged: boolean;
  showBoundary: boolean;
  useSimpleMarkers: boolean;
  onlyVrijToegankelijk: boolean;
  showOnlySharedLocations: boolean;
}

// --------------------------------------------------------------------------
// Display metadata
// --------------------------------------------------------------------------

/**
 * Brand order. This is also the colour-slot order (see MERK_COLORS) and the
 * order series are drawn in, so the validated adjacency of the palette holds
 * in legends, stacked bars and the data matrix alike. Do not reorder without
 * re-validating the palette.
 */
export const ALL_MERKEN: Merk[] = [
  'StatiegeldNederland',
  'StichtingOPEN',
  'Droppie',
  'Stibat',
  'StatieDrive',
];

export const ALL_MATERIALEN: Materiaal[] = [
  'pet-groot',
  'pet-klein',
  'blik',
  'glas',
  'krat',
  'batterijen',
  'elektro-klein',
  'elektro-middel',
  'elektro-groot',
  'lampen',
  'tl-buizen',
  'armaturen',
];

export const ALL_CATEGORIEEN: PuntCategorie[] = [
  'automaat',
  'balie',
  'inzamelbak',
  'milieustraat',
];

export const MERK_LABELS: Record<Merk, string> = {
  StatiegeldNederland: 'Statiegeld Nederland',
  StichtingOPEN: 'Stichting OPEN / Wecycle',
  Stibat: 'Stibat (batterijen)',
  Droppie: 'Droppie',
  StatieDrive: 'StatieDrive',
};

/**
 * Series colours, assigned in ALL_MERKEN order.
 *
 * These are deliberately *not* the warm green house palette. Five brand-tinted
 * greens and oranges collapse under red-green colour blindness — the original
 * green/orange pair measured ΔE 0.5 for protanopia, i.e. identical. This is a
 * validated categorical ramp instead: it clears the lightness band, chroma
 * floor, CVD separation and normal-vision floor on the adjacent pairlist.
 * Warm green stays where it belongs — the app chrome and the coverage rings.
 *
 * Aqua, yellow and magenta sit below 3:1 against a light surface, so every
 * chart using them ships a legend, direct value labels and a table view.
 */
export const MERK_COLORS: Record<Merk, string> = {
  StatiegeldNederland: '#2a78d6', // blue
  StichtingOPEN: '#eb6834', // orange
  Droppie: '#1baf7a', // aqua
  Stibat: '#eda100', // yellow
  StatieDrive: '#e87ba4', // magenta
};

export const MATERIAAL_LABELS: Record<Materiaal, string> = {
  'pet-groot': 'Grote PET-fles',
  'pet-klein': 'Kleine PET-fles',
  blik: 'Blik',
  glas: 'Glas',
  krat: 'Krat',
  batterijen: 'Batterijen',
  'elektro-klein': 'Kleine apparaten',
  'elektro-middel': 'Middelgrote apparaten',
  'elektro-groot': 'Grote apparaten',
  lampen: 'Spaar- & LED-lampen',
  'tl-buizen': 'TL-buizen',
  armaturen: 'Armaturen',
};

/** Grouping used by the filter panel, so twelve checkboxes read as three themes. */
export const MATERIAAL_GROEPEN: { label: string; materialen: Materiaal[] }[] = [
  { label: 'Statiegeld', materialen: ['pet-groot', 'pet-klein', 'blik', 'krat', 'glas'] },
  { label: 'Elektrisch', materialen: ['elektro-klein', 'elektro-middel', 'elektro-groot'] },
  { label: 'Batterijen & lampen', materialen: ['batterijen', 'lampen', 'tl-buizen', 'armaturen'] },
];

export const CATEGORIE_LABELS: Record<PuntCategorie, string> = {
  automaat: 'Inleverautomaat',
  balie: 'Balie / winkel',
  inzamelbak: 'Inzamelbak',
  milieustraat: 'Milieustraat',
};

export const UITBETALING_LABELS: Record<Uitbetaling, string> = {
  bonnetje: 'Bon',
  donatie: 'Donatie',
  tikkie: 'Tikkie',
  droppie: 'Droppie-app',
  retourpinnen: 'Retourpinnen',
  contant: 'Contant',
};

export const DAY_LABELS: Record<string, string> = {
  ma: 'Maandag',
  di: 'Dinsdag',
  wo: 'Woensdag',
  do: 'Donderdag',
  vr: 'Vrijdag',
  za: 'Zaterdag',
  zo: 'Zondag',
};

/**
 * Marker colour. Colour encodes the brand and nothing else; the category is
 * carried by the glyph inside the marker, so the two encodings stay separable.
 */
export function getPointColor(props: InleverpuntProperties): string {
  return MERK_COLORS[props.merk] ?? '#2a78d6';
}

export function isInleverpunt(
  props: FeatureProperties
): props is InleverpuntProperties {
  return props.type === 'inleverpunt';
}
