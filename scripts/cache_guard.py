"""
Guard against silently wiping a good cache with a bad fetch.

Every source fetcher writes through `safe_save`. If a fetch returns zero
results, or more than 20% fewer than the cache it would replace, the existing
cache is left untouched and the process exits with code 2. The GitHub Actions
workflow treats that exit code as a warning rather than a failure, so one
broken source degrades the dataset instead of breaking the whole run.

Exit codes:
    0 = data saved
    2 = anomaly detected, existing cache preserved
"""

from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

EXIT_CODE_ANOMALY = 2
THRESHOLD_PCT = 20


def _existing_count(cache_path: Path) -> int | None:
    """Number of locations in an existing cache file, or None if unreadable."""
    if not cache_path.exists():
        return None
    try:
        with open(cache_path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
        return len(data.get("locations", []))
    except Exception:  # noqa: BLE001 - a corrupt cache is the same as no cache
        return None


def safe_save(
    source: str,
    new_locations: list[dict[str, Any]],
    output_path: Path | str,
    metadata: dict[str, Any],
) -> bool:
    """Write locations to the cache unless the result looks anomalous."""
    output_path = Path(output_path)
    new_count = len(new_locations)
    old_count = _existing_count(output_path)

    if new_count == 0:
        print()
        print(f"⚠️  WARNING: {source} fetched 0 locations.")
        if old_count:
            print(f"   Keeping existing cache ({old_count} locations) to prevent data loss.")
        else:
            print("   No existing cache to preserve.")
        print()
        sys.exit(EXIT_CODE_ANOMALY)

    if old_count:
        drop_pct = ((old_count - new_count) / old_count) * 100
        if drop_pct > THRESHOLD_PCT:
            print()
            print("=" * 78)
            print(f"ANOMALY DETECTED: {source}")
            print("=" * 78)
            print(f"  Existing cache: {old_count} locations")
            print(f"  New fetch:      {new_count} locations")
            print(f"  Change:         {-drop_pct:.1f}% (threshold: -{THRESHOLD_PCT}%)")
            print()
            print("  Keeping existing cache. Investigate the source before re-running.")
            print("=" * 78)
            sys.exit(EXIT_CODE_ANOMALY)

        if abs(drop_pct) > 5:
            direction = "decrease" if drop_pct > 0 else "increase"
            print(f"  ℹ️  {source}: {abs(drop_pct):.1f}% {direction} ({old_count} → {new_count})")

    metadata["total_locations"] = new_count
    metadata.setdefault("fetched_at", datetime.now(timezone.utc).isoformat())

    output_path.parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as handle:
        json.dump({"metadata": metadata, "locations": new_locations}, handle, ensure_ascii=False)

    size_kb = output_path.stat().st_size / 1024
    print(f"💾 Saved: {output_path.name}  ({new_count} locations, {size_kb:.0f} KB)")
    return True
