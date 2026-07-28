"""
Fetch StatieDrive deposit-return shops.

statiedrive.nl is an Astro site that renders its location overview statically
and describes every shop in a schema.org `ItemList` of `LocalBusiness` entries,
coordinates included. We parse that JSON-LD rather than the DOM.

    python scripts/statiedrive_fetch_all.py
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from cache_guard import safe_save  # noqa: E402
from normalize import in_netherlands, make_record  # noqa: E402
from utils import DATA_DIR, fetch_text, make_session, slugify  # noqa: E402

PAGE_URL = "https://www.statiedrive.nl/locaties"
OUTPUT_PATH = DATA_DIR / "statiedrive_all_locations.json"

LD_JSON_PATTERN = re.compile(
    r'<script[^>]*type=["\']application/ld\+json["\'][^>]*>(.*?)</script>',
    re.DOTALL | re.IGNORECASE,
)

# StatieDrive shops are bulk statiegeld return points.
STATIEDRIVE_MATERIALS = ["pet-groot", "pet-klein", "blik", "krat"]


def extract_businesses(html: str) -> list[dict]:
    """Collect LocalBusiness entries from ItemList (or standalone) JSON-LD."""
    businesses: list[dict] = []

    def collect(entry) -> None:
        if not isinstance(entry, dict):
            return
        entry_type = entry.get("@type")
        if entry_type == "ItemList":
            for element in entry.get("itemListElement", []) or []:
                if isinstance(element, dict):
                    collect(element.get("item", element))
        elif entry_type in {"LocalBusiness", "Store"}:
            businesses.append(entry)

    for block in LD_JSON_PATTERN.findall(html):
        try:
            data = json.loads(block.strip())
        except json.JSONDecodeError:
            continue

        candidates = data.get("@graph") if isinstance(data, dict) else data
        if candidates is None:
            candidates = [data]
        if isinstance(candidates, dict):
            candidates = [candidates]

        for entry in candidates or []:
            collect(entry)

    return businesses


def normalise(business: dict) -> dict | None:
    """Turn one LocalBusiness into a canonical record, or None if unusable."""
    geo = business.get("geo") or {}
    try:
        latitude = float(geo["latitude"])
        longitude = float(geo["longitude"])
    except (KeyError, TypeError, ValueError):
        return None

    if not in_netherlands(latitude, longitude):
        return None

    address = business.get("address") or {}
    street_address = str(address.get("streetAddress") or "")

    match = re.match(r"^(.*?)[\s,]+(\d+[\w\-/]*)$", street_address.strip())
    if match:
        street, number = match.group(1).strip(), match.group(2).strip()
    else:
        street, number = street_address.strip(), ""

    name = str(business.get("name") or "StatieDrive")
    identifier = business.get("@id") or business.get("url") or name

    return make_record(
        merk="StatieDrive",
        bron_id=slugify(str(identifier).rsplit("/", 1)[-1]) or slugify(name),
        locatie_naam=name,
        latitude=latitude,
        longitude=longitude,
        punt_type="automaat",
        materialen=STATIEDRIVE_MATERIALS,
        straat_naam=street,
        straat_nr=number,
        postcode=str(address.get("postalCode") or ""),
        plaats=str(address.get("addressLocality") or ""),
        uitbetaling=["bonnetje"],
        vrij_toegankelijk=True,
    )


def main() -> int:
    print("🔵 Fetching StatieDrive locations...")
    session = make_session()

    html = fetch_text(session, PAGE_URL, timeout=60)
    businesses = extract_businesses(html)
    print(f"  📥 {len(businesses)} businesses in JSON-LD")

    records = []
    seen: set[str] = set()
    for business in businesses:
        record = normalise(business)
        if record and record["bronId"] not in seen:
            seen.add(record["bronId"])
            records.append(record)

    safe_save(
        source="StatieDrive",
        new_locations=records,
        output_path=OUTPUT_PATH,
        metadata={
            "source": "StatieDrive",
            "url": PAGE_URL,
            "method": "schema.org JSON-LD extraction",
        },
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
