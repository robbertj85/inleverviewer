"""
Load the per-source caches and turn them into one national GeoDataFrame.

The fetchers in scripts/ each write a cache of canonical records. This module
reads those caches, stacks them, and assigns every point to a municipality by
spatial join against the PDOK boundaries.

The join happens once for all ~33.000 points rather than per municipality —
342 separate point-in-polygon passes over the full set would be needlessly
slow, and GeoPandas' spatial index does the whole thing in one go.
"""

from __future__ import annotations

import json
from pathlib import Path

import geopandas as gpd
import pandas as pd
from shapely import wkt
from shapely.geometry import Point

from normalize import MERKEN
from utils import DATA_DIR, WGS84, load_polygon_cache

# Cache file per brand. A missing file is survivable — the source simply
# contributes nothing this run — so the pipeline degrades rather than fails.
SOURCE_CACHES: dict[str, Path] = {
    "StatiegeldNederland": DATA_DIR / "statiegeld_all_locations.json",
    "Stibat": DATA_DIR / "stibat_all_locations.json",
    "StichtingOPEN": DATA_DIR / "open_all_locations.json",
    "Droppie": DATA_DIR / "droppie_all_locations.json",
    "StatieDrive": DATA_DIR / "statiedrive_all_locations.json",
}


def load_source(merk: str) -> list[dict]:
    """Read one source cache; returns an empty list when it is missing."""
    path = SOURCE_CACHES[merk]

    if not path.exists():
        print(f"  ⚠️  No cache for {merk} ({path.name}) — skipping")
        return []

    try:
        with open(path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except (json.JSONDecodeError, OSError) as error:
        print(f"  ⚠️  Could not read {path.name}: {error}")
        return []

    locations = data.get("locations", [])
    fetched_at = (data.get("metadata") or {}).get("fetched_at", "unknown")
    print(f"  📦 {merk}: {len(locations)} locations (fetched {fetched_at[:10]})")
    return locations


def load_all_sources() -> tuple[pd.DataFrame, dict[str, dict]]:
    """Load every source cache into one DataFrame, plus per-source status."""
    frames: list[pd.DataFrame] = []
    status: dict[str, dict] = {}

    for merk in MERKEN:
        locations = load_source(merk)
        status[merk] = {"success": bool(locations), "count": len(locations)}
        if locations:
            frames.append(pd.DataFrame(locations))

    if not frames:
        return pd.DataFrame(), status

    combined = pd.concat(frames, ignore_index=True)
    return combined, status


def load_boundaries() -> gpd.GeoDataFrame:
    """Build a GeoDataFrame of all municipality polygons from the cache."""
    cache = load_polygon_cache()

    if not cache:
        raise RuntimeError(
            "Municipality polygon cache is empty. "
            "Run: python scripts/fetch_pdok_boundaries.py"
        )

    rows = []
    geometries = []

    for slug, entry in cache.items():
        try:
            geometry = wkt.loads(entry["geometry_wkt"])
        except Exception as error:  # noqa: BLE001
            print(f"  ⚠️  Skipping unparseable polygon for '{slug}': {error}")
            continue

        if not geometry.is_valid:
            geometry = geometry.buffer(0)

        rows.append({
            "slug": slug,
            "gemeente": entry.get("naam", slug),
            "code": entry.get("code"),
            "provincie": entry.get("provincie"),
            "population": entry.get("population", 0),
        })
        geometries.append(geometry)

    return gpd.GeoDataFrame(rows, geometry=geometries, crs=WGS84)


def points_to_gdf(df: pd.DataFrame) -> gpd.GeoDataFrame:
    """Attach point geometry to the stacked source records."""
    geometry = [Point(lon, lat) for lon, lat in zip(df["longitude"], df["latitude"])]
    return gpd.GeoDataFrame(df.copy(), geometry=geometry, crs=WGS84)


def assign_municipalities(
    points: gpd.GeoDataFrame,
    boundaries: gpd.GeoDataFrame,
) -> tuple[gpd.GeoDataFrame, int]:
    """Assign each point to the municipality containing it.

    Returns the points that fell inside a municipality (with slug/gemeente/code
    columns attached) and the number that fell outside all of them — typically
    coordinates in the North Sea or just over the German/Belgian border.
    """
    joined = gpd.sjoin(
        points,
        boundaries[["slug", "gemeente", "code", "provincie", "geometry"]],
        how="left",
        predicate="within",
    )

    # A point sitting exactly on a shared border can match two polygons; keep
    # the first match so totals stay consistent with the national roll-up.
    joined = joined[~joined.index.duplicated(keep="first")]

    unassigned = int(joined["slug"].isna().sum())
    assigned = joined[joined["slug"].notna()].drop(columns=["index_right"], errors="ignore")

    return gpd.GeoDataFrame(assigned, geometry="geometry", crs=WGS84), unassigned


def get_data_inleverpunten() -> tuple[gpd.GeoDataFrame, dict[str, dict], int]:
    """Full pipeline: load caches, geocode-free join to municipalities.

    Returns (points with municipality columns, per-source status, unassigned count).
    """
    print("📦 Loading source caches...")
    combined, status = load_all_sources()

    if combined.empty:
        print("  ❌ No source data available")
        return gpd.GeoDataFrame(), status, 0

    print(f"  📍 {len(combined)} points across {len(SOURCE_CACHES)} sources")

    print("🗺️  Assigning points to municipalities...")
    boundaries = load_boundaries()
    points = points_to_gdf(combined)
    assigned, unassigned = assign_municipalities(points, boundaries)

    print(f"  ✅ {len(assigned)} points assigned to {assigned['slug'].nunique()} municipalities")
    if unassigned:
        print(f"  ℹ️  {unassigned} points fell outside all municipal boundaries (dropped)")

    return assigned, status, unassigned
