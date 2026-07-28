"""
Append a weekly snapshot to the totals history.

Runs at the end of the weekly update, after the GeoJSON files are regenerated.
Reads what was just written, records national and per-municipality counts for
the current ISO week, and appends it to totals_history.json.

The file is append-only per ISO week: re-running in the same week overwrites
that week's entry rather than adding a duplicate, so a manual re-run after a
failed job does not corrupt the trend.

    python scripts/update_totals_history.py
"""

from __future__ import annotations

import json
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from normalize import MERKEN  # noqa: E402
from utils import WEBAPP_DATA_DIR  # noqa: E402

HISTORY_PATH = WEBAPP_DATA_DIR / "totals_history.json"

# Trend is reported over this many weeks when enough history exists.
TREND_WINDOW_WEEKS = 4


def week_bounds(today: date) -> tuple[str, str]:
    """Monday and Sunday of the ISO week containing `today`."""
    monday = today - timedelta(days=today.weekday())
    return monday.isoformat(), (monday + timedelta(days=6)).isoformat()


def read_municipality_counts() -> tuple[dict[str, dict], dict[str, int], int]:
    """Read every municipality GeoJSON and tally points per brand."""
    per_municipality: dict[str, dict] = {}
    national: dict[str, int] = {merk: 0 for merk in MERKEN}
    total = 0

    for path in sorted(WEBAPP_DATA_DIR.glob("*.geojson")):
        # The national file is a roll-up of the rest; counting it would double.
        if path.stem == "nederland":
            continue

        try:
            with open(path, "r", encoding="utf-8") as handle:
                data = json.load(handle)
        except (json.JSONDecodeError, OSError) as error:
            print(f"  ⚠️  Skipping {path.name}: {error}")
            continue

        counts: dict[str, int] = {}
        for feature in data.get("features", []):
            properties = feature.get("properties", {})
            if properties.get("type") != "inleverpunt":
                continue
            merk = properties.get("merk")
            if merk:
                counts[merk] = counts.get(merk, 0) + 1

        municipality_total = sum(counts.values())
        per_municipality[path.stem] = {"total": municipality_total, "merken": counts}

        for merk, count in counts.items():
            national[merk] = national.get(merk, 0) + count
        total += municipality_total

    return per_municipality, national, total


def load_history() -> dict:
    """Load the existing history file, or start a fresh one."""
    if not HISTORY_PATH.exists():
        return {"updated_at": None, "snapshots": [], "municipalities": {}}

    try:
        with open(HISTORY_PATH, "r", encoding="utf-8") as handle:
            history = json.load(handle)
    except (json.JSONDecodeError, OSError) as error:
        print(f"  ⚠️  Could not read history ({error}); starting fresh")
        return {"updated_at": None, "snapshots": [], "municipalities": {}}

    history.setdefault("snapshots", [])
    history.setdefault("municipalities", {})
    return history


def compute_trend(snapshots: list[dict]) -> dict | None:
    """Compare the newest snapshot against one from `TREND_WINDOW_WEEKS` ago."""
    if len(snapshots) < 2:
        return None

    latest = snapshots[-1]
    earlier = snapshots[max(0, len(snapshots) - 1 - TREND_WINDOW_WEEKS)]

    merk_changes = {
        merk: latest["totals"]["merken"].get(merk, 0) - earlier["totals"]["merken"].get(merk, 0)
        for merk in MERKEN
    }

    return {
        "period": {
            "from": earlier["week_label"],
            "to": latest["week_label"],
            "weeks": len(snapshots) - 1 - max(0, len(snapshots) - 1 - TREND_WINDOW_WEEKS),
        },
        "change": {
            "total": latest["totals"]["total"] - earlier["totals"]["total"],
            "merken": merk_changes,
        },
    }


def main() -> int:
    print("📈 Updating totals history...")

    per_municipality, national, total = read_municipality_counts()

    if total == 0:
        print("  ❌ No points found in the data directory — refusing to record an empty week")
        return 1

    today = date.today()
    iso_year, iso_week, _ = today.isocalendar()
    week_label = f"{iso_year}-W{iso_week:02d}"
    date_from, date_to = week_bounds(today)

    snapshot = {
        "date": today.isoformat(),
        "week": iso_week,
        "year": iso_year,
        "week_label": week_label,
        "date_from": date_from,
        "date_to": date_to,
        "totals": {"total": total, "merken": national},
    }

    history = load_history()

    # Replace this week's entry if the job already ran, else append.
    snapshots = [s for s in history["snapshots"] if s.get("week_label") != week_label]
    snapshots.append(snapshot)
    snapshots.sort(key=lambda s: (s["year"], s["week"]))
    history["snapshots"] = snapshots

    for slug, counts in per_municipality.items():
        entry = history["municipalities"].setdefault(slug, {"history": []})
        entries = [e for e in entry["history"] if e.get("week_label") != week_label]
        entries.append({
            "date": today.isoformat(),
            "week": iso_week,
            "year": iso_year,
            "week_label": week_label,
            "date_from": date_from,
            "date_to": date_to,
            "total": counts["total"],
            "merken": counts["merken"],
        })
        entries.sort(key=lambda e: (e["year"], e["week"]))
        entry["history"] = entries

    history["updated_at"] = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    trend = compute_trend(snapshots)
    if trend:
        history["trend"] = trend

    HISTORY_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(HISTORY_PATH, "w", encoding="utf-8") as handle:
        json.dump(history, handle, ensure_ascii=False)

    print(f"  ✅ {week_label}: {total} points across {len(per_municipality)} municipalities")
    for merk, count in national.items():
        print(f"     {merk}: {count}")
    if trend:
        change = trend["change"]["total"]
        sign = "+" if change >= 0 else ""
        print(f"  📊 Trend since {trend['period']['from']}: {sign}{change}")
    print(f"  💾 {HISTORY_PATH.name}: {len(snapshots)} weekly snapshots")

    return 0


if __name__ == "__main__":
    sys.exit(main())
