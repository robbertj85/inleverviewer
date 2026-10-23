#!/usr/bin/env python3
"""
Publiek of privaat terrein, per POI.

Whether a candidate location stands on public or private ground decides who
gets to say yes to an inleverpunt there: on public ground the municipality
(permit, placement), on private ground the owner. The network planner can
therefore plan with only public, only private, or both.

There is no open national register of who owns a plot: the Kadaster's open
kadastrale kaart has parcels without owners, and owner data is a paid lookup
per object. So this classifies the *ground the point stands on*, from three
sources, first match wins:

  1. OSM tags          ownership=municipal/public/national/... → publiek,
                       ownership=private → privaat; operator:type likewise;
                       an operator named "Gemeente …", a province, Rijks-
                       waterstaat or ProRail → publiek, a commercial parking
                       operator (Q-Park, Interparking, APCOA…) → privaat. A
                       building alone says nothing: Zwolle's own car parks
                       are buildings too.
  2. Category          where the type settles it: a bus stop or glass bank
                       stands in the public street, a supermarket is a shop.
  3. BGT (PDOK)        for the types that can be either (sports grounds,
                       bicycle parking, car parks, P+R, stations): the BGT
                       object under the point, via the OGC API.
                       pand (building) or erf (private yard)       → privaat
                       wegdeel / ondersteunend wegdeel (road)      → publiek
                       other unvegetated ground (plein, verharding) → publiek
                       groenvoorziening (public green)             → publiek
                       agricultural land                            → privaat
                       wegdeel functie "inrit" (driveway)           → privaat
                       anything else                                → onbekend

Every POI gets `eigendom` (publiek | privaat | onbekend) and `eigendom_bron`
(the rule that decided it). It is a classification of terrain, not a legal
ownership statement; the UI says so.

BGT lookups are cached per POI (osm_id + coordinates) in
data/poi_ownership_cache.json, so after the first run only new or moved POIs
cost a request.

Usage:
    python scripts/classify_poi_ownership.py
    python scripts/classify_poi_ownership.py --workers 8
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import requests
from shapely import STRtree, wkt
from shapely.geometry import Point, shape

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from utils import DATA_DIR, WEBAPP_DATA_DIR  # noqa: E402

POI_DIR = WEBAPP_DATA_DIR / "poi"
CACHE_PATH = DATA_DIR / "poi_ownership_cache.json"
MUNI_CACHE_PATH = DATA_DIR / "municipality_polygon_cache.json"
BGT_API = "https://api.pdok.nl/lv/bgt/ogc/v1/collections/{collection}/items"

PUBLIEK, PRIVAAT, ONBEKEND = "publiek", "privaat", "onbekend"

OSM_OWNERSHIP = {
    "municipal": PUBLIEK, "public": PUBLIEK, "national": PUBLIEK, "state": PUBLIEK,
    "county": PUBLIEK, "provincial": PUBLIEK, "government": PUBLIEK,
    "private": PRIVAAT, "private_nonprofit": PRIVAAT, "religious": PRIVAAT,
}
OSM_OPERATOR_TYPE = {
    "government": PUBLIEK, "public": PUBLIEK, "municipal": PUBLIEK,
    "private": PRIVAAT, "business": PRIVAAT, "commercial": PRIVAAT,
}

OPERATOR_PUBLIEK = re.compile(
    r"\b(gemeente|provincie|rijkswaterstaat|rijksvastgoedbedrijf|prorail|"
    r"staatsbosbeheer|waterschap|hoogheemraadschap)\b", re.I)
OPERATOR_PRIVAAT = re.compile(
    r"\b(q-park|interparking|apcoa|indigo|p1|parkbee|yellowbrick)\b", re.I)

# Types whose category settles the question. Institutions (schools,
# hospitals, universities) own or lease their own buildings: the
# municipality is not the party that says yes, even where it has a role in
# school housing.
CATEGORY_RULES = {
    "bus_halte": (PUBLIEK, "categorie: halte in de openbare weg"),
    "tram_halte": (PUBLIEK, "categorie: halte in de openbare weg"),
    "metro_station": (PUBLIEK, "categorie: openbaar vervoer"),
    "glasbak": (PUBLIEK, "categorie: container in de openbare ruimte"),
    "milieustraat": (PUBLIEK, "categorie: gemeentelijke afvalvoorziening"),
    "gemeentehuis": (PUBLIEK, "categorie: gemeentelijk gebouw"),
    "stadsdeelkantoor": (PUBLIEK, "categorie: gemeentelijk gebouw"),
    "bibliotheek": (PUBLIEK, "categorie: gemeentelijk gefinancierde voorziening"),
    "supermarkt": (PRIVAAT, "categorie: winkelpand"),
    "bouwmarkt": (PRIVAAT, "categorie: winkelpand"),
    "drogisterij": (PRIVAAT, "categorie: winkelpand"),
    "winkelcentrum": (PRIVAAT, "categorie: winkelvastgoed"),
    "ziekenhuis": (PRIVAAT, "categorie: instellingsvastgoed"),
    "universiteit": (PRIVAAT, "categorie: instellingsvastgoed"),
    "hogeschool": (PRIVAAT, "categorie: instellingsvastgoed"),
    "middelbare_school": (PRIVAAT, "categorie: instellingsvastgoed (schoolbestuur)"),
}

# Asked in this order; the first collection with an object under the point wins.
BGT_ORDER = ("pand", "onbegroeidterreindeel", "wegdeel", "ondersteunendwegdeel",
             "begroeidterreindeel")
AGRARISCH = {"grasland agrarisch", "bouwland", "fruitteelt", "boomteelt"}

# Half a metre either side, in degrees: enough to hit the polygon under the
# point without pulling in the neighbours.
BBOX_HALF = 0.000005

_local = threading.local()


def session() -> requests.Session:
    if not hasattr(_local, "session"):
        _local.session = requests.Session()
        _local.session.headers["User-Agent"] = "inleverpuntenviewer/poi-eigendom"
    return _local.session


def bgt_objects(collection: str, lon: float, lat: float) -> list[dict]:
    bbox = f"{lon - BBOX_HALF},{lat - BBOX_HALF},{lon + BBOX_HALF},{lat + BBOX_HALF}"
    for attempt in range(4):
        try:
            response = session().get(
                BGT_API.format(collection=collection),
                params={"bbox": bbox, "limit": 20, "f": "json"},
                timeout=30,
            )
            if response.status_code in (429, 500, 502, 503, 504):
                raise requests.HTTPError(response=response)
            response.raise_for_status()
            return response.json().get("features", [])
        except (requests.RequestException, ValueError):
            if attempt == 3:
                raise
            time.sleep(2 ** attempt * 2)
    return []


def classify_bgt(lon: float, lat: float) -> tuple[str, str]:
    point = Point(lon, lat)
    for collection in BGT_ORDER:
        for feature in bgt_objects(collection, lon, lat):
            geometry = feature.get("geometry")
            # Ended objects stay in the BGT with an end date; skip them.
            props = feature.get("properties", {})
            if not geometry or props.get("eind_registratie"):
                continue
            if not shape(geometry).buffer(1e-7).contains(point):
                continue
            voorkomen = props.get("fysiek_voorkomen") or ""
            if collection == "pand":
                return PRIVAAT, "BGT: pand"
            if collection == "onbegroeidterreindeel":
                if voorkomen == "erf":
                    return PRIVAAT, "BGT: erf"
                return PUBLIEK, f"BGT: onbegroeid terrein ({voorkomen or 'onbekend'})"
            if collection in ("wegdeel", "ondersteunendwegdeel"):
                if (props.get("functie") or "") == "inrit":
                    return PRIVAAT, "BGT: inrit"
                return PUBLIEK, f"BGT: {collection} ({props.get('functie') or voorkomen})"
            if collection == "begroeidterreindeel":
                if voorkomen == "groenvoorziening":
                    return PUBLIEK, "BGT: groenvoorziening"
                if voorkomen in AGRARISCH:
                    return PRIVAAT, f"BGT: {voorkomen}"
                return ONBEKEND, f"BGT: {voorkomen or 'begroeid terrein'}"
    return ONBEKEND, "BGT: geen object gevonden"


def classify_tags(props: dict) -> tuple[str, str] | None:
    ownership = (props.get("ownership") or "").lower()
    if ownership in OSM_OWNERSHIP:
        return OSM_OWNERSHIP[ownership], f"OSM: ownership={ownership}"
    operator_type = (props.get("operator_type") or "").lower()
    if operator_type in OSM_OPERATOR_TYPE:
        return OSM_OPERATOR_TYPE[operator_type], f"OSM: operator:type={operator_type}"
    operator = props.get("operator") or ""
    if OPERATOR_PUBLIEK.search(operator):
        return PUBLIEK, f"OSM: exploitant {operator}"
    if OPERATOR_PRIVAAT.search(operator):
        return PRIVAAT, f"OSM: exploitant {operator}"
    return None


def netherlands():
    """A point-in-NL test over the municipality polygons.

    Overpass is queried with a bounding box, which takes in a strip of
    Belgium and Germany: about two thirds of the sports grounds and bicycle
    parkings it returns. The BGT covers the Netherlands only, and the split
    drops those POIs anyway, so they are not looked up.
    """
    cache = json.loads(MUNI_CACHE_PATH.read_text())
    polygons = [wkt.loads(entry["geometry_wkt"]) for entry in cache.values()]
    tree = STRtree(polygons)

    def inside(lon: float, lat: float) -> bool:
        return len(tree.query(Point(lon, lat), predicate="within")) > 0

    return inside


OUTSIDE = (ONBEKEND, "buiten Nederland")


def cache_key(props: dict, lon: float, lat: float) -> str:
    return f"{props.get('osm_id', '')}@{lon:.5f},{lat:.5f}"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workers", type=int, default=int(os.environ.get("INLEVER_BGT_WORKERS", "8")))
    args = parser.parse_args()

    index = json.loads((POI_DIR / "index.json").read_text())
    categories = [c["slug"] for c in index["categories"]]
    try:
        cache: dict[str, list[str]] = json.loads(CACHE_PATH.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        cache = {}

    in_nl = netherlands()
    outside: set[str] = set()
    files: dict[str, dict] = {}
    todo: list[tuple[str, float, float]] = []
    for slug in categories:
        path = POI_DIR / f"{slug}.geojson"
        if not path.exists():
            continue
        payload = json.loads(path.read_text())
        files[slug] = payload
        for feature in payload["features"]:
            props = feature["properties"]
            lon, lat = feature["geometry"]["coordinates"][:2]
            key = cache_key(props, lon, lat)
            if not in_nl(lon, lat):
                outside.add(key)
                continue
            if slug in CATEGORY_RULES or classify_tags(props) is not None or key in cache:
                continue
            todo.append((key, lon, lat))

    print(f"BGT-opzoekingen: {len(todo)} nieuw, {len(cache)} uit de cache "
          f"({args.workers} tegelijk)", flush=True)
    failed = 0
    started = time.monotonic()
    with ThreadPoolExecutor(args.workers) as pool:
        futures = {pool.submit(classify_bgt, lon, lat): key for key, lon, lat in todo}
        for done, future in enumerate(as_completed(futures), 1):
            key = futures[future]
            try:
                cache[key] = list(future.result())
            except Exception as error:  # noqa: BLE001 — retried next run
                failed += 1
                if failed <= 5:
                    print(f"  ⚠ {key}: {error}", flush=True)
            if done % 2000 == 0:
                rate = done / (time.monotonic() - started)
                print(f"  {done}/{len(todo)} ({rate:.1f}/s)", flush=True)
                CACHE_PATH.write_text(json.dumps(cache, separators=(",", ":")))

    tmp = CACHE_PATH.with_suffix(".tmp")
    tmp.write_text(json.dumps(cache, separators=(",", ":")))
    os.replace(tmp, CACHE_PATH)

    totals: dict[str, dict[str, int]] = {}
    for slug, payload in files.items():
        counts = totals.setdefault(slug, {PUBLIEK: 0, PRIVAAT: 0, ONBEKEND: 0})
        for feature in payload["features"]:
            props = feature["properties"]
            lon, lat = feature["geometry"]["coordinates"][:2]
            key = cache_key(props, lon, lat)
            result = (
                (OUTSIDE if key in outside else None)
                or classify_tags(props)
                or CATEGORY_RULES.get(slug)
                or tuple(cache.get(key, (ONBEKEND, "BGT: opzoeking mislukt")))
            )
            props["eigendom"], props["eigendom_bron"] = result
            if result != OUTSIDE:
                counts[result[0]] += 1
        path = POI_DIR / f"{slug}.geojson"
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(payload, separators=(",", ":"), ensure_ascii=False))
        os.replace(tmp, path)

    print(f"Binnen Nederland ({len(outside)} POI's over de grens overgeslagen):")
    for slug, counts in totals.items():
        print(f"  {slug:>20}: {counts[PUBLIEK]:>6} publiek  {counts[PRIVAAT]:>6} privaat  "
              f"{counts[ONBEKEND]:>6} onbekend")
    if failed:
        print(f"⚠ {failed} opzoekingen mislukt; ze staan als onbekend en worden de "
              f"volgende run opnieuw geprobeerd.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
