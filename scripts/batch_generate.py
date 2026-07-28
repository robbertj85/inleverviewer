"""
Generate one GeoJSON file per municipality for the webapp.

Reads the source caches, assigns every point to a municipality, and writes
webapp/public/data/{slug}.geojson containing the points plus that
municipality's boundary.

Buffer zones are deliberately *not* written here. The webapp recomputes
300/400/500 m coverage client-side with Turf.js, which keeps the files small
and lets the user toggle radii without a round trip. The Python buffers in
geo_analysis.py feed the coverage statistics instead.

    python scripts/batch_generate.py
    python scripts/batch_generate.py --only zwolle,amsterdam,vlieland
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

import geopandas as gpd  # noqa: E402
from shapely.geometry import mapping  # noqa: E402

from api_client import get_data_inleverpunten, load_boundaries  # noqa: E402
from normalize import MERKEN  # noqa: E402
from utils import WEBAPP_DATA_DIR, WGS84, polygon_cache_stats  # noqa: E402

# Display simplification tolerance for municipality outlines, in metres.
BOUNDARY_TOLERANCE_M = 20

# Properties copied verbatim from the record onto each GeoJSON feature.
FEATURE_FIELDS = (
    "locatieNaam", "straatNaam", "straatNr", "postcode", "plaats",
    "merk", "puntType", "materialen", "uitbetaling",
    "vrijToegankelijk", "gemeenteBeperking", "openingstijden",
    "latitude", "longitude", "bronId",
)


def point_feature(row) -> dict:
    """Build one GeoJSON point feature from a joined record."""
    properties = {"type": "inleverpunt"}

    for field in FEATURE_FIELDS:
        value = row.get(field)
        # pandas turns missing values into NaN; JSON wants null.
        if isinstance(value, float) and value != value:
            value = None
        properties[field] = value

    return {
        "type": "Feature",
        "geometry": {
            "type": "Point",
            "coordinates": [row["longitude"], row["latitude"]],
        },
        "properties": properties,
    }


def simplify_boundary(geometry, tolerance_m: float = BOUNDARY_TOLERANCE_M):
    """Simplify a boundary for display, in metres rather than degrees.

    PDOK outlines are cadastral-grade — Amsterdam alone is 8.400 vertices and
    190 KB of JSON. At the zoom levels this map uses, a 20 m tolerance is
    visually indistinguishable and cuts the payload by roughly 90%. The
    unsimplified polygon stays in the cache and is what the spatial join uses,
    so point-to-municipality assignment keeps full precision.
    """
    try:
        series = gpd.GeoSeries([geometry], crs=WGS84).to_crs(28992)
        simplified = series.simplify(tolerance_m, preserve_topology=True).to_crs(WGS84)
        result = simplified.iloc[0]
        if result.is_empty or not result.is_valid:
            return geometry
        return result
    except Exception:  # noqa: BLE001 - fall back to the original outline
        return geometry


def boundary_feature(geometry, gemeente: str) -> dict:
    """Build the municipality outline feature."""
    return {
        "type": "Feature",
        "geometry": mapping(simplify_boundary(geometry)),
        "properties": {"type": "boundary", "gemeente": gemeente},
    }


def write_municipality(
    slug: str,
    gemeente: str,
    points: gpd.GeoDataFrame,
    boundary_geometry,
    generated_at: str,
) -> dict:
    """Write one municipality's GeoJSON and return a summary dict."""
    features = [point_feature(row) for _, row in points.iterrows()]

    if boundary_geometry is not None:
        features.append(boundary_feature(boundary_geometry, gemeente))

    if len(points):
        bounds = [
            float(points["longitude"].min()), float(points["latitude"].min()),
            float(points["longitude"].max()), float(points["latitude"].max()),
        ]
        merken = sorted(points["merk"].unique().tolist())
    else:
        bounds = []
        merken = []

    payload = {
        "type": "FeatureCollection",
        "metadata": {
            "gemeente": gemeente,
            "slug": slug,
            "generated_at": generated_at,
            "total_points": int(len(points)),
            "merken": merken,
            "bounds": bounds,
        },
        "features": features,
    }

    WEBAPP_DATA_DIR.mkdir(parents=True, exist_ok=True)
    output_path = WEBAPP_DATA_DIR / f"{slug}.geojson"
    with open(output_path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False)

    return {
        "gemeente": gemeente,
        "slug": slug,
        "success": True,
        "count": int(len(points)),
        "file_size_kb": round(output_path.stat().st_size / 1024, 1),
        "merken": merken,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate per-municipality GeoJSON")
    parser.add_argument("--only", help="comma-separated slugs to limit the run to")
    args = parser.parse_args()

    print("🚀 Starting batch generation")
    started = datetime.now()

    stats = polygon_cache_stats()
    print(f"📦 Polygon cache: {stats['total']} municipalities "
          f"(next refresh {stats['next_refresh']})")

    assigned, source_status, unassigned = get_data_inleverpunten()

    if assigned.empty:
        print("❌ No data to write — aborting")
        return 1

    boundaries = load_boundaries().set_index("slug")

    wanted = None
    if args.only:
        wanted = {s.strip() for s in args.only.split(",") if s.strip()}
        print(f"🎯 Limiting run to {len(wanted)} municipalities")

    generated_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    by_slug = dict(tuple(assigned.groupby("slug")))

    results = []
    for slug, boundary_row in boundaries.iterrows():
        if wanted is not None and slug not in wanted:
            continue

        points = by_slug.get(slug)
        if points is None:
            points = assigned.iloc[0:0]

        result = write_municipality(
            slug=slug,
            gemeente=boundary_row["gemeente"],
            points=points,
            boundary_geometry=boundary_row["geometry"],
            generated_at=generated_at,
        )
        results.append(result)

        if len(results) % 50 == 0:
            print(f"  [{len(results)}] municipalities written...")

    # ---- Summary --------------------------------------------------------
    total_points = sum(r["count"] for r in results)
    total_size = sum(r["file_size_kb"] for r in results)
    empty = [r for r in results if r["count"] == 0]

    print()
    print("=" * 62)
    print("📊 BATCH SUMMARY")
    print("=" * 62)
    print(f"  Municipalities written : {len(results)}")
    print(f"  Total points           : {total_points}")
    print(f"  Total size             : {total_size / 1024:.1f} MB")
    print(f"  Points dropped (no gemeente): {unassigned}")
    if empty:
        print(f"  ⚠️  {len(empty)} municipalities with zero points: "
              f"{', '.join(r['slug'] for r in empty[:8])}")

    merk_totals = {merk: int((assigned['merk'] == merk).sum()) for merk in MERKEN}
    print("\n  Per source:")
    for merk, count in merk_totals.items():
        state = "✅" if source_status.get(merk, {}).get("success") else "⚠️ "
        print(f"    {state} {merk}: {count}")

    summary_path = WEBAPP_DATA_DIR / "summary.json"
    with open(summary_path, "w", encoding="utf-8") as handle:
        json.dump({
            "generated_at": generated_at,
            "total_municipalities": len(results),
            "total_points": total_points,
            "unassigned_points": unassigned,
            "source_status": source_status,
            "merk_totals": merk_totals,
            "results": results,
        }, handle, ensure_ascii=False, indent=2)

    print(f"\n💾 Summary: {summary_path}")
    print(f"⏱️  Completed in {(datetime.now() - started).total_seconds():.0f}s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
