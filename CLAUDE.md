# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

Two components that meet at a GeoJSON file:

- **Python backend** — fetches inleverpunten from five public sources, assigns each
  point to a municipality by spatial join, and writes one GeoJSON per municipality.
- **Next.js webapp** (`webapp/`) — interactive Leaflet map, filters, statistics,
  data export and a read-only API.

Sister project: `../pakketpunten` (Pakketpuntenviewer). Same principles, different
domain. Patterns worth reusing generally live there first.

## Commands

```bash
# Python (use the venv; geopandas needs 3.12, not the system 3.14)
source venv/bin/activate
python scripts/fetch_pdok_boundaries.py         # boundaries; no-ops unless refresh week
python scripts/<source>_fetch_all.py            # statiegeld | stibat | open | droppie | statiedrive
python scripts/batch_generate.py --only zwolle  # fast iteration on one municipality
python scripts/create_national_overview.py
python scripts/compute_statistics.py

# Webapp
cd webapp
npm run dev
npm run build     # runs TypeScript; must be clean
npm run lint      # must be clean
```

## Things that will bite you

**Two vocabularies must stay in sync.** `normalize.py` defines brands, materials and
categories for the backend; `webapp/types/inleverpunten.ts` mirrors them. Adding a
material to one without the other silently drops points from the filters —
`make_record` deliberately discards unknown terms rather than passing them through.

**CRS discipline.** WGS84 (EPSG:4326) for APIs, GeoJSON and the map; RD New
(EPSG:28992) for anything in metres. Buffering or measuring in degrees is wrong
across the country, not just imprecise.

**`ALL_MERKEN` order is the colour-slot order.** The series palette is validated on
the *adjacent* pairlist, so reordering brands invalidates it. If you change the
order or the colours, re-run the dataviz validator before shipping.

**Series colours are not the house green.** The app chrome is warm green; the series
palette deliberately is not. Five green/orange brand tints collapse under red-green
colour blindness (the original pair measured ΔE 0.5 for protanopia — identical).
See the note on `MERK_COLORS`.

**Boundary geometry is simplified for display only.** `batch_generate.py` simplifies
outlines to 20 m for the GeoJSON; the spatial join uses the full-resolution polygon
from the cache. Do not simplify the cache.

**The national file is reduced on purpose.** `nederland.geojson` omits address,
opening hours and payout fields (`"reduced": true` in its metadata). Full detail
lives in the per-municipality files.

**`cache_guard.safe_save` exits 2, not 1.** That is the "anomaly, previous cache
kept" signal the workflow treats as a warning. Do not convert it into a hard failure.

**Municipal recycling centres need both sweeps.** The Stichting OPEN endpoint does
not bbox-filter `municipalityServicePoint` records — it returns the handful
*nearest the query point*. A single national call surfaces two of ~390. So
`open_fetch_all.py` runs two sweeps and unions them: per-municipality centroid
(catches each town's own centre, but Rotterdam's centroid is 15 km out in the port)
and a land-clipped lattice (shape-proof, but misses centres that sit between cells —
a cell 3 km from Helmond returns Laarbeek's instead). Dropping either sweep loses
coverage; measured, not assumed.

**Some sources ship fallback coordinates.** When their geocoder fails they drop
unrelated addresses on one point — thirteen Statiegeld records share 51.92965/4.47834,
including an Almere school that then geofences into Rotterdam. `geocode.py` detects
coordinates shared by *different* addresses and re-resolves them against PDOK
Locatieserver, cached in `data/geocode_cache.json`. Two records at the same address
are normal (a shop with two bins) and are left alone.

## Source endpoints

| Source | Endpoint | Shape |
|---|---|---|
| Statiegeld Nederland | `geoserver-statiegeld.webgis.nl/Statiegeld/wfs` | WFS GetFeature, one call |
| Stibat | `legebatterijen.nl/wp-json/stibat-inlever-locator/v1/locations` | lat/lng/radius; small radii intermittently 500 |
| Stichting OPEN | `inleverpunten.stichting-open.org/wecyclenl/servicepoints/Search` | bbox; `WasteTypes` repeats |
| Droppie | `godroppie.com/nl/locaties` | schema.org JSON-LD |
| StatieDrive | `statiedrive.nl/locaties` | schema.org JSON-LD `ItemList` |
| Boundaries | `api.pdok.nl/kadaster/bestuurlijkegebieden/ogc/v1` | cursor-paged, not offset |
| Population | `opendata.cbs.nl/ODataApi/odata/37230ned` | filter on `startswith(RegioS,'GM')` |

## Deployment

Vercel. The project's **Root Directory must be `webapp`** — the repo root holds the
Python pipeline and has no `package.json`, so a project left at the default root
fails the build with "No Next.js version detected". This is a project setting in
Vercel, not something `vercel.json` can express.

`next.config.ts` declares `outputFileTracingIncludes` for the data files —
without it the dynamic API routes 404 in production while working locally, because
the tracer cannot see reads whose filename comes from a request parameter.

`NEXT_PUBLIC_SITE_URL` drives canonical URLs, OG tags and embed snippets. Set it
when a custom domain is attached.
