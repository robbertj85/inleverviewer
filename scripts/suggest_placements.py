"""Generate placement suggestions for new inleverpunten per municipality.

Combines four PC4-level signals into one priority score, then derives concrete
coordinates for the top-N postcode areas:

  underservice  predicted minus actual points, from the regression in the
                Schatting tab (per material stream)
  uncovered     inhabitants beyond 400 m of a point
  density       omgevingsadressendichtheid — where the demand concentrates
  overlap       share of the PC4 already inside a 400 m buffer (a penalty)

Each is z-scored within the municipality, so the weights are comparable, and
the client can recompute the score under different weights without a rerun.

Variants. Every municipality is scored for each of

  stream   statiegeld, batterijen, elektro, or `alle`: one location that takes
           all three. For `alle` a resident counts as reached in proportion to
           the streams they can already drop off within 400 m, and the
           underservice of the three streams is summed.
  pakket   with or without parcel points as an extra network. With, a resident
           without a pakketpunt within 400 m counts as unreached on that
           network too, and only hosts that can also take a parcel counter or
           locker are eligible.
  terrain  `mix`, `publiek` or `privaat`: which hosts the spot may snap to,
           from the ownership classification in classify_poi_ownership.py.
           Only the spots depend on this, so PC4 rows carry one suggestion
           list per terrain choice.

Suggestion derivation, per PC4, on the 100 m CBS raster:
  1. Every inhabited cell gets a need weight: its inhabitants times the share
     of the variant's networks (streams, plus parcel) that have no point
     within 400 m of it.
  2. Among the PC4's cells with need, take the one whose 400 m disk holds the
     most need-weighted inhabitants. Parks, water and farmland have none.
  3. Snap to a nearby POI that can host this variant, else leave it on the
     cell.
  4. est_new_pop = need-weighted inhabitants inside the final spot's 400 m
     buffer; gain_by_layer gives the same per network, unweighted.
  5. Mark those cells reached on every network of the variant.

Unlike the sister pakketpunten project, the reached state is carried across
PC4s within a municipality rather than reset per PC4. Resetting lets two
adjacent PC4s each propose a spot 200 m apart, both claiming the same
residents as newly reached — which overstates the gain when the suggestions
are added up.

Coverage uses the municipality's own inleverpunten (a milieustraat may turn
away residents of a neighbouring municipality) but every pakketpunt within
reach, which serves anyone.

Output → webapp/public/data/placement_suggestions/
    index.json        parameters, methodology, municipalities and variants
    <slug>.json       every variant for one municipality

Run order:
    python scripts/build_pc4_stats.py
    python scripts/fit_pc4_model.py
    python scripts/compute_population_coverage.py
    python scripts/fetch_pakketpunten.py
    python scripts/suggest_placements.py --only pilot
"""

from __future__ import annotations

import argparse
import json
import multiprocessing as mp
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

import geopandas as gpd  # noqa: E402
import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402
import shapely  # noqa: E402
from pyproj import Transformer  # noqa: E402
from shapely.ops import unary_union  # noqa: E402
from shapely.validation import make_valid  # noqa: E402

from analysis import (  # noqa: E402
    BUFFER_RESOLUTION,
    PAKKETPUNTEN_SNAPSHOT_PATH,
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
OUT_DIR = WEBAPP_DATA_DIR / "placement_suggestions"
# The single national file this used to write; removed so a release does not
# carry a stale copy next to the per-municipality files.
LEGACY_PATH = WEBAPP_DATA_DIR / "placement_suggestions.json"

BUFFER_M = 400                    # the walkable threshold used app-wide
CELL_M = 100                      # CBS raster; centroids sit on xx50
TOP_N = 10                        # PC4s shipped per municipality
MIN_PC4_POPULATION = 50           # exclude industrial and water PC4s
MAX_SUGGESTIONS_PER_PC4 = 3
# Cells per PC4 whose 400 m disk is evaluated; the rest have less need than
# the 40th-neediest cell and do not win in practice.
CANDIDATE_CELLS = 40

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
ALLE = "alle"
PAKKET = "pakket"
TERRAINS = ("mix", "publiek", "privaat")

DEFAULT_WEIGHTS = {
    "underservice": 0.40,
    "uncovered_pop": 0.35,
    "density": 0.15,
    "overlap_penalty": -0.10,
}
SIGNALS = tuple(DEFAULT_WEIGHTS)

# Which POI types can host which stream, and in what order of preference.
# This differs per stream on purpose: a deposit machine belongs at a
# supermarket, a battery bin at a chemist or DIY store, and bulky electricals
# at a municipal recycling centre. `alle` asks for room for all three at once,
# which a shopping centre or a large supermarket has and a glass container
# does not.
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
    ALLE: {
        "winkelcentrum": 0, "supermarkt": 0,
        "bouwmarkt": 1, "milieustraat": 1,
        "gemeentehuis": 2, "ns_station": 2, "ov_knooppunt": 2,
    },
}

# Hosts that can also take a parcel counter or locker, matching
# combi_geschikt in plan_inleverpunt_network.py. A milieustraat and a glass
# container cannot.
PAKKET_HOSTS = {
    "supermarkt", "winkelcentrum", "bouwmarkt", "drogisterij", "bibliotheek",
    "gemeentehuis", "ns_station", "ov_knooppunt", "metro_station", "parkeergarage",
}

_TO_WGS84 = Transformer.from_crs(RD_NEW, WGS84, always_xy=True)

# Offsets (in cells) of the cell centres within BUFFER_M of a cell centre.
_R_CELLS = BUFFER_M // CELL_M
_DISK = np.array(
    [(dy, dx) for dy in range(-_R_CELLS, _R_CELLS + 1)
     for dx in range(-_R_CELLS, _R_CELLS + 1) if dx * dx + dy * dy <= _R_CELLS ** 2]
)

# National inputs, shared with fork workers via module globals.
_CELL_X: np.ndarray
_CELL_Y: np.ndarray
_CELL_POP: np.ndarray
_STATS: dict
_COVERAGE: dict
_PC4_POLYGONS: dict
_POINTS: dict           # slug -> stream -> (x, y)
_PAKKET_XY: tuple       # national (x, y) in RD
_NAMES: dict
_WEIGHTS: dict


def variant_key(stream: str, pakket: bool) -> str:
    return f"{stream}+{PAKKET}" if pakket else stream


def variant_layers(stream: str, pakket: bool) -> list[str]:
    layers = list(STREAMS) if stream == ALLE else [stream]
    return layers + [PAKKET] if pakket else layers


def zscore(values: np.ndarray) -> np.ndarray:
    """z-score, falling back to zeros when every value is identical."""
    sd = float(np.std(values))
    if sd == 0:
        return np.zeros_like(values, dtype=float)
    return (values - float(np.mean(values))) / sd


def to_wgs84(x: float, y: float) -> tuple[float, float]:
    lon, lat = _TO_WGS84.transform(x, y)
    return round(float(lat), 6), round(float(lon), 6)


class Raster:
    """The 100 m CBS grid around one municipality as 2-D arrays.

    Row i, column j is the cell whose centre is (x0 + 100 j + 50,
    y0 + 100 i + 50). The extent reaches 500 m past every candidate PC4, so a
    400 m disk around any cell in one never runs off the edge.
    """

    def __init__(self, bounds: tuple[float, float, float, float]) -> None:
        margin = BUFFER_M + CELL_M
        self.x0 = np.floor((bounds[0] - margin) / CELL_M) * CELL_M
        self.y0 = np.floor((bounds[1] - margin) / CELL_M) * CELL_M
        self.width = int(np.ceil((bounds[2] + margin - self.x0) / CELL_M))
        self.height = int(np.ceil((bounds[3] + margin - self.y0) / CELL_M))
        self.pop = np.zeros((self.height, self.width))
        inside = np.nonzero(
            (_CELL_X >= self.x0) & (_CELL_X < self.x0 + self.width * CELL_M)
            & (_CELL_Y >= self.y0) & (_CELL_Y < self.y0 + self.height * CELL_M)
        )[0]
        rows, cols = self.index(_CELL_X[inside], _CELL_Y[inside])
        self.pop[rows, cols] = _CELL_POP[inside]

    def index(self, xs, ys) -> tuple[np.ndarray, np.ndarray]:
        cols = np.floor((np.asarray(xs) - self.x0) / CELL_M).astype(int)
        rows = np.floor((np.asarray(ys) - self.y0) / CELL_M).astype(int)
        return rows, cols

    def centre(self, row: int, col: int) -> tuple[float, float]:
        return self.x0 + col * CELL_M + CELL_M / 2, self.y0 + row * CELL_M + CELL_M / 2

    def disk(self, x: float, y: float) -> tuple[np.ndarray, np.ndarray]:
        """Cells whose centre lies within BUFFER_M of an arbitrary point."""
        reach = _R_CELLS + 1
        row0, col0 = self.index(x, y)
        rows, cols = np.mgrid[row0 - reach: row0 + reach + 1, col0 - reach: col0 + reach + 1]
        rows, cols = rows.ravel(), cols.ravel()
        ok = (rows >= 0) & (rows < self.height) & (cols >= 0) & (cols < self.width)
        rows, cols = rows[ok], cols[ok]
        cx = self.x0 + cols * CELL_M + CELL_M / 2
        cy = self.y0 + rows * CELL_M + CELL_M / 2
        near = (cx - x) ** 2 + (cy - y) ** 2 <= BUFFER_M ** 2
        return rows[near], cols[near]

    def covered_by(self, xs, ys) -> np.ndarray:
        covered = np.zeros(self.pop.shape, dtype=bool)
        for x, y in zip(xs, ys):
            covered[self.disk(x, y)] = True
        return covered

    def cells_in(self, polygon) -> tuple[np.ndarray, np.ndarray]:
        """Inhabited cells whose centre falls inside `polygon`."""
        minx, miny, maxx, maxy = polygon.bounds
        r0, c0 = self.index(minx, miny)
        r1, c1 = self.index(maxx, maxy)
        rows, cols = np.mgrid[max(r0, 0): min(r1, self.height - 1) + 1,
                              max(c0, 0): min(c1, self.width - 1) + 1]
        rows, cols = rows.ravel(), cols.ravel()
        keep = self.pop[rows, cols] > 0
        rows, cols = rows[keep], cols[keep]
        cx = self.x0 + cols * CELL_M + CELL_M / 2
        cy = self.y0 + rows * CELL_M + CELL_M / 2
        inside = shapely.contains_xy(polygon, cx, cy)
        return rows[inside], cols[inside]


def load_hosts(slug: str) -> dict | None:
    """Every POI in the municipality's bundle that some variant could snap to."""
    path = POI_MUNI_DIR / f"{slug}.geojson"
    if not path.exists():
        return None
    eligible = set().union(*(set(t) for t in POI_SNAP_TIERS.values()))
    with open(path, encoding="utf-8") as handle:
        payload = json.load(handle)

    lons, lats, props = [], [], []
    for feature in payload.get("features", []):
        properties = feature.get("properties", {})
        category = properties.get("category")
        coords = (feature.get("geometry") or {}).get("coordinates")
        if category not in eligible or not coords:
            continue
        lons.append(float(coords[0]))
        lats.append(float(coords[1]))
        props.append({
            "category": category,
            "name": str(properties.get("name") or ""),
            "eigendom": properties.get("eigendom") or "onbekend",
            "eigendom_bron": properties.get("eigendom_bron"),
        })
    if not props:
        return None
    projected = gpd.GeoSeries(gpd.points_from_xy(lons, lats), crs=WGS84).to_crs(RD_NEW)
    return {
        "x": projected.x.to_numpy(),
        "y": projected.y.to_numpy(),
        "category": np.array([p["category"] for p in props]),
        "eigendom": np.array([p["eigendom"] for p in props]),
        "props": props,
    }


def host_index(hosts: dict | None, stream: str, pakket: bool, terrain: str) -> dict | None:
    """The hosts one variant may snap to, with their tier."""
    if hosts is None:
        return None
    tiers = POI_SNAP_TIERS[stream]
    tier = np.array([tiers.get(c, -1) for c in hosts["category"]])
    keep = tier >= 0
    if pakket:
        keep &= np.isin(hosts["category"], list(PAKKET_HOSTS))
    if terrain != "mix":
        keep &= hosts["eigendom"] == terrain
    idx = np.nonzero(keep)[0]
    if idx.size == 0:
        return None
    return {
        "x": hosts["x"][idx],
        "y": hosts["y"][idx],
        "tier": tier[idx],
        "props": [hosts["props"][i] for i in idx],
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
        "eigendom": entry["eigendom"],
        "eigendom_bron": entry["eigendom_bron"],
        "x": float(index["x"][best]),
        "y": float(index["y"][best]),
        "distance_m": int(round(float(np.sqrt(d2[best])))),
    }


def need_weight(raster: Raster, covered: dict[str, np.ndarray], layers: list[str]) -> np.ndarray:
    """Inhabitants per cell times the share of `layers` that do not reach it."""
    missing = sum((~covered[layer]).astype(float) for layer in layers)
    return raster.pop * missing / len(layers)


def derive_spot(raster: Raster, cells: tuple[np.ndarray, np.ndarray],
                covered: dict[str, np.ndarray], layers: list[str],
                hosts: dict | None) -> dict | None:
    """One concrete suggestion in this PC4; marks its residents reached."""
    weight = need_weight(raster, covered, layers)
    rows, cols = cells
    need = weight[rows, cols]
    has_need = need > 0
    if not has_need.any():
        # Everyone here is already reached on every network of the variant.
        return None
    rows, cols, need = rows[has_need], cols[has_need], need[has_need]
    top = np.argsort(-need)[:CANDIDATE_CELLS]
    rows, cols = rows[top], cols[top]

    # Need-weighted inhabitants within 400 m of each candidate cell. The
    # raster margin keeps every offset in range.
    disk_rows = rows[:, None] + _DISK[None, :, 0]
    disk_cols = cols[:, None] + _DISK[None, :, 1]
    gains = weight[disk_rows, disk_cols].sum(axis=1)
    best = int(np.argmax(gains))
    x, y = raster.centre(int(rows[best]), int(cols[best]))
    pre_lat, pre_lon = to_wgs84(x, y)

    # Snap when a host is close enough to still serve the same residents;
    # otherwise keep the cell and report the nearest host as context.
    poi = nearest_snap_poi(x, y, hosts, POI_SNAP_MAX_M)
    snapped = poi is not None
    if snapped:
        x, y = poi["x"], poi["y"]
    else:
        poi = nearest_snap_poi(x, y, hosts, POI_REPORT_RADIUS_M)
    lat, lon = to_wgs84(x, y)

    reach = raster.disk(x, y)
    gain_by_layer = {}
    for layer in layers:
        fresh = ~covered[layer][reach]
        gain_by_layer[layer] = int(round(float(raster.pop[reach][fresh].sum())))
        covered[layer][reach] = True

    return {
        "lat": lat,
        "lon": lon,
        "pre_snap_lat": pre_lat,
        "pre_snap_lon": pre_lon,
        "est_new_pop_within_400m": int(round(sum(gain_by_layer.values()) / len(layers))),
        "gain_by_layer": gain_by_layer,
        # `snapped` distinguishes "this coordinate is a real address" from
        # "this is the population centre, nearest host is N metres away".
        "snapped": snapped,
        "poi_category": poi["category"] if poi else None,
        "poi_naam": poi["naam"] if poi else None,
        "poi_distance_m": poi["distance_m"] if poi else None,
        "poi_eigendom": poi["eigendom"] if poi else None,
        "poi_eigendom_bron": poi["eigendom_bron"] if poi else None,
    }


def buffer_union(xs, ys):
    if len(xs) == 0:
        return None
    union = unary_union(
        [shapely.Point(x, y).buffer(BUFFER_M, resolution=BUFFER_RESOLUTION)
         for x, y in zip(xs, ys)]
    )
    return union if union.is_valid else make_valid(union)


def area_share(polygon, union) -> float:
    area = float(polygon.area)
    if union is None or area == 0:
        return 0.0
    try:
        return float(polygon.intersection(union).area) / area
    except Exception:  # noqa: BLE001 — invalid geometry, no overlap
        return 0.0


def process_municipality(slug: str) -> tuple[str, dict | None, str]:
    """Score every PC4 in one municipality for every variant."""
    base = []
    for pc4, entry in _STATS.items():
        if entry.get("municipality_slug") != slug:
            continue
        if (entry.get("population") or 0) < MIN_PC4_POPULATION:
            continue
        if pc4 not in _PC4_POLYGONS or not _COVERAGE.get(pc4):
            continue
        base.append((pc4, entry))
    if len(base) < 2:
        return slug, None, "overgeslagen (te weinig PC4's)"

    polygons = {pc4: _PC4_POLYGONS[pc4] for pc4, _ in base}
    # Bounds from the parts, not a union: some PC4 polygons are invalid and
    # GEOS refuses to union them.
    extents = np.array([polygon.bounds for polygon in polygons.values()])
    raster = Raster((extents[:, 0].min(), extents[:, 1].min(),
                     extents[:, 2].max(), extents[:, 3].max()))
    pc4_cells = {pc4: raster.cells_in(polygon) for pc4, polygon in polygons.items()}

    # The networks: this municipality's own inleverpunten per stream, and
    # every pakketpunt that can reach the raster.
    own = _POINTS.get(slug, {})
    layer_points: dict[str, tuple[np.ndarray, np.ndarray]] = {
        stream: own.get(stream, (np.empty(0), np.empty(0))) for stream in STREAMS
    }
    px, py = _PAKKET_XY
    x_hi = raster.x0 + raster.width * CELL_M
    y_hi = raster.y0 + raster.height * CELL_M
    near = (px >= raster.x0 - BUFFER_M) & (px <= x_hi + BUFFER_M) \
        & (py >= raster.y0 - BUFFER_M) & (py <= y_hi + BUFFER_M)
    layer_points[PAKKET] = (px[near], py[near])

    covered0 = {layer: raster.covered_by(*xy) for layer, xy in layer_points.items()}
    overlap = {}
    for layer, (xs, ys) in layer_points.items():
        union = buffer_union(xs, ys)
        overlap[layer] = {pc4: area_share(polygon, union) for pc4, polygon in polygons.items()}

    hosts = load_hosts(slug)
    variants: dict[str, dict] = {}
    for stream in (*STREAMS, ALLE):
        for pakket in (False, True):
            layers = variant_layers(stream, pakket)
            streams = [layer for layer in layers if layer != PAKKET]
            weight0 = need_weight(raster, covered0, layers)

            rows = []
            for pc4, entry in base:
                actual = predicted = underservice = 0.0
                for s in streams:
                    a = entry["inleverpunten"]["by_subset"].get(s, 0)
                    model = (entry.get("model") or {}).get(s) or {}
                    # Prefer the feature set that cross-validates best; fall
                    # back down the chain when CBS suppressed the inputs.
                    p = next(
                        (model.get(k) for k in ("ruim", "extended", "base")
                         if model.get(k) is not None),
                        float(a),
                    )
                    actual += a
                    predicted += float(p)
                    underservice += max(0.0, float(p) - float(a))

                if layers == [stream]:
                    # A single stream keeps the figures the Bereik tab shows.
                    pct = ((_COVERAGE[pc4].get(stream) or {}).get("400m") or {}).get("pct", 0.0) or 0.0
                    uncovered = float(entry["population"]) * (1.0 - pct / 100.0)
                else:
                    r, c = pc4_cells[pc4]
                    cell_pop = float(raster.pop[r, c].sum())
                    uncovered_cells = float(weight0[r, c].sum())
                    pct = 100.0 * (1.0 - uncovered_cells / cell_pop) if cell_pop else 0.0
                    uncovered = float(entry["population"]) * (1.0 - pct / 100.0)

                rows.append({
                    "pc4": pc4,
                    "population": entry["population"],
                    "actual": actual,
                    "predicted": predicted,
                    "underservice": underservice,
                    "uncovered_pop": uncovered,
                    "density": float(entry.get("oad") or 0.0),
                    "overlap_penalty": float(np.mean([overlap[layer][pc4] for layer in layers])),
                    "coverage_pct_400m": pct,
                })

            frame = pd.DataFrame(rows)
            for column in SIGNALS:
                frame[f"z_{column}"] = zscore(frame[column].to_numpy())
            frame["priority"] = sum(_WEIGHTS[column] * frame[f"z_{column}"] for column in SIGNALS)
            frame = frame.sort_values("priority", ascending=False).reset_index(drop=True)
            top = frame.head(TOP_N)

            # One reached-state for the whole municipality per terrain choice,
            # grown as spots are placed. Resetting it per PC4 — as the sister
            # project does — lets two neighbouring PC4s claim the same residents.
            spots_by_terrain: dict[str, dict[str, list]] = {}
            for terrain in TERRAINS:
                index = host_index(hosts, stream, pakket, terrain)
                covered = {layer: covered0[layer].copy() for layer in layers}
                per_pc4: dict[str, list] = {}
                for pc4 in top["pc4"]:
                    spots = []
                    for rank in range(1, MAX_SUGGESTIONS_PER_PC4 + 1):
                        spot = derive_spot(raster, pc4_cells[pc4], covered, layers, index)
                        if spot is None:
                            break
                        spot["rank"] = rank
                        spots.append(spot)
                    per_pc4[pc4] = spots
                spots_by_terrain[terrain] = per_pc4

            records = []
            for _, row in top.iterrows():
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
                    # weights and reproduce the server ranking at the defaults.
                    **{f"z_{c}": round(float(row[f"z_{c}"]), 4) for c in SIGNALS},
                    "suggestions": {t: spots_by_terrain[t][row["pc4"]] for t in TERRAINS},
                })

            variants[variant_key(stream, pakket)] = {
                "layers": layers,
                "pc4_count_evaluated": int(len(frame)),
                "existing": {layer: int(len(layer_points[layer][0])) for layer in layers},
                "pc4s": records,
            }

    hosts_by_terrain = {
        t: int((hosts["eigendom"] == t).sum()) if hosts else 0 for t in ("publiek", "privaat", "onbekend")
    }
    payload = {
        "slug": slug,
        "gemeente": _NAMES[slug],
        "hosts_by_eigendom": hosts_by_terrain,
        "variants": variants,
    }
    path = OUT_DIR / f"{slug}.json"
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(payload, separators=(",", ":"), allow_nan=False))
    tmp.replace(path)
    n_spots = sum(len(r["suggestions"]["mix"]) for r in variants["statiegeld"]["pc4s"])
    return slug, payload, f"{len(variants)} varianten, {n_spots} statiegeld-plekken, " \
        f"{path.stat().st_size / 1024:.0f} KB"


def load_pakketpunten() -> tuple[np.ndarray, np.ndarray]:
    if not PAKKETPUNTEN_SNAPSHOT_PATH.exists():
        print("⚠️  geen pakketpunten — draai scripts/fetch_pakketpunten.py; de "
              "pakket-varianten tellen dan iedereen als onbereikt", file=sys.stderr)
        return np.empty(0), np.empty(0)
    with open(PAKKETPUNTEN_SNAPSHOT_PATH, encoding="utf-8") as handle:
        payload = json.load(handle)
    coords = [
        f["geometry"]["coordinates"] for f in payload.get("features", [])
        if f.get("properties", {}).get("type") == "pakketpunt"
        and (f.get("geometry") or {}).get("coordinates")
    ]
    if not coords:
        return np.empty(0), np.empty(0)
    series = gpd.GeoSeries(
        gpd.points_from_xy([c[0] for c in coords], [c[1] for c in coords]), crs=WGS84
    ).to_crs(RD_NEW)
    return series.x.to_numpy(), series.y.to_numpy()


METHODOLOGY = {
    "score": (
        "Σ gewicht × z-score binnen de gemeente over vier signalen: "
        "onderbediening t.o.v. het regressiemodel, ongedekte inwoners "
        "binnen 400 m, adressendichtheid, en een strafterm voor het deel "
        "van het PC4 dat al binnen 400 m van een punt ligt"
    ),
    "alle_stromen": (
        "één locatie die statiegeld, batterijen en elektro tegelijk inneemt. Een "
        "inwoner telt mee naar het deel van de drie stromen dat hij nog niet "
        "binnen 400 m kwijt kan; de onderbediening van de drie stromen wordt "
        "opgeteld. Alleen gastheren met ruimte voor alle drie komen in aanmerking "
        "(winkelcentrum, supermarkt, bouwmarkt, milieustraat, gemeentehuis, station)"
    ),
    "met_pakketpunten": (
        "het pakketpuntennetwerk telt als extra netwerk: een inwoner zonder "
        "pakketpunt binnen 400 m telt daar ook als onbereikt, en alleen "
        "gastheren die ook een pakketbalie of -kluis kunnen huisvesten komen in "
        "aanmerking (dus geen milieustraat of glasbak). Pakketpunten uit het "
        "landelijke bestand van de pakketpuntenviewer, wekelijks opgehaald"
    ),
    "terrein": (
        "publiek of privaat terrein van de gastheer, uit OSM-tags, de "
        "beheerder, de categorie en anders het BGT-object onder het punt. Het "
        "zegt waar de gemeente zelf over gaat, niet wie juridisch eigenaar is. "
        "Bij alleen publiek of privaat snapt het advies uitsluitend naar zulke "
        "gastheren; de PC4-ranking verandert daar niet door"
    ),
    "witte_vlek": (
        "op het CBS 100 m-raster krijgt elke bewoonde cel een gewicht: inwoners "
        "× het aandeel van de netwerken dat haar niet binnen 400 m bereikt. De "
        "cel in het PC4 met het meeste gewicht binnen haar eigen 400 m wordt de "
        "kandidaat"
    ),
    "snapping": (
        f"de kandidaat schuift naar een POI die deze variant kan huisvesten "
        f"binnen {POI_SNAP_MAX_M} m (supermarkt voor statiegeld, bouwmarkt "
        f"of drogisterij voor batterijen, milieustraat voor elektro). Ligt "
        f"er geen gastheer binnen loopafstand, dan blijft het punt op de "
        f"kandidaatcel staan en wordt de dichtstbijzijnde gastheer "
        f"alleen gerapporteerd — dat betekent een zelfstandige unit in "
        f"plaats van een balie in een winkel"
    ),
    "waarom_vaak_niet_gesnapt": (
        "een witte vlek ligt per definitie ≥400 m van de bestaande punten in "
        "die stroom, en voor statiegeld zíjn dat de supermarkten — dus ligt "
        "de vlek ook ver van supermarkten"
    ),
    "uitsluiting": (
        "wie door een eerdere plek bereikt is, telt bij de volgende niet meer "
        "mee, over alle PC4's van een gemeente heen; anders claimen twee "
        "aangrenzende PC4's dezelfde inwoners als nieuw bereikt"
    ),
    "netwerken": (
        "inleverpunten tellen alleen binnen de eigen gemeente (een milieustraat "
        "kan buren weigeren); pakketpunten tellen ook over de gemeentegrens"
    ),
}


def write_index() -> int:
    municipalities = {}
    for path in sorted(OUT_DIR.glob("*.json")):
        if path.name == "index.json":
            continue
        payload = json.loads(path.read_text())
        municipalities[payload["slug"]] = {
            "gemeente": payload["gemeente"],
            "variants": sorted(payload["variants"]),
        }
    index = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "weights": _WEIGHTS,
        "streams": [*STREAMS, ALLE],
        "terrains": list(TERRAINS),
        "top_n_per_municipality": TOP_N,
        "suggestions_per_pc4": MAX_SUGGESTIONS_PER_PC4,
        "buffer_m": BUFFER_M,
        "poi_snap_radius_m": POI_SNAP_RADIUS_M,
        "poi_snap_max_m": POI_SNAP_MAX_M,
        "poi_report_radius_m": POI_REPORT_RADIUS_M,
        "poi_snap_tiers": POI_SNAP_TIERS,
        "pakket_hosts": sorted(PAKKET_HOSTS),
        "min_pc4_population": MIN_PC4_POPULATION,
        "methodology": METHODOLOGY,
        "municipalities": municipalities,
    }
    path = OUT_DIR / "index.json"
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(index, separators=(",", ":"), ensure_ascii=False))
    tmp.replace(path)
    return len(municipalities)


def main() -> int:
    global _CELL_X, _CELL_Y, _CELL_POP, _STATS, _COVERAGE, _PC4_POLYGONS
    global _POINTS, _PAKKET_XY, _NAMES, _WEIGHTS

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--only", type=str, default="pilot",
                        help="Comma-separated slugs, 'pilot', or 'all'")
    parser.add_argument("--jobs", type=int, default=max(1, mp.cpu_count() - 1))
    for key, value in DEFAULT_WEIGHTS.items():
        parser.add_argument(f"--w-{key.replace('_', '-')}", type=float, default=value)
    args = parser.parse_args()

    _WEIGHTS = {key: getattr(args, f"w_{key}") for key in DEFAULT_WEIGHTS}

    print("Inputs laden…")
    with open(STATS_PATH, encoding="utf-8") as handle:
        _STATS = json.load(handle)["stats"]
    if not any(entry.get("model") for entry in _STATS.values()):
        print("❌ pc4_stats.json bevat geen modelvoorspellingen — draai eerst "
              "`python scripts/fit_pc4_model.py`.", file=sys.stderr)
        return 1

    with open(COVERAGE_PATH, encoding="utf-8") as handle:
        _COVERAGE = json.load(handle)["pc4"]

    pc4_gdf = gpd.read_file(PC4_PATH).to_crs(RD_NEW)
    pc4_gdf["pc4"] = pc4_gdf["pc4"].astype(str).str.zfill(4)
    # Zip the columns rather than iterrows(): a row Series holds mixed dtypes,
    # so `.geometry` there resolves to the pandas accessor, not the shape.
    _PC4_POLYGONS = {
        pc4: geometry
        for pc4, geometry in zip(pc4_gdf["pc4"], pc4_gdf.geometry)
        if geometry is not None and not geometry.is_empty
    }

    _CELL_X, _CELL_Y, _CELL_POP = load_cbs_grid_arrays()
    print(f"  {len(_PC4_POLYGONS)} PC4-polygonen, {_CELL_POP.size:,} bewoonde cellen")

    municipalities = load_webapp_municipalities()
    by_slug = {m["slug"]: m for m in municipalities}
    _NAMES = {slug: m["name"] for slug, m in by_slug.items()}
    slugs = resolve_slugs(args.only, all_slugs=by_slug)
    assert_poi_bundles_exist(slugs)

    print("Bestaande inleverpunten en pakketpunten laden…")
    points = load_analysis_points()
    points = points[points["gemeenteSlug"].isin(slugs)].to_crs(RD_NEW)
    _POINTS = {}
    for slug, group in points.groupby("gemeenteSlug"):
        xs, ys = group.geometry.x.to_numpy(), group.geometry.y.to_numpy()
        subsets = list(group["subsets"])
        _POINTS[slug] = {
            stream: (xs[mask], ys[mask])
            for stream in STREAMS
            for mask in [np.array([stream in row for row in subsets], dtype=bool)]
        }
    _PAKKET_XY = load_pakketpunten()
    print(f"  {len(points)} inleverpunten, {_PAKKET_XY[0].size} pakketpunten")

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    print(f"\n{len(slugs)} gemeenten × 8 varianten × {len(TERRAINS)} terreinkeuzes…")
    ok = 0
    if args.jobs > 1 and len(slugs) > 1:
        ctx = mp.get_context("fork")
        with ctx.Pool(min(args.jobs, len(slugs))) as pool:
            results = pool.imap_unordered(process_municipality, slugs)
            for slug, payload, message in results:
                print(f"  {slug}: {message}", flush=True)
                ok += payload is not None
    else:
        for slug in slugs:
            slug, payload, message = process_municipality(slug)
            print(f"  {slug}: {message}", flush=True)
            ok += payload is not None

    count = write_index()
    LEGACY_PATH.unlink(missing_ok=True)
    print(f"\n✅ {ok} gemeenten herberekend, {count} in {OUT_DIR}/index.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
