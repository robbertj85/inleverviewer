"""Generate placement suggestions for new inleverpunten per municipality.

Combines four PC4-level signals into one priority score, then derives concrete
coordinates for the top-N postcode areas:

  underservice  predicted minus actual points, from the regression in the
                Schatting tab (per material stream)
  uncovered     inhabitants beyond 400 m of any point in that stream
  density       omgevingsadressendichtheid — where the demand concentrates
  overlap       share of the PC4 already inside a 400 m buffer (a penalty)

Each is z-scored within the municipality, so the weights are comparable, and
the client can recompute the score under different weights without a rerun.

Suggestion derivation, per PC4:
  1. White spot = PC4 polygon minus the existing 400 m buffer union.
  2. Keep only the parts holding inhabited CBS 100 m cells. Parks, water,
     farmland and golf courses drop out.
  3. Take the densest inhabited cell in the best-populated part as candidate.
  4. Snap to a nearby POI that can host this stream (supermarkt and
     winkelcentrum for statiegeld, bouwmarkt and drogisterij for batteries,
     milieustraat for elektro), else leave it on the cell.
  5. est_new_pop = CBS inhabitants inside the candidate's 400 m buffer that
     are not already covered.

Unlike the sister pakketpunten project, the exclusion buffer is carried across
PC4s within a municipality rather than reset per PC4. Resetting lets two
adjacent PC4s each propose a spot 200 m apart, both claiming the same
residents as newly reached — which overstates the gain when the suggestions
are added up.

Output → webapp/public/data/placement_suggestions.json

Run order:
    python scripts/build_pc4_stats.py
    python scripts/fit_pc4_model.py
    python scripts/compute_population_coverage.py
    python scripts/suggest_placements.py --only pilot
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

import geopandas as gpd  # noqa: E402
import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402
from shapely.geometry import Point  # noqa: E402
from shapely.geometry.base import BaseGeometry  # noqa: E402
from shapely.ops import unary_union  # noqa: E402
from shapely.validation import make_valid  # noqa: E402

from analysis import (  # noqa: E402
    BUFFER_RESOLUTION,
    PC4_PATH,
    POI_MUNI_DIR,
    RD_NEW,
    WGS84,
    assert_poi_bundles_exist,
    load_analysis_points,
    load_cbs_grid_arrays,
    load_webapp_municipalities,
    resolve_slugs,
)
from utils import WEBAPP_DATA_DIR  # noqa: E402

STATS_PATH = WEBAPP_DATA_DIR / "pc4_stats.json"
COVERAGE_PATH = WEBAPP_DATA_DIR / "population_coverage.json"
OUT_PATH = WEBAPP_DATA_DIR / "placement_suggestions.json"

BUFFER_M = 400                    # the walkable threshold used app-wide
TOP_N = 10                        # PC4s shipped per municipality
MIN_PC4_POPULATION = 50           # exclude industrial and water PC4s
MIN_WHITE_SPOT_AREA_M2 = 5_000    # discard slivers
MAX_SUGGESTIONS_PER_PC4 = 3

# Snapping radii.
#
# A white spot is by construction at least 400 m from an existing point in the
# stream — and for statiegeld those points *are* supermarkets, so the white
# spot is also far from supermarkets. In Zwolle the nearest host sits 400 to
# 1600 m from every candidate cell, and a 250 m radius therefore never fires,
# leaving the advice as a bare coordinate in a residential street.
#
# So: snap within 250 m when possible, accept up to 400 m (the same walking
# threshold the whole app uses — a host that far away still serves the same
# residents), and beyond that report the nearest host without moving the
# suggestion. "No suitable host within walking distance" is itself a finding:
# it means a standalone unit rather than a counter inside a shop.
POI_SNAP_RADIUS_M = 250
POI_SNAP_MAX_M = 400
POI_REPORT_RADIUS_M = 1500

STREAMS = ("statiegeld", "batterijen", "elektro")

DEFAULT_WEIGHTS = {
    "underservice": 0.40,
    "uncovered_pop": 0.35,
    "density": 0.15,
    "overlap_penalty": -0.10,
}

# Which POI types can host which stream, and in what order of preference.
# This differs per stream on purpose: a deposit machine belongs at a
# supermarket, a battery bin at a chemist or DIY store, and bulky electricals
# at a municipal recycling centre.
POI_SNAP_TIERS: dict[str, dict[str, int]] = {
    "statiegeld": {
        "supermarkt": 0, "winkelcentrum": 0,
        "ns_station": 1, "ov_knooppunt": 1, "metro_station": 1,
        "parkeergarage": 2, "glasbak": 3,
    },
    "batterijen": {
        "bouwmarkt": 0, "drogisterij": 0, "supermarkt": 0,
        "winkelcentrum": 1, "bibliotheek": 1, "gemeentehuis": 1,
        "ns_station": 2, "ov_knooppunt": 2, "glasbak": 3,
    },
    "elektro": {
        "milieustraat": 0,
        "bouwmarkt": 1, "winkelcentrum": 1,
        "supermarkt": 2, "gemeentehuis": 2,
    },
}

# Grid arrays shared with the per-municipality loop.
_CELL_X: np.ndarray
_CELL_Y: np.ndarray
_CELL_POP: np.ndarray


def zscore(values: np.ndarray) -> np.ndarray:
    """z-score, falling back to zeros when every value is identical."""
    sd = float(np.std(values))
    if sd == 0:
        return np.zeros_like(values, dtype=float)
    return (values - float(np.mean(values))) / sd


def cells_in(geometry: BaseGeometry) -> np.ndarray:
    """Indices of CBS cells whose centroid falls inside `geometry` (RD)."""
    minx, miny, maxx, maxy = geometry.bounds
    box = np.nonzero(
        (_CELL_X >= minx) & (_CELL_X <= maxx) & (_CELL_Y >= miny) & (_CELL_Y <= maxy)
    )[0]
    if box.size == 0:
        return box
    from shapely.prepared import prep

    prepared = prep(geometry)
    return np.asarray(
        [i for i in box if prepared.contains(Point(_CELL_X[i], _CELL_Y[i]))], dtype=int
    )


def white_spot_parts(pc4_polygon, exclusion) -> list[BaseGeometry]:
    """Polygon parts of (PC4 − exclusion) above the sliver threshold."""
    if exclusion is None:
        white = pc4_polygon
    else:
        try:
            white = pc4_polygon.difference(exclusion)
        except Exception:  # noqa: BLE001 — invalid geometry, no white spot
            return []
    if white.is_empty:
        return []
    if white.geom_type == "Polygon":
        parts = [white]
    elif white.geom_type == "MultiPolygon":
        parts = list(white.geoms)
    else:
        return []
    return [p for p in parts if p.area >= MIN_WHITE_SPOT_AREA_M2]


def load_poi_index(slug: str, stream: str) -> dict | None:
    """Snap targets for one stream: RD arrays plus per-POI metadata."""
    path = POI_MUNI_DIR / f"{slug}.geojson"
    if not path.exists():
        return None
    tiers = POI_SNAP_TIERS[stream]
    with open(path, encoding="utf-8") as handle:
        payload = json.load(handle)

    lons, lats, props = [], [], []
    for feature in payload.get("features", []):
        category = feature.get("properties", {}).get("category")
        if category not in tiers:
            continue
        coords = (feature.get("geometry") or {}).get("coordinates")
        if not coords:
            continue
        lons.append(float(coords[0]))
        lats.append(float(coords[1]))
        props.append({
            "category": category,
            "name": str(feature["properties"].get("name") or ""),
            "tier": tiers[category],
        })
    if not props:
        return None
    projected = gpd.GeoSeries(gpd.points_from_xy(lons, lats), crs=WGS84).to_crs(RD_NEW)
    return {
        "x": projected.x.to_numpy(),
        "y": projected.y.to_numpy(),
        "tier": np.array([p["tier"] for p in props], dtype=int),
        "props": props,
    }


def nearest_snap_poi(x: float, y: float, index: dict | None,
                     radius_m: float) -> dict | None:
    """Best host POI within `radius_m`, ranked by (tier, distance).

    Tier dominates so a supermarket beats a closer glass container, which is
    what "where would this actually go" means in practice.
    """
    if index is None:
        return None
    dx = index["x"] - x
    dy = index["y"] - y
    d2 = dx * dx + dy * dy
    in_range = np.nonzero(d2 <= radius_m**2)[0]
    if in_range.size == 0:
        return None
    best = min(in_range, key=lambda i: (int(index["tier"][i]), float(d2[i])))
    entry = index["props"][best]
    return {
        "category": entry["category"],
        "naam": entry["name"],
        "x": float(index["x"][best]),
        "y": float(index["y"][best]),
        "distance_m": int(round(float(np.sqrt(d2[best])))),
    }


def to_wgs84(x: float, y: float) -> tuple[float, float]:
    point = gpd.GeoSeries([Point(x, y)], crs=RD_NEW).to_crs(WGS84).iloc[0]
    return round(float(point.y), 6), round(float(point.x), 6)


def derive_spot(pc4_polygon, exclusion, poi_index) -> dict | None:
    """One concrete suggestion inside this PC4's largest populated white spot."""
    parts = white_spot_parts(pc4_polygon, exclusion)
    if not parts:
        return None

    best_part = None
    best_cells: np.ndarray | None = None
    best_pop = -1.0
    for part in parts:
        idx = cells_in(part)
        population = float(_CELL_POP[idx].sum()) if idx.size else 0.0
        if population > best_pop:
            best_pop, best_part, best_cells = population, part, idx
    if best_part is None or best_pop <= 0:
        # Unpopulated white spot — a park or a lake, not a placement gap.
        return None

    # The densest inhabited cell beats representative_point(): it gravitates
    # to where people actually live inside the polygon.
    densest = int(best_cells[np.argmax(_CELL_POP[best_cells])])
    x, y = float(_CELL_X[densest]), float(_CELL_Y[densest])
    pre_lat, pre_lon = to_wgs84(x, y)

    # Snap when a host is close enough to still serve the same residents;
    # otherwise keep the cell and report the nearest host as context.
    poi = nearest_snap_poi(x, y, poi_index, POI_SNAP_MAX_M)
    snapped = poi is not None
    if snapped:
        x, y = poi["x"], poi["y"]
    else:
        poi = nearest_snap_poi(x, y, poi_index, POI_REPORT_RADIUS_M)
    lat, lon = to_wgs84(x, y)

    # Newly reached inhabitants: cells inside the 400 m buffer that the
    # exclusion union does not already cover.
    buffer = Point(x, y).buffer(BUFFER_M, resolution=BUFFER_RESOLUTION)
    reachable = buffer if exclusion is None else buffer.difference(exclusion)
    est_new_pop = 0
    if not reachable.is_empty:
        idx = cells_in(reachable)
        est_new_pop = int(round(float(_CELL_POP[idx].sum()))) if idx.size else 0

    return {
        "lat": lat,
        "lon": lon,
        "pre_snap_lat": pre_lat,
        "pre_snap_lon": pre_lon,
        "white_spot_area_m2": int(round(float(best_part.area))),
        "est_new_pop_within_400m": est_new_pop,
        # `snapped` distinguishes "this coordinate is a real address" from
        # "this is the population centre, nearest host is N metres away".
        "snapped": snapped,
        "poi_category": poi["category"] if poi else None,
        "poi_naam": poi["naam"] if poi else None,
        "poi_distance_m": poi["distance_m"] if poi else None,
        "_x": x,
        "_y": y,
    }


def process_municipality(slug: str, name: str, stream: str, stats: dict,
                         coverage_pc4: dict, pc4_polygons: dict,
                         points_by_muni: dict, weights: dict) -> dict | None:
    """Score every PC4 in one municipality and derive spots for the top-N."""
    candidates = []
    for pc4, entry in stats.items():
        if entry.get("municipality_slug") != slug:
            continue
        if (entry.get("population") or 0) < MIN_PC4_POPULATION:
            continue
        if pc4 not in pc4_polygons:
            continue
        coverage = coverage_pc4.get(pc4)
        if not coverage:
            continue

        actual = entry["inleverpunten"]["by_subset"].get(stream, 0)
        model = (entry.get("model") or {}).get(stream) or {}
        # Prefer the feature set that cross-validates best; fall back down the
        # chain when CBS suppressed the inputs for this PC4.
        predicted = next(
            (model.get(k) for k in ("ruim", "extended", "base") if model.get(k) is not None),
            float(actual),
        )
        pct_400 = ((coverage.get(stream) or {}).get("400m") or {}).get("pct", 0.0) or 0.0
        candidates.append({
            "pc4": pc4,
            "population": entry["population"],
            "area_km2": entry["area_km2"],
            "actual": actual,
            "predicted": float(predicted),
            "underservice": max(0.0, float(predicted) - float(actual)),
            "uncovered_pop": float(entry["population"]) * (1.0 - pct_400 / 100.0),
            "density": float(entry.get("oad") or 0.0),
            "coverage_pct_400m": pct_400,
        })

    if len(candidates) < 2:
        return None  # too few PC4s to z-score meaningfully

    # 400 m union around this municipality's existing points in this stream.
    geometries = points_by_muni.get(slug, {}).get(stream, [])
    buffer_union = None
    if geometries:
        buffer_union = unary_union(
            [g.buffer(BUFFER_M, resolution=BUFFER_RESOLUTION) for g in geometries]
        )
        if not buffer_union.is_valid:
            buffer_union = make_valid(buffer_union)

    for candidate in candidates:
        polygon = pc4_polygons[candidate["pc4"]]
        area = float(polygon.area)
        candidate["pc4_area_m2"] = area
        if buffer_union is None or area == 0:
            candidate["overlap_penalty"] = 0.0
        else:
            try:
                candidate["overlap_penalty"] = float(
                    polygon.intersection(buffer_union).area
                ) / area
            except Exception:  # noqa: BLE001
                candidate["overlap_penalty"] = 0.0

    frame = pd.DataFrame(candidates)
    for column in ("underservice", "uncovered_pop", "density", "overlap_penalty"):
        frame[f"z_{column}"] = zscore(frame[column].to_numpy())
    frame["priority"] = sum(
        weights[column] * frame[f"z_{column}"]
        for column in ("underservice", "uncovered_pop", "density", "overlap_penalty")
    )
    frame = frame.sort_values("priority", ascending=False).reset_index(drop=True)

    poi_index = load_poi_index(slug, stream)

    # One exclusion union for the whole municipality, grown as spots are
    # placed. Resetting it per PC4 — as the sister project does — lets two
    # neighbouring PC4s both claim the same residents.
    exclusion = buffer_union
    records = []
    for _, row in frame.head(TOP_N).iterrows():
        polygon = pc4_polygons[row["pc4"]]
        spots = []
        for rank in range(1, MAX_SUGGESTIONS_PER_PC4 + 1):
            spot = derive_spot(polygon, exclusion, poi_index)
            if spot is None:
                break
            spot["rank"] = rank
            spot_buffer = Point(spot.pop("_x"), spot.pop("_y")).buffer(
                BUFFER_M, resolution=BUFFER_RESOLUTION
            )
            exclusion = spot_buffer if exclusion is None else exclusion.union(spot_buffer)
            spots.append(spot)

        records.append({
            "pc4": row["pc4"],
            "priority": round(float(row["priority"]), 3),
            "population": int(row["population"]),
            "actual": int(row["actual"]),
            "predicted": round(float(row["predicted"]), 2),
            "underservice": round(float(row["underservice"]), 2),
            "uncovered_pop": int(round(float(row["uncovered_pop"]))),
            "density": int(round(float(row["density"]))),
            "overlap_pct": round(float(row["overlap_penalty"]) * 100, 1),
            "coverage_pct_400m": round(float(row["coverage_pct_400m"]), 1),
            # Z-scores so the client can recompute priority under other
            # weights and reproduce the server ranking exactly at the defaults.
            "z_underservice": round(float(row["z_underservice"]), 4),
            "z_uncovered_pop": round(float(row["z_uncovered_pop"]), 4),
            "z_density": round(float(row["z_density"]), 4),
            "z_overlap_penalty": round(float(row["z_overlap_penalty"]), 4),
            "suggestions": spots,
        })

    return {
        "gemeente": name,
        "pc4_count_evaluated": int(len(frame)),
        "existing_points": len(geometries),
        "pc4s": records,
    }


def main() -> int:
    global _CELL_X, _CELL_Y, _CELL_POP

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--only", type=str, default="pilot",
                        help="Comma-separated slugs, 'pilot', or 'all'")
    parser.add_argument("--streams", type=str, default=",".join(STREAMS))
    for key, value in DEFAULT_WEIGHTS.items():
        parser.add_argument(f"--w-{key.replace('_', '-')}", type=float, default=value)
    args = parser.parse_args()

    weights = {
        key: getattr(args, f"w_{key}") for key in DEFAULT_WEIGHTS
    }
    streams = [s.strip() for s in args.streams.split(",") if s.strip()]
    unknown = [s for s in streams if s not in STREAMS]
    if unknown:
        parser.error(f"onbekende stromen {unknown} (kies uit {list(STREAMS)})")

    print("Inputs laden…")
    with open(STATS_PATH, encoding="utf-8") as handle:
        stats_payload = json.load(handle)
    stats = stats_payload["stats"]
    if not any(entry.get("model") for entry in stats.values()):
        print("❌ pc4_stats.json bevat geen modelvoorspellingen — draai eerst "
              "`python scripts/fit_pc4_model.py`.", file=sys.stderr)
        return 1

    with open(COVERAGE_PATH, encoding="utf-8") as handle:
        coverage_pc4 = json.load(handle)["pc4"]

    pc4_gdf = gpd.read_file(PC4_PATH).to_crs(RD_NEW)
    pc4_gdf["pc4"] = pc4_gdf["pc4"].astype(str).str.zfill(4)
    # Zip the columns rather than iterrows(): a row Series holds mixed dtypes,
    # so `.geometry` there resolves to the pandas accessor, not the shape.
    pc4_polygons = {
        pc4: geometry
        for pc4, geometry in zip(pc4_gdf["pc4"], pc4_gdf.geometry)
        if geometry is not None and not geometry.is_empty
    }

    _CELL_X, _CELL_Y, _CELL_POP = load_cbs_grid_arrays()
    print(f"  {len(pc4_polygons)} PC4-polygonen, {_CELL_POP.size:,} bewoonde cellen")

    municipalities = load_webapp_municipalities()
    by_slug = {m["slug"]: m for m in municipalities}
    slugs = resolve_slugs(args.only, all_slugs=by_slug)
    assert_poi_bundles_exist(slugs)

    print("Bestaande inleverpunten laden…")
    points = load_analysis_points()
    points = points[points["gemeenteSlug"].isin(slugs)].to_crs(RD_NEW)
    points_by_muni: dict[str, dict[str, list]] = {}
    for slug, group in points.groupby("gemeenteSlug"):
        per_stream: dict[str, list] = {s: [] for s in STREAMS}
        for geometry, subsets in zip(group.geometry, group["subsets"]):
            for stream in STREAMS:
                if stream in subsets:
                    per_stream[stream].append(geometry)
        points_by_muni[slug] = per_stream

    print(f"\n{len(slugs)} gemeenten × {len(streams)} stromen scoren…")
    results: dict[str, dict] = {}
    for stream in streams:
        results[stream] = {}
        for slug in slugs:
            payload = process_municipality(
                slug, by_slug[slug]["name"], stream, stats, coverage_pc4,
                pc4_polygons, points_by_muni, weights,
            )
            if payload is None:
                print(f"  {stream:<11} {slug}: overgeslagen (te weinig PC4's)")
                continue
            results[stream][slug] = payload
            n_spots = sum(len(r["suggestions"]) for r in payload["pc4s"])
            print(f"  {stream:<11} {slug}: {len(payload['pc4s'])} PC4's, "
                  f"{n_spots} locaties", flush=True)

    out = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "weights": weights,
        "streams": streams,
        "top_n_per_municipality": TOP_N,
        "suggestions_per_pc4": MAX_SUGGESTIONS_PER_PC4,
        "buffer_m": BUFFER_M,
        "poi_snap_radius_m": POI_SNAP_RADIUS_M,
        "poi_snap_max_m": POI_SNAP_MAX_M,
        "poi_report_radius_m": POI_REPORT_RADIUS_M,
        "poi_snap_tiers": POI_SNAP_TIERS,
        "min_pc4_population": MIN_PC4_POPULATION,
        "min_white_spot_area_m2": MIN_WHITE_SPOT_AREA_M2,
        "methodology": {
            "score": (
                "Σ gewicht × z-score binnen de gemeente over vier signalen: "
                "onderbediening t.o.v. het regressiemodel, ongedekte inwoners "
                "binnen 400 m, adressendichtheid, en een strafterm voor het deel "
                "van het PC4 dat al binnen 400 m van een punt ligt"
            ),
            "witte_vlek": (
                "PC4-polygoon minus de 400 m-buffer om bestaande punten, "
                "gemaskeerd op bewoonde CBS 100 m-cellen; de dichtstbevolkte cel "
                "in het best bevolkte deel wordt de kandidaat"
            ),
            "snapping": (
                f"de kandidaat schuift naar een POI die deze stroom kan huisvesten "
                f"binnen {POI_SNAP_MAX_M} m (supermarkt voor statiegeld, bouwmarkt "
                f"of drogisterij voor batterijen, milieustraat voor elektro). Ligt "
                f"er geen gastheer binnen loopafstand, dan blijft het punt op het "
                f"bevolkingszwaartepunt staan en wordt de dichtstbijzijnde gastheer "
                f"alleen gerapporteerd — dat betekent een zelfstandige unit in "
                f"plaats van een balie in een winkel"
            ),
            "waarom_vaak_niet_gesnapt": (
                "een witte vlek ligt per definitie ≥400 m van de bestaande punten in "
                "die stroom, en voor statiegeld zíjn dat de supermarkten — dus ligt "
                "de vlek ook ver van supermarkten"
            ),
            "uitsluiting": (
                "de uitsluitingsbuffer loopt door over alle PC4's van een gemeente, "
                "niet per PC4 opnieuw; anders claimen twee aangrenzende PC4's "
                "dezelfde inwoners als nieuw bereikt"
            ),
        },
        "by_stream": results,
    }
    OUT_PATH.write_text(json.dumps(out, separators=(",", ":"), allow_nan=False))
    print(f"\n✅ {OUT_PATH.relative_to(Path(__file__).parent.parent)} "
          f"({OUT_PATH.stat().st_size / 1024:.0f} KB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
