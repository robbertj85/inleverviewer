# Inleverpunten Nederland

Een systeem voor het **verzamelen, analyseren en visualiseren van inleverpunten in
Nederland** — statiegeld, batterijen, elektrische apparaten en gemeentelijke
milieustraten — bestaande uit een Python-backend voor dataverzameling en een
Next.js-webapp voor interactieve kaartvisualisatie.

De data wordt elke maandagnacht automatisch bijgewerkt via GitHub Actions, voor alle
**342 Nederlandse gemeenten**.

**Disclaimer** — Dit project wordt geleverd "as is", zonder garantie. De data is
verzameld uit publieke bronnen en kan onnauwkeurigheden bevatten; verifieer
locatiegegevens voordat je op pad gaat. Dit project is niet gelieerd aan de
genoemde organisaties.

---

## Huidige dekking

| Bron | Methode | Punten | Landelijk ophalen |
|---|---|---|---|
| Stibat / Lege Batterijen | Publieke REST API (straal) | ~18.400 | Eén call, 200 km straal |
| Statiegeld Nederland (Verpact) | Publieke WFS (GeoServer) | ~8.000 | Eén GetFeature |
| Stichting OPEN / Wecycle | Publieke REST API (bbox) | ~7.200 | Landelijk + gemeente-grid |
| Droppie | schema.org JSON-LD | 13 | Eén pagina |
| StatieDrive | schema.org JSON-LD | 12 | Eén pagina |
| **Totaal** | | **~33.700** | |

Waarvan ~380 gemeentelijke milieustraten en recyclingstations.

---

## Webapplicatie

### Features

- **Interactieve kaart** met OpenStreetMap en Leaflet, voor alle 342 gemeenten plus
  een landelijk overzicht
- **Adaptieve rendering** — canvas en vereenvoudigde markers voor grote datasets;
  de grootste bron wordt onderop getekend zodat kleinere netwerken zichtbaar blijven
- **Filters** — per bron, per materiaalstroom (wat kun je hier inleveren?), per
  type punt, en op vrije toegankelijkheid
- **Dekkingscirkels** van 300, 400 en 500 meter, live in de browser berekend met
  Turf.js, samengevoegd of per punt
- **Adres zoeken** en **dichtstbijzijnde punten** binnen de actieve filters
- **Gemeentegrenzen**, landelijk geladen in 12 provinciale delen met voortgangsindicatie
- **Data-export** — GeoJSON en CSV per gemeente, plus een publieke API
- **Data matrix** en **statistieken** per gemeente, inclusief dekkingsgraad
- **Embed** — iframe-weergave voor gebruik op andere sites

#### Analyselagen (beta)

Vijf tabbladen die op de gemeten dataset een model leggen. Ze zijn als beta
gemarkeerd omdat ze schattingen tonen, geen tellingen.

- **Schatting inleverpunten** — hoeveel punten zou je per postcodegebied
  verwachten op grond van inwonertal, oppervlakte en CBS-kenmerken, en waar wijkt
  de werkelijkheid daarvan af? Statiegeld, batterijen en elektro zijn apart
  gemodelleerd. Elk model rapporteert zowel R² op de trainingsset als een
  5-voudig gekruisvalideerde R²; alleen de tweede zegt iets over generalisatie.
  Inclusief een regressie die je in de browser zelf samenstelt.
- **Bereik inwoners** — percentage inwoners binnen 300/400/500 m van een
  inleverpunt, per gemeente en per PC4. Teller én noemer komen uit het
  CBS-vierkantstatistiekraster van 100 m, dus lege ruimte telt niet mee als
  onbereikte bevolking. Acht subsets langs twee assen: materiaalstroom en
  punttype. Milieustraten tellen alleen mee voor de gemeenten die ze mogen
  gebruiken.
- **Publieke POI's** — kandidaat-gastheren uit OpenStreetMap (supermarkt,
  bouwmarkt, drogisterij, milieustraat, OV, publieke gebouwen), met de bestaande
  inleverpunten eroverheen zodat zichtbaar is welke locaties er al één hebben.
- **Plaatsingsadvies** — welke postcodegebieden verdienen als eerste een extra
  punt, en waar precies. Prioriteit uit vier gewogen z-scores; concrete plekken
  uit de bewoonde witte vlekken, gesnapt naar een gastheer die de stroom aankan.
- **Netwerkplanner** — greedy set-cover over de kandidaat-locaties: schuif het
  aantal nieuwe punten omhoog en kijk de witte vlekken dicht lopen. De
  **combi-modus** rekent er het pakketpuntennetwerk bij en zoekt locaties die
  beide tegelijk kunnen zijn, met een synergie-index per locatie.

De gemeente-gebonden lagen (POI's, plaatsingsadvies, netwerkplanner) zijn eerst
voor een pilotset van acht gemeenten gegenereerd; de PC4-lagen zijn landelijk.

### Installatie

```bash
cd webapp
npm install
npm run dev
```

Open <http://localhost:3000>.

Zet `NEXT_PUBLIC_SITE_URL` als er een eigen domein aan de deployment hangt; alle
canonical-URL's, OG-tags en embed-snippets lezen die waarde.

---

## Python-backend

### Installatie

```bash
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

### Gebruik

```bash
# 1. Gemeentegrenzen + inwoneraantallen (PDOK + CBS)
#    Haalt alleen op als de cache leeg is of het een refresh-week is.
python scripts/fetch_pdok_boundaries.py
python scripts/fetch_pdok_boundaries.py --force   # forceer een refresh

# 2. Bronnen ophalen (elk schrijft een eigen cache in data/)
python scripts/statiegeld_fetch_all.py
python scripts/stibat_fetch_all.py
python scripts/open_fetch_all.py           # --skip-grid slaat de milieustraten-pass over
python scripts/droppie_fetch_all.py
python scripts/statiedrive_fetch_all.py

# 3. GeoJSON per gemeente + landelijk overzicht + provinciale grenzen
python scripts/batch_generate.py
python scripts/batch_generate.py --only zwolle,amsterdam,vlieland   # snelle test
python scripts/create_national_overview.py
python scripts/create_provincial_boundaries.py

# 4. Statistieken en historie
python scripts/compute_statistics.py
python scripts/update_totals_history.py

# Losse gemeente inspecteren
python main.py --gemeente Zwolle
python main.py --gemeente Amsterdam --format csv --output amsterdam.csv
```

#### Analyselagen

Deze draaien op dezelfde GeoJSON's plus drie externe datasets: het CBS
100 m-vierkantstatistiekraster, de PC4-polygonen en OpenStreetMap-POI's. De
eerste twee stappen zijn eenmalig en de resultaten worden gecached.

```bash
# Eenmalige inputs (groot, gitignored, regenereerbaar)
python scripts/fetch_pois.py                        # Overpass, ~10 min voor alles
python scripts/split_pois_by_municipality.py --only pilot

# 1. Analysebestand: de per-gemeente GeoJSON's samengevoegd, mét
#    gemeenteBeperking (die het landelijke bestand bewust weglaat)
python scripts/build_analysis_points.py

# 2. Bereik van inwoners (landelijk, ~40 s)
python scripts/compute_population_coverage.py

# 3. PC4-tabel en regressiemodellen (landelijk)
python scripts/build_pc4_stats.py
python scripts/fit_pc4_model.py

# 4. Plaatsingsadvies en netwerkplanner (per gemeente)
python scripts/suggest_placements.py --only pilot
python scripts/plan_inleverpunt_network.py --only pilot

# Landelijk uitrollen: vervang --only pilot door --only all
```

De combi-modus van de netwerkplanner leest
`data/pakketpunten_snapshot.geojson`, een momentopname van de
convenant-pakketpuntenviewer. Verversen betekent dat bestand opnieuw kopiëren;
de datum in de metadata wordt in de UI getoond.

---

## Architectuur

```
Bron-API's  →  scripts/*_fetch_all.py  →  data/*_all_locations.json   (cache per bron)
                                              ↓
                          api_client.py  →  spatial join op PDOK-grenzen
                                              ↓
                     scripts/batch_generate.py  →  webapp/public/data/{slug}.geojson
```

**Coördinatenstelsels.** WGS84 (EPSG:4326) voor alle API's, GeoJSON en webkaarten;
RD New (EPSG:28992) voor alles wat in meters moet — buffers, oppervlaktes,
point-in-polygon. Altijd omzetten naar RD New vóór metrisch werk, en terug voor output.

**Geofencing.** Elk punt wordt via een spatial join tegen de officiële
gemeentepolygonen van PDOK aan één gemeente toegewezen. De join draait één keer over
alle ~33.700 punten in plaats van 342 keer per gemeente.

**Robuustheid.** Elke bron schrijft via `scripts/cache_guard.py`. Levert een fetch
niets op, of meer dan 20% minder dan de bestaande cache, dan blijft de oude cache
staan en eindigt het script met exitcode 2. De workflow logt dat als waarschuwing en
gaat verder — één kapotte bron sleept de rest van de dataset niet mee.

---

## Datamodel

Elk inleverpunt is een GeoJSON-`Feature` met deze eigenschappen:

| Veld | Betekenis |
|---|---|
| `merk` | bron: `StatiegeldNederland`, `StichtingOPEN`, `Droppie`, `Stibat`, `StatieDrive` |
| `puntType` | `automaat`, `balie`, `inzamelbak` of `milieustraat` |
| `materialen` | wat je hier kunt inleveren (PET, blik, glas, krat, batterijen, elektro, lampen, TL, armaturen) |
| `uitbetaling` | hoe statiegeld terugkomt (bon, donatie, Tikkie, retourpinnen, contant, Droppie-app) |
| `vrijToegankelijk` | of het punt zonder aankoop of afspraak bereikbaar is |
| `gemeenteBeperking` | gemeenten waarvan inwoners hier terechtkunnen (milieustraten) |
| `openingstijden` | per dag of als vrije tekst, waar de bron ze levert |

De vocabulaire staat in `normalize.py` (Python) en `webapp/types/inleverpunten.ts`
(TypeScript); die twee horen gelijk te lopen. Hetzelfde geldt voor de
analyse-subsets: `SUBSETS` in `normalize.py` tegenover `SUBSETS` in
`webapp/types/analyse.ts`.

De analyselagen slicen de puntenset langs twee onafhankelijke assen:

| As | Waarden |
|---|---|
| Materiaalstroom | `statiegeld` (PET, blik, glas, krat), `batterijen` (batterijen, lampen, TL, armaturen), `elektro` (klein, middel, groot) |
| Punttype | `automaat`, `balie`, `inzamelbak`, `milieustraat` |

Een punt hoort altijd bij `alles`, bij precies één punttype en bij nul tot drie
materiaalstromen. De assen worden bewust niet gekruist.

Het landelijke bestand (`nederland.geojson`) is bewust *verkort*: adres-,
openingstijd- en uitbetalingsvelden ontbreken om de download klein te houden. Dat
staat als `"reduced": true` in de metadata.

---

## API

| Endpoint | Doel |
|---|---|
| `GET /api/v1/municipalities` | alle gemeenten met slug, CBS-code en aantal punten |
| `GET /api/v1/municipality/{identifier}` | GeoJSON per gemeente (naam, slug of CBS-code) |
| `GET /api/download?slug=…&format=json\|csv` | download met `Content-Disposition` |
| `GET /api/v1/docs` | Redoc-documentatie op `public/openapi.yaml` |

Geen sleutel nodig; rate limits staan in de OpenAPI-spec.

---

## Wekelijkse update

`.github/workflows/update-data.yml` draait elke maandag om 02:00 UTC, en is ook
handmatig te starten via *workflow_dispatch*. De workflow haalt elke bron los op,
rapporteert anomalieën, regenereert alle GeoJSON, berekent de statistieken en commit
het resultaat naar `main`.

---

## Bronvermelding

Bij hergebruik van de data graag vermelden:

```
Databronnen:
- Statiegeld Nederland / Verpact (https://www.statiegeldnederland.nl)
- Stichting OPEN / Wecycle (https://www.wecycle.nl)
- Stibat / Lege Batterijen (https://www.legebatterijen.nl)
- Droppie (https://www.godroppie.com)
- StatieDrive (https://www.statiedrive.nl)
- Gemeentegrenzen © Kadaster / PDOK
- Inwoneraantallen © CBS
- Kaartmateriaal © OpenStreetMap-bijdragers
```

---

## Bekende beperkingen

- Straatcontainers voor glas, textiel, papier en PMD zitten nog niet in de dataset.
  OpenStreetMap (`amenity=recycling`) heeft er 40.000–80.000; die zouden de dataset
  ruwweg verviervoudigen en vragen om een eigen, minder frequente ophaalcyclus.
- Gemeentelijke milieustraten zijn meestal alleen toegankelijk voor inwoners van de
  betreffende gemeente. Dat staat in `gemeenteBeperking` waar de bron het aangeeft.
- Openingstijden zijn alleen beschikbaar waar de bron ze levert en kunnen verouderd zijn.
- Punten van verschillende bronnen op hetzelfde adres blijven aparte features. Gebruik
  het filter 'alleen gedeelde locaties' om die plekken te vinden.
- Dekkingscirkels zijn hemelsbreed: niet gecorrigeerd voor looproutes, water of hoogte.

Voor de analyselagen komt daar bij:

- De **capaciteitscijfers** in de netwerkplanner zijn expliciete aannames, geen
  gepubliceerde kentallen. Er bestaat geen openbaar cijfer voor inleveringen per
  inwoner per jaar per stroom; de UI labelt ze als aanname en noemt de registers
  die nog geraadpleegd moeten worden (Afvalfonds Verpakkingen, Stichting OPEN,
  Stibat).
- De **pakketpuntendata** in de combi-modus is een momentopname uit een andere
  repository, geen live koppeling. De datum staat in de UI.
- De **POI's** komen uit OpenStreetMap en zijn dus zo compleet als de
  vrijwilligers in dat gebied. Bus- en tramhaltes staan standaard uit als
  kandidaat: ze vormen veruit het dichtste raster en zouden het greedy-resultaat
  domineren, terwijl er geen statiegeldautomaat of balie op past.
- Het **regressiemodel** verklaart 30–60% van de variantie, afhankelijk van de
  stroom. Elektro is met R²(cv) ≈ 0,29 het zwakst: milieustraten volgen
  gemeentelijk beleid, niet de demografie. Vergelijk modellen op de
  cross-validatiescore, niet op R² van de trainingsset.
- Het **plaatsingsadvies** snapt ongeveer de helft van de voorstellen naar een
  echte gastheer. Dat is geen fout: een witte vlek ligt per definitie ≥400 m van
  de bestaande punten in die stroom, en voor statiegeld zíjn dat de supermarkten.
  Waar geen gastheer binnen loopafstand ligt, staat dat erbij — dat vraagt om een
  zelfstandige unit.
