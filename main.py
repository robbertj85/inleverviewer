"""
Command-line entry point for inspecting a single municipality.

Handy during development and debugging; the weekly pipeline uses the scripts in
scripts/ directly rather than going through this.

    python main.py --gemeente Zwolle
    python main.py --gemeente Amsterdam --format csv --output amsterdam.csv
"""

from __future__ import annotations

import argparse
import json
import sys

from api_client import get_data_inleverpunten
from normalize import MERKEN
from utils import slugify


def main() -> int:
    parser = argparse.ArgumentParser(description="Inspect inleverpunten for one municipality")
    parser.add_argument("--gemeente", required=True, help="municipality name or slug")
    parser.add_argument("--format", choices=["table", "json", "csv"], default="table")
    parser.add_argument("--output", help="write to this file instead of stdout")
    args = parser.parse_args()

    assigned, _status, _unassigned = get_data_inleverpunten()
    if assigned.empty:
        print("❌ No data available. Run the fetchers in scripts/ first.", file=sys.stderr)
        return 1

    slug = slugify(args.gemeente)
    points = assigned[assigned["slug"] == slug]

    if points.empty:
        available = sorted(assigned["slug"].unique())
        print(f"❌ No data for '{args.gemeente}' (slug: {slug})", file=sys.stderr)
        near = [s for s in available if slug[:4] in s][:5]
        if near:
            print(f"   Did you mean: {', '.join(near)}?", file=sys.stderr)
        return 1

    columns = [
        "locatieNaam", "straatNaam", "straatNr", "postcode", "plaats",
        "merk", "puntType", "materialen", "latitude", "longitude",
    ]
    frame = points[columns].copy()

    if args.format == "csv":
        frame["materialen"] = frame["materialen"].apply(lambda m: "|".join(m or []))
        payload = frame.to_csv(index=False)
    elif args.format == "json":
        payload = json.dumps(frame.to_dict(orient="records"), ensure_ascii=False, indent=2)
    else:
        gemeente = points["gemeente"].iloc[0]
        lines = [f"\n{gemeente} — {len(points)} inleverpunten\n"]
        for merk in MERKEN:
            count = int((points["merk"] == merk).sum())
            if count:
                lines.append(f"  {merk:22s} {count:5d}")
        lines.append("")
        for categorie, count in points["puntType"].value_counts().items():
            lines.append(f"  {categorie:22s} {count:5d}")
        payload = "\n".join(lines)

    if args.output:
        with open(args.output, "w", encoding="utf-8") as handle:
            handle.write(payload)
        print(f"💾 Written to {args.output}")
    else:
        print(payload)

    return 0


if __name__ == "__main__":
    sys.exit(main())
