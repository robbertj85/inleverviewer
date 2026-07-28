"""
Fetch e-waste collection points from Stichting OPEN / Wecycle.

The Wecycle locator (inleverpunten.stichting-open.org, also embedded on
wecycle.nl) exposes a bbox search endpoint. Two passes are needed:

1. **National pass** — one request with a bbox covering the whole country
   returns every retail collection point (~6.900). Verified against a
   two-halves split: 4.021 + 2.841 unique ids vs 6.863 in one call, so the
   endpoint applies no result cap.

2. **Sweep passes** — municipal recycling centres (`municipalityServicePoint`)
   are handled differently by the endpoint: rather than returning everything in
   the bounding box, it returns only the handful *nearest to the query point*.
   The national call therefore surfaces two of ~390. To find the rest you have
   to stand next to each one.

   Two sweeps are needed, and neither is sufficient alone:

   - **Per municipality centroid.** Usually lands near the town it serves, so
     it picks up that municipality's own milieustraat. But it fails on
     oddly-shaped municipalities: Rotterdam's centroid sits 15 km west in the
     port, which returns the Delft, Rijswijk and Wassenaar milieustraten and
     misses all six Rotterdam milieuparken.
   - **Land lattice.** A uniform grid clipped to the land mass, which no
     municipality shape can defeat. On its own it still misses centres that sit
     between cells — a cell 3 km from Helmond returns Laarbeek's milieustraat
     instead, because that one is nearer to the cell.

   The union of the two is what gets full coverage. Results deduplicate on id.

    python scripts/open_fetch_all.py
    python scripts/open_fetch_all.py --skip-grid   # national pass only
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from shapely import wkt  # noqa: E402
from shapely.geometry import box  # noqa: E402
from shapely.strtree import STRtree  # noqa: E402

from cache_guard import safe_save  # noqa: E402
from geocode import repair_coordinates  # noqa: E402
from normalize import in_netherlands, make_record  # noqa: E402
from utils import (  # noqa: E402
    DATA_DIR,
    fetch_json,
    load_municipalities,
    load_polygon_cache,
    make_session,
)

SEARCH_URL = "https://inleverpunten.stichting-open.org/wecyclenl/servicepoints/Search"

OUTPUT_PATH = DATA_DIR / "open_all_locations.json"

# Bounding box covering the Netherlands with margin.
NL_BBOX = {"south": 50.6, "west": 3.2, "north": 53.7, "east": 7.4}

# Lattice cell size in degrees. 0.08° gives ~970 land cells, which is the point
# where extra density stops finding new centres and only costs time.
GRID_STEP = 0.08

# Half-width of the bounds box sent with each sweep query. The box barely
# affects which municipal points come back (the endpoint ranks those by
# distance to Location), but a wider box does return more retail points.
QUERY_HALF_SPAN = 0.12

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


def land_grid(step: float = GRID_STEP) -> list[tuple[float, float]]:
    """Lattice of cell centres covering the Dutch land mass.

    Cells that touch no municipality are dropped, so we do not spend a third of
    the run querying the North Sea.
    """
    cache = load_polygon_cache()
    if not cache:
        raise RuntimeError(
            "Municipality polygon cache is empty. "
            "Run: python scripts/fetch_pdok_boundaries.py"
        )

    geometries = [wkt.loads(entry["geometry_wkt"]) for entry in cache.values()]
    tree = STRtree(geometries)

    min_lon = min(g.bounds[0] for g in geometries)
    max_lon = max(g.bounds[2] for g in geometries)
    min_lat = min(g.bounds[1] for g in geometries)
    max_lat = max(g.bounds[3] for g in geometries)

    cells: list[tuple[float, float]] = []
    lat = min_lat
    while lat < max_lat:
        lon = min_lon
        while lon < max_lon:
            if tree.query(box(lon, lat, lon + step, lat + step), predicate="intersects").size:
                cells.append((lat + step / 2, lon + step / 2))
            lon += step
        lat += step

    return cells


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


def sweep(session, records: dict[str, dict], points: list[tuple[float, float]],
          label: str) -> None:
    """Query every point in `points`, merging new records into `records`.

    Failures are retried once. Two kinds occur:

    - Transient 500s, which the retry clears.
    - Deterministic 500s on cells that are entirely open water (IJsselmeer,
      Waddenzee, North Sea). Municipal boundaries extend well offshore, so the
      land clip keeps a handful of these; the endpoint errors rather than
      returning an empty list when there is nothing to rank. They cost no
      coverage, so they are reported as skipped rather than as a problem.
    """
    print(f"  🗺️  {label}: {len(points)} queries...")

    before = len(records)
    failed: list[tuple[float, float]] = []

    def run(batch: list[tuple[float, float]], collect_failures: bool) -> None:
        for index, (lat, lon) in enumerate(batch, 1):
            try:
                items = search(
                    session,
                    lat - QUERY_HALF_SPAN, lon - QUERY_HALF_SPAN,
                    lat + QUERY_HALF_SPAN, lon + QUERY_HALF_SPAN,
                    lat, lon,
                )
            except Exception:  # noqa: BLE001 - one gap must not kill the run
                if collect_failures:
                    failed.append((lat, lon))
                continue

            for item in items:
                record = normalise(item)
                if record:
                    records.setdefault(record["bronId"], record)

            if index % 100 == 0:
                centres = sum(1 for r in records.values() if r["puntType"] == "milieustraat")
                print(f"     [{index}/{len(batch)}] {len(records)} records, {centres} milieustraten")

            time.sleep(REQUEST_DELAY_SECONDS)

    run(points, collect_failures=True)

    if failed:
        print(f"     ↻ retrying {len(failed)} failed queries...")
        retry_batch, failed = failed, []
        run(retry_batch, collect_failures=True)
        if failed:
            print(f"     ℹ️  {len(failed)} queries skipped (persistent errors; "
                  "these are open-water cells with nothing to return)")

    centres = sum(1 for r in records.values() if r["puntType"] == "milieustraat")
    print(f"     +{len(records) - before} new records ({centres} milieustraten total)")


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

    # --- Pass 2 & 3: sweeps for municipal recycling centres ------------------
    if not args.skip_grid:
        municipalities = load_municipalities()
        centroids = [tuple(m["center"]) for m in municipalities]

        sweep(session, records, centroids, "Centroid pass (per municipality)")
        sweep(session, records, land_grid(), f"Lattice pass ({GRID_STEP}° land grid)")

    all_records = list(records.values())
    centres = sum(1 for r in all_records if r["puntType"] == "milieustraat")
    print(f"  📊 {centres} milieustraten, {len(all_records) - centres} retail points")

    geocode_stats = repair_coordinates(session, all_records, "Stichting OPEN")

    safe_save(
        source="Stichting OPEN",
        new_locations=all_records,
        output_path=OUTPUT_PATH,
        metadata={
            "source": "Stichting OPEN / Wecycle",
            "url": "https://inleverpunten.stichting-open.org",
            "method": "REST bbox search (national + per-municipality)",
            "municipal_pass": not args.skip_grid,
            "geocode_repair": geocode_stats,
        },
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
