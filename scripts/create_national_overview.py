"""
Build the national overview file (nederland.geojson).

The national view renders every point in the country at once. Carrying the
full per-point payload would make the file ~18 MB, which is a poor first
load on mobile, so the national file is written in *reduced* form: the fields
the national map actually uses (name, brand, category, materials, coordinates)
and nothing else. Opening hours, address details and payout methods are
dropped — a user who needs those zooms into a municipality, which loads the
full file for that area.

The metadata carries `"reduced": true` so the webapp knows a point's missing
detail is by design rather than a data gap.

    python scripts/create_national_overview.py
"""

from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from api_client import get_data_inleverpunten  # noqa: E402
from utils import WEBAPP_DATA_DIR  # noqa: E402

OUTPUT_PATH = WEBAPP_DATA_DIR / "nederland.geojson"

# Coordinate precision for the national view. 5 decimals ≈ 1 m, which is far
# finer than any marker on a nationwide map can express.
COORD_PRECISION = 5


def reduced_feature(row) -> dict:
    """Build a slim GeoJSON feature for the national view."""
    longitude = round(float(row["longitude"]), COORD_PRECISION)
    latitude = round(float(row["latitude"]), COORD_PRECISION)

    return {
        "type": "Feature",
        "geometry": {"type": "Point", "coordinates": [longitude, latitude]},
        "properties": {
            "type": "inleverpunt",
            "locatieNaam": row["locatieNaam"],
            "plaats": row["plaats"],
            "merk": row["merk"],
            "puntType": row["puntType"],
            "materialen": row["materialen"],
            "gemeente": row["gemeente"],
            "latitude": latitude,
            "longitude": longitude,
        },
    }


def main() -> int:
    print("🇳🇱 Building national overview...")

    assigned, _source_status, _unassigned = get_data_inleverpunten()

    if assigned.empty:
        print("❌ No data available — aborting")
        return 1

    features = [reduced_feature(row) for _, row in assigned.iterrows()]

    payload = {
        "type": "FeatureCollection",
        "metadata": {
            "gemeente": "Nederland (totaal)",
            "slug": "nederland",
            "generated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "total_points": len(features),
            "merken": sorted(assigned["merk"].unique().tolist()),
            "bounds": [
                float(assigned["longitude"].min()), float(assigned["latitude"].min()),
                float(assigned["longitude"].max()), float(assigned["latitude"].max()),
            ],
            "municipalities": int(assigned["slug"].nunique()),
            "reduced": True,
        },
        "features": features,
    }

    WEBAPP_DATA_DIR.mkdir(parents=True, exist_ok=True)
    with open(OUTPUT_PATH, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False)

    size_mb = OUTPUT_PATH.stat().st_size / (1024 * 1024)
    print(f"  ✅ {len(features)} points across "
          f"{payload['metadata']['municipalities']} municipalities")
    print(f"  💾 {OUTPUT_PATH.name}: {size_mb:.1f} MB")

    if size_mb > 12:
        print(f"  ⚠️  National file exceeds 12 MB — consider trimming further")

    return 0


if __name__ == "__main__":
    sys.exit(main())
