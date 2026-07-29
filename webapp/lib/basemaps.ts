/**
 * Background maps.
 *
 * Every entry is a plain XYZ raster source, so switching is a matter of
 * swapping one TileLayer — no extra renderer, no vector-tile dependency.
 *
 * Two things to keep in step when adding one:
 *  - the host has to be listed in `img-src` in `next.config.ts`, or the CSP
 *    blocks the tiles and the map goes blank;
 *  - `maxNativeZoom` must match what the service actually serves. The map
 *    itself always zooms to MAX_ZOOM, so a shallower source upscales its
 *    deepest level instead of requesting tiles that 404 — and, more to the
 *    point, instead of disappearing when you switch to it while zoomed in
 *    past its limit.
 *
 * PDOK has no dark topographic style — the BRT WMTS ships standaard, grijs,
 * pastel and water only. "BRT donker" is therefore the grijs style rendered
 * through an inverting CSS filter (see `.basemap-inverted` in globals.css),
 * which is why it is a flag here rather than a separate URL.
 */

const OSM_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>-bijdragers';
const CARTO_ATTRIBUTION = `${OSM_ATTRIBUTION} &copy; <a href="https://carto.com/attributions">CARTO</a>`;
const PDOK_ATTRIBUTION =
  'Kaartgegevens &copy; <a href="https://www.kadaster.nl">Kadaster</a> / PDOK';

export interface Basemap {
  id: string;
  /** Shown in the switcher menu. */
  label: string;
  /** Longer name for the tooltip and screen readers. */
  title: string;
  url: string;
  attribution: string;
  /** Deepest zoom level the service actually serves. */
  maxNativeZoom: number;
  subdomains?: string;
  /** Render the tiles through an inverting filter. */
  inverted?: boolean;
  /** Dark-looking result: darkens the container so tile gaps do not flash. */
  dark?: boolean;
}

export const BASEMAPS: Basemap[] = [
  {
    id: 'voyager',
    label: 'Voyager',
    title: 'CARTO Voyager',
    url: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
    attribution: CARTO_ATTRIBUTION,
    maxNativeZoom: 20,
    subdomains: 'abcd',
  },
  {
    id: 'carto-light',
    label: 'Licht',
    title: 'CARTO Positron — rustige lichte kaart',
    url: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
    attribution: CARTO_ATTRIBUTION,
    maxNativeZoom: 20,
    subdomains: 'abcd',
  },
  {
    id: 'carto-dark',
    label: 'Donker',
    title: 'CARTO Dark Matter — donkere kaart',
    url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    attribution: CARTO_ATTRIBUTION,
    maxNativeZoom: 20,
    subdomains: 'abcd',
    dark: true,
  },
  {
    id: 'osm',
    label: 'OpenStreetMap',
    title: 'OpenStreetMap standaard',
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: OSM_ATTRIBUTION,
    maxNativeZoom: 19,
  },
  {
    id: 'brt',
    label: 'BRT topografisch',
    title: 'BRT Achtergrondkaart (topografisch, PDOK)',
    url: 'https://service.pdok.nl/brt/achtergrondkaart/wmts/v2_0/standaard/EPSG:3857/{z}/{x}/{y}.png',
    attribution: PDOK_ATTRIBUTION,
    maxNativeZoom: 19,
  },
  {
    id: 'brt-dark',
    label: 'BRT donker',
    title: 'BRT Achtergrondkaart grijs, donker weergegeven',
    url: 'https://service.pdok.nl/brt/achtergrondkaart/wmts/v2_0/grijs/EPSG:3857/{z}/{x}/{y}.png',
    attribution: PDOK_ATTRIBUTION,
    maxNativeZoom: 19,
    inverted: true,
    dark: true,
  },
];

/** Deepest zoom the map allows, regardless of what a source serves. */
export const MAX_ZOOM = 20;

export const DEFAULT_BASEMAP_ID = 'voyager';

export function getBasemap(id: string | null | undefined): Basemap {
  return BASEMAPS.find((b) => b.id === id) ?? BASEMAPS[0];
}
