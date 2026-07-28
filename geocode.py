"""
Repair records whose coordinates the source got wrong.

Several sources ship a fallback coordinate when their own geocoding fails: a
batch of unrelated addresses all end up on one point. In the Statiegeld
Nederland WFS, thirteen locations share 51.92965/4.47834 — among them an Almere
school and a Frisian shop, both of which then get geofenced into Rotterdam.

The fix is to detect those collisions (one coordinate, several distinct
addresses) and re-geocode the affected records against PDOK Locatieserver,
which is authoritative for Dutch addresses. Results are cached on disk so the
weekly run only pays for addresses it has not seen before.

Records that cannot be resolved keep their original coordinate — a slightly
misplaced point is more useful than a missing one, and the count is reported so
the drift is visible.
"""

from __future__ import annotations

import json
import re
import time
from collections import defaultdict
from pathlib import Path
from typing import Any

from utils import DATA_DIR, fetch_json

LOCATIESERVER_URL = "https://api.pdok.nl/bzk/locatieserver/search/v3_1/free"
CACHE_FILE = DATA_DIR / "geocode_cache.json"

# PDOK is a public government service built for this, but stay polite.
REQUEST_DELAY_SECONDS = 0.15

# Coordinates are compared at 5 decimals (~1 m) when looking for collisions.
COORD_PRECISION = 5


def _load_cache() -> dict[str, Any]:
    if not CACHE_FILE.exists():
        return {}
    try:
        with open(CACHE_FILE, "r", encoding="utf-8") as handle:
            return json.load(handle)
    except (json.JSONDecodeError, OSError):
        return {}


def _save_cache(cache: dict[str, Any]) -> None:
    CACHE_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(CACHE_FILE, "w", encoding="utf-8") as handle:
        json.dump(cache, handle, ensure_ascii=False)


def _cache_key(postcode: str, number: str, street: str, city: str) -> str:
    return "|".join([
        re.sub(r"\s+", "", postcode).upper(),
        re.sub(r"\s+", "", str(number)).upper(),
        street.strip().lower(),
        city.strip().lower(),
    ])


def _parse_point(wkt_point: str) -> tuple[float, float] | None:
    """Parse PDOK's 'POINT(lon lat)' into (lat, lon)."""
    match = re.match(r"POINT\(([-\d.]+)\s+([-\d.]+)\)", wkt_point or "")
    if not match:
        return None
    return float(match.group(2)), float(match.group(1))


def _query(session, query: str) -> dict | None:
    """Run one Locatieserver address lookup, returning the best hit."""
    try:
        payload = fetch_json(
            session,
            LOCATIESERVER_URL,
            params={"q": query, "fq": "type:adres", "rows": 1},
            timeout=30,
            retries=2,
        )
    except Exception:  # noqa: BLE001 - a failed lookup just means no repair
        return None

    docs = (payload.get("response") or {}).get("docs") or []
    return docs[0] if docs else None


def geocode(session, postcode: str, number: str, street: str, city: str,
            cache: dict[str, Any]) -> tuple[float, float] | None:
    """Resolve an address to (lat, lon), using and filling the cache."""
    key = _cache_key(postcode, number, street, city)

    if key in cache:
        hit = cache[key]
        return (hit["lat"], hit["lon"]) if hit else None

    # Postcode + house number is the most reliable query PDOK accepts; the
    # street/city form is the fallback for records with no postcode.
    clean_postcode = re.sub(r"\s+", "", postcode).upper()
    clean_number = str(number).strip()

    attempts = []
    if clean_postcode and clean_number:
        attempts.append(f"{clean_postcode} {clean_number}")
    if street and clean_number and city:
        attempts.append(f"{street} {clean_number} {city}")
    if street and city:
        attempts.append(f"{street} {city}")

    for query in attempts:
        doc = _query(session, query)
        time.sleep(REQUEST_DELAY_SECONDS)

        if not doc:
            continue

        point = _parse_point(doc.get("centroide_ll", ""))
        if not point:
            continue

        # Guard against fuzzy matches landing on a different postcode.
        returned_postcode = re.sub(r"\s+", "", doc.get("postcode", "")).upper()
        if clean_postcode and returned_postcode and returned_postcode != clean_postcode:
            continue

        cache[key] = {"lat": point[0], "lon": point[1]}
        return point

    cache[key] = None
    return None


def find_collisions(records: list[dict]) -> list[dict]:
    """Records sharing a coordinate with a *different* address.

    Two entries at the same address and the same point are normal — a shop with
    two collection bins. Different addresses on one point are not.
    """
    by_coord: dict[tuple[float, float], list[dict]] = defaultdict(list)
    for record in records:
        key = (round(record["latitude"], COORD_PRECISION),
               round(record["longitude"], COORD_PRECISION))
        by_coord[key].append(record)

    suspect: list[dict] = []
    for group in by_coord.values():
        if len(group) < 2:
            continue
        addresses = {
            (r.get("straatNaam", "").strip().lower(),
             str(r.get("straatNr", "")).strip().lower(),
             r.get("postcode", "").strip())
            for r in group
        }
        if len(addresses) > 1:
            suspect.extend(group)

    return suspect


def repair_coordinates(session, records: list[dict], source: str) -> dict[str, int]:
    """Re-geocode records whose coordinate collides with a different address.

    Mutates `records` in place. Returns counts for logging.
    """
    suspect = find_collisions(records)

    if not suspect:
        print(f"  📍 {source}: no coordinate collisions")
        return {"suspect": 0, "repaired": 0, "unresolved": 0}

    print(f"  📍 {source}: {len(suspect)} records share a coordinate with a "
          f"different address — re-geocoding via PDOK")

    cache = _load_cache()
    cached_before = len(cache)
    repaired = 0
    unresolved = 0

    for index, record in enumerate(suspect, 1):
        point = geocode(
            session,
            record.get("postcode", ""),
            record.get("straatNr", ""),
            record.get("straatNaam", ""),
            record.get("plaats", ""),
            cache,
        )

        if point:
            record["latitude"] = round(point[0], 7)
            record["longitude"] = round(point[1], 7)
            repaired += 1
        else:
            unresolved += 1

        if index % 100 == 0:
            print(f"     [{index}/{len(suspect)}] {repaired} repaired")

    _save_cache(cache)

    print(f"  ✅ {source}: {repaired} coordinates corrected, "
          f"{unresolved} unresolved (kept original) — "
          f"{len(cache) - cached_before} new cache entries")

    return {"suspect": len(suspect), "repaired": repaired, "unresolved": unresolved}
