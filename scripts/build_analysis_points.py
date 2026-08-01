"""Consolidate the per-municipality GeoJSONs into one analysis-grade point set.

The national `nederland.geojson` is reduced on purpose — it drops address,
opening hours, payout *and* `gemeenteBeperking`. The coverage maths needs that
last field: a milieustraat only serves residents of the municipalities that
are allowed to use it, so counting it as reaching everyone within 400 m would
overstate reach in exactly the places where reach is thinnest.

So we read the 342 per-municipality files instead and write one file with the
fields the analysis layers use, pre-tagged with the analysis subsets and the
resolved restriction slugs.

Output → data/analysis_points.geojson (regenerable, gitignored)

    python scripts/build_analysis_points.py
"""

from __future__ import annotations

import json
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from analysis import (  # noqa: E402
    ANALYSIS_POINTS_PATH,
    load_webapp_municipalities,
    point_subsets,
    restriction_slugs,
)
from utils import WEBAPP_DATA_DIR  # noqa: E402


def main() -> int:
    municipalities = load_webapp_municipalities()
    features: list[dict] = []
    subset_counts: Counter[str] = Counter()
    restricted = 0
    unresolved: Counter[str] = Counter()
    missing_files: list[str] = []

    for muni in municipalities:
        slug = muni["slug"]
        path = WEBAPP_DATA_DIR / f"{slug}.geojson"
        if not path.exists():
            missing_files.append(slug)
            continue
        with open(path, encoding="utf-8") as handle:
            payload = json.load(handle)

        for feature in payload.get("features", []):
            props = feature.get("properties", {})
            if props.get("type") != "inleverpunt":
                continue
            subsets = point_subsets(props)
            allowed = restriction_slugs(props)
            if props.get("gemeenteBeperking"):
                restricted += 1
                for name in props["gemeenteBeperking"]:
                    if not name:
                        continue
                    # A restriction we cannot resolve to a current slug would
                    # silently shrink the catchment, so count it for the log.
                    from analysis import gemeente_slug

                    if gemeente_slug(name) not in {m["slug"] for m in municipalities}:
                        unresolved[name] += 1
            subset_counts.update(subsets)

            features.append({
                "type": "Feature",
                "geometry": feature["geometry"],
                "properties": {
                    "merk": props.get("merk"),
                    "puntType": props.get("puntType"),
                    "materialen": props.get("materialen") or [],
                    "subsets": subsets,
                    "gemeente": muni["name"],
                    "gemeenteSlug": slug,
                    "gemeenteBeperkingSlugs": allowed,
                    "vrijToegankelijk": bool(props.get("vrijToegankelijk")),
                    "bronId": props.get("bronId"),
                },
            })

    payload = {
        "type": "FeatureCollection",
        "metadata": {
            "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "total_points": len(features),
            "restricted_points": restricted,
            "subset_counts": dict(sorted(subset_counts.items())),
            "source": "webapp/public/data/{slug}.geojson",
        },
        "features": features,
    }
    ANALYSIS_POINTS_PATH.parent.mkdir(parents=True, exist_ok=True)
    ANALYSIS_POINTS_PATH.write_text(json.dumps(payload, separators=(",", ":")))

    print(f"✓ {len(features)} punten → {ANALYSIS_POINTS_PATH} "
          f"({ANALYSIS_POINTS_PATH.stat().st_size / 1e6:.1f} MB)")
    print(f"  {restricted} punten met gemeentebeperking")
    for name, count in sorted(subset_counts.items()):
        print(f"  {name:<14} {count:>6}")
    if missing_files:
        print(f"  ⚠️  geen GeoJSON voor {len(missing_files)} gemeenten: "
              f"{sorted(missing_files)[:5]}...")
    if unresolved:
        print("  ⚠️  onbekende gemeentenamen in gemeenteBeperking "
              "(catchment wordt hier te klein geschat):")
        for name, count in unresolved.most_common():
            print(f"     {name} ({count}×)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
