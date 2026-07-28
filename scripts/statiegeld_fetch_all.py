"""
Fetch every statiegeld inleverpunt from Statiegeld Nederland (Verpact).

Statiegeld Nederland's Locatiewijzer is backed by a public GeoServer WFS. One
GetFeature request returns the complete national dataset (~8.000 points) as
GeoJSON, including accepted materials, payout methods and opening hours — so
there is no grid, no pagination and no scraping involved.

    python scripts/statiegeld_fetch_all.py
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from cache_guard import safe_save  # noqa: E402
from normalize import (  # noqa: E402
    in_netherlands,
    make_record,
    normalise_hours,
    split_postcode_city,
    split_street,
    yes,
)
from utils import DATA_DIR, make_session  # noqa: E402

WFS_URL = "https://geoserver-statiegeld.webgis.nl/Statiegeld/wfs"
WFS_PARAMS = {
    "service": "WFS",
    "version": "1.0.0",
    "request": "GetFeature",
    "srsName": "EPSG:4326",
    "typeName": "Statiegeld:inleverpunten",
    "maxFeatures": "100000",
    "outputFormat": "application/json",
}

OUTPUT_PATH = DATA_DIR / "statiegeld_all_locations.json"

# WFS attribute -> our material vocabulary
MATERIAL_FIELDS = {
    "groot_pet": "pet-groot",
    "klein_pet": "pet-klein",
    "blik": "blik",
    "glas": "glas",
    "krat": "krat",
}

# WFS attribute -> payout method
PAYOUT_FIELDS = ("bonnetje", "donatie", "tikkie", "droppie", "retourpinnen", "contant")

# The WFS spells Wednesday and Friday differently from our day keys.
DAY_FIELDS = {
    "ma": "ma", "di": "di", "woe": "wo",
    "do": "do", "vrij": "vr", "za": "za", "zo": "zo",
}


def normalise(feature: dict) -> dict | None:
    """Turn one WFS feature into a canonical record, or None if unusable."""
    props = feature.get("properties") or {}
    geometry = feature.get("geometry") or {}
    coordinates = geometry.get("coordinates") or []

    # Prefer the explicit lat/lng attributes; they carry more precision than
    # the rounded geometry the WFS emits.
    latitude = props.get("lat")
    longitude = props.get("lng")
    if latitude is None or longitude is None:
        if len(coordinates) < 2:
            return None
        longitude, latitude = coordinates[0], coordinates[1]

    try:
        latitude, longitude = float(latitude), float(longitude)
    except (TypeError, ValueError):
        return None

    if not in_netherlands(latitude, longitude):
        return None

    street, number = split_street(props.get("straat_huisnr"))
    postcode, city = split_postcode_city(props.get("postcode_plaats"))

    materials = [
        material for field, material in MATERIAL_FIELDS.items()
        if yes(props.get(field))
    ]
    # 'bulk' means the location takes crates/bulk returns rather than a new
    # material stream, so it maps onto 'krat' rather than a category of its own.
    if yes(props.get("bulk")) and "krat" not in materials:
        materials.append("krat")

    payouts = [field for field in PAYOUT_FIELDS if yes(props.get(field))]

    hours = normalise_hours({
        our_key: props.get(wfs_key)
        for wfs_key, our_key in DAY_FIELDS.items()
    })

    # An RVM present makes it an automaat; otherwise it is a staffed counter.
    punt_type = "automaat" if yes(props.get("automaat_aanwezig")) else "balie"

    name = props.get("bedrijf") or ""
    # A few records are prefixed with a stray hyphen in the source data.
    name = name.lstrip("-").strip()

    return make_record(
        merk="StatiegeldNederland",
        bron_id=props.get("id") or feature.get("id", ""),
        locatie_naam=name,
        latitude=latitude,
        longitude=longitude,
        punt_type=punt_type,
        materialen=materials,
        straat_naam=street,
        straat_nr=number,
        postcode=postcode,
        plaats=city,
        uitbetaling=payouts,
        vrij_toegankelijk=yes(props.get("vrij_toegankelijk")),
        openingstijden=hours,
    )


def main() -> int:
    print("🥤 Fetching Statiegeld Nederland inleverpunten (WFS)...")
    session = make_session()

    payload = session.get(WFS_URL, params=WFS_PARAMS, timeout=300)
    payload.raise_for_status()
    data = payload.json()

    features = data.get("features", [])
    print(f"  📥 {len(features)} features from WFS")

    records = []
    seen: set[str] = set()
    for feature in features:
        record = normalise(feature)
        if record and record["bronId"] not in seen:
            seen.add(record["bronId"])
            records.append(record)

    skipped = len(features) - len(records)
    if skipped:
        print(f"  ℹ️  Skipped {skipped} features (missing/invalid coordinates or duplicates)")

    automaten = sum(1 for r in records if r["puntType"] == "automaat")
    print(f"  📊 {automaten} automaten, {len(records) - automaten} balies")

    safe_save(
        source="Statiegeld Nederland",
        new_locations=records,
        output_path=OUTPUT_PATH,
        metadata={
            "source": "Statiegeld Nederland (Verpact)",
            "url": "https://www.statiegeldnederland.nl/locatiewijzer",
            "method": "WFS GetFeature",
        },
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
