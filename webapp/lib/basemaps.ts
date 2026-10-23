/**
 * Background maps.
 *
 * Two kinds, both drawn by `components/BasemapLayer.tsx`:
 *  - `vector`: a MapLibre GL style, rendered inside Leaflet by
 *    @maplibre/maplibre-gl-leaflet. The CARTO styles are vector because CARTO's
 *    raster tiles (basemaps.cartocdn.com/{style}/{z}/{x}/{y}.png) now answer
 *    every request with an "API KEY REQUIRED" image, still with HTTP 200;
 *    the GL styles and their vector tiles stay keyless.
 *  - `raster`: a plain XYZ source in a Leaflet TileLayer.
 *
 * Things to keep in step when adding one:
 *  - the host has to be in the CSP in `next.config.ts` (`img-src` for raster
 *    tiles; `connect-src` for a vector style, its tiles, glyphs and sprite),
 *    or the map goes blank;
 *  - for raster, `maxNativeZoom` must match what the service serves. The map
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

interface BasemapBase {
  id: string;
  /** Shown in the switcher menu. */
  label: string;
  /** Longer name for the tooltip and screen readers. */
  title: string;
  attribution: string;
  /** Dark-looking result: darkens the container so tile gaps do not flash. */
  dark?: boolean;
}

export interface VectorBasemap extends BasemapBase {
  kind: 'vector';
  /** MapLibre GL style JSON. */
  styleUrl: string;
}

export interface RasterBasemap extends BasemapBase {
  kind: 'raster';
  url: string;
  /** Deepest zoom level the service actually serves. */
  maxNativeZoom: number;
  subdomains?: string;
  /** Render the tiles through an inverting filter. */
  inverted?: boolean;
}

export type Basemap = VectorBasemap | RasterBasemap;

const cartoStyle = (name: string) =>
  `https://basemaps.cartocdn.com/gl/${name}-gl-style/style.json`;

export const BASEMAPS: Basemap[] = [
  {
    id: 'voyager',
    label: 'Voyager',
    title: 'CARTO Voyager',
    kind: 'vector',
    styleUrl: cartoStyle('voyager'),
    attribution: CARTO_ATTRIBUTION,
  },
  {
    id: 'carto-light',
    label: 'Licht',
    title: 'CARTO Positron — rustige lichte kaart',
    kind: 'vector',
    styleUrl: cartoStyle('positron'),
    attribution: CARTO_ATTRIBUTION,
  },
  {
    id: 'carto-dark',
    label: 'Donker',
    title: 'CARTO Dark Matter — donkere kaart',
    kind: 'vector',
    styleUrl: cartoStyle('dark-matter'),
    attribution: CARTO_ATTRIBUTION,
    dark: true,
  },
  {
    id: 'osm',
    label: 'OpenStreetMap',
    title: 'OpenStreetMap standaard',
    kind: 'raster',
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: OSM_ATTRIBUTION,
    maxNativeZoom: 19,
  },
  {
    id: 'brt',
    label: 'BRT topografisch',
    title: 'BRT Achtergrondkaart (topografisch, PDOK)',
    kind: 'raster',
    url: 'https://service.pdok.nl/brt/achtergrondkaart/wmts/v2_0/standaard/EPSG:3857/{z}/{x}/{y}.png',
    attribution: PDOK_ATTRIBUTION,
    maxNativeZoom: 19,
  },
  {
    id: 'brt-dark',
    label: 'BRT donker',
    title: 'BRT Achtergrondkaart grijs, donker weergegeven',
    kind: 'raster',
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
