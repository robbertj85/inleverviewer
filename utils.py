"""
Shared helpers for the Inleverpunten pipeline.

Two responsibilities:

1. HTTP plumbing — a requests Session that ignores any ambient proxy config for
   the source domains, plus a small JSON fetch wrapper with retries.
2. Municipality geometry — the 342 Dutch municipality polygons, sourced from
   PDOK Bestuurlijke Gebieden and held in a persistent on-disk cache that is
   only refreshed twice a year.

Coordinate reference systems, as in the pakketpunten project:
  WGS84 (EPSG:4326)   — all API input/output, GeoJSON, web maps
  RD New (EPSG:28992) — metric work (buffers, distances, point-in-polygon)
"""

from __future__ import annotations

import json
import os
import re
import time
import unicodedata
from datetime import datetime
from pathlib import Path
from typing import Iterable

import geopandas as gpd
import requests
from shapely import wkt
from shapely.geometry import shape

PROJECT_ROOT = Path(__file__).parent
DATA_DIR = PROJECT_ROOT / "data"
WEBAPP_DATA_DIR = PROJECT_ROOT / "webapp" / "public" / "data"

POLYGON_CACHE_FILE = DATA_DIR / "municipality_polygon_cache.json"
MUNICIPALITIES_FILE = DATA_DIR / "municipalities_all.json"

WGS84 = "EPSG:4326"
RD_NEW = "EPSG:28992"

# Domains we talk to directly; corporate proxies tend to mangle these.
SOURCE_DOMAINS = (
    "geoserver-statiegeld.webgis.nl",
    "www.legebatterijen.nl",
    "inleverpunten.stichting-open.org",
    "www.godroppie.com",
    "www.statiedrive.nl",
    "api.pdok.nl",
    "nominatim.openstreetmap.org",
)

USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)


# --------------------------------------------------------------------------
# HTTP
# --------------------------------------------------------------------------

def ensure_no_proxy(domains: Iterable[str]) -> None:
    """Add the given domains to NO_PROXY so ambient proxy settings are bypassed."""
    existing = {d.strip() for d in os.environ.get("NO_PROXY", "").split(",") if d.strip()}
    existing.update(domains)
    joined = ",".join(sorted(existing))
    os.environ["NO_PROXY"] = joined
    os.environ["no_proxy"] = joined


def make_session(disable_env_proxy: bool = True) -> requests.Session:
    """Build a requests Session with a browser UA and optional proxy bypass."""
    if disable_env_proxy:
        ensure_no_proxy(SOURCE_DOMAINS)

    session = requests.Session()
    session.trust_env = not disable_env_proxy
    session.headers.update({
        "User-Agent": USER_AGENT,
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "nl-NL,nl;q=0.9,en;q=0.8",
    })
    return session


def fetch_json(
    session: requests.Session,
    url: str,
    *,
    params: dict | None = None,
    timeout: int = 120,
    retries: int = 3,
    backoff: float = 2.0,
):
    """GET a URL and parse JSON, retrying on transient failures.

    Raises the last exception if every attempt fails, so callers can decide
    whether a source is fatal or merely degraded.
    """
    last_error: Exception | None = None

    for attempt in range(1, retries + 1):
        try:
            response = session.get(url, params=params, timeout=timeout)
            response.raise_for_status()
            return response.json()
        except Exception as error:  # noqa: BLE001 - deliberately broad, caller decides
            last_error = error
            if attempt < retries:
                delay = backoff * attempt
                print(f"    ⚠️  Attempt {attempt}/{retries} failed ({error}); retrying in {delay:.0f}s")
                time.sleep(delay)

    raise last_error  # type: ignore[misc]


def fetch_text(
    session: requests.Session,
    url: str,
    *,
    timeout: int = 60,
    retries: int = 3,
    backoff: float = 2.0,
) -> str:
    """GET a URL and return the raw body as text, with the same retry policy."""
    last_error: Exception | None = None

    for attempt in range(1, retries + 1):
        try:
            response = session.get(url, timeout=timeout)
            response.raise_for_status()
            return response.text
        except Exception as error:  # noqa: BLE001
            last_error = error
            if attempt < retries:
                time.sleep(backoff * attempt)

    raise last_error  # type: ignore[misc]


# --------------------------------------------------------------------------
# Slugs
# --------------------------------------------------------------------------

def slugify(name: str) -> str:
    """Turn a municipality name into a URL-safe slug.

    Matches the pakketpunten convention so both viewers share URL shapes:
    'Súdwest-Fryslân' -> 'sudwest-fryslan', "'s-Gravenhage" -> 's-gravenhage'.
    """
    normalised = unicodedata.normalize("NFKD", name)
    ascii_only = normalised.encode("ascii", "ignore").decode("ascii")
    lowered = ascii_only.lower().strip()
    lowered = lowered.replace("'", "").replace("'", "")
    lowered = re.sub(r"[^a-z0-9]+", "-", lowered)
    return lowered.strip("-")


# --------------------------------------------------------------------------
# Municipality polygons (PDOK, persistently cached)
# --------------------------------------------------------------------------

_polygon_cache: dict | None = None
_polygon_cache_dirty = False


def _is_cache_refresh_week() -> bool:
    """True during the last week of June or December.

    Dutch municipal reorganisations take effect on 1 January, so refreshing
    twice a year keeps boundaries current without hammering PDOK weekly.
    """
    today = datetime.now()
    if today.month == 6 and today.day >= 24:
        return True
    if today.month == 12 and today.day >= 25:
        return True
    return False


def _next_refresh_date() -> str:
    today = datetime.now()
    june = datetime(today.year, 6, 24)
    december = datetime(today.year, 12, 25)
    if today < june:
        return june.strftime("%Y-%m-%d")
    if today < december:
        return december.strftime("%Y-%m-%d")
    return datetime(today.year + 1, 6, 24).strftime("%Y-%m-%d")


def load_polygon_cache() -> dict:
    """Load the persistent polygon cache from disk (once per process)."""
    global _polygon_cache

    if _polygon_cache is not None:
        return _polygon_cache

    if POLYGON_CACHE_FILE.exists():
        try:
            with open(POLYGON_CACHE_FILE, "r", encoding="utf-8") as handle:
                _polygon_cache = json.load(handle)
            print(f"  📦 Loaded polygon cache: {len(_polygon_cache)} municipalities")
        except (json.JSONDecodeError, OSError) as error:
            print(f"  ⚠️  Could not load polygon cache: {error}")
            _polygon_cache = {}
    else:
        _polygon_cache = {}

    return _polygon_cache


def save_polygon_cache(force: bool = False) -> None:
    """Write the polygon cache back to disk if it changed."""
    global _polygon_cache_dirty

    if _polygon_cache is None or (not _polygon_cache_dirty and not force):
        return

    try:
        POLYGON_CACHE_FILE.parent.mkdir(parents=True, exist_ok=True)
        with open(POLYGON_CACHE_FILE, "w", encoding="utf-8") as handle:
            json.dump(_polygon_cache, handle, ensure_ascii=False)
        _polygon_cache_dirty = False
    except OSError as error:
        print(f"  ⚠️  Could not save polygon cache: {error}")


def store_polygon(slug: str, entry: dict) -> None:
    """Add or replace one municipality in the polygon cache."""
    global _polygon_cache_dirty

    cache = load_polygon_cache()
    cache[slug] = {**entry, "cached_at": datetime.now().isoformat()}
    _polygon_cache_dirty = True


def polygon_cache_stats() -> dict:
    """Summarise cache size and freshness for logging."""
    cache = load_polygon_cache()

    if not cache:
        return {"total": 0, "next_refresh": _next_refresh_date(), "is_refresh_week": _is_cache_refresh_week()}

    dates = []
    for entry in cache.values():
        cached_at = entry.get("cached_at", "")
        if cached_at:
            try:
                dates.append(datetime.fromisoformat(cached_at))
            except ValueError:
                continue

    return {
        "total": len(cache),
        "oldest_cached": min(dates).strftime("%Y-%m-%d") if dates else None,
        "newest_cached": max(dates).strftime("%Y-%m-%d") if dates else None,
        "next_refresh": _next_refresh_date(),
        "is_refresh_week": _is_cache_refresh_week(),
    }


def cache_needs_refresh() -> bool:
    """True when the cache is empty, or when we are in a refresh week and it is stale."""
    cache = load_polygon_cache()

    if not cache:
        return True

    if not _is_cache_refresh_week():
        return False

    # Already refreshed during this window? Then leave it alone.
    today = datetime.now()
    for entry in cache.values():
        cached_at = entry.get("cached_at", "")
        if not cached_at:
            continue
        try:
            cached_date = datetime.fromisoformat(cached_at)
        except ValueError:
            continue
        if (cached_date.year == today.year
                and cached_date.month == today.month
                and cached_date.day >= 24):
            return False

    return True


def get_gemeente_polygon(slug: str) -> gpd.GeoDataFrame | None:
    """Return one municipality's boundary as a WGS84 GeoDataFrame, or None."""
    cache = load_polygon_cache()
    entry = cache.get(slug)

    if not entry:
        return None

    try:
        geometry = wkt.loads(entry["geometry_wkt"])
    except Exception as error:  # noqa: BLE001
        print(f"  ⚠️  Could not parse cached polygon for '{slug}': {error}")
        return None

    return gpd.GeoDataFrame(
        {"gemeente": [entry.get("naam", slug)], "code": [entry.get("code")]},
        geometry=[geometry],
        crs=WGS84,
    )


def geometry_from_geojson(geometry: dict):
    """Build a shapely geometry from a GeoJSON geometry dict."""
    return shape(geometry)


def load_municipalities() -> list[dict]:
    """Load the municipality index built by scripts/fetch_pdok_boundaries.py."""
    with open(MUNICIPALITIES_FILE, "r", encoding="utf-8") as handle:
        return json.load(handle)
