"""
Fetch Dutch municipality boundaries from PDOK and population figures from CBS.

Produces three artefacts:

  data/municipality_polygon_cache.json  — slug -> {naam, code, provincie, geometry_wkt}
  data/municipalities_all.json          — index used by the Python pipeline
  webapp/public/municipalities.json     — index used by the webapp (incl. Nederland)

The polygon cache is only rebuilt when it is empty or when we are in a refresh
week (last week of June/December), which is when Dutch municipal
reorganisations land. Every other run reads straight from disk and makes no
network calls at all.

  python scripts/fetch_pdok_boundaries.py           # honour the cache
  python scripts/fetch_pdok_boundaries.py --force   # rebuild regardless
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from shapely import wkt
from shapely.geometry import shape

from utils import (  # noqa: E402
    DATA_DIR,
    MUNICIPALITIES_FILE,
    PROJECT_ROOT,
    cache_needs_refresh,
    fetch_json,
    load_polygon_cache,
    make_session,
    polygon_cache_stats,
    save_polygon_cache,
    slugify,
    store_polygon,
)

PDOK_ITEMS_URL = (
    "https://api.pdok.nl/kadaster/bestuurlijkegebieden/ogc/v1"
    "/collections/gemeentegebied/items"
)
PDOK_PAGE_SIZE = 100  # PDOK caps page size; paging is cursor-based via rel=next

# CBS 37230ned — "Bevolkingsontwikkeling; regio per maand". Gives an up-to-date
# population per municipality, keyed on the same GM-code PDOK uses.
CBS_BASE = "https://opendata.cbs.nl/ODataApi/odata/37230ned"
CBS_PERIODS_URL = f"{CBS_BASE}/Perioden"
CBS_POPULATION_URL = f"{CBS_BASE}/TypedDataSet"

WEBAPP_PUBLIC = PROJECT_ROOT / "webapp" / "public"


def fetch_pdok_municipalities(session) -> list[dict]:
    """Page through the PDOK OGC API and collect every municipality feature.

    PDOK pages with an opaque cursor rather than an offset, so we follow the
    `rel=next` link until it disappears.
    """
    features: list[dict] = []
    url: str | None = PDOK_ITEMS_URL
    params: dict | None = {"f": "json", "limit": PDOK_PAGE_SIZE}

    for _ in range(50):  # defensive: NL has ~342 municipalities
        payload = fetch_json(session, url, params=params, timeout=180)
        batch = payload.get("features", [])
        if not batch:
            break

        features.extend(batch)
        print(f"  📥 {len(features)} municipalities fetched...")

        next_link = next(
            (link["href"] for link in payload.get("links", []) if link.get("rel") == "next"),
            None,
        )
        if not next_link:
            break

        url, params = next_link, None

    return features


def fetch_cbs_population(session) -> dict[str, int]:
    """Return {GM-code: inhabitants} from CBS 37230ned, for the newest month.

    Population is cosmetic (it drives the 'per 10.000 inwoners' statistics), so
    a failure here degrades the output rather than breaking the run.
    """
    populations: dict[str, int] = {}

    try:
        periods = fetch_json(session, CBS_PERIODS_URL, params={"$format": "json"}, timeout=120)
        monthly = [p["Key"] for p in periods.get("value", []) if "MM" in p.get("Key", "")]
        if not monthly:
            print("  ⚠️  CBS returned no monthly periods")
            return populations
        latest = monthly[-1]

        payload = fetch_json(
            session,
            CBS_POPULATION_URL,
            params={
                "$filter": f"startswith(RegioS,'GM') and Perioden eq '{latest}'",
                "$format": "json",
            },
            timeout=180,
        )
    except Exception as error:  # noqa: BLE001
        print(f"  ⚠️  Could not fetch CBS population data: {error}")
        return populations

    for row in payload.get("value", []):
        code = (row.get("RegioS") or "").strip()
        # Prefer end-of-period; fall back to start for the most recent month,
        # which CBS sometimes publishes before the closing figure is known.
        inhabitants = (row.get("BevolkingAanHetEindeVanDePeriode_15")
                       or row.get("BevolkingAanHetBeginVanDePeriode_1"))
        if code and isinstance(inhabitants, int):
            populations[code] = inhabitants

    print(f"  👥 CBS population figures for {len(populations)} municipalities ({latest})")
    return populations


def build_cache(session) -> None:
    """Fetch boundaries + population and write the polygon cache."""
    print("🗺️  Fetching municipality boundaries from PDOK...")
    features = fetch_pdok_municipalities(session)

    if not features:
        raise RuntimeError("PDOK returned no municipality features")

    print(f"  ✅ {len(features)} municipalities from PDOK")

    print("👥 Fetching population figures from CBS...")
    populations = fetch_cbs_population(session)

    cache = load_polygon_cache()
    cache.clear()

    for feature in features:
        properties = feature.get("properties", {})
        name = properties.get("naam")
        code = properties.get("identificatie")

        if not name or not feature.get("geometry"):
            continue

        geometry = shape(feature["geometry"])
        if not geometry.is_valid:
            geometry = geometry.buffer(0)

        slug = slugify(name)
        store_polygon(slug, {
            "naam": name,
            "slug": slug,
            "code": code,
            "provincie": properties.get("ligt_in_provincie_naam"),
            "population": populations.get(code, 0),
            "geometry_wkt": wkt.dumps(geometry, rounding_precision=6),
        })

    save_polygon_cache(force=True)
    print(f"  💾 Polygon cache written: {len(load_polygon_cache())} municipalities")


def write_indexes() -> None:
    """Write the municipality index files consumed by the pipeline and webapp."""
    cache = load_polygon_cache()

    municipalities = []
    for slug, entry in cache.items():
        geometry = wkt.loads(entry["geometry_wkt"])
        centroid = geometry.centroid
        municipalities.append({
            "name": entry["naam"],
            "slug": slug,
            "province": entry.get("provincie") or "Onbekend",
            "population": entry.get("population", 0),
            "code": entry.get("code"),
            "center": [round(centroid.y, 6), round(centroid.x, 6)],
        })

    municipalities.sort(key=lambda m: m["name"])

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with open(MUNICIPALITIES_FILE, "w", encoding="utf-8") as handle:
        json.dump(municipalities, handle, ensure_ascii=False, indent=2)
    print(f"  💾 {MUNICIPALITIES_FILE.name}: {len(municipalities)} municipalities")

    # The webapp index additionally carries the national roll-up entry.
    national_population = sum(m["population"] for m in municipalities)
    webapp_index = [{
        "name": "Nederland (totaal)",
        "slug": "nederland",
        "province": "Alle provincies",
        "population": national_population,
        "code": None,
    }] + [
        {k: v for k, v in m.items() if k != "center"}
        for m in municipalities
    ]

    WEBAPP_PUBLIC.mkdir(parents=True, exist_ok=True)
    with open(WEBAPP_PUBLIC / "municipalities.json", "w", encoding="utf-8") as handle:
        json.dump(webapp_index, handle, ensure_ascii=False, indent=2)
    print(f"  💾 webapp/public/municipalities.json: {len(webapp_index)} entries")


def main() -> int:
    parser = argparse.ArgumentParser(description="Fetch PDOK municipality boundaries")
    parser.add_argument("--force", action="store_true", help="rebuild even if the cache is fresh")
    args = parser.parse_args()

    stats = polygon_cache_stats()
    print(f"📦 Polygon cache: {stats['total']} municipalities, next refresh {stats['next_refresh']}")

    if args.force or cache_needs_refresh():
        reason = "forced" if args.force else "cache empty or refresh week"
        print(f"🔄 Rebuilding polygon cache ({reason})")
        session = make_session()
        build_cache(session)
    else:
        print("✅ Cache is current; no network calls needed")

    write_indexes()
    return 0


if __name__ == "__main__":
    sys.exit(main())
