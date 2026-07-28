"""
Split municipality outlines into 12 provincial chunks.

The national map can overlay all 342 municipal borders, but shipping them as
one file makes for a slow, all-or-nothing download. Instead we write one file
per province plus an index; the webapp loads all twelve in parallel and shows
a progress bar while they arrive. This mirrors the approach the pakketpunten
project uses.

Outputs:
    webapp/public/data/boundaries/index.json
    webapp/public/data/boundaries/provincie-{slug}.geojson

    python scripts/create_provincial_boundaries.py
"""

from __future__ import annotations

import json
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

import geopandas as gpd  # noqa: E402
from shapely.geometry import mapping  # noqa: E402

from api_client import load_boundaries  # noqa: E402
from utils import WEBAPP_DATA_DIR, WGS84, slugify  # noqa: E402

OUTPUT_DIR = WEBAPP_DATA_DIR / "boundaries"

# The national overlay is drawn far zoomed out, so it tolerates much coarser
# outlines than the per-municipality view.
TOLERANCE_M = 60


def simplify(geometry, tolerance_m: float = TOLERANCE_M):
    """Simplify in metres via RD New, falling back to the original on error."""
    try:
        series = gpd.GeoSeries([geometry], crs=WGS84).to_crs(28992)
        result = series.simplify(tolerance_m, preserve_topology=True).to_crs(WGS84).iloc[0]
        if result.is_empty or not result.is_valid:
            return geometry
        return result
    except Exception:  # noqa: BLE001
        return geometry


def main() -> int:
    print("🗺️  Building provincial boundary chunks...")

    boundaries = load_boundaries()
    if boundaries.empty:
        print("❌ No boundaries available — run scripts/fetch_pdok_boundaries.py first")
        return 1

    by_province: dict[str, list] = defaultdict(list)

    for _, row in boundaries.iterrows():
        province = row["provincie"] or "Onbekend"
        by_province[province].append({
            "type": "Feature",
            "geometry": mapping(simplify(row["geometry"])),
            "properties": {
                "type": "boundary",
                "gemeente": row["gemeente"],
                "slug": row["slug"],
                "code": row["code"],
                "provincie": province,
            },
        })

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    generated_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")

    index = []
    for province, features in sorted(by_province.items()):
        slug = slugify(province)
        filename = f"provincie-{slug}.geojson"

        payload = {
            "type": "FeatureCollection",
            "metadata": {
                "provincie": province,
                "slug": slug,
                "generated_at": generated_at,
                "total_boundaries": len(features),
            },
            "features": features,
        }

        path = OUTPUT_DIR / filename
        with open(path, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False)

        size_kb = path.stat().st_size / 1024
        index.append({
            "provincie": province,
            "slug": slug,
            "file": filename,
            "boundaries": len(features),
            "size_kb": round(size_kb, 1),
        })
        print(f"  ✅ {province}: {len(features)} municipalities, {size_kb:.0f} KB")

    with open(OUTPUT_DIR / "index.json", "w", encoding="utf-8") as handle:
        json.dump({
            "generated_at": generated_at,
            "total_provinces": len(index),
            "total_boundaries": sum(entry["boundaries"] for entry in index),
            "provinces": index,
        }, handle, ensure_ascii=False, indent=2)

    total_mb = sum(entry["size_kb"] for entry in index) / 1024
    print(f"\n💾 {len(index)} provinces, "
          f"{sum(e['boundaries'] for e in index)} municipalities, {total_mb:.1f} MB total")
    return 0


if __name__ == "__main__":
    sys.exit(main())
