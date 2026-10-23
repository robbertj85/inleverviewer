#!/usr/bin/env python3
"""
Fetch the national parcel-point set from the pakketpuntenviewer.

The network planner's combi mode needs every pakketpunt in the country. That
used to be a hand-copied snapshot from a sister repository (August 2026,
19.137 points) with no way to refresh it. The pakketpuntenviewer publishes the
same national file as a static asset, regenerated weekly on Monday morning:

    https://pakketpuntenviewer.nl/data/nederland.geojson   (~16 MB)

It is a static file, not the rate-limited /api/v1 routes (15 requests/hour),
so one weekly download costs nothing.

Written to data/pakketpunten_snapshot.geojson with only what the planner
reads, plus provenance metadata the netwerkplanner tab shows. `bezettingsgraad`
is dropped on purpose: the source generates it randomly as mock data.

Guarded like the source caches (cache_guard.py): zero points, or more than 20%
fewer than the file it would replace, leaves the old file in place and exits 2,
which the scheduler records as an anomaly rather than a failure.

Usage:
    python scripts/fetch_pakketpunten.py
    INLEVER_PAKKETPUNTEN_URL=... python scripts/fetch_pakketpunten.py
"""

from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from utils import DATA_DIR  # noqa: E402

SOURCE_URL = os.environ.get(
    "INLEVER_PAKKETPUNTEN_URL", "https://pakketpuntenviewer.nl/data/nederland.geojson"
)
OUT_PATH = DATA_DIR / "pakketpunten_snapshot.geojson"
THRESHOLD_PCT = 20
EXIT_CODE_ANOMALY = 2

# Everything the planner and the tab use; the rest of the record stays upstream.
KEEP = ("type", "vervoerder", "puntType", "locatieNaam", "canPickup", "canDropoff")


def existing_count() -> int | None:
    try:
        return json.loads(OUT_PATH.read_text())["metadata"]["total_points"]
    except (FileNotFoundError, KeyError, json.JSONDecodeError):
        return None


def main() -> int:
    print(f"📦 Pakketpunten ophalen: {SOURCE_URL}")
    response = requests.get(SOURCE_URL, timeout=120)
    response.raise_for_status()
    source = response.json()

    features = [
        {
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": feature["geometry"]["coordinates"][:2]},
            "properties": {key: feature["properties"].get(key) for key in KEEP},
        }
        for feature in source.get("features", [])
        if feature.get("properties", {}).get("type") == "pakketpunt"
        and feature.get("geometry", {}).get("type") == "Point"
    ]

    previous = existing_count()
    if not features or (previous and len(features) < previous * (1 - THRESHOLD_PCT / 100)):
        print(f"⚠️  {len(features)} punten opgehaald tegen {previous} in de huidige "
              f"momentopname; bestaand bestand blijft staan.", file=sys.stderr)
        return EXIT_CODE_ANOMALY

    meta = source.get("metadata", {})
    generated = meta.get("generated_at") or response.headers.get("last-modified")
    payload = {
        "type": "FeatureCollection",
        "metadata": {
            "source_url": SOURCE_URL,
            "source_generated_at": generated,
            # The tab shows this date; it is when the source built the data,
            # not when we downloaded it.
            "snapshot_date": (generated or "")[:10] or None,
            "fetched_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "total_points": len(features),
            "providers": meta.get("providers"),
            "note": "Wekelijks opgehaald van de pakketpuntenviewer (statisch landelijk bestand).",
        },
        "features": features,
    }

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = OUT_PATH.with_suffix(".tmp")
    tmp.write_text(json.dumps(payload, separators=(",", ":"), ensure_ascii=False))
    os.replace(tmp, OUT_PATH)
    delta = f" ({len(features) - previous:+d})" if previous else ""
    print(f"✅ {len(features)} pakketpunten{delta}, bron {payload['metadata']['snapshot_date']} → {OUT_PATH}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
