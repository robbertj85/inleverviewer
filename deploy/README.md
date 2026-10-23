# Inleverpuntenviewer op de Hetzner-VPS (Coolify)

Draait als Coolify-resource (build pack **Docker Compose**, `docker-compose.yaml`
in de repo-root) op `prototype.transportlab.app/inleverpuntenviewer`. Zelfde opzet
als laadpalenviewer: Nginx Proxy Manager staat ervoor en praat over het gedeelde
`coolify`-netwerk met een vaste alias.

```
NPM (prototype.transportlab.app)
  └─ location /inleverpuntenviewer/  ->  http://inleverpuntenviewer:80   (alias van service `web`, geen URI-rewrite)
        web (nginx)
        ├─ /inleverpuntenviewer/data/*, /municipalities.json  -> volume inlever-site/current (live)
        └─ de rest                                             -> app-inleverpuntenviewer:3000 (Next.js)
                                                                  └─ API's en analysepagina's lezen inlever-site/current
worker (deploy/scheduler.py)
  └─ maandag 04:00   grenzen -> 5 bronnen + pakketpunten -> GeoJSON -> statistieken
                     -> totalenhistorie -> analyselagen (alle 342 gemeenten)
                     in een kopie van current; bij succes current in één keer omgezet
```

Wat er anders is dan op Vercel:

| | Vercel + GitHub Action | Coolify |
|---|---|---|
| Data ophalen | Action commit wekelijks ~400 bestanden naar `main` | worker schrijft direct naar een volume |
| Publiceren | elke datacommit = volledige deploy | niets: nginx serveert de nieuwe release live; alleen code-pushes deployen |
| Halve run | commit bleef uit | vorige dataset blijft live, halve release wordt weggegooid |
| Analysepagina's | bij de build voorgerenderd | per request van schijf (`force-dynamic`) |
| Cache | `max-age=3600` | `no-cache` + ETag (altijd vers, 304 als ongewijzigd) |
| API-limiet | 30/u, in de praktijk vaak gereset (instances wisselen) | 120/u per IP, en die geldt echt (één langlevende server) |
| Analytics | Vercel Analytics | optioneel Umami (`NEXT_PUBLIC_UMAMI_*`) |

## Bestanden

| Bestand | Doel |
|---|---|
| `../docker-compose.yaml` | de drie services + volumes `inlever-site`, `inlever-data` |
| `Dockerfile.nginx` + `nginx.conf` | voorkant: data van het volume, rest naar de app |
| `Dockerfile.web` | Next.js standalone, gebouwd met `NEXT_PUBLIC_BASE_PATH=/inleverpuntenviewer` |
| `Dockerfile.worker` | Python 3.12 + geopandas, start `scheduler.py serve` |
| `scheduler.py` | wekelijkse run, losse scripts, seed (zie docstring) |
| `analysis_stage.py` | analyselagen als stap van de wekelijkse run (zie hieronder) |
| `push-analysis-inputs.sh` | eenmalig: CBS 100 m-raster naar het data-volume |
| `seed-data.sh` | eenmalig: data uit git → volumes (incl. analyselagen) |
| `pull-data.sh` | live dataset → je lokale `webapp/public` |
| `reload-proxy.sh` | NPM herladen na een redeploy (zie hieronder) |
| `lib.sh` | vindt de Coolify-container (`<service>-<uuid>`) via labels |

Volumes (Coolify zet de resource-uuid ervoor):

```
inlever-site  current -> releases/<stamp>/{municipalities.json,data/}   (huidige + vorige release)
inlever-data  bron-caches, CBS/OV-invoer, geocode-cache,
              backups/totals_history-YYYY-MM-DD.json (14 stuks), worker-state.json
```

`totals_history.json` is het enige bestand dat aangroeit (één entry per week);
de rest is opnieuw te maken. De worker bewaart na elke run een kopie in
`inlever-data/backups`.

## Eerste keer uitrollen (cutover)

1. **Branch pushen**: `git push -u origin vps-migration`.

2. **Coolify-resource aanmaken** (project `coolify-tb`, environment `production`):
   - *+ New → Public Repository* → `https://github.com/robbertj85/inleverviewer`
   - branch **`vps-migration`** (tot stap 6; `main` krijgt tot dan nog bot-commits)
   - Build Pack: **Docker Compose**, Docker Compose Location `/docker-compose.yaml`
   - geen domein invullen (NPM regelt dat)
   - *Advanced*: **Consistent Container Names** aan, Custom Internal Name
     `inleverpuntenviewer`. Containers heten dan `web-`, `app-` en
     `worker-inleverpuntenviewer`; nginx proxyt naar `app-inleverpuntenviewer`
     (niet naar `app`: op het gedeelde `coolify`-netwerk antwoordt de `app` van
     een andere applicatie ook op die naam). Zonder deze instelling geeft de site 502.
   - Environment Variables (optioneel): `NEXT_PUBLIC_UMAMI_SRC`, `NEXT_PUBLIC_UMAMI_WEBSITE_ID`
   - Deploy. De worker ziet een leeg volume en wacht op de seed.

3. **Seeden**: `./deploy/seed-data.sh`. Zet de laatste data uit git (ook de
   analyselagen, die de wekelijkse run niet maakt) in de volumes en publiceert
   die. Binnen 10 minuten start de worker vanzelf een eerste verse run (~10-20 min).

4. **Nginx Proxy Manager**: proxy host `prototype.transportlab.app` →
   *Custom locations* → `/inleverpuntenviewer` → `http` / `inleverpuntenviewer` / `80`.
   Controleer `https://prototype.transportlab.app/inleverpuntenviewer`.

5. **GitHub Action uitzetten**:
   `gh workflow disable "Update inleverpunten data" -R robbertj85/inleverviewer`

6. **Mergen naar `main`** en in Coolify de branch op `main` zetten. Dit verwijdert
   de workflow en de gegenereerde data uit de repo (de git-historie blijft; CI
   test tegen de laatste gecommitte dataset).

7. **Vercel**: redirect naar de nieuwe URL of verwijderen. Let op: de
   inleverpuntenplanner leest standaard `inleverpuntenviewer.vercel.app`
   (`INLEVERPUNTEN_API`); zet die eerst om.

## Analyselagen

Na de punten bouwt de run de analysetabs (bereik, schatting, plaatsingsadvies,
netwerkplanner, POI's) voor **alle** gemeenten (`analysis_stage.py`):

- **POI's** (Overpass, 10–35 min): maandelijks, of zodra een gemeente geen bundel heeft.
  Elke week daarna: publiek/privaat terrein per POI (`classify_poi_ownership.py`,
  BGT via PDOK, gecachet per POI: alleen nieuwe POI's kosten een opzoeking) en
  de bundels per gemeente opnieuw.
- **Landelijk** (analysepunten, bereik, PC4-tabel, regressiemodel), ~1,5 min: elke week.
  Het model wordt landelijk gefit, dus elke gemeente schuift mee.
- **Plaatsingsadvies** (~5 min): elke week, alle gemeenten.
- **Netwerkplanner**: alleen gemeenten waarvan iets is veranderd: eigen
  inleverpunten, pakketpunten binnen de grens, POI-bundel, of gedeelde invoer
  (code, CBS-raster, grenzen). Vingerafdrukken in `inlever-data/analysis-state.json`.
  Alles opnieuw: `analyse --all` (~30 s op 7 kernen).

Een fout in deze stap houdt de punten niet tegen: de analysebestanden van de vorige
release worden teruggezet en de run publiceert gewoon (anomalie `analysis:<stap>`).

Pakketpunten (combi-modus) komen elke week van
`https://pakketpuntenviewer.nl/data/nederland.geojson` (statisch, geen rate limit;
`scripts/fetch_pakketpunten.py`). Die wordt daar maandagochtend vernieuwd, na onze
run van 04:00, dus we lopen een week achter.

Eenmalig nodig, want geen script haalt het op: `./deploy/push-analysis-inputs.sh`
(CBS 100 m-raster, 85 MB). Zonder dat bestand wordt de stap overgeslagen.

## Dagelijks gebruik

- Nieuwe code: push naar `main` (Coolify deployt) of *Redeploy* in Coolify. Data-volumes blijven staan.
- **Na een redeploy die `web` opnieuw aanmaakt: `./deploy/reload-proxy.sh`.** NPM
  zoekt de alias maar één keer op, bij het laden van zijn config; de nieuwe
  container krijgt een ander IP en NPM geeft 502 tot hij herlaadt.
- Logs: Coolify → resource → *Logs* → `worker`, of
  `ssh hetzner docker logs -f worker-inleverpuntenviewer`.
- Run nu: `docker exec worker-inleverpuntenviewer python deploy/scheduler.py run`.
- Alleen de analyselagen: `docker exec worker-inleverpuntenviewer python deploy/scheduler.py analyse [--all]`.
- Eén analysescript opnieuw (ook via een kopie, dus atomair):
  `docker exec worker-inleverpuntenviewer python deploy/scheduler.py run-script scripts/suggest_placements.py`.
  De invoer daarvan (CBS-gpkg, OV-data) is gitignored en staat niet in de seed;
  draai eerst het bijbehorende fetch-script op dezelfde manier.
- Terug naar de vorige release: `docker exec worker-inleverpuntenviewer python deploy/scheduler.py rollback`
  (de volgende run bouwt weer verder op wat dan live staat).
- Instelbaar in de worker: `INLEVER_WEEKDAY` (0 = maandag), `INLEVER_RUN_AT` (`04:00`),
  `INLEVER_BACKUP_KEEP` (14).

Lokaal de hele stack testen: `docker network create coolify` (eenmalig), dan
`docker compose -p inlevertest -f docker-compose.yaml -f <override met ports: ["8088:80"] op web> up -d --build`,
seeden met `git archive <rev> webapp/public data | gzip | docker compose -p inlevertest exec -T worker python deploy/scheduler.py seed`
→ `http://localhost:8088/inleverpuntenviewer`.
