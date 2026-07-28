"""
Compute per-municipality statistics for the /data-export/statistieken page.

For every municipality this records:
  - point counts per brand, per category and per material stream
  - density per 10.000 inhabitants
  - the share of the municipality's land area within 300/400/500 m of a point

Coverage is the expensive part: it buffers every point and intersects the union
with the municipal outline, in RD New so the metres are real metres. That is
why this runs as its own step rather than inside batch_generate.

    python scripts/compute_statistics.py
"""

from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

import geopandas as gpd  # noqa: E402

from api_client import get_data_inleverpunten, load_boundaries  # noqa: E402
from geo_analysis import BUFFER_RADII, coverage_ratio  # noqa: E402
from normalize import MATERIALEN, MERKEN, PUNT_CATEGORIEEN  # noqa: E402
from utils import WEBAPP_DATA_DIR  # noqa: E402

OUTPUT_PATH = WEBAPP_DATA_DIR / "statistics.json"


def count_by(values, vocabulary) -> dict[str, int]:
    """Count occurrences, keeping only terms from the known vocabulary."""
    counts = {term: 0 for term in vocabulary}
    for value in values:
        if value in counts:
            counts[value] += 1
    return counts


def municipality_stats(slug: str, boundary_row, points: gpd.GeoDataFrame) -> dict:
    """Build the statistics record for one municipality."""
    population = int(boundary_row.get("population") or 0)
    total = len(points)

    per_merk = count_by(points["merk"], MERKEN) if total else count_by([], MERKEN)
    per_categorie = count_by(points["puntType"], PUNT_CATEGORIEEN) if total else count_by([], PUNT_CATEGORIEEN)

    material_counts = {material: 0 for material in MATERIALEN}
    if total:
        for materials in points["materialen"]:
            for material in materials or []:
                if material in material_counts:
                    material_counts[material] += 1

    boundary = gpd.GeoDataFrame(
        {"slug": [slug]}, geometry=[boundary_row["geometry"]], crs="EPSG:4326"
    )

    coverage = {}
    for radius in BUFFER_RADII:
        coverage[str(radius)] = round(coverage_ratio(points, boundary, radius), 4) if total else 0.0

    # Land area in km², from the RD New projection.
    area_km2 = round(boundary.to_crs(28992).geometry.area.iloc[0] / 1_000_000, 2)

    return {
        "slug": slug,
        "gemeente": boundary_row["gemeente"],
        "provincie": boundary_row["provincie"],
        "code": boundary_row["code"],
        "population": population,
        "area_km2": area_km2,
        "total": total,
        "per_10k_inwoners": round(total / population * 10_000, 2) if population else 0.0,
        "per_km2": round(total / area_km2, 2) if area_km2 else 0.0,
        "merken": per_merk,
        "categorieen": per_categorie,
        "materialen": material_counts,
        "dekking": coverage,
    }


def main() -> int:
    print("📊 Computing municipality statistics...")

    assigned, _status, _unassigned = get_data_inleverpunten()
    if assigned.empty:
        print("❌ No data available — aborting")
        return 1

    boundaries = load_boundaries().set_index("slug")
    by_slug = dict(tuple(assigned.groupby("slug")))

    records = []
    for index, (slug, boundary_row) in enumerate(boundaries.iterrows(), 1):
        points = by_slug.get(slug, assigned.iloc[0:0])
        records.append(municipality_stats(slug, boundary_row, points))

        if index % 50 == 0:
            print(f"  [{index}/{len(boundaries)}] municipalities processed...")

    records.sort(key=lambda r: r["gemeente"])

    # National roll-up. Coverage is a weighted mean by area, since averaging
    # ratios across wildly different municipality sizes would overweight the
    # small ones.
    total_area = sum(r["area_km2"] for r in records) or 1
    national = {
        "total": sum(r["total"] for r in records),
        "population": sum(r["population"] for r in records),
        "area_km2": round(total_area, 2),
        "merken": {
            merk: sum(r["merken"][merk] for r in records) for merk in MERKEN
        },
        "categorieen": {
            categorie: sum(r["categorieen"][categorie] for r in records)
            for categorie in PUNT_CATEGORIEEN
        },
        "materialen": {
            material: sum(r["materialen"][material] for r in records)
            for material in MATERIALEN
        },
        "dekking": {
            str(radius): round(
                sum(r["dekking"][str(radius)] * r["area_km2"] for r in records) / total_area, 4
            )
            for radius in BUFFER_RADII
        },
    }

    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "national": national,
        "municipalities": records,
    }

    WEBAPP_DATA_DIR.mkdir(parents=True, exist_ok=True)
    with open(OUTPUT_PATH, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False)

    size_kb = OUTPUT_PATH.stat().st_size / 1024
    print(f"\n  ✅ {len(records)} municipalities")
    print(f"  📍 {national['total']} points, "
          f"{national['total'] / national['population'] * 10_000:.1f} per 10.000 inhabitants")
    for radius in BUFFER_RADII:
        print(f"  🎯 Coverage within {radius} m: {national['dekking'][str(radius)] * 100:.1f}% of land area")
    print(f"  💾 {OUTPUT_PATH.name}: {size_kb:.0f} KB")

    return 0


if __name__ == "__main__":
    sys.exit(main())
