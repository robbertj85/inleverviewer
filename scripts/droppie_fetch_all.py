"""
Fetch Droppie deposit-return locations.

godroppie.com is a Webflow site with no location API, but it publishes every
branch as schema.org `Store` entries in a JSON-LD block on the overview page,
complete with coordinates. That is far more stable than scraping the rendered
DOM, so we parse the structured data instead.

    python scripts/droppie_fetch_all.py
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

PAGE_URL = "https://www.godroppie.com/nl/locaties"
OUTPUT_PATH = DATA_DIR / "droppie_all_locations.json"

LD_JSON_PATTERN = re.compile(
    r'<script[^>]*type=["\']application/ld\+json["\'][^>]*>(.*?)</script>',
    re.DOTALL | re.IGNORECASE,
)

# Droppie machines take the standard statiegeld streams.
DROPPIE_MATERIALS = ["pet-groot", "pet-klein", "blik"]


def extract_stores(html: str) -> list[dict]:
    """Pull every schema.org Store object out of the page's JSON-LD blocks."""
    stores: list[dict] = []

    for block in LD_JSON_PATTERN.findall(html):
        try:
            data = json.loads(block.strip())
        except json.JSONDecodeError:
            continue

        candidates = data.get("@graph", []) if isinstance(data, dict) else data
        if isinstance(candidates, dict):
            candidates = [candidates]

        for entry in candidates or []:
            if isinstance(entry, dict) and entry.get("@type") in {"Store", "LocalBusiness"}:
                stores.append(entry)

    return stores


def normalise(store: dict) -> dict | None:
    """Turn one schema.org Store into a canonical record, or None if unusable."""
    geo = store.get("geo") or {}
    try:
        latitude = float(geo["latitude"])
        longitude = float(geo["longitude"])
    except (KeyError, TypeError, ValueError):
        return None

    if not in_netherlands(latitude, longitude):
        return None

    address = store.get("address") or {}
    street_address = str(address.get("streetAddress") or "")

    # schema.org gives street and number as one string.
    match = re.match(r"^(.*?)[\s,]+(\d+[\w\-/]*)$", street_address.strip())
    if match:
        street, number = match.group(1).strip(), match.group(2).strip()
    else:
        street, number = street_address.strip(), ""

    name = str(store.get("name") or "Droppie")

    return make_record(
        merk="Droppie",
        bron_id=slugify(name) or slugify(street_address),
        locatie_naam=name,
        latitude=latitude,
        longitude=longitude,
        punt_type="automaat",
        materialen=DROPPIE_MATERIALS,
        straat_naam=street,
        straat_nr=number,
        postcode=str(address.get("postalCode") or ""),
        plaats=str(address.get("addressLocality") or ""),
        uitbetaling=["droppie"],
        vrij_toegankelijk=True,
    )


def main() -> int:
    print("🟢 Fetching Droppie locations...")
    session = make_session()

    html = fetch_text(session, PAGE_URL, timeout=60)
    stores = extract_stores(html)
    print(f"  📥 {len(stores)} stores in JSON-LD")

    records = []
    seen: set[str] = set()
    for store in stores:
        record = normalise(store)
        if record and record["bronId"] not in seen:
            seen.add(record["bronId"])
            records.append(record)

    safe_save(
        source="Droppie",
        new_locations=records,
        output_path=OUTPUT_PATH,
        metadata={
            "source": "Droppie",
            "url": PAGE_URL,
            "method": "schema.org JSON-LD extraction",
        },
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
