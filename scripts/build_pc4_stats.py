"""Build one nationwide PC4 stats table.

Per PC4 polygon:
  - area_km2      accurate metric area from the RD New projection
  - population    CBS, latest year
  - municipality  from the full-resolution boundary cache
  - inleverpunten total plus a count per analysis subset and per brand
  - CBS enrichments: income, WOZ, SES-WOA, density, household composition

Output → webapp/public/data/pc4_stats.json

Serves both the regression training set behind the "Schatting" tab and the
PC4 map layer. The NDW loading-zone, emission-zone and BRON accident features
the sister pakketpunten project carries are deliberately absent: they exist to
explain freight and van traffic, and the person returning a crate of bottles
walks or cycles.

    python scripts/build_pc4_stats.py
"""

from __future__ import annotations

import json
import sys
from collections import Counter, defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

import geopandas as gpd  # noqa: E402
from shapely import wkt  # noqa: E402

from analysis import (  # noqa: E402
    PC4_PATH,
    RD_NEW,
    SUBSETS,
    WGS84,
    load_analysis_points,
)
from normalize import MERKEN  # noqa: E402
from utils import DATA_DIR, WEBAPP_DATA_DIR  # noqa: E402

CBS_PC4_PATH = DATA_DIR / "cbs_pc4.json"
CBS_INCOME_PATH = DATA_DIR / "cbs_pc4_income.json"
CBS_SES_PATH = DATA_DIR / "cbs_pc4_ses_woa.json"
CBS_EXTRA_PATH = DATA_DIR / "cbs_pc4_extra.json"
MUNI_CACHE_PATH = DATA_DIR / "municipality_polygon_cache.json"
OUTPUT = WEBAPP_DATA_DIR / "pc4_stats.json"

# Fields copied from each CBS enrichment file onto the PC4 row. Every one of
# these is a candidate regression feature; CBS suppresses cells for small PC4s,
# so any of them can be None.
INCOME_FIELDS = (
    "avg_income_household", "pct_low_income_household",
    "pct_high_income_household", "avg_woz_value",
)
SES_FIELDS = ("ses_woa_total", "ses_woa_welvaart", "ses_woa_arbeid")
EXTRA_FIELDS = (
    "urbanity", "oad", "pct_age_25_45", "pct_single_hh", "pct_multi_family",
    "pct_owner_occupied", "horeca_1km", "supermarket_1km", "station_km",
    "highway_km",
)


def jsonable(value):
    """None for anything JSON cannot represent.

    Both pandas (unmatched sjoin rows) and CBS (suppressed cells) hand us NaN,
    and `json.dumps(allow_nan=False)` rejects it. Missing has to reach the
    webapp as null, not as a number that silently reads as zero.
    """
    if value is None:
        return None
    if isinstance(value, float) and value != value:
        return None
    return value


def load_lookup(path: Path, key: str = "pc4") -> tuple[dict, dict | None]:
    """Return (per-PC4 lookup, provenance) for an optional enrichment file."""
    if not path.exists():
        print(f"  ⚠️  {path.name} ontbreekt — bijbehorende features vervallen")
        return {}, None
    with open(path, encoding="utf-8") as handle:
        payload = json.load(handle)
    meta = {
        "source": payload.get("source"),
        "reference_date": payload.get("reference_date"),
    }
    return payload.get(key, {}), meta


def main() -> int:
    print(f"{PC4_PATH.name} laden...")
    pc4_gdf = gpd.read_file(PC4_PATH)
    pc4_gdf["pc4"] = pc4_gdf["pc4"].astype(str).str.zfill(4)
    print(f"  → {len(pc4_gdf)} PC4-gebieden")

    print("Oppervlakte in EPSG:28992...")
    pc4_gdf["area_km2"] = (pc4_gdf.to_crs(RD_NEW).area / 1e6).round(4).fillna(0.0)

    with open(CBS_PC4_PATH, encoding="utf-8") as handle:
        cbs = json.load(handle)
    population_lookup: dict[str, int] = cbs.get("pc4_population", {})
    print(f"CBS bevolking: {len(population_lookup)} PC4's "
          f"({cbs.get('dataset')} {cbs.get('period')})")

    income_lookup, income_meta = load_lookup(CBS_INCOME_PATH)
    ses_lookup, ses_meta = load_lookup(CBS_SES_PATH)
    extra_lookup, extra_meta = load_lookup(CBS_EXTRA_PATH)

    # Municipality attribution from the full-resolution cache — the same
    # source the coverage layer uses, so the two tabs agree on which PC4
    # belongs where.
    print("PC4's aan gemeenten toewijzen...")
    with open(MUNI_CACHE_PATH, encoding="utf-8") as handle:
        muni_cache = json.load(handle)
    muni_gdf = gpd.GeoDataFrame(
        [
            {
                "municipality": entry.get("naam") or slug,
                "municipality_slug": entry.get("slug") or slug,
                "geometry": wkt.loads(entry["geometry_wkt"]),
            }
            for slug, entry in muni_cache.items()
        ],
        crs=WGS84,
    )
    centroids = pc4_gdf.copy()
    centroids["geometry"] = centroids.geometry.representative_point()
    # sjoin_nearest rather than a strict `within`: a handful of representative
    # points land in slivers between municipal polygons. For interior points
    # the distance is 0, so the result matches a `within` join everywhere else.
    # In RD, because "nearest" in degrees is not a distance.
    located = gpd.sjoin_nearest(
        centroids[["pc4", "geometry"]].to_crs(RD_NEW),
        muni_gdf[["municipality", "municipality_slug", "geometry"]].to_crs(RD_NEW),
        how="left",
    )
    located = located[~located.index.duplicated(keep="first")]
    pc4_to_muni = dict(zip(located["pc4"], located["municipality"]))
    pc4_to_slug = dict(zip(located["pc4"], located["municipality_slug"]))

    print("Inleverpunten laden en aan PC4's koppelen...")
    points_gdf = load_analysis_points()
    joined = gpd.sjoin(
        points_gdf, pc4_gdf[["pc4", "geometry"]], how="inner", predicate="within"
    )
    joined = joined[~joined.index.duplicated(keep="first")]
    print(f"  → {len(joined)}/{len(points_gdf)} punten binnen een PC4")

    counts: dict[str, dict] = {}
    for pc4, group in joined.groupby("pc4"):
        by_subset: Counter[str] = Counter()
        by_merk: dict[str, Counter] = defaultdict(Counter)
        for subsets, merk in zip(group["subsets"], group["merk"]):
            by_subset.update(subsets)
            by_merk[merk].update(subsets)
        counts[pc4] = {
            "total": int(by_subset.get("alles", 0)),
            "by_subset": {s: int(by_subset.get(s, 0)) for s in SUBSETS},
            "by_merk": {
                m: {s: int(c.get(s, 0)) for s in SUBSETS if c.get(s)}
                for m, c in sorted(by_merk.items())
            },
        }

    empty_counts = {
        "total": 0,
        "by_subset": {s: 0 for s in SUBSETS},
        "by_merk": {},
    }

    stats: dict[str, dict] = {}
    for _, row in pc4_gdf.iterrows():
        pc4 = row["pc4"]
        income = income_lookup.get(pc4, {})
        ses = ses_lookup.get(pc4, {})
        extra = extra_lookup.get(pc4, {})
        municipality = pc4_to_muni.get(pc4)
        entry = {
            "area_km2": float(row["area_km2"]),
            "population": int(population_lookup.get(pc4, 0)),
            "municipality": municipality if isinstance(municipality, str) else None,
            "municipality_slug": jsonable(pc4_to_slug.get(pc4)) or None,
            "inleverpunten": counts.get(pc4, empty_counts),
        }
        for field in INCOME_FIELDS:
            entry[field] = jsonable(income.get(field))
        for field in SES_FIELDS:
            entry[field] = jsonable(ses.get(field))
        for field in EXTRA_FIELDS:
            entry[field] = jsonable(extra.get(field))
        stats[pc4] = entry

    payload = {
        "generated_from": {
            "pc4_polygons": PC4_PATH.name,
            "inleverpunten": "data/analysis_points.geojson",
            "cbs_dataset": cbs.get("dataset"),
            "cbs_period": cbs.get("period"),
            "cbs_income": income_meta,
            "cbs_ses_woa": ses_meta,
            "cbs_extra": extra_meta,
        },
        "subsets": list(SUBSETS),
        "merken": list(MERKEN),
        "stats": dict(sorted(stats.items())),
    }
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps(payload, separators=(",", ":"), allow_nan=False))
    print(f"✓ {len(stats)} PC4's → {OUTPUT} "
          f"({OUTPUT.stat().st_size / 1024:.0f} KB)")
    total = sum(v["inleverpunten"]["total"] for v in stats.values())
    print(f"  {total} inleverpunten toegewezen")
    return 0


if __name__ == "__main__":
    sys.exit(main())
