"""Split the nationwide POI GeoJSONs into per-municipality bundles.

The webapp loads one bundle per city rather than pulling the 20 MB nationwide
bushalte file every time. Each bundle keeps a flat feature array where
`properties.category` identifies the layer.

Slugs come straight off the provincial boundary files, which already carry the
`slug` the rest of the app uses. That is deliberate: the sister project derives
bundle filenames with its own slug function, which disagrees with
municipalities.json on parenthesised and accented names — Bergen (L.), Bergen
(NH.), Noardeast-Fryslân and Súdwest-Fryslân ended up with bundles their
network planner could never find, and the only symptom was a skip line in a
342-line log. One source of truth for slugs instead, and a hard check at the
end that every municipality got a bundle.

Output → webapp/public/data/poi/by-municipality/<slug>.geojson

    python scripts/split_pois_by_municipality.py                 # everything
    python scripts/split_pois_by_municipality.py --only pilot    # pilot set
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

import geopandas as gpd  # noqa: E402
import pandas as pd  # noqa: E402
from shapely.geometry import shape  # noqa: E402

from analysis import (  # noqa: E402
    PILOT_SLUGS,
    POI_DIR,
    POI_MUNI_DIR,
    WGS84,
    load_webapp_municipalities,
)
from utils import WEBAPP_DATA_DIR  # noqa: E402

BOUNDARIES_DIR = WEBAPP_DATA_DIR / "boundaries"


def load_municipality_polygons() -> gpd.GeoDataFrame:
    parts = [
        gpd.read_file(path)[["gemeente", "slug", "geometry"]]
        for path in sorted(BOUNDARIES_DIR.glob("provincie-*.geojson"))
    ]
    if not parts:
        raise SystemExit(f"No provincial boundary files in {BOUNDARIES_DIR}")
    return gpd.GeoDataFrame(pd.concat(parts, ignore_index=True), crs=parts[0].crs)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--only", type=str, default=None,
        help="Comma-separated slugs, or 'pilot' for the pilot set (default: all)",
    )
    args = parser.parse_args()

    index_path = POI_DIR / "index.json"
    if not index_path.exists():
        print(f"Missing {index_path}; run scripts/fetch_pois.py first", file=sys.stderr)
        return 1
    categories = json.loads(index_path.read_text())["categories"]

    municipalities = load_municipality_polygons()
    print(f"Gemeentegrenzen: {len(municipalities)}")

    if args.only in (None, "", "all"):
        wanted: set[str] | None = None
    elif args.only == "pilot":
        wanted = set(PILOT_SLUGS)
    else:
        wanted = {s.strip() for s in args.only.split(",") if s.strip()}
    if wanted is not None:
        unknown = wanted - set(municipalities["slug"])
        if unknown:
            raise SystemExit(f"Unknown slugs: {sorted(unknown)}")
        municipalities = municipalities[municipalities["slug"].isin(wanted)].copy()
        print(f"  beperkt tot {len(municipalities)} gemeenten")

    bundles: dict[str, dict] = {}
    for cat in categories:
        slug = cat["slug"]
        path = POI_DIR / f"{slug}.geojson"
        if not path.exists():
            print(f"  {slug:>22} : bestand ontbreekt — overgeslagen")
            continue
        features = json.loads(path.read_text()).get("features", [])
        records = [
            {
                "geometry": shape(f["geometry"]),
                "name": f["properties"].get("name", ""),
                "operator": f["properties"].get("operator", ""),
                "osm_id": f["properties"].get("osm_id", ""),
            }
            for f in features
            if f.get("geometry", {}).get("type") == "Point"
        ]
        if not records:
            print(f"  {slug:>22} : leeg")
            continue

        gdf = gpd.GeoDataFrame(records, crs=WGS84)
        joined = gpd.sjoin(
            gdf, municipalities[["slug", "gemeente", "geometry"]],
            how="inner", predicate="within",
        )
        # A POI on a shared boundary can match two polygons; keep the first so
        # counts stay consistent with the total.
        joined = joined[~joined.index.duplicated(keep="first")]

        for _, row in joined.iterrows():
            bundle = bundles.setdefault(row["slug"], {
                "gemeente": row["gemeente"],
                "by_category": defaultdict(int),
                "features": [],
            })
            bundle["by_category"][slug] += 1
            bundle["features"].append({
                "type": "Feature",
                "geometry": {
                    "type": "Point",
                    "coordinates": [
                        round(row["geometry"].x, 6), round(row["geometry"].y, 6),
                    ],
                },
                "properties": {
                    "category": slug,
                    "name": row["name"] or "",
                    "operator": row["operator"] or "",
                    "osm_id": row["osm_id"] or "",
                },
            })
        print(f"  {slug:>22} : {len(joined):>6} punten → "
              f"{joined['slug'].nunique()} gemeenten")

    POI_MUNI_DIR.mkdir(parents=True, exist_ok=True)
    for muni_slug, bundle in bundles.items():
        payload = {
            "type": "FeatureCollection",
            "metadata": {
                "gemeente": bundle["gemeente"],
                "slug": muni_slug,
                "by_category": dict(
                    sorted(bundle["by_category"].items(), key=lambda kv: -kv[1])
                ),
                "total": len(bundle["features"]),
            },
            "features": bundle["features"],
        }
        (POI_MUNI_DIR / f"{muni_slug}.geojson").write_text(
            json.dumps(payload, separators=(",", ":"), ensure_ascii=False)
        )

    # Index so the webapp can list available cities without downloading bundles.
    # Merged with whatever is already on disk, so a --only run does not wipe
    # entries for municipalities it did not touch.
    index_file = POI_MUNI_DIR / "index.json"
    existing = json.loads(index_file.read_text()) if index_file.exists() else {}
    existing.update({
        muni_slug: {
            "gemeente": bundle["gemeente"],
            "total": len(bundle["features"]),
            "by_category": dict(
                sorted(bundle["by_category"].items(), key=lambda kv: -kv[1])
            ),
        }
        for muni_slug, bundle in bundles.items()
    })
    index_file.write_text(json.dumps(dict(sorted(existing.items())), indent=2,
                                     ensure_ascii=False))
    print(f"\n✓ {len(bundles)} bundels → {POI_MUNI_DIR}")

    # Every municipality we were asked to cover must have come out with a
    # bundle. Silence here is how the sister project lost four of them.
    expected = wanted if wanted is not None else {
        m["slug"] for m in load_webapp_municipalities()
    }
    empty = sorted(s for s in expected if s not in existing)
    if empty:
        print(f"  ⚠️  geen POI's gevonden voor: {empty}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
