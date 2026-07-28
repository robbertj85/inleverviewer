"""
Buffer-zone analysis for inleverpunten.

Ported from the pakketpunten project, extended from two radii (300/400 m) to
three (300/400/500 m). The webapp recomputes these client-side with Turf.js for
the live map; the Python version is what feeds the coverage statistics.
"""

from __future__ import annotations

import geopandas as gpd
from shapely.geometry import GeometryCollection, MultiPolygon, Polygon
from shapely.ops import unary_union

# Coverage radii in metres. 300/400 match pakketpunten; 500 is new here.
BUFFER_RADII = (300, 400, 500)


def union_geom_to_gdf(geom, crs, buffer_m: int) -> gpd.GeoDataFrame:
    """Normalise a union result into a GeoDataFrame of (Multi)Polygons."""
    polygons: list[Polygon] = []

    if isinstance(geom, Polygon):
        polygons = [geom]
    elif isinstance(geom, MultiPolygon):
        polygons = list(geom.geoms)
    elif isinstance(geom, GeometryCollection):
        for part in geom.geoms:
            if isinstance(part, Polygon):
                polygons.append(part)
            elif isinstance(part, MultiPolygon):
                polygons.extend(part.geoms)

    return gpd.GeoDataFrame(
        {"buffer_m": [buffer_m] * len(polygons)},
        geometry=polygons,
        crs=crs,
    )


def get_bufferzones(gdf: gpd.GeoDataFrame, radius: int):
    """Buffer points by `radius` metres and return (per-point, dissolved union).

    Points come in as WGS84 degrees, so we project to RD New before buffering —
    buffering in degrees would distort badly across the country.
    """
    if gdf.crs is None:
        gdf = gdf.set_crs(4326)

    gdf_rd = gdf.to_crs(28992)
    gdf_rd["geometry"] = gdf_rd.geometry.buffer(radius)

    buffer_union = unary_union(gdf_rd["geometry"])

    gdf_union = gpd.GeoDataFrame(
        {"buffer_m": [radius]},
        geometry=[buffer_union],
        crs=gdf_rd.crs,
    ).to_crs(epsg=4326)

    return gdf_rd, gdf_union


def coverage_ratio(points: gpd.GeoDataFrame, boundary: gpd.GeoDataFrame, radius: int) -> float:
    """Fraction of a municipality's area within `radius` metres of any point.

    Returns 0.0 when there are no points, and clamps to 1.0 — buffers spill
    across the municipal border, and that overspill should not read as >100%.
    """
    if points.empty or boundary.empty:
        return 0.0

    points_rd = points.to_crs(28992) if points.crs != "EPSG:28992" else points
    boundary_rd = boundary.to_crs(28992)

    boundary_geom = unary_union(boundary_rd.geometry)
    boundary_area = boundary_geom.area

    if boundary_area <= 0:
        return 0.0

    buffered = unary_union(points_rd.geometry.buffer(radius))
    covered = buffered.intersection(boundary_geom).area

    return min(covered / boundary_area, 1.0)
