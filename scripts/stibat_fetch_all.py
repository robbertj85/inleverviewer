"""
Fetch every battery collection point from Stibat (legebatterijen.nl).

The Stibat locator is a WordPress plugin exposing a REST route that takes a
centre point plus a radius in metres. A single call with a 200 km radius from
the middle of the country covers the whole of the Netherlands (~18.500 points).

Note: small radii intermittently return HTTP 500 from the upstream plugin, so
we deliberately query wide rather than tiling.

    python scripts/stibat_fetch_all.py
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from cache_guard import safe_save  # noqa: E402
from geocode import repair_coordinates  # noqa: E402
from normalize import in_netherlands, make_record  # noqa: E402
from utils import DATA_DIR, fetch_json, make_session  # noqa: E402

API_URL = "https://www.legebatterijen.nl/wp-json/stibat-inlever-locator/v1/locations"

# Centre of the Netherlands, with a radius that comfortably covers Vlieland to
# Vaals in one request.
CENTRE_LAT = 52.1
CENTRE_LNG = 5.3
RADIUS_M = 200_000

OUTPUT_PATH = DATA_DIR / "stibat_all_locations.json"

# Stibat labels its streams in Dutch free text; map the ones we know.
PRODUCT_FLOW_MAP = {
    "batterijen": "batterijen",
    "spaarlampen": "lampen",
    "led-lampen": "lampen",
    "tl-buizen": "tl-buizen",
}


def map_product_flows(flows: list[str] | None) -> list[str]:
    """Map Stibat's product_flows onto our material vocabulary."""
    materials = []
    for flow in flows or []:
        key = str(flow).strip().lower()
        mapped = PRODUCT_FLOW_MAP.get(key)
        if mapped:
            materials.append(mapped)
    # Everything in this dataset is a battery drop-off at minimum.
    if not materials:
        materials.append("batterijen")
    return materials


def normalise(item: dict) -> dict | None:
    """Turn one Stibat location into a canonical record, or None if unusable."""
    try:
        latitude = float(item["lat"])
        longitude = float(item["lng"])
    except (KeyError, TypeError, ValueError):
        return None

    if not in_netherlands(latitude, longitude):
        return None

    # 'active' is a string flag; inactive points should not be shown.
    if str(item.get("active", "1")).strip() not in {"1", "true", "True"}:
        return None

    return make_record(
        merk="Stibat",
        bron_id=item.get("location_number") or item.get("id", ""),
        locatie_naam=item.get("name") or "",
        latitude=latitude,
        longitude=longitude,
        punt_type="inzamelbak",
        materialen=map_product_flows(item.get("product_flows")),
        straat_naam=item.get("street") or "",
        straat_nr=item.get("street_number") or "",
        postcode=item.get("postal_code") or "",
        plaats=item.get("county") or "",
        vrij_toegankelijk=False,
    )


def main() -> int:
    print("🔋 Fetching Stibat battery collection points...")
    session = make_session()

    data = fetch_json(
        session,
        API_URL,
        params={"lat": CENTRE_LAT, "lng": CENTRE_LNG, "radius": RADIUS_M},
        timeout=300,
        retries=3,
    )

    if not isinstance(data, list):
        print(f"  ⚠️  Unexpected response type: {type(data).__name__}")
        data = []

    print(f"  📥 {len(data)} locations from API")

    records = []
    seen: set[str] = set()
    for item in data:
        record = normalise(item)
        if record and record["bronId"] not in seen:
            seen.add(record["bronId"])
            records.append(record)

    skipped = len(data) - len(records)
    if skipped:
        print(f"  ℹ️  Skipped {skipped} locations (inactive, out of bounds or duplicate)")

    geocode_stats = repair_coordinates(session, records, "Stibat")

    safe_save(
        source="Stibat",
        new_locations=records,
        output_path=OUTPUT_PATH,
        metadata={
            "source": "Stibat / Lege Batterijen",
            "url": "https://www.legebatterijen.nl/inleveren/waar-inleveren/",
            "method": f"REST radius search ({RADIUS_M / 1000:.0f} km)",
            "geocode_repair": geocode_stats,
        },
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
