# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

Two components that meet at a GeoJSON file:

- **Python backend** — fetches inleverpunten from five public sources, assigns each
  point to a municipality by spatial join, and writes one GeoJSON per municipality.
- **Next.js webapp** (`webapp/`) — interactive Leaflet map, filters, statistics,
  data export, five analysis tabs and a read-only API.

Sister projects: `../pakketpunten` (Pakketpuntenviewer) and
`../pakketpunten-analyse` (the convenant variant, which the analysis tabs were
ported from). Same principles, different domain. Patterns worth reusing
generally live there first.

## Commands

```bash
# Python (use the venv; geopandas needs 3.12, not the system 3.14)
source venv/bin/activate
python scripts/fetch_pdok_boundaries.py         # boundaries; no-ops unless refresh week
python scripts/<source>_fetch_all.py            # statiegeld | stibat | open | droppie | statiedrive
python scripts/batch_generate.py --only zwolle  # fast iteration on one municipality
python scripts/create_national_overview.py
python scripts/compute_statistics.py

# Analysis layers, in this order — each reads what the previous one wrote
python scripts/build_analysis_points.py             # consolidates the per-muni files
python scripts/compute_population_coverage.py       # → population_coverage.json (~40 s)
python scripts/build_pc4_stats.py                   # → pc4_stats.json
python scripts/fit_pc4_model.py                     # adds predictions + model metadata
python scripts/suggest_placements.py --only pilot   # → placement_suggestions.json
python scripts/plan_inleverpunt_network.py --only pilot   # → inleverpunt_network/

# One-off inputs (slow, cached, gitignored)
python scripts/fetch_pois.py                        # Overpass, ~10 min for everything
python scripts/split_pois_by_municipality.py --only pilot

# Webapp
cd webapp
npm run dev
npm run build     # runs TypeScript; must be clean
npm run lint      # must be clean
npm test          # Playwright; must be clean
```

## Things that will bite you

**Two vocabularies must stay in sync.** `normalize.py` defines brands, materials and
categories for the backend; `webapp/types/inleverpunten.ts` mirrors them. Adding a
material to one without the other silently drops points from the filters —
`make_record` deliberately discards unknown terms rather than passing them through.
The same applies to the analysis subsets: `SUBSETS` in `normalize.py` against
`SUBSETS` in `webapp/types/analyse.ts`, asserted by the first test in
`tests/analyse.spec.ts`.

**Milieustraten are not open to everyone.** `gemeenteBeperking` lists which
municipalities' residents may use a recycling centre. `compute_population_coverage.py`
therefore builds them a separate buffer union per permitted municipality instead
of letting them join the national one — counting a Rotterdam milieustraat as
serving everyone within 400 m would overstate reach in exactly the places where
reach is thinnest. `analysis.GEMEENTE_ALIASES` maps the pre-merger names the
sources still publish ("Boxmeer", "Weesp") onto current slugs; an unmapped name
silently shrinks a catchment.

**The national file cannot feed the analysis layers.** `nederland.geojson` is
reduced on purpose and drops `gemeenteBeperking` along with the address fields.
`build_analysis_points.py` rebuilds a full-detail national set from the
per-municipality files into `data/analysis_points.geojson` (gitignored,
regenerable) — that is what every analysis script reads.

**Bus stops swamp the network planner.** Zwolle's POI bundle has 302 bus stops
against 41 supermarkets, so stops form by far the densest even grid of
candidates and a greedy that only maximises population within R picks almost
nothing else. `TYPE_META[...]["standaard_actief"]` is `False` for `bus_halte`
and `tram_halte` for that reason; `--types alle` brings them back for
comparison. Before this filter the top six picks in Zwolle were all bus stops.

**Compare models on `r2_cv_mean`, never on `r2`.** In-sample R² cannot fall when
you add a feature, so a feature set chosen on it is chosen by its size.
`fit_pc4_model.py` reports both, and the 5-fold cross-validated score is what the
UI ranks on. It earns its keep: the "extended" feature set (income + SES-WOA)
scores *worse* on CV than the two-variable base model for every stream.

**Regression targets are per material stream.** One model over "all
inleverpunten" averages supermarket deposit machines against ~390 municipal
recycling centres and predicts neither. `fit_pc4_model.py` fits `statiegeld`,
`batterijen` and `elektro` separately, plus the total as a fourth target.

**The capacity model is assumptions, not data.** There is no published figure
for returns per inhabitant per year per stream. `CAPACITY_DEFAULTS` in
`plan_inleverpunt_network.py` carries `status: "aanname"`, a null `bron` per
number and a list of registers still to consult, and the UI labels it as such.
Do not quietly promote these to facts.

**Pakketpunten data is a snapshot, not a feed.** `data/pakketpunten_snapshot.geojson`
is a copy of `nederland.geojson` from `../pakketpunten-analyse`, carrying a
`snapshot_date` in its metadata. The combi mode of the network planner reads it;
the UI states the date. Refreshing means copying the file again.

**Slugs come from one place.** `utils.slugify`, and for POI bundles straight off
the `slug` field in the provincial boundary files. The sister project derives
bundle filenames with a second, subtly different function, which disagrees with
`municipalities.json` on parenthesised and accented names — Bergen (L.), Bergen
(NH.), Noardeast-Fryslân and Súdwest-Fryslân ended up with bundles its network
planner could never find, and the only symptom was a skip line in a 342-line
log. `analysis.assert_poi_bundles_exist` fails loudly instead.

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

**A new basemap needs its host in the CSP.** `webapp/lib/basemaps.ts` lists the
background maps; `img-src` in `next.config.ts` lists the hosts they may load from.
Add one without the other and the map goes blank with a console-only complaint —
which is what the "elke achtergrondkaart laadt tegels" test in `tests/smoke.spec.ts`
is there to catch. PDOK serves no dark topographic style, so "BRT donker" is the
grijs style put through an inverting CSS filter rather than its own URL.

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
the tracer cannot see reads whose filename comes from a request parameter. The
four analysis pages that read a dataset server-side have their own entries there
for the same reason.

`NEXT_PUBLIC_SITE_URL` drives canonical URLs, OG tags and embed snippets. Set it
when a custom domain is attached.
