"""Fetch public POI categories from OpenStreetMap (Overpass API), nationwide.

Writes one GeoJSON per category to webapp/public/data/poi/<slug>.geojson plus
an index.json. Consumed by the POI explorer, the placement advice and the
network planner, which all treat these as *candidate host locations* for an
inleverpunt.

The category list differs from the sister pakketpunten project in two ways.
Transformatorhuisjes are gone — you can bolt a parcel locker to one, but not a
staffed counter or a deposit machine. And four categories are added that only
matter here: glasbakken and milieustraten (existing waste infrastructure,
already street-adjacent and already visited for this purpose), bouwmarkten
(where Stichting OPEN and Stibat put their collection bins) and drogisterijen
(battery collection).

    python scripts/fetch_pois.py               # everything
    python scripts/fetch_pois.py glasbak       # one or more categories
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path
from typing import Iterable

import requests

ROOT = Path(__file__).parent.parent
OUT_DIR = ROOT / "webapp" / "public" / "data" / "poi"

# South, west, north, east — the whole country including the Wadden and
# Zeeland. Cheaper than an `[area:...]` filter and accurate enough; stray
# Belgian/German nodes get dropped by the municipality join downstream.
NL_BBOX = (50.65, 3.20, 53.75, 7.25)

OVERPASS_URL = "https://overpass-api.de/api/interpreter"
HEADERS = {"User-Agent": "inleverpuntenviewer/1.0 (POI fetch)"}

# slug → label, group, colour, icon, Overpass query body.
# `out center` so ways and relations come back as a single representative
# point we can render without further geometry work.
CATEGORIES: list[dict] = [
    # ── OV ────────────────────────────────────────────────────────────────
    {
        "slug": "ns_station",
        "label": "NS-stations",
        "group": "ov",
        "color": "#FFC900",
        "icon": "train",
        "query": """
          node[railway=station][station!=subway][station!=light_rail]({bbox});
          way[railway=station][station!=subway][station!=light_rail]({bbox});
          relation[railway=station][station!=subway][station!=light_rail]({bbox});
        """,
    },
    {
        "slug": "metro_station",
        "label": "Metrostations",
        "group": "ov",
        "color": "#E2231A",
        "icon": "metro",
        "query": """
          node[station=subway]({bbox});
          way[station=subway]({bbox});
          relation[station=subway]({bbox});
          node[railway=station][station=subway]({bbox});
        """,
    },
    {
        "slug": "tram_halte",
        "label": "Tramhaltes",
        "group": "ov",
        "color": "#0073B7",
        "icon": "tram",
        "query": """
          node[railway=tram_stop]({bbox});
          node[public_transport=stop_position][tram=yes]({bbox});
        """,
    },
    {
        "slug": "bus_halte",
        "label": "Bushaltes",
        "group": "ov",
        "color": "#1F8A4C",
        "icon": "bus",
        "query": """
          node[highway=bus_stop]({bbox});
        """,
    },
    {
        "slug": "ov_knooppunt",
        "label": "OV-knooppunten",
        "group": "ov",
        "color": "#6B46C1",
        "icon": "transit",
        "query": """
          node[public_transport=station]({bbox});
          way[public_transport=station]({bbox});
          relation[public_transport=station]({bbox});
        """,
    },
    # ── Afval & inzameling ────────────────────────────────────────────────
    {
        "slug": "milieustraat",
        "label": "Milieustraten",
        "group": "afval",
        "color": "#0F766E",
        "icon": "recycling",
        "query": """
          node[amenity=recycling][recycling_type=centre]({bbox});
          way[amenity=recycling][recycling_type=centre]({bbox});
        """,
    },
    {
        "slug": "glasbak",
        "label": "Glas- & textielcontainers",
        "group": "afval",
        "color": "#14B8A6",
        "icon": "container",
        "query": """
          node[amenity=recycling][recycling_type=container]({bbox});
        """,
    },
    # ── Publieke gebouwen ─────────────────────────────────────────────────
    {
        "slug": "gemeentehuis",
        "label": "Gemeentehuizen",
        "group": "publiek",
        "color": "#B45309",
        "icon": "townhall",
        "query": """
          node[amenity=townhall]({bbox});
          way[amenity=townhall]({bbox});
          relation[amenity=townhall]({bbox});
        """,
    },
    {
        "slug": "stadsdeelkantoor",
        "label": "Stadsdeelkantoren",
        "group": "publiek",
        "color": "#92400E",
        "icon": "district",
        "query": """
          node[office=government]["government"~"district|borough"]({bbox});
          way[office=government]["government"~"district|borough"]({bbox});
          relation[office=government]["government"~"district|borough"]({bbox});
          node[amenity=townhall]["townhall:type"="district"]({bbox});
          way[amenity=townhall]["townhall:type"="district"]({bbox});
        """,
    },
    {
        "slug": "bibliotheek",
        "label": "Bibliotheken",
        "group": "publiek",
        "color": "#4338CA",
        "icon": "library",
        "query": """
          node[amenity=library]({bbox});
          way[amenity=library]({bbox});
          relation[amenity=library]({bbox});
        """,
    },
    {
        "slug": "ziekenhuis",
        "label": "Ziekenhuizen",
        "group": "publiek",
        "color": "#DC2626",
        "icon": "hospital",
        "query": """
          node[amenity=hospital]({bbox});
          way[amenity=hospital]({bbox});
          relation[amenity=hospital]({bbox});
        """,
    },
    # ── Onderwijs ─────────────────────────────────────────────────────────
    {
        "slug": "universiteit",
        "label": "Universiteiten",
        "group": "onderwijs",
        "color": "#7C3AED",
        "icon": "university",
        "query": """
          node[amenity=university]({bbox});
          way[amenity=university]({bbox});
          relation[amenity=university]({bbox});
        """,
    },
    {
        "slug": "hogeschool",
        "label": "Hogescholen",
        "group": "onderwijs",
        "color": "#A855F7",
        "icon": "college",
        "query": """
          node[amenity=college]({bbox});
          way[amenity=college]({bbox});
          relation[amenity=college]({bbox});
        """,
    },
    {
        "slug": "middelbare_school",
        "label": "Middelbare scholen",
        "group": "onderwijs",
        "color": "#C026D3",
        "icon": "school",
        "query": """
          node[amenity=school]["isced:level"~"2|3"]({bbox});
          way[amenity=school]["isced:level"~"2|3"]({bbox});
          relation[amenity=school]["isced:level"~"2|3"]({bbox});
        """,
    },
    # ── Voorzieningen ─────────────────────────────────────────────────────
    {
        "slug": "sportveld",
        "label": "Sportcomplexen",
        "group": "voorzieningen",
        "color": "#16A34A",
        "icon": "sport",
        "query": """
          way[leisure=sports_centre]({bbox});
          relation[leisure=sports_centre]({bbox});
          way[leisure=stadium]({bbox});
          relation[leisure=stadium]({bbox});
        """,
    },
    {
        "slug": "winkelcentrum",
        "label": "Winkelcentra",
        "group": "voorzieningen",
        "color": "#EA580C",
        "icon": "mall",
        "query": """
          node[shop=mall]({bbox});
          way[shop=mall]({bbox});
          relation[shop=mall]({bbox});
        """,
    },
    {
        "slug": "supermarkt",
        "label": "Supermarkten",
        "group": "voorzieningen",
        "color": "#DB2777",
        "icon": "supermarket",
        "query": """
          node[shop=supermarket]({bbox});
          way[shop=supermarket]({bbox});
        """,
    },
    {
        "slug": "bouwmarkt",
        "label": "Bouwmarkten",
        "group": "voorzieningen",
        "color": "#F97316",
        "icon": "hardware",
        "query": """
          node[shop~"^(doityourself|hardware|trade)$"]({bbox});
          way[shop~"^(doityourself|hardware|trade)$"]({bbox});
        """,
    },
    {
        "slug": "drogisterij",
        "label": "Drogisterijen",
        "group": "voorzieningen",
        "color": "#0D9488",
        "icon": "chemist",
        "query": """
          node[shop=chemist]({bbox});
          way[shop=chemist]({bbox});
        """,
    },
    {
        "slug": "fietsenstalling",
        "label": "Fietsenstallingen (overdekt)",
        "group": "voorzieningen",
        "color": "#0891B2",
        "icon": "bike",
        "query": """
          node[amenity=bicycle_parking][bicycle_parking~"shed|lockers|building|underground|covered"]({bbox});
          way[amenity=bicycle_parking][bicycle_parking~"shed|lockers|building|underground|covered"]({bbox});
          node[amenity=bicycle_parking][covered=yes]({bbox});
          way[amenity=bicycle_parking][covered=yes]({bbox});
        """,
    },
    {
        "slug": "parkeergarage",
        "label": "Parkeergarages",
        "group": "voorzieningen",
        "color": "#475569",
        "icon": "garage",
        "query": """
          node[amenity=parking][parking~"multi-storey|underground"]({bbox});
          way[amenity=parking][parking~"multi-storey|underground"]({bbox});
          relation[amenity=parking][parking~"multi-storey|underground"]({bbox});
        """,
    },
    {
        "slug": "p_and_r",
        "label": "P+R-locaties",
        "group": "voorzieningen",
        "color": "#0EA5E9",
        "icon": "pr",
        "query": """
          node[amenity=parking][park_ride~"yes|designated"]({bbox});
          way[amenity=parking][park_ride~"yes|designated"]({bbox});
          relation[amenity=parking][park_ride~"yes|designated"]({bbox});
        """,
    },
]

CATEGORY_BY_SLUG = {c["slug"]: c for c in CATEGORIES}


def _build_query(body: str) -> str:
    bbox_str = ",".join(str(v) for v in NL_BBOX)
    return f"[out:json][timeout:180];({body.format(bbox=bbox_str).strip()});out center tags;"


def _fetch(query: str, attempt: int = 0) -> dict:
    try:
        response = requests.post(
            OVERPASS_URL, data={"data": query}, headers=HEADERS, timeout=300
        )
        response.raise_for_status()
        return response.json()
    except requests.HTTPError as error:
        if attempt < 2 and error.response.status_code in (429, 502, 503, 504):
            wait = 30 * (attempt + 1)
            print(f"    rate-limited / gateway timeout — {wait}s wachten en opnieuw")
            time.sleep(wait)
            return _fetch(query, attempt + 1)
        raise


def _to_features(elements: Iterable[dict], cat: dict) -> list[dict]:
    features = []
    for element in elements:
        if element["type"] == "node":
            lon, lat = element.get("lon"), element.get("lat")
        else:
            center = element.get("center") or {}
            lon, lat = center.get("lon"), center.get("lat")
        if lon is None or lat is None:
            continue
        tags = element.get("tags", {})
        features.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [round(lon, 6), round(lat, 6)]},
            "properties": {
                "osm_id": f"{element['type']}/{element['id']}",
                "category": cat["slug"],
                "name": tags.get("name") or tags.get("ref") or "",
                "operator": tags.get("operator", ""),
            },
        })
    return features


def write_category(cat: dict, features: list[dict]) -> dict:
    """Write one category file and return its index entry."""
    payload = {
        "type": "FeatureCollection",
        "metadata": {
            "slug": cat["slug"],
            "label": cat["label"],
            "group": cat["group"],
            "color": cat["color"],
            "icon": cat["icon"],
            "source": "OpenStreetMap (Overpass API)",
            "count": len(features),
        },
        "features": features,
    }
    out_path = OUT_DIR / f"{cat['slug']}.geojson"
    with open(out_path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, separators=(",", ":"), ensure_ascii=False)
    return {
        "slug": cat["slug"],
        "label": cat["label"],
        "group": cat["group"],
        "color": cat["color"],
        "icon": cat["icon"],
        "count": len(features),
        "file": f"poi/{cat['slug']}.geojson",
    }


def rebuild_index() -> None:
    """Rewrite index.json from whatever category files are on disk.

    Kept separate from the fetch loop so a partial run — or files copied in
    from elsewhere — still produces a consistent index in CATEGORIES order.
    """
    entries = []
    for cat in CATEGORIES:
        path = OUT_DIR / f"{cat['slug']}.geojson"
        if not path.exists():
            continue
        with open(path, encoding="utf-8") as handle:
            payload = json.load(handle)
        entries.append({
            "slug": cat["slug"],
            "label": cat["label"],
            "group": cat["group"],
            "color": cat["color"],
            "icon": cat["icon"],
            "count": len(payload.get("features", [])),
            "file": f"poi/{cat['slug']}.geojson",
        })
    with open(OUT_DIR / "index.json", "w", encoding="utf-8") as handle:
        json.dump({"categories": entries}, handle, indent=2, ensure_ascii=False)
    total = sum(e["count"] for e in entries)
    print(f"✓ index met {len(entries)} categorieën, {total:,} punten "
          f"→ {(OUT_DIR / 'index.json').relative_to(ROOT)}")


def main() -> int:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    only = set(sys.argv[1:]) or None
    if only:
        unknown = only - set(CATEGORY_BY_SLUG)
        if unknown:
            print(f"Onbekende categorieën: {sorted(unknown)}", file=sys.stderr)
            return 1

    for cat in CATEGORIES:
        if only and cat["slug"] not in only:
            continue
        print(f"→ {cat['slug']} ({cat['label']})…", flush=True)
        try:
            data = _fetch(_build_query(cat["query"]))
        except Exception as error:  # noqa: BLE001 — one dead category is not fatal
            print(f"    FOUT: {error}")
            continue
        features = _to_features(data.get("elements", []), cat)
        entry = write_category(cat, features)
        print(f"    {entry['count']:>6} punten  →  poi/{cat['slug']}.geojson")
        time.sleep(2)  # be polite to Overpass between categories

    rebuild_index()
    return 0


if __name__ == "__main__":
    sys.exit(main())
