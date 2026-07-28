"""
Fetch e-waste collection points from Stichting OPEN / Wecycle.

The Wecycle locator (inleverpunten.stichting-open.org, also embedded on
wecycle.nl) exposes a bbox search endpoint. Two passes are needed:

1. **National pass** — one request with a bbox covering the whole country
   returns every retail collection point (~6.900). Verified against a
   two-halves split: 4.021 + 2.841 unique ids vs 6.863 in one call, so the
   endpoint applies no result cap.

2. **Municipal pass** — municipal recycling centres (`municipalityServicePoint`)
   are only returned when the query sits close to them; the national call
   surfaces just a handful. So we additionally query once per municipality
   centroid and deduplicate on id. This is the same grid strategy the
   pakketpunten project uses for DHL.

    python scripts/open_fetch_all.py
    python scripts/open_fetch_all.py --skip-grid   # national pass only
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from cache_guard import safe_save  # noqa: E402
from normalize import in_netherlands, make_record  # noqa: E402
from utils import DATA_DIR, fetch_json, load_municipalities, make_session  # noqa: E402

SEARCH_URL = "https://inleverpunten.stichting-open.org/wecyclenl/servicepoints/Search"

OUTPUT_PATH = DATA_DIR / "open_all_locations.json"

# Bounding box covering the Netherlands with margin.
NL_BBOX = {"south": 50.6, "west": 3.2, "north": 53.7, "east": 7.4}

# Half-degree box around each municipality centroid for the municipal pass;
# wide enough to catch a centre just outside the border, tight enough that the
# endpoint still treats it as a local query.
GRID_HALF_SPAN = 0.12

# Stichting OPEN waste type ids -> our material vocabulary.
# Type 8 ("Zakelijke / industriële apparaten") is business-only and has no
# consumer equivalent, so it is deliberately unmapped.
WASTE_TYPE_MAP = {
    1: "elektro-groot",
    2: "elektro-klein",
    3: "tl-buizen",
    4: "lampen",
    5: "armaturen",
    6: "elektro-middel",
    7: "batterijen",
}

ALL_WASTE_TYPES = sorted(WASTE_TYPE_MAP) + [8]

REQUEST_DELAY_SECONDS = 0.4


def build_params(south: float, west: float, north: float, east: float,
                 centre_lat: float, centre_lng: float) -> list[tuple[str, str]]:
    """Build the query string; WasteTypes repeats, so we use a list of pairs."""
    params: list[tuple[str, str]] = [
        ("RadiusDistance", "200"),
        ("UserType", "1"),
    ]
    params += [("WasteTypes", str(t)) for t in ALL_WASTE_TYPES]
    params += [
        ("MapBound.SouthWest.Latitude", str(south)),
        ("MapBound.SouthWest.Longitude", str(west)),
        ("MapBound.NorthEast.Latitude", str(north)),
        ("MapBound.NorthEast.Longitude", str(east)),
        ("Location.Latitude", str(centre_lat)),
        ("Location.Longitude", str(centre_lng)),
    ]
    return params


def search(session, south, west, north, east, centre_lat, centre_lng) -> list[dict]:
    """Run one bbox search and return its raw result items."""
    payload = fetch_json(
        session,
        SEARCH_URL,
        params=build_params(south, west, north, east, centre_lat, centre_lng),
        timeout=240,
        retries=2,
    )
    return payload.get("resultItems", []) or []


def normalise(item: dict) -> dict | None:
    """Turn one servicepoint into a canonical record, or None if unusable."""
    try:
        latitude = float(item["lat"])
        longitude = float(item["lon"])
    except (KeyError, TypeError, ValueError):
        return None

    if not in_netherlands(latitude, longitude):
        return None

    materials = [
        WASTE_TYPE_MAP[waste["type"]]
        for waste in item.get("wasteTypes") or []
        if waste.get("allowed") and waste.get("type") in WASTE_TYPE_MAP
    ]

    address = item.get("address") or {}
    number = f"{address.get('number') or ''}{address.get('suffix') or ''}".strip()

    is_municipal = bool(item.get("municipalityServicePoint"))
    municipalities = item.get("municipalities") or []

    return make_record(
        merk="StichtingOPEN",
        bron_id=item.get("code") or item.get("id", ""),
        locatie_naam=item.get("name") or "",
        latitude=latitude,
        longitude=longitude,
        punt_type="milieustraat" if is_municipal else "balie",
        materialen=materials,
        straat_naam=address.get("street") or "",
        straat_nr=number,
        postcode=address.get("postalCode") or "",
        plaats=address.get("city") or "",
        # Municipal recycling centres are restricted to their own residents.
        gemeente_beperking=municipalities if is_municipal and municipalities else None,
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="Fetch Stichting OPEN / Wecycle points")
    parser.add_argument("--skip-grid", action="store_true",
                        help="skip the per-municipality pass for recycling centres")
    args = parser.parse_args()

    print("♻️  Fetching Stichting OPEN / Wecycle collection points...")
    session = make_session()

    records: dict[str, dict] = {}

    # --- Pass 1: national ---------------------------------------------------
    print("  🌍 National pass...")
    national = search(
        session,
        NL_BBOX["south"], NL_BBOX["west"], NL_BBOX["north"], NL_BBOX["east"],
        52.1, 5.3,
    )
    print(f"     {len(national)} result items")

    for item in national:
        record = normalise(item)
        if record:
            records[record["bronId"]] = record

    print(f"     {len(records)} usable records")

    # --- Pass 2: per municipality (recycling centres) ------------------------
    if not args.skip_grid:
        municipalities = load_municipalities()
        print(f"  🏙️  Municipal pass over {len(municipalities)} municipalities "
              "(recycling centres are only returned to nearby queries)...")

        before = len(records)
        failures = 0

        for index, municipality in enumerate(municipalities, 1):
            centre_lat, centre_lng = municipality["center"]
            try:
                items = search(
                    session,
                    centre_lat - GRID_HALF_SPAN, centre_lng - GRID_HALF_SPAN,
                    centre_lat + GRID_HALF_SPAN, centre_lng + GRID_HALF_SPAN,
                    centre_lat, centre_lng,
                )
            except Exception as error:  # noqa: BLE001 - one gap must not kill the run
                failures += 1
                print(f"     ⚠️  {municipality['name']}: {error}")
                continue

            for item in items:
                record = normalise(item)
                if record:
                    records.setdefault(record["bronId"], record)

            if index % 50 == 0:
                print(f"     [{index}/{len(municipalities)}] {len(records)} unique records")

            time.sleep(REQUEST_DELAY_SECONDS)

        added = len(records) - before
        print(f"     +{added} additional records from the municipal pass")
        if failures:
            print(f"     ⚠️  {failures} municipalities failed and were skipped")

    all_records = list(records.values())
    centres = sum(1 for r in all_records if r["puntType"] == "milieustraat")
    print(f"  📊 {centres} milieustraten, {len(all_records) - centres} retail points")

    safe_save(
        source="Stichting OPEN",
        new_locations=all_records,
        output_path=OUTPUT_PATH,
        metadata={
            "source": "Stichting OPEN / Wecycle",
            "url": "https://inleverpunten.stichting-open.org",
            "method": "REST bbox search (national + per-municipality)",
            "municipal_pass": not args.skip_grid,
        },
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
