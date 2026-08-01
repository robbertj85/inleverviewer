"""
Shared plumbing for the analysis layers (bereik, schatting, plaatsingsadvies,
netwerkplanner).

Where `normalize.py` owns the *vocabulary* and `utils.py` the HTTP + boundary
plumbing, this module owns the things every analysis script needs and none of
the fetchers do: the CBS 100 m population grid, the analysis-grade point set,
and the subset masks the coverage maths runs over.

CRS discipline is the same as everywhere else in this repo: WGS84 for GeoJSON
and APIs, RD New for anything measured in metres.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Iterable

import geopandas as gpd
import numpy as np

from normalize import MATERIAAL_STROMEN, PUNT_CATEGORIEEN, SUBSETS, subsets_of
from utils import DATA_DIR, WEBAPP_DATA_DIR, WGS84, RD_NEW, slugify

# Inputs shared by the analysis layers.
CBS_GRID_PATH = DATA_DIR / "cbs" / "cbs_vk100_2024_inhabited.gpkg"
PC4_PATH = WEBAPP_DATA_DIR / "pc4.geojson"
ANALYSIS_POINTS_PATH = DATA_DIR / "analysis_points.geojson"
PAKKETPUNTEN_SNAPSHOT_PATH = DATA_DIR / "pakketpunten_snapshot.geojson"
POI_DIR = WEBAPP_DATA_DIR / "poi"
POI_MUNI_DIR = POI_DIR / "by-municipality"

# Walking-distance rings, shared by every coverage figure in the app.
BUFFER_DISTANCES_M = (300, 400, 500)

# 32-segment circles. At 300-500 m the area error against a true circle is
# under 0.1%, well below the precision of anything we compare it to.
BUFFER_RESOLUTION = 8

# The pilot set. The PC4-level layers (bereik, schatting) run nationally
# because the regression needs the full training set and the municipality
# comparison is meaningless without national context; the municipality-bound
# layers (POI bundles, plaatsingsadvies, netwerkplanner) start here.
PILOT_SLUGS = (
    "amsterdam",
    "rotterdam",
    "s-gravenhage",
    "utrecht",
    "zwolle",
    "apeldoorn",
    "sudwest-fryslan",
    "aa-en-hunze",
)

# `gemeenteBeperking` carries the municipality names the source published, which
# include pre-merger names and a colloquial "Den Haag". Mapping them onto
# current slugs matters: an unmapped name silently narrows a milieustraat's
# catchment, which would understate coverage rather than overstate it.
GEMEENTE_ALIASES = {
    "den haag": "s-gravenhage",
    "hengelo": "hengelo-o",
    # Municipalities merged away since the sources last updated their lists.
    "beemster": "purmerend",
    "weesp": "amsterdam",
    "delfzijl": "eemsdelta",
    "loppersum": "eemsdelta",
    "boxmeer": "land-van-cuijk",
    "cuijk": "land-van-cuijk",
    "grave": "land-van-cuijk",
    "mill en sint hubert": "land-van-cuijk",
    "sint anthonis": "land-van-cuijk",
}


def gemeente_slug(name: str) -> str:
    """Slug for a municipality name, resolving aliases and former names."""
    return GEMEENTE_ALIASES.get((name or "").strip().lower(), slugify(name or ""))


# --------------------------------------------------------------------------
# CBS 100 m population grid
# --------------------------------------------------------------------------

def load_cbs_grid_arrays() -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Cell centroids in RD plus inhabitants per cell, as flat numpy arrays.

    Flat arrays rather than a GeoDataFrame because every consumer either
    forks workers (which inherit these copy-on-write) or does bounding-box
    maths on them; neither needs shapely objects.
    """
    if not CBS_GRID_PATH.exists():
        raise FileNotFoundError(
            f"CBS grid not found at {CBS_GRID_PATH}. "
            f"Run `python scripts/fetch_cbs_100m_grid.py` first."
        )
    grid = gpd.read_file(CBS_GRID_PATH)
    if grid.crs is None:
        grid = grid.set_crs(RD_NEW)
    elif grid.crs.to_epsg() != 28992:
        grid = grid.to_crs(RD_NEW)
    centroids = grid.geometry.centroid
    return (
        centroids.x.to_numpy(),
        centroids.y.to_numpy(),
        grid["aantal_inwoners"].to_numpy(dtype=np.int64),
    )


# --------------------------------------------------------------------------
# Analysis-grade point set
# --------------------------------------------------------------------------

def load_analysis_points() -> gpd.GeoDataFrame:
    """Every inleverpunt with the fields the analysis layers need.

    Built by `scripts/build_analysis_points.py` from the per-municipality
    GeoJSONs. The national `nederland.geojson` cannot serve here: it is
    reduced on purpose and drops `gemeenteBeperking`, which the coverage maths
    needs to keep a milieustraat from serving residents who may not use it.
    """
    if not ANALYSIS_POINTS_PATH.exists():
        raise FileNotFoundError(
            f"{ANALYSIS_POINTS_PATH} not found. "
            f"Run `python scripts/build_analysis_points.py` first."
        )
    # Parsed by hand rather than via gpd.read_file: the GeoJSON drivers coerce
    # list-valued properties into numpy arrays or JSON strings depending on
    # which one is installed, and `materialen`/`subsets` have to stay lists.
    with open(ANALYSIS_POINTS_PATH, encoding="utf-8") as handle:
        payload = json.load(handle)
    records = [f["properties"] for f in payload["features"]]
    lons = [f["geometry"]["coordinates"][0] for f in payload["features"]]
    lats = [f["geometry"]["coordinates"][1] for f in payload["features"]]
    return gpd.GeoDataFrame(
        records, geometry=gpd.points_from_xy(lons, lats), crs=WGS84
    )


def point_subsets(props: dict) -> list[str]:
    """Subsets for one GeoJSON feature's properties."""
    return subsets_of(props.get("puntType") or "", props.get("materialen") or [])


def restriction_slugs(props: dict) -> list[str]:
    """Municipality slugs a restricted point may serve, [] when unrestricted."""
    beperking = props.get("gemeenteBeperking")
    if not beperking:
        return []
    return sorted({gemeente_slug(n) for n in beperking if n})


# --------------------------------------------------------------------------
# Municipality helpers
# --------------------------------------------------------------------------

def load_webapp_municipalities(include_national: bool = False) -> list[dict]:
    """The municipality index the webapp ships, name/slug/province/population."""
    with open(WEBAPP_DATA_DIR.parent / "municipalities.json", encoding="utf-8") as handle:
        entries = json.load(handle)
    if include_national:
        return entries
    return [m for m in entries if m.get("slug") != "nederland"]


def resolve_slugs(only: str | None, *, all_slugs: Iterable[str]) -> list[str]:
    """Turn a --only argument into a slug list.

    Accepts a comma-separated list, the literal 'pilot' for PILOT_SLUGS, or
    None/'all' for everything. Unknown slugs are an error rather than a silent
    skip — a typo that quietly produces nothing is exactly how the sister
    project lost four municipalities from its network planner.
    """
    known = set(all_slugs)
    if only in (None, "", "all"):
        return sorted(known)
    wanted = list(PILOT_SLUGS) if only == "pilot" else [
        s.strip() for s in only.split(",") if s.strip()
    ]
    missing = [s for s in wanted if s not in known]
    if missing:
        raise SystemExit(f"Unknown municipality slugs: {sorted(missing)}")
    return wanted


def assert_poi_bundles_exist(slugs: Iterable[str]) -> None:
    """Fail loudly when a municipality has no POI bundle.

    The sister project derives POI bundle filenames with a second, subtly
    different slug function; four municipalities ended up with bundles the
    network planner could never find, and the only symptom was one skip line
    in a 342-line log. One slug function and this assertion instead.
    """
    missing = [s for s in slugs if not (POI_MUNI_DIR / f"{s}.geojson").exists()]
    if missing:
        raise SystemExit(
            f"No POI bundle for {sorted(missing)} in {POI_MUNI_DIR}. "
            f"Run `python scripts/split_pois_by_municipality.py`."
        )


__all__ = [
    "ANALYSIS_POINTS_PATH",
    "BUFFER_DISTANCES_M",
    "BUFFER_RESOLUTION",
    "CBS_GRID_PATH",
    "MATERIAAL_STROMEN",
    "PAKKETPUNTEN_SNAPSHOT_PATH",
    "PC4_PATH",
    "PILOT_SLUGS",
    "POI_DIR",
    "POI_MUNI_DIR",
    "PUNT_CATEGORIEEN",
    "SUBSETS",
    "assert_poi_bundles_exist",
    "gemeente_slug",
    "load_analysis_points",
    "load_cbs_grid_arrays",
    "load_webapp_municipalities",
    "point_subsets",
    "resolve_slugs",
    "restriction_slugs",
    "RD_NEW",
    "WGS84",
]
