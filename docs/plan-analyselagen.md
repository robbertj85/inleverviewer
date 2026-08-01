# Plan — vijf analyselagen in de /data-tab

Doel: feature-pariteit met de convenant-variant van de pakketpuntenviewer
(`../pakketpunten-analyse`), vertaald naar inleverpunten, plus één uitbreiding die
daar nog niet in zit: een gecombineerde netwerkplanner voor locaties die
tegelijk inleverpunt én pakketpunt kunnen zijn.

## Vastgestelde keuzes

| Keuze | Besluit |
|---|---|
| Subsets voor bereik/planner | **Allebei** — materiaalstroom *en* punttype als twee onafhankelijke assen (9 subsets) |
| Datavolume | **Pilot**: 5–10 gemeenten voor de gemeente-gebonden lagen; landelijk waar het model dat eist |
| 3D-viewer | **Niet nu** — geen three.js, geen Google 3D Tiles, geen `/3d/[slug]`-routes |

### Subsets, concreet

```python
SUBSETS = [
    "alles",
    # materiaalstroom
    "statiegeld",   # pet-groot, pet-klein, blik, glas, krat
    "batterijen",   # batterijen, lampen, tl-buizen, armaturen
    "elektro",      # elektro-klein, elektro-middel, elektro-groot
    # punttype
    "automaat", "balie", "inzamelbak", "milieustraat",
]
```

Dat zijn 8 subsets × 3 afstanden (300/400/500 m) = 24 buffer-unions per scope,
tegen 9 in de pakketpuntenvariant. De twee assen zijn niet orthogonaal
gekruist (geen `statiegeld × automaat`) — dat zou 36 combinaties geven zonder
dat de meeste cellen gevuld raken. Wie de kruising wil, kan hem in de UI
benaderen via de bestaande filters op de hoofdkaart.

**Aandachtspunt milieustraat.** `gemeenteBeperking` is niet leeg voor
milieustraten: die zijn alleen toegankelijk voor inwoners van bepaalde
gemeenten. Voor `scope=national` (buffers over de gemeentegrens heen) moet een
milieustraat dus *niet* meetellen buiten zijn eigen toegestane gemeenten. Dit
is een echt verschil met pakketpunten en zit in geen van de bronscripts.

### Pilotgemeenten (voorstel)

`amsterdam, rotterdam, den-haag, utrecht, zwolle, apeldoorn, sudwest-fryslan,
aa-en-hunze` — G4 voor dichtheid, Zwolle als thuisbasis, Apeldoorn als
middelgroot, en twee landelijke gemeenten omdat juist daar de witte vlekken
zitten. Landelijk uitrollen is daarna `--all` in plaats van `--only`.

**Uitzondering:** Schatting en Bereik worden wél landelijk berekend. Het
regressiemodel heeft alle ~4.070 PC4's als trainingsset nodig, en de
gemeentevergelijking in de bereik-tab is zonder landelijke context zinloos.
Kosten: `pc4_stats.json` ≈ 5 MB, `population_coverage.json` ≈ 6 MB. De
gemeente-gebonden lagen (POI-bundels, plaatsingsadvies, netwerkplanner)
blijven bij de pilotset.

---

## Fase 0 — Gedeelde datafundering

Nieuw in `data/` en `webapp/public/data/`. Niets hiervan bestaat nu in deze
repo; alles is te kopiëren of opnieuw op te halen uit `../pakketpunten-analyse`.

| Artefact | Herkomst | Committen? |
|---|---|---|
| `webapp/public/data/pc4.geojson` (2,2 MB) | kopie uit pakketpunten-analyse (CBS PC4 2024) | ja |
| `data/cbs/cbs_vk100_2024_inhabited.gpkg` (85 MB) | `scripts/fetch_cbs_100m_grid.py` (porten) | **nee** — gitignore, regenereerbaar |
| `data/cbs_pc4.json` (inwoners per PC4) | `scripts/fetch_cbs_pc4_data.py` (porten) | ja |
| `data/cbs_pc4_income.json`, `_ses_woa.json`, `_extra.json` | drie fetch-scripts porten | ja |
| `data/ov/gtfs_stops.json` (6,8 MB) | `scripts/fetch_gtfs_ov_stops.py` (porten) | nee |
| `webapp/public/data/poi/*.geojson` + `by-municipality/` | `scripts/fetch_pois.py` + `split_pois_by_municipality.py` | alleen pilot-bundels |
| `data/pakketpunten_snapshot.geojson` (10,7 MB) | kopie van `nederland.geojson` uit pakketpunten-analyse | ja (nodig voor fase 6) |

De NDW-, BRON- en emissiezone-verrijkingen (`loading_zones`, `crashes_*`,
`in_emission_zone`) zijn in de pakketpuntenvariant bedoeld om vrachtverkeer en
laad-/losdruk te verklaren. Voor inleverpunten — waar de consument te voet of
per fiets komt — zijn ze grotendeels irrelevant. **Voorstel: overslaan.** Dat
scheelt vijf fetch-scripts en houdt de feature-set van het model uitlegbaar.
De CBS-verrijkingen (inkomen, SES-WOA, stedelijkheid, huishoudsamenstelling)
gaan wél mee: die verklaren inleveraanbod wel degelijk.

**POI-uitbreiding voor dit domein.** `fetch_pois.py` krijgt er twee categorieën
bij die voor inleverpunten essentieel zijn en in de pakketpuntenvariant
ontbreken:

```python
{"slug": "milieustraat", "query": "node/way[amenity=recycling][recycling_type=centre]"}  # bestaat al als 'inzamelpunt', hernoemen
{"slug": "glasbak",      "query": "node[amenity=recycling][recycling_type=container]"}   # nieuw — ~30k punten in NL
{"slug": "bouwmarkt",    "query": "node/way[shop=doityourself|hardware]"}                # nieuw — Stibat/OPEN-inleverpunten
{"slug": "drogisterij",  "query": "node[shop=chemist]"}                                  # nieuw — batterij-inzameling
```

**Slug-bug om niet over te nemen** — zie "Gevonden fouten" onderaan.

Scripts die 1-op-1 mee kunnen (met pad-aanpassingen):
`fetch_pc4_boundaries.py`, `fetch_cbs_pc4_data.py`, `fetch_cbs_pc4_income.py`,
`fetch_cbs_pc4_ses_woa.py`, `fetch_cbs_pc4_extra.py`, `fetch_cbs_100m_grid.py`,
`fetch_gtfs_ov_stops.py`, `fetch_pois.py`, `split_pois_by_municipality.py`.

---

## Fase 1 — `Bereik inwoners` (tab 5)

**Backend:** `scripts/compute_population_coverage.py` (nieuw, ~550 regels,
geport).

Wijzigingen t.o.v. het origineel:

1. `LOCKER_TYPES`/`categorize()` vervangen door `subsets_of(props)` die per punt
   teruggeeft in welke van de 8 subsets het valt (een punt zit in meerdere:
   `alles`, één punttype, en 0–3 materiaalstromen).
2. Milieustraat-restrictie: bij `scope=national` telt een punt met
   `gemeenteBeperking != null` alleen mee voor cellen in de toegestane
   gemeenten. Implementatie: een extra masker per subset-union, niet één
   nationale union.
3. `MUNI_CACHE_PATH` wijst al naar `data/municipality_polygon_cache.json` —
   bestaat hier al (14 MB, full-resolution). Goed.
4. **Performance-fix** (zie fouten #3): `prep(union)` één keer per
   `(subset, distance)` bouwen in plaats van per PC4-aanroep. Met 24 unions ×
   4.071 PC4's scheelt dat naar schatting een factor 5–10 in doorlooptijd.

**Output:** `webapp/public/data/population_coverage.json` (~6 MB) — landelijk,
per gemeente en per PC4, met `national` en `strict` scope.

**Frontend:** `components/PopulationReachReport.tsx` (33 KB, geport) +
`app/data-export/bereik/page.tsx`.

Aanpassingen: subset-segmentcontrol krijgt twee rijen (materiaal / punttype),
de G4/G40-cohorten blijven, kleuren en typografie naar de design tokens van
deze app (`bg-card`, `text-muted-foreground`, `--green-900`) in plaats van de
harde `bg-white`/`text-gray-900` uit de bron. CSV-export blijft.

---

## Fase 2 — `Schatting inleverpunten` (tab 6)

**Backend:** `scripts/build_pc4_stats.py` + `scripts/fit_pc4_model.py` (nieuw,
geport).

`build_pc4_stats.py` telt per PC4 het aantal inleverpunten uit
`nederland.geojson`, opgesplitst naar merk, punttype en materiaalstroom, en
plakt de CBS-verrijkingen erbij. `fit_pc4_model.py` fit een OLS-model
`inleverpunten ~ inwoners + oppervlakte` plus een uitgebreid model met
inkomen/SES-WOA/stedelijkheid, schrijft `predicted_points` en
`delta_vs_predicted` terug.

Twee inhoudelijke aanpassingen:

- **Aparte modellen per stroom.** Eén model over "alle inleverpunten" mengt
  supermarkt-statiegeldautomaten (volgen de detailhandel) met milieustraten
  (één per gemeente, volgen bestuurlijke grenzen). Voorstel: drie modellen —
  `statiegeld`, `batterijen`, `elektro` — plus het totaal. De UI krijgt een
  extra keuzeknop naast de bestaande model-toggle.
- **Cross-validatie.** Zie fout #1: de bron rapporteert alleen in-sample R².
  Ik voeg 5-fold CV toe en toon `R²_cv` naast `R²`, zodat de "K=8 is beter dan
  het basismodel"-claim toetsbaar wordt.

**Frontend:** `components/RegressionReport.tsx` (65 KB, geport) +
`app/data-export/schatting/page.tsx`.

De bron kleurt de scatterplot rood/blauw op basis van door carriers
aangeleverde *pijnpunten* (`pc4_painpoints.json`). Dat bestand heeft geen
tegenhanger in dit domein en die pagina's porten we niet. **De pijnpunt-laag
vervalt**; de scatter kleurt in plaats daarvan op stedelijkheidsklasse (`oad`),
wat dezelfde visuele functie heeft (waar zit de afwijking) zonder verzonnen
data. Het `PC4DetailPanel`, de variabelenkiezer en de model-presets blijven.

---

## Fase 3 — `Publieke POI's` (tab 7)

**Backend:** fase 0 levert de bundels al. Geen extra script.

**Frontend:** `components/PoiExplorer.tsx` (21 KB, geport) +
`utils/poiIcons.tsx` + `app/data-export/pois/page.tsx`.

Aanpassingen: pijnpunt-overlay vervalt (zelfde reden als fase 2). In plaats
daarvan een overlay met de bestaande inleverpunten uit `{slug}.geojson`, zodat
je direct ziet welke POI's al een inleverpunt hebben en welke niet — dat is
precies de vraag die deze tab in dit domein moet beantwoorden. Groepslabels
worden uitgebreid met de nieuwe categorieën uit fase 0.

---

## Fase 4 — `Plaatsingsadvies` (tab 8)

**Backend:** `scripts/suggest_placements.py` (nieuw, ~970 regels, geport).

Kernlogica ongewijzigd: per PC4 een prioriteitsscore uit vier z-gescoorde
signalen (onderbediening t.o.v. het model, ongedekte inwoners binnen 400 m,
dichtheid, overlappenalty), daarna per top-10-PC4 tot drie concrete plekken via
witte-vlek-analyse op het CBS 100 m-raster, gesnapt naar een POI of BAG-pand.

Aanpassingen:

1. **Per materiaalstroom.** De score wordt per stroom berekend; de UI kiest
   welke. Een PC4 met vijf statiegeldautomaten en nul batterij-inleverpunten is
   onderbediend, en dat verdwijnt in een totaalscore.
2. **POI-snapvoorkeur herzien.** `_POI_SNAP_TIER` in de bron zet supermarkt en
   winkelcentrum op tier 0. Voor inleverpunten klopt dat voor statiegeld, maar
   voor batterijen/lampen horen bouwmarkt en drogisterij erbij, en voor elektro
   de milieustraat. Per stroom een eigen tier-tabel.
3. **BAG-gebruiksdoel-tiers herzien.** `winkelfunctie` blijft tier 0;
   `industriefunctie` is voor een milieustraat juist passend in plaats van
   "last resort".
4. **Cross-PC4-exclusie** (zie fout #2): de exclusiebuffer wordt gedeeld over
   alle PC4's van een gemeente in plaats van per PC4 gereset, zodat twee
   voorstellen niet 200 m uit elkaar landen en dezelfde inwoners claimen.
5. `--only <pilotgemeenten>` bij de eerste run.

**Output:** `webapp/public/data/placement_suggestions.json` (~1 MB voor de
pilotset).

**Frontend:** `components/PlacementSuggestionsReport.tsx` (76 KB, geport, het
grootste bestand), `SuggestionMiniMap.tsx`, `SuggestionBigMap.tsx`,
`app/data-export/suggesties/page.tsx`. De `/3d/[slug]/[pc4]`-route vervalt.

---

## Fase 5 — `Netwerkplanner` (tab 9)

**Backend:** `scripts/plan_inleverpunt_network.py` (nieuw, geport van
`plan_locker_network.py`).

Greedy set-cover blijft identiek: kandidaten uit de POI-bundel, vraag uit het
CBS 100 m-raster geclipt op de gemeentegrens, iteratief de kandidaat met de
grootste marginale populatiewinst binnen R. `cell_rank` per scenario voor de
witte-vlek-animatie.

Aanpassingen:

1. **`TYPE_META` naar dit domein.** Supermarkt en winkelcentrum blijven
   prioriteit 0–1 (daar staan de statiegeldautomaten al). Transformatorhuisje
   gaat eruit — je zet er een pakketkluis neer, geen inzamelbak. Erbij:
   milieustraat, bouwmarkt, drogisterij, glasbak-cluster.
2. **`starts` per stroom.** `greenfield`, `bestaande-automaten`,
   `alle-inleverpunten`, en per stroom `bestaand-statiegeld` /
   `bestaand-batterijen` / `bestaand-elektro`.
3. **Capaciteitsmodel opnieuw opbouwen.** `CAPACITY_DEFAULTS` in de bron rekent
   pakketten/persoon/jaar → vakken → kolommen → strekkende meter. Voor
   inleverpunten is de equivalent: kg of stuks per inwoner per jaar →
   containervolume → legingsfrequentie. **Openstaand punt:** dit heeft een bron
   nodig. Kandidaten: Afvalfonds Verpakkingen (statiegeldvolumes),
   Stichting OPEN jaarverslag (WEEE kg/inwoner), Stibat jaarverslag
   (batterijen). Ik bouw de structuur met expliciet gelabelde aannames en een
   `bron`-veld per getal, zoals de bron dat ook doet, en laat de getallen leeg
   tot ze bevestigd zijn — liever een zichtbaar gat dan een verzonnen kental.
4. **Gemeentegrens uit de cache**, niet uit `{slug}.geojson` (zie fout #4).

**Output:** `webapp/public/data/inleverpunt_network/{slug}.json`, ~70 KB per
gemeente voor de pilotset.

**Frontend:** `components/NetworkPlanner.tsx` (24 KB) +
`NetworkPlannerMap.tsx` (23 KB) + `NetworkCoverageChart.tsx` (5 KB) +
`lib/inleverpuntNetwork.ts` (geport van `lockerNetwork.ts`) +
`app/data-export/netwerkplanner/page.tsx`. De `/3d/[slug]`-route vervalt; de
knop ernaartoe ook.

---

## Fase 6 — Uitbreiding: gecombineerd inleverpunt + pakketpunt

Dit zit niet in de convenant-variant. De vraag: *wat zijn de beste plekken om
tegelijk inleverpunt én pakketpunt te zijn?*

De logische grond eronder is sterk: beide zijn out-of-home-voorzieningen met
dezelfde succesfactoren (loopafstand, sociale controle, 24/7-toegang,
straat-adjacentie voor de logistiek) en dezelfde natuurlijke gastheer (de
supermarkt). En er is een echte synergie: wie een pakket ophaalt kan meteen
zijn flesjes inleveren — één verplaatsing in plaats van twee.

**Data:** `data/pakketpunten_snapshot.geojson` (kopie, 10,7 MB, met een
`snapshot_date` in de metadata zodat duidelijk is dat het een momentopname is
en geen live koppeling).

**Backend:** `--mode combi` in `plan_inleverpunt_network.py`.

Twee dekkingstoestanden per CBS-cel in plaats van één:

```
covered_i[cel]  — binnen R van een inleverpunt
covered_p[cel]  — binnen R van een pakketpunt
```

Beide geseed uit de bestaande netwerken. Per kandidaat:

```
gain_i = Σ pop over cellen binnen R die nog geen inleverpunt hebben
gain_p = Σ pop over cellen binnen R die nog geen pakketpunt hebben
```

Twee selectieregels, allebei uitgeleverd zodat de UI kan wisselen:

| Regel | Formule | Wat het optimaliseert |
|---|---|---|
| `gewogen` | `α·gain_i + (1−α)·gain_p` | totale dekkingswinst; α-slider in de UI, default 0,5 |
| `synergie` | `min(gain_i, gain_p)` | alleen plekken die op *beide* assen leveren |

Plus per pick een **synergie-index** `2·min(gain_i, gain_p) / (gain_i + gain_p)`
∈ [0, 1]: 1 = de plek dient beide netwerken evenveel, 0 = hij dient er maar
één. Dat is het getal waar de vraag om draait, en het is los te sorteren van de
absolute winst.

**Gastheergeschiktheid.** Niet elke kandidaat kan beide huisvesten. Een
supermarkt of winkelcentrum wel (kassa + buitengevel), een glasbak niet. Een
extra veld `combi_geschikt: bool` per `TYPE_META`-type, en in de `synergie`-
regel een harde filter daarop. Transparant, geen verborgen weging.

**Output:** extra scenariosleutels `"{r}|combi-gewogen"` en `"{r}|combi-synergie"`,
met per pick `{c, gain_i, gain_p, synergie}` en twee `cell_rank`-arrays.

**Frontend:** een vierde startmodus in de netwerkplanner, met:
- α-slider (alleen bij `gewogen`);
- een dubbele dekkingsgrafiek (twee lijnen: % inwoners met inleverpunt binnen
  R, % met pakketpunt binnen R, tegen aantal geplaatste locaties);
- een tabel "beste dubbelfunctie-locaties" gesorteerd op synergie-index, met
  per rij het POI-type, de twee winsten en welke van beide netwerken er al
  aanwezig is;
- op de kaart drie markerkleuren: alleen-inleveren, alleen-pakket, beide.

**Eerlijkheidsclausule in de UI:** de pakketpuntendata is een momentopname uit
een andere repo. Datum en herkomst komen bovenaan de tab te staan.

---

## Fase 7 — Integratie

1. **Navigatie:** `app/data-export/layout.tsx` — vijf tabs erbij in de bestaande
   `TABS`-array met lucide-icons en een `beta`-badge. De tabstrip scrollt al
   horizontaal op mobiel; met negen tabs wordt dat krap, dus een overflow-groep
   ("Analyse ▾") voor de vijf nieuwe.
2. **`next.config.ts`:** `outputFileTracingIncludes` uitbreiden met
   `population_coverage.json`, `pc4_stats.json`, `placement_suggestions.json`
   en `inleverpunt_network/**` — anders 404'en de server-componenten in
   productie terwijl ze lokaal werken (staat als valkuil in CLAUDE.md).
3. **CSP:** geen nieuwe hosts nodig; PDOK BAG WFS en Overpass worden alleen
   server-side/in scripts aangeroepen.
4. **Tests:** `tests/smoke.spec.ts` uitbreiden met één test per nieuwe tab
   (laadt, rendert de kaart/tabel, geen console-errors), plus een test die
   controleert dat elke pilotgemeente een netwerkbestand heeft — precies het
   gat waar de bron in valt (fout #5).
5. **Docs:** `CLAUDE.md` bijwerken met de nieuwe run-volgorde en de valkuilen;
   `README.md` met de nieuwe tabs.
6. **Vocabulaire-synchronisatie:** de subset-definities komen in `normalize.py`
   én `webapp/types/inleverpunten.ts` — dezelfde tweeledigheid die CLAUDE.md al
   voor merken/materialen benoemt.

---

## Volgorde en omvang

| Fase | Nieuwe/gewijzigde bestanden | Inschatting |
|---|---|---|
| 0 — datafundering | 9 scripts, ~12 dataartefacten | groot, veel wachttijd (Overpass, CBS) |
| 1 — Bereik | 1 script, 2 frontend | middel |
| 2 — Schatting | 2 scripts, 2 frontend | middel |
| 3 — POI's | 3 frontend | klein |
| 4 — Plaatsingsadvies | 1 script, 4 frontend | groot |
| 5 — Netwerkplanner | 1 script, 5 frontend | groot |
| 6 — Combi-uitbreiding | 1 scriptmodus, 3 frontend | middel |
| 7 — Integratie | layout, config, tests, docs | klein |

Fases 1–5 zijn onderling onafhankelijk zodra fase 0 staat; fase 6 heeft fase 5
nodig. Elke fase eindigt met een schone `npm run build` en `npm run lint`.

---

## Gevonden fouten in de convenant-pakketpuntenviewer

Vijf dingen die ik onderweg tegenkwam. Ik neem ze geen van alle over.

**1. `fit_pc4_model.py` — R² is in-sample, en `find_best_model.py` selecteert
daarop.** `LinearRegression.score(X, y)` op de trainingsset. Best-subset-selectie
op in-sample R² kiest per definitie het model met de meeste variabelen: R²
kan niet dalen als je een feature toevoegt. De conclusie "K=8 haalt R² 0,539
tegen 0,439 voor het basismodel" (`fit_pc4_model.py:47-49`) toont dus niet aan
dat K=8 beter generaliseert. Fix: k-fold CV, en de CV-score rapporteren naast
de in-sample score.

**2. `suggest_placements.py` — exclusiebuffer wordt per PC4 gereset.** In
`process_municipality` begint elke PC4 uit de top-10 met
`exclusion = buffer_union` (regel 275). Binnen één PC4 klopt de iteratieve
uitsluiting, maar twee aangrenzende PC4's kunnen elk een voorstel plaatsen dat
op 200 m van dat van de buur ligt, en beide claimen dezelfde inwoners in
`est_new_pop_within_400m`. Bij optelling van de voorstellen per gemeente wordt
de winst dus overschat. Fix: exclusie meedragen over de PC4-lus heen.

**3. `compute_population_coverage.py` — `prep()` wordt per aanroep opnieuw
gebouwd.** `_mask_cells_in_union` doet `pu = prep(union)` bij iedere aanroep
(regel ~124), en wordt 9× per PC4 aangeroepen voor 4.071 PC4's — ~37.000 keer
prepareren van een landelijke MultiPolygon. Geen correctheidsfout, wel een
forse vertraging. Fix: één keer prepareren per `(subset, distance)` en de
prepared geometrie in de worker-globals zetten.

**4. `plan_locker_network.py` gebruikt een andere gemeentegrens dan
`compute_population_coverage.py`.** De planner leest de grens uit
`{slug}.geojson` (regel ~250) — die is voor weergave vereenvoudigd tot 20 m —
terwijl de dekkingsberekening `municipality_polygon_cache.json` op volle
resolutie gebruikt. De noemer "aantal inwoners in de gemeente" verschilt
daardoor licht tussen de twee tabs voor dezelfde gemeente. Fix: allebei uit de
cache.

**5. `split_pois_by_municipality.py` — slug-mismatch laat vier gemeenten
stilletjes buiten de netwerkplanner.** De lokale `_slug()` (regel 29) strikt
niet-alfanumerieke tekens weg en zet geen `â`/`û` om, terwijl
`municipalities.json` een andere conventie hanteert:

| gemeente | `municipalities.json` | POI-bundel | netwerkbestand |
|---|---|---|---|
| Bergen (L.) | `bergen-(l.)` | `bergen-l` | ontbreekt |
| Bergen (NH.) | `bergen-(nh.)` | `bergen-nh` | ontbreekt |
| Noardeast-Fryslân | `noardeast-fryslan` | `noardeast-frysl-n` | ontbreekt |
| Súdwest-Fryslân | `sudwest-fryslan` | `sudwest-frysl-n` | ontbreekt |

`plan_locker_network.py` zoekt `poi/by-municipality/{slug}.geojson`, vindt niets
en retourneert `"skip: geen POI-kandidaten"` — een regel in de log die niet
opvalt tussen 342 andere. Súdwest-Fryslân is met ~90.000 inwoners de
qua oppervlak grootste gemeente van Nederland; die ontbreekt gewoon in de tab.
Fix: één gedeelde slug-functie, plus een assertie dat elke gemeente uit
`municipalities.json` een POI-bundel heeft. Deze repo gebruikt al `bergen-l` /
`bergen-nh`, dus de bug reproduceert hier niet vanzelf — maar de assertie wil
ik er wel in.
