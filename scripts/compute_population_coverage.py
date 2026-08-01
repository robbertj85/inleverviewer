"""Compute how many inhabitants live within 300/400/500 m of an inleverpunt.

Output → webapp/public/data/population_coverage.json

Per PC4 and per municipality, for every combination of the eight analysis
subsets and three walking distances:

  covered_population = Σ aantal_inwoners over CBS 100 m cells whose centroid
                       lies inside (PC4 ∩ buffer_union)
  pc4_population     = Σ aantal_inwoners over cells whose centroid lies in PC4

Numerator and denominator both come from the CBS Vierkantstatistiek 100 m grid.
That is genuine dasymetric mapping: water, parks, industrial estates and
farmland contribute 0 to the denominator, so an inleverpunt on the edge of a
residential strip flanked by fields is credited with reaching the residents
rather than being diluted across the whole PC4 polygon.

Two scopes, so the elasticity between them is visible:

  national — buffer union from ALL points in the country. A point just over the
             municipal border still reaches the residents next to it.
  strict   — buffer union from points inside the same municipality only.
             The administrative view.

Milieustraten are the exception to `national`. They carry a `gemeenteBeperking`
listing which municipalities' residents may use them, so they get their own
per-municipality union rather than joining the national one — counting a
Rotterdam milieustraat as serving everyone within 400 m would overstate reach
in exactly the places where reach is thinnest. This has no counterpart in the
sister pakketpunten project, where every point serves everyone.

Parallelised with the 'fork' start method so workers inherit the loaded
geodata copy-on-write instead of pickling big MultiPolygons per task.

    python scripts/compute_population_coverage.py
"""

from __future__ import annotations

import json
import multiprocessing as mp
import os
import sys
import time
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

import geopandas as gpd  # noqa: E402
import numpy as np  # noqa: E402
from shapely import wkt  # noqa: E402
from shapely.geometry import Point  # noqa: E402
from shapely.ops import unary_union  # noqa: E402
from shapely.prepared import prep  # noqa: E402
from shapely.validation import make_valid  # noqa: E402

from analysis import (  # noqa: E402
    BUFFER_DISTANCES_M,
    BUFFER_RESOLUTION,
    CBS_GRID_PATH,
    PC4_PATH,
    RD_NEW,
    SUBSETS,
    WGS84,
    load_analysis_points,
)
from normalize import SUBSET_AXES, SUBSET_LABELS  # noqa: E402
from utils import DATA_DIR, WEBAPP_DATA_DIR  # noqa: E402

MUNI_CACHE_PATH = DATA_DIR / "municipality_polygon_cache.json"
OUTPUT = WEBAPP_DATA_DIR / "population_coverage.json"


def build_union(geoms, distance_m: int):
    """Buffer every geometry by `distance_m` and union the result."""
    buffered = [
        g.buffer(distance_m, resolution=BUFFER_RESOLUTION)
        for g in geoms if g is not None and not g.is_empty
    ]
    if not buffered:
        return None
    union = unary_union(buffered)
    return union if union.is_valid else make_valid(union)


# ───────────────────────────────────────────────────────────────────────
# Worker state, populated before each Pool forks so children inherit it
# copy-on-write. Workers only ever read these.
# ───────────────────────────────────────────────────────────────────────
_CELL_X: np.ndarray | None = None
_CELL_Y: np.ndarray | None = None
_CELL_POP: np.ndarray | None = None
_PC4_DATA: list | None = None          # (pc4, muni_slug, muni_name, area_km2)
_PC4_CELL_INDICES: list | None = None  # cell indices per PC4 row
_MUNI_CELL_INDICES: dict | None = None
_MUNI_PC4_INDICES: dict | None = None
_POINTS_BY_SUBSET: dict | None = None       # subset -> [geometry]
_RESTRICTED_BY_SUBSET: dict | None = None   # subset -> {muni_slug: [geometry]}
_POINTS_BY_MUNI: dict | None = None         # muni_slug -> [(geom, subsets)]
_NATIONAL_UNIONS: dict | None = None        # (subset, dist) -> prepared union
_RESTRICTED_UNIONS: dict | None = None      # (subset, dist) -> {slug: prepared}


class PreparedUnion:
    """A union geometry plus its prepared form and bounds.

    Preparing a nationwide MultiPolygon is not free, and the naive shape of
    this computation re-prepares it once per PC4 per subset per distance —
    tens of thousands of times. Preparing once per union and carrying it
    through the fork is the whole optimisation.
    """

    __slots__ = ("geometry", "prepared", "bounds")

    def __init__(self, geometry):
        self.geometry = geometry
        self.prepared = prep(geometry)
        self.bounds = geometry.bounds

    def contains_mask(self, xs: np.ndarray, ys: np.ndarray) -> np.ndarray:
        """Which of these cell centroids fall inside the union?"""
        out = np.zeros(xs.shape[0], dtype=bool)
        if xs.size == 0:
            return out
        minx, miny, maxx, maxy = self.bounds
        # Cheap numpy bbox prefilter before the per-point contains test.
        bbox = (xs >= minx) & (xs <= maxx) & (ys >= miny) & (ys <= maxy)
        for i in np.nonzero(bbox)[0]:
            if self.prepared.contains(Point(xs[i], ys[i])):
                out[i] = True
        return out


def _worker_national_union(key):
    subset, distance = key
    union = build_union(_POINTS_BY_SUBSET[subset], distance)
    return key, union


def _worker_restricted_union(key):
    """Per-municipality unions for points that only serve certain municipalities."""
    subset, distance = key
    per_muni = {}
    for muni_slug, geoms in _RESTRICTED_BY_SUBSET[subset].items():
        union = build_union(geoms, distance)
        if union is not None:
            per_muni[muni_slug] = union
    return key, per_muni


def _covered_in_cells(cell_idx: np.ndarray, subset: str, distance: int,
                      muni_slug: str | None) -> int:
    """Inhabitants among these cells reached by `subset` at `distance`.

    A cell counts when it is inside the unrestricted national union OR inside
    the restricted union belonging to the municipality the cell sits in.
    """
    if cell_idx.size == 0:
        return 0
    xs = _CELL_X[cell_idx]
    ys = _CELL_Y[cell_idx]
    mask = np.zeros(cell_idx.size, dtype=bool)

    national = _NATIONAL_UNIONS.get((subset, distance))
    if national is not None:
        mask |= national.contains_mask(xs, ys)

    if muni_slug:
        restricted = (_RESTRICTED_UNIONS.get((subset, distance)) or {}).get(muni_slug)
        if restricted is not None:
            mask |= restricted.contains_mask(xs, ys)

    return int(_CELL_POP[cell_idx][mask].sum())


def _worker_pc4(idx):
    """National-scope coverage for one PC4."""
    pc4, muni_slug, muni_name, area_km2 = _PC4_DATA[idx]
    cell_idx = _PC4_CELL_INDICES[idx]
    population = int(_CELL_POP[cell_idx].sum()) if cell_idx.size else 0
    row = {
        "pc4": pc4,
        "municipality": muni_name,
        "municipality_slug": muni_slug,
        "population": population,
        "area_km2": area_km2,
    }
    for subset in SUBSETS:
        for distance in BUFFER_DISTANCES_M:
            covered = (
                _covered_in_cells(cell_idx, subset, distance, muni_slug)
                if population else 0
            )
            row[f"{subset}_{distance}_covered"] = covered
            row[f"{subset}_{distance}_pct"] = (
                round(covered / population * 100, 2) if population else 0.0
            )
    return row


def _worker_muni_strict(muni_slug):
    """Strict coverage: union built from this municipality's own points only."""
    points = _POINTS_BY_MUNI.get(muni_slug, [])
    cell_idx = _MUNI_CELL_INDICES.get(muni_slug, np.array([], dtype=np.int64))
    result = {"slug": muni_slug}
    for subset in SUBSETS:
        result[f"points_{subset}"] = sum(1 for _, subs in points if subset in subs)

    xs = _CELL_X[cell_idx]
    ys = _CELL_Y[cell_idx]
    for subset in SUBSETS:
        geoms = [g for g, subs in points if subset in subs]
        for distance in BUFFER_DISTANCES_M:
            union = build_union(geoms, distance)
            covered = 0
            if union is not None and cell_idx.size:
                mask = PreparedUnion(union).contains_mask(xs, ys)
                covered = int(_CELL_POP[cell_idx][mask].sum())
            result[f"{subset}_{distance}_covered_strict"] = covered
    return result


def metric_block(covered: float, population: float) -> dict:
    return {
        "covered": int(round(covered)),
        "pct": round(covered / population * 100, 2) if population > 0 else 0.0,
    }


def main() -> int:
    global _CELL_X, _CELL_Y, _CELL_POP
    global _PC4_DATA, _PC4_CELL_INDICES, _MUNI_CELL_INDICES, _MUNI_PC4_INDICES
    global _POINTS_BY_SUBSET, _RESTRICTED_BY_SUBSET, _POINTS_BY_MUNI
    global _NATIONAL_UNIONS, _RESTRICTED_UNIONS

    n_jobs = int(os.environ.get("N_JOBS", max(1, (os.cpu_count() or 8) - 1)))
    print(f"{n_jobs} parallelle workers (zet N_JOBS om te overrulen)")
    t0 = time.time()

    # ─── Inputs ──────────────────────────────────────────────────────────
    print("PC4-polygonen laden...")
    pc4_gdf = gpd.read_file(PC4_PATH)
    pc4_gdf["pc4"] = pc4_gdf["pc4"].astype(str).str.zfill(4)
    pc4_gdf = pc4_gdf.to_crs(RD_NEW)
    pc4_gdf = pc4_gdf[pc4_gdf.geometry.notna()].copy()
    pc4_gdf["geometry"] = pc4_gdf.geometry.apply(
        lambda g: g if (g is not None and g.is_valid) else make_valid(g)
    )
    pc4_gdf["area_km2"] = (pc4_gdf.area / 1e6).round(4)
    pc4_gdf = pc4_gdf.reset_index(drop=True)

    if not CBS_GRID_PATH.exists():
        print(f"❌ CBS-raster ontbreekt: {CBS_GRID_PATH}", file=sys.stderr)
        return 1
    print(f"CBS 100 m-raster laden ({CBS_GRID_PATH.name})...")
    cells_gdf = gpd.read_file(CBS_GRID_PATH)
    if cells_gdf.crs is None:
        cells_gdf = cells_gdf.set_crs(RD_NEW)
    elif cells_gdf.crs.to_epsg() != 28992:
        cells_gdf = cells_gdf.to_crs(RD_NEW)
    print(f"  → {len(cells_gdf):,} bewoonde cellen, "
          f"{int(cells_gdf['aantal_inwoners'].sum()):,} inwoners")

    print("Inleverpunten laden...")
    points_gdf = load_analysis_points().to_crs(RD_NEW)
    print(f"  → {len(points_gdf)} punten")

    print("Gemeentepolygonen laden (volledige resolutie)...")
    with open(MUNI_CACHE_PATH, encoding="utf-8") as handle:
        muni_cache = json.load(handle)
    muni_records = [
        {
            "municipality": entry.get("naam") or slug,
            "municipality_slug": entry.get("slug") or slug,
            "geometry": wkt.loads(entry["geometry_wkt"]),
        }
        for slug, entry in muni_cache.items()
    ]
    muni_gdf = gpd.GeoDataFrame(muni_records, crs=WGS84).to_crs(RD_NEW)
    print(f"  → {len(muni_gdf)} gemeenten")

    # ─── Attribution ─────────────────────────────────────────────────────
    print("PC4's aan gemeenten toewijzen (representative point)...")
    pc4_centroids = pc4_gdf.copy()
    pc4_centroids["geometry"] = pc4_centroids.geometry.representative_point()
    located = gpd.sjoin_nearest(
        pc4_centroids[["pc4", "geometry"]],
        muni_gdf[["municipality", "municipality_slug", "geometry"]],
        how="left",
    )
    located = located[~located.index.duplicated(keep="first")]
    pc4_gdf["municipality"] = pc4_gdf["pc4"].map(
        dict(zip(located["pc4"], located["municipality"]))
    )
    pc4_gdf["municipality_slug"] = pc4_gdf["pc4"].map(
        dict(zip(located["pc4"], located["municipality_slug"]))
    )

    print("CBS-cellen aan PC4's toewijzen...")
    cells_gdf["geometry"] = cells_gdf.geometry.centroid
    cell_join = gpd.sjoin(
        cells_gdf[["aantal_inwoners", "geometry"]],
        pc4_gdf[["pc4", "geometry"]],
        how="left", predicate="within",
    )
    cell_join = cell_join[~cell_join.index.duplicated(keep="first")].reindex(cells_gdf.index)
    pc4_row = {p: i for i, p in enumerate(pc4_gdf["pc4"].tolist())}
    cell_pc4_idx = cell_join["pc4"].map(pc4_row).fillna(-1).astype(np.int64).to_numpy()
    outside = int((cell_pc4_idx == -1).sum())
    if outside:
        print(f"  → {outside:,} cellen buiten elk PC4 (genegeerd)")

    _CELL_X = np.array([g.x for g in cells_gdf.geometry])
    _CELL_Y = np.array([g.y for g in cells_gdf.geometry])
    _CELL_POP = cells_gdf["aantal_inwoners"].astype(np.int64).to_numpy()

    _PC4_DATA = [
        (row["pc4"], row["municipality_slug"], row["municipality"], float(row["area_km2"]))
        for _, row in pc4_gdf.iterrows()
    ]

    # Cell indices grouped per PC4, via argsort + split rather than a groupby.
    _PC4_CELL_INDICES = [np.array([], dtype=np.int64)] * len(_PC4_DATA)
    with_pc4 = np.nonzero(cell_pc4_idx >= 0)[0]
    order = with_pc4[np.argsort(cell_pc4_idx[with_pc4], kind="stable")]
    splits = np.searchsorted(cell_pc4_idx[order], np.arange(len(_PC4_DATA) + 1))
    _PC4_CELL_INDICES = [order[splits[i]:splits[i + 1]] for i in range(len(_PC4_DATA))]

    _MUNI_PC4_INDICES = defaultdict(list)
    for i, (_, muni_slug, _, _) in enumerate(_PC4_DATA):
        if muni_slug:
            _MUNI_PC4_INDICES[muni_slug].append(i)
    _MUNI_PC4_INDICES = dict(_MUNI_PC4_INDICES)
    _MUNI_CELL_INDICES = {
        slug: (np.concatenate([_PC4_CELL_INDICES[i] for i in idxs])
               if idxs else np.array([], dtype=np.int64))
        for slug, idxs in _MUNI_PC4_INDICES.items()
    }

    # ─── Point bookkeeping ───────────────────────────────────────────────
    # Restricted points (milieustraten) are held apart: they contribute to the
    # union of every municipality they serve, not to the national one.
    _POINTS_BY_SUBSET = {s: [] for s in SUBSETS}
    _RESTRICTED_BY_SUBSET = {s: defaultdict(list) for s in SUBSETS}
    _POINTS_BY_MUNI = defaultdict(list)
    n_restricted = 0
    for geom, subsets, allowed, own_slug in zip(
        points_gdf.geometry,
        points_gdf["subsets"],
        points_gdf["gemeenteBeperkingSlugs"],
        points_gdf["gemeenteSlug"],
    ):
        subsets = list(subsets)
        if allowed:
            n_restricted += 1
            for subset in subsets:
                for muni_slug in allowed:
                    _RESTRICTED_BY_SUBSET[subset][muni_slug].append(geom)
        else:
            for subset in subsets:
                _POINTS_BY_SUBSET[subset].append(geom)
        # Strict scope is administrative: a restricted point still sits in its
        # own municipality and serves it, so it counts there either way.
        if own_slug:
            _POINTS_BY_MUNI[own_slug].append((geom, subsets))
    _RESTRICTED_BY_SUBSET = {s: dict(d) for s, d in _RESTRICTED_BY_SUBSET.items()}
    _POINTS_BY_MUNI = dict(_POINTS_BY_MUNI)
    print(f"  → {n_restricted} punten met gemeentebeperking (aparte unions)")
    print(f"Inputs klaar in {time.time() - t0:.1f}s")

    ctx = mp.get_context("fork")
    keys = [(s, d) for s in SUBSETS for d in BUFFER_DISTANCES_M]

    # ─── Phase 1: buffer unions ──────────────────────────────────────────
    t1 = time.time()
    print(f"\nFase 1: {len(keys)} landelijke buffer-unions...")
    national: dict = {}
    with ctx.Pool(min(len(keys), n_jobs)) as pool:
        for key, union in pool.imap_unordered(_worker_national_union, keys):
            national[key] = PreparedUnion(union) if union is not None else None
            area = union.area / 1e6 if union is not None else 0.0
            print(f"  {key[0]:<13} @ {key[1]:3d}m: "
                  f"{len(_POINTS_BY_SUBSET[key[0]]):5d} pnt → {area:8.1f} km²")
    _NATIONAL_UNIONS = national

    restricted_keys = [k for k in keys if _RESTRICTED_BY_SUBSET[k[0]]]
    restricted: dict = {}
    if restricted_keys:
        print(f"Fase 1b: {len(restricted_keys)} beperkte unions "
              f"(per toegestane gemeente)...")
        with ctx.Pool(min(len(restricted_keys), n_jobs)) as pool:
            for key, per_muni in pool.imap_unordered(_worker_restricted_union,
                                                     restricted_keys):
                restricted[key] = {
                    slug: PreparedUnion(u) for slug, u in per_muni.items()
                }
    _RESTRICTED_UNIONS = restricted
    print(f"Fase 1 klaar in {time.time() - t1:.1f}s")

    # ─── Phase 2a: per-PC4 national scope ────────────────────────────────
    t2 = time.time()
    print(f"\nFase 2a: dekking per PC4 ({len(_PC4_DATA)} PC4's)...")
    pc4_rows: list = []
    chunk = max(20, len(_PC4_DATA) // (n_jobs * 8))
    with ctx.Pool(n_jobs) as pool:
        done, tick = 0, 500
        for row in pool.imap_unordered(_worker_pc4, range(len(_PC4_DATA)),
                                       chunksize=chunk):
            pc4_rows.append(row)
            done += 1
            if done >= tick:
                print(f"  {done}/{len(_PC4_DATA)}...", flush=True)
                tick += 500
    print(f"Fase 2a klaar in {time.time() - t2:.1f}s")

    # ─── Phase 2b: strict per-municipality ───────────────────────────────
    t3 = time.time()
    muni_slugs = list(_MUNI_PC4_INDICES)
    print(f"\nFase 2b: strikte dekking per gemeente ({len(muni_slugs)})...")
    strict_rows: list = []
    with ctx.Pool(n_jobs) as pool:
        done, tick = 0, 50
        for row in pool.imap_unordered(_worker_muni_strict, muni_slugs, chunksize=4):
            strict_rows.append(row)
            done += 1
            if done >= tick:
                print(f"  {done}/{len(muni_slugs)}...", flush=True)
                tick += 50
    print(f"Fase 2b klaar in {time.time() - t3:.1f}s")

    # ─── Roll up ─────────────────────────────────────────────────────────
    print("\nTotalen samenstellen...")
    muni_accum: dict = defaultdict(lambda: defaultdict(float))
    muni_names: dict[str, str] = {}
    nation: dict = defaultdict(float)
    for row in pc4_rows:
        population = row["population"]
        slug = row["municipality_slug"]
        nation["population"] += population
        if slug:
            muni_names[slug] = row["municipality"]
            muni_accum[slug]["population"] += population
            muni_accum[slug]["pc4_count"] += 1
        for subset in SUBSETS:
            for distance in BUFFER_DISTANCES_M:
                covered = row[f"{subset}_{distance}_covered"]
                nation[f"{subset}_{distance}_covered"] += covered
                if slug:
                    muni_accum[slug][f"{subset}_{distance}_covered_nat"] += covered

    for row in strict_rows:
        slug = row["slug"]
        for subset in SUBSETS:
            muni_accum[slug][f"points_{subset}"] = row[f"points_{subset}"]
            for distance in BUFFER_DISTANCES_M:
                muni_accum[slug][f"{subset}_{distance}_covered_strict"] = \
                    row[f"{subset}_{distance}_covered_strict"]

    municipalities_out = {}
    for slug, acc in muni_accum.items():
        population = acc["population"]
        entry = {
            "name": muni_names.get(slug, slug),
            "population": int(round(population)),
            "pc4_count": int(acc["pc4_count"]),
            "points": {s: int(acc[f"points_{s}"]) for s in SUBSETS},
            "national": {}, "strict": {},
        }
        for subset in SUBSETS:
            entry["national"][subset] = {
                f"{d}m": metric_block(acc[f"{subset}_{d}_covered_nat"], population)
                for d in BUFFER_DISTANCES_M
            }
            entry["strict"][subset] = {
                f"{d}m": metric_block(acc[f"{subset}_{d}_covered_strict"], population)
                for d in BUFFER_DISTANCES_M
            }
        municipalities_out[slug] = entry

    pc4_out = {}
    for row in pc4_rows:
        entry = {
            "municipality": row["municipality"],
            "municipality_slug": row["municipality_slug"],
            "population": row["population"],
            "area_km2": row["area_km2"],
        }
        for subset in SUBSETS:
            entry[subset] = {
                f"{d}m": {
                    "pct": row[f"{subset}_{d}_pct"],
                    "covered": row[f"{subset}_{d}_covered"],
                }
                for d in BUFFER_DISTANCES_M
            }
        pc4_out[row["pc4"]] = entry

    national_population = nation["population"]
    national_out = {"population": int(round(national_population))}
    for subset in SUBSETS:
        national_out[subset] = {
            f"{d}m": metric_block(nation[f"{subset}_{d}_covered"], national_population)
            for d in BUFFER_DISTANCES_M
        }

    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "subsets": list(SUBSETS),
        "subset_labels": SUBSET_LABELS,
        "subset_axes": {k: list(v) for k, v in SUBSET_AXES.items()},
        "buffer_distances_m": list(BUFFER_DISTANCES_M),
        "methodology": {
            "verdeling": (
                "CBS Vierkantstatistiek 100 m: gedekt = Σ aantal_inwoners over "
                "bewoonde cellen waarvan het middelpunt in (PC4 ∩ buffer-union) "
                "ligt; noemer = Σ over cellen waarvan het middelpunt in het PC4 "
                "ligt. Lege ruimte (water, park, bedrijventerrein, landbouw) "
                "telt 0 mee — geen aanname van gelijkmatige dichtheid."
            ),
            "scope_national": (
                "buffer-union over álle inleverpunten in Nederland; bereik over "
                "de gemeentegrens heen telt mee"
            ),
            "scope_strict": (
                "buffer-union alleen over punten binnen dezelfde gemeente"
            ),
            "gemeentebeperking": (
                "Milieustraten zijn alleen toegankelijk voor inwoners van de "
                "gemeenten in gemeenteBeperking. Ze krijgen daarom een eigen "
                "union per toegestane gemeente in plaats van deel te nemen aan "
                "de landelijke union."
            ),
            "pc4_naar_gemeente": (
                "representative_point van het PC4, sjoin_nearest tegen "
                "municipality_polygon_cache (volledige resolutie, 342 gemeenten)"
            ),
            "cirkel_segmenten": BUFFER_RESOLUTION * 4,
            "afstand": "euclidisch in RD New (EPSG:28992); loopnetwerk is future work",
        },
        "sources": {
            "inleverpunten": "data/analysis_points.geojson",
            "pc4_polygonen": "webapp/public/data/pc4.geojson",
            "bevolking": f"CBS Vierkantstatistiek 100 m ({CBS_GRID_PATH.name})",
            "gemeentegrenzen": "data/municipality_polygon_cache.json",
        },
        "national": national_out,
        "municipalities": municipalities_out,
        "pc4": pc4_out,
    }

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps(payload, separators=(",", ":")))
    print(f"\n✓ {OUTPUT.relative_to(Path(__file__).parent.parent)} "
          f"({OUTPUT.stat().st_size / 1e6:.2f} MB) in {time.time() - t0:.1f}s")
    for subset in SUBSETS:
        print(f"  {subset:<13} 400 m landelijk: "
              f"{national_out[subset]['400m']['pct']}%")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
