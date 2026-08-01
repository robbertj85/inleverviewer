"""Plan a covering network of inleverpunten per municipality (greedy set-cover).

Method
------
1. Candidates = public POIs from the per-municipality bundle
   (webapp/public/data/poi/by-municipality/{slug}.geojson), restricted to types
   that could plausibly host an inleverpunt. Deduplicated so a higher-priority
   type wins within 50 m — a supermarket absorbs the bus stop out front.
2. Demand = CBS Vierkantstatistieken 100 m inhabited cells clipped to the
   municipality boundary, taken from the full-resolution polygon cache rather
   than the display-simplified outline in {slug}.geojson, so this tab and the
   Bereik tab agree on how many people live in the municipality.
3. Greedy set-cover per scenario (walking distance × starting situation):
   repeatedly place a point at the candidate covering the most *not yet
   covered* inhabitants within R, until the marginal gain drops below
   --min-gain or --max-picks is reached. Greedy solutions are nested, so the
   webapp can slide "aantal punten" from 0..N for free.
4. Per scenario a `cell_rank` array records for every cell when it was first
   covered (0 = at the start, k = by pick k, -1 = never). That drives the
   white-spot animation client-side without shipping any polygons.

Combined mode (--mode combi)
----------------------------
Answers a question the sister pakketpunten project does not ask: which
locations are the best places to be an inleverpunt *and* a pakketpunt at once?

Both are out-of-home services with the same success factors — walking
distance, social control, 24/7 access — and the same natural host, the
supermarket. And they compound: someone collecting a parcel can hand in their
bottles in the same trip.

Two coverage states are tracked per cell instead of one, seeded from the two
existing networks, and each candidate is scored on both:

    gain_i = inhabitants within R with no inleverpunt yet
    gain_p = inhabitants within R with no pakketpunt yet

Two selection rules are emitted so the UI can switch between them:

    combi-gewogen   α·gain_i + (1−α)·gain_p   — total coverage gain
    combi-synergie  min(gain_i, gain_p)        — only sites that serve both

plus a synergy index 2·min/(sum) ∈ [0,1] per pick: 1 means the site serves
both networks equally, 0 means it only serves one. The synergy rule is
additionally restricted to candidate types that can physically host both.

Distance is Euclidean in RD (EPSG:28992), consistent with every other coverage
figure in this project. Walking-network isochrones are future work.

Output → webapp/public/data/inleverpunt_network/{slug}.json

    python scripts/plan_inleverpunt_network.py --only pilot
    python scripts/plan_inleverpunt_network.py --only zwolle --mode combi
    python scripts/plan_inleverpunt_network.py --only all --mode both
"""

from __future__ import annotations

import argparse
import json
import math
import multiprocessing as mp
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

sys.path.insert(0, str(Path(__file__).parent.parent))

import geopandas as gpd  # noqa: E402
import numpy as np  # noqa: E402
from shapely import wkt  # noqa: E402
from shapely.geometry import Point  # noqa: E402
from shapely.prepared import prep  # noqa: E402

from analysis import (  # noqa: E402
    PAKKETPUNTEN_SNAPSHOT_PATH,
    POI_MUNI_DIR,
    RD_NEW,
    WGS84,
    assert_poi_bundles_exist,
    load_analysis_points,
    load_cbs_grid_arrays,
    load_webapp_municipalities,
    resolve_slugs,
)
from normalize import MATERIAAL_STROMEN  # noqa: E402
from utils import DATA_DIR, WEBAPP_DATA_DIR  # noqa: E402

OUT_DIR = WEBAPP_DATA_DIR / "inleverpunt_network"
MUNI_CACHE_PATH = DATA_DIR / "municipality_polygon_cache.json"

DEFAULT_DISTANCES = [300, 400, 500]
DEDUPE_M = 50           # a candidate near a higher-priority one is dropped
MIN_GAIN_DEFAULT = 25   # stop when the best pick adds fewer inhabitants
MIN_SPACING_DEFAULT = 100
COVERAGE_STOP = 0.995   # stop at 99.5% of inhabitants covered

# Candidate location types. Priority: lower wins dedupe and ties — it mirrors
# where inleverpunten actually sit. Transformer huts, which the sister project
# uses for parcel lockers, are absent: you can bolt a locker to one, but not a
# staffed counter or a deposit machine.
#
# `standaard_actief` is off for bus and tram stops, and that matters more than
# it looks. Zwolle's POI bundle holds 302 bus stops against 41 supermarkets, so
# stops form by far the densest even grid of candidates — and a greedy that
# only maximises population within R will therefore pick almost nothing else.
# The result reads as a bus-stop network, not an inleverpunt network. A stop
# can hold a small battery box, but not a deposit machine or a counter, so the
# default pool excludes them; --types brings them back for comparison.
#
# fields: label, prioriteit, buiten_24_7, sociale_controle (0-2),
#         combi_geschikt (can this host a pakketpunt too?),
#         standaard_actief (in the default candidate pool?), stromen
TYPE_META: dict[str, dict] = {
    "supermarkt": {
        "label": "Supermarkt", "prioriteit": 0, "buiten_24_7": False,
        "sociale_controle": 2, "combi_geschikt": True, "standaard_actief": True, "kleur": "#DB2777",
        "stromen": ["statiegeld", "batterijen"],
    },
    "winkelcentrum": {
        "label": "Winkelcentrum", "prioriteit": 0, "buiten_24_7": False,
        "sociale_controle": 2, "combi_geschikt": True, "standaard_actief": True, "kleur": "#EA580C",
        "stromen": ["statiegeld", "batterijen", "elektro"],
    },
    "milieustraat": {
        "label": "Milieustraat", "prioriteit": 1, "buiten_24_7": False,
        "sociale_controle": 1, "combi_geschikt": False, "standaard_actief": True, "kleur": "#0F766E",
        "stromen": ["statiegeld", "batterijen", "elektro"],
    },
    "bouwmarkt": {
        "label": "Bouwmarkt", "prioriteit": 2, "buiten_24_7": False,
        "sociale_controle": 2, "combi_geschikt": True, "standaard_actief": True, "kleur": "#F97316",
        "stromen": ["batterijen", "elektro"],
    },
    "drogisterij": {
        "label": "Drogisterij", "prioriteit": 2, "buiten_24_7": False,
        "sociale_controle": 2, "combi_geschikt": True, "standaard_actief": True, "kleur": "#0D9488",
        "stromen": ["batterijen"],
    },
    "ns_station": {
        "label": "NS-station", "prioriteit": 2, "buiten_24_7": True,
        "sociale_controle": 2, "combi_geschikt": True, "standaard_actief": True, "kleur": "#D97706",
        "stromen": ["statiegeld", "batterijen"],
    },
    "metro_station": {
        "label": "Metrostation", "prioriteit": 3, "buiten_24_7": True,
        "sociale_controle": 2, "combi_geschikt": True, "standaard_actief": True, "kleur": "#E2231A",
        "stromen": ["statiegeld", "batterijen"],
    },
    "ov_knooppunt": {
        "label": "OV-knooppunt", "prioriteit": 3, "buiten_24_7": True,
        "sociale_controle": 2, "combi_geschikt": True, "standaard_actief": True, "kleur": "#6B46C1",
        "stromen": ["statiegeld", "batterijen"],
    },
    "gemeentehuis": {
        "label": "Gemeentehuis", "prioriteit": 4, "buiten_24_7": False,
        "sociale_controle": 1, "combi_geschikt": True, "standaard_actief": True, "kleur": "#B45309",
        "stromen": ["batterijen"],
    },
    "bibliotheek": {
        "label": "Bibliotheek", "prioriteit": 4, "buiten_24_7": False,
        "sociale_controle": 1, "combi_geschikt": True, "standaard_actief": True, "kleur": "#4338CA",
        "stromen": ["batterijen"],
    },
    "parkeergarage": {
        "label": "Parkeergarage", "prioriteit": 5, "buiten_24_7": True,
        "sociale_controle": 1, "combi_geschikt": True, "standaard_actief": True, "kleur": "#475569",
        "stromen": ["statiegeld"],
    },
    "glasbak": {
        "label": "Glas-/textielcontainer", "prioriteit": 5, "buiten_24_7": True,
        "sociale_controle": 0, "combi_geschikt": False, "standaard_actief": True, "kleur": "#14B8A6",
        "stromen": ["statiegeld", "batterijen"],
    },
    "tram_halte": {
        "label": "Tramhalte", "prioriteit": 6, "buiten_24_7": True,
        "sociale_controle": 1, "combi_geschikt": True, "standaard_actief": False, "kleur": "#0073B7",
        "stromen": ["batterijen"],
    },
    "bus_halte": {
        "label": "Bushalte", "prioriteit": 7, "buiten_24_7": True,
        "sociale_controle": 1, "combi_geschikt": True, "standaard_actief": False, "kleur": "#1F8A4C",
        "stromen": ["batterijen"],
    },
}

# Which existing points seed each starting situation.
START_SUBSETS = {
    "greenfield": None,
    "alle-punten": "alles",
    "automaten": "automaat",
    "statiegeld": "statiegeld",
    "batterijen": "batterijen",
    "elektro": "elektro",
}
DEFAULT_STARTS = ["greenfield", "automaten", "alle-punten"]

# Capacity assumptions.
#
# Unlike the parcel side — where ACM publishes a national parcel count that
# divides cleanly into parcels per inhabitant per year — there is no published
# figure for returns per inhabitant per stream. The numbers below are stated
# assumptions, not measurements, and are flagged as such all the way into the
# UI so nobody mistakes them for sourced data. `bron` stays null until each is
# confirmed against the registers listed in `bronnen_te_raadplegen`.
CAPACITY_DEFAULTS = {
    "status": "aanname",
    "toelichting": (
        "Er bestaat geen gepubliceerd kental voor inleveringen per inwoner per "
        "jaar per stroom. Onderstaande waarden zijn expliciete aannames om de "
        "orde van grootte te tonen; pas ze aan zodra de bronnen hieronder zijn "
        "geraadpleegd."
    ),
    "bronnen_te_raadplegen": [
        "Afvalfonds Verpakkingen — monitoring statiegeldvolumes",
        "Stichting OPEN — jaarverslag WEEE-inzameling (kg/inwoner)",
        "Stibat — jaarverslag batterij-inzameling",
    ],
    "retourvolume_liter_pp_jaar": {
        "statiegeld": {"waarde": 60.0, "bron": None},
        "batterijen": {"waarde": 0.6, "bron": None},
        "elektro": {"waarde": 15.0, "bron": None},
    },
    "container_liter": 240,
    "bezetting_max": 0.85,
    "legingen_per_week_max": 3,
}

METHODOLOGY = {
    "afstand": (
        "euclidische straal in RD (EPSG:28992) — consistent met alle "
        "dekkingscijfers in deze app; loopnetwerk-isochronen zijn future work"
    ),
    "vraag": (
        "CBS Vierkantstatistieken 100 m, bewoonde cellen, geclipt op de "
        "gemeentegrens uit municipality_polygon_cache.json (volledige "
        "resolutie, niet de voor weergave vereenvoudigde omtrek)"
    ),
    "kandidaten": (
        "OpenStreetMap-POI's per gemeente, beperkt tot types die een "
        "inleverpunt kunnen huisvesten; ontdubbeld binnen 50 m op typeprioriteit"
    ),
    "optimalisatie": (
        "greedy set-cover: iteratief de kandidaat met de grootste marginale "
        "populatiewinst binnen de loopafstand. Greedy-oplossingen zijn genest, "
        "dus 'de eerste N punten' is altijd het N-puntennetwerk"
    ),
    "sociale_veiligheid": (
        "indicatieve score per locatietype (2 = hoge sociale controle, "
        "0 = aandachtspunt); geen harde uitsluiting"
    ),
    "capaciteit": (
        "aannames, geen gepubliceerde kentallen — zie capacity_defaults"
    ),
    "combi": (
        "gain_i en gain_p zijn de nog niet gedekte inwoners voor respectievelijk "
        "het inleverpunten- en het pakketpuntennetwerk. De synergie-index "
        "2·min/(som) is 1 als een locatie beide netwerken evenveel dient en 0 "
        "als hij er maar één dient. De synergie-regel selecteert alleen types "
        "die beide fysiek kunnen huisvesten (combi_geschikt)"
    ),
    "combi_databron": (
        "pakketpunten uit een momentopname van de convenant-pakketpuntenviewer "
        "(data/pakketpunten_snapshot.geojson) — geen live koppeling"
    ),
}

# CBS grid and point sets, shared with fork workers via module globals.
_CBS_X: Optional[np.ndarray] = None
_CBS_Y: Optional[np.ndarray] = None
_CBS_POP: Optional[np.ndarray] = None
_CBS_LAT: Optional[np.ndarray] = None
_CBS_LON: Optional[np.ndarray] = None
_BOUNDARIES: Optional[dict] = None            # slug -> RD polygon
_POINTS_BY_SUBSET: Optional[dict] = None      # slug -> subset -> (x, y) arrays
_PAKKET_POINTS: Optional[dict] = None         # slug -> (x, y) arrays
_ARGS = None


def load_grid() -> None:
    global _CBS_X, _CBS_Y, _CBS_POP, _CBS_LAT, _CBS_LON
    _CBS_X, _CBS_Y, _CBS_POP = load_cbs_grid_arrays()
    lonlat = gpd.GeoSeries(gpd.points_from_xy(_CBS_X, _CBS_Y), crs=RD_NEW).to_crs(WGS84)
    _CBS_LAT = lonlat.y.to_numpy()
    _CBS_LON = lonlat.x.to_numpy()


def load_boundaries(slugs: set[str]) -> dict:
    """Full-resolution municipality polygons in RD, keyed by slug."""
    with open(MUNI_CACHE_PATH, encoding="utf-8") as handle:
        cache = json.load(handle)
    wanted = [(slug, entry) for slug, entry in cache.items() if slug in slugs]
    if not wanted:
        return {}
    series = gpd.GeoSeries(
        [wkt.loads(entry["geometry_wkt"]) for _, entry in wanted], crs=WGS84
    ).to_crs(RD_NEW)
    return {slug: geom for (slug, _), geom in zip(wanted, series)}


def load_existing_points(slugs: set[str]) -> dict:
    """Per municipality, RD coordinates of the existing inleverpunten by subset."""
    points = load_analysis_points()
    points = points[points["gemeenteSlug"].isin(slugs)].to_crs(RD_NEW)
    out: dict[str, dict[str, tuple[np.ndarray, np.ndarray]]] = {}
    for slug, group in points.groupby("gemeenteSlug"):
        per_subset: dict[str, tuple[np.ndarray, np.ndarray]] = {}
        xs = group.geometry.x.to_numpy()
        ys = group.geometry.y.to_numpy()
        subsets = list(group["subsets"])
        for subset in {s for row in subsets for s in row}:
            mask = np.array([subset in row for row in subsets])
            per_subset[subset] = (xs[mask], ys[mask])
        out[slug] = per_subset
    return out


def load_pakketpunten(boundaries: dict) -> dict:
    """Parcel points per municipality, from the snapshot copied into this repo.

    Attributed by point-in-polygon against the same boundaries the demand grid
    is clipped to, so a parcel point and an inhabitant are assigned to the same
    municipality by the same rule.
    """
    if not PAKKETPUNTEN_SNAPSHOT_PATH.exists():
        return {}
    with open(PAKKETPUNTEN_SNAPSHOT_PATH, encoding="utf-8") as handle:
        payload = json.load(handle)
    coords = [
        feature["geometry"]["coordinates"]
        for feature in payload.get("features", [])
        if feature.get("properties", {}).get("type") == "pakketpunt"
        and feature.get("geometry", {}).get("coordinates")
    ]
    if not coords:
        return {}
    series = gpd.GeoSeries(
        gpd.points_from_xy([c[0] for c in coords], [c[1] for c in coords]), crs=WGS84
    ).to_crs(RD_NEW)
    xs = series.x.to_numpy()
    ys = series.y.to_numpy()

    out: dict[str, tuple[np.ndarray, np.ndarray]] = {}
    for slug, polygon in boundaries.items():
        minx, miny, maxx, maxy = polygon.bounds
        box = np.nonzero((xs >= minx) & (xs <= maxx) & (ys >= miny) & (ys <= maxy))[0]
        if box.size == 0:
            out[slug] = (np.empty(0), np.empty(0))
            continue
        prepared = prep(polygon)
        keep = [i for i in box if prepared.contains(Point(xs[i], ys[i]))]
        out[slug] = (xs[keep], ys[keep])
    return out


def load_candidates(slug: str, allowed_types: set[str]) -> list[dict]:
    """POI candidates in RD, deduplicated on type priority."""
    path = POI_MUNI_DIR / f"{slug}.geojson"
    if not path.exists():
        return []
    with open(path, encoding="utf-8") as handle:
        payload = json.load(handle)

    raw: list[dict] = []
    lons: list[float] = []
    lats: list[float] = []
    for feature in payload.get("features", []):
        props = feature.get("properties", {})
        category = props.get("category")
        if category not in allowed_types:
            continue
        coords = (feature.get("geometry") or {}).get("coordinates")
        if not coords:
            continue
        lons.append(float(coords[0]))
        lats.append(float(coords[1]))
        raw.append({
            "type": category,
            "naam": str(props.get("name") or ""),
            "lat": round(float(coords[1]), 6),
            "lon": round(float(coords[0]), 6),
            "prio": TYPE_META[category]["prioriteit"],
        })
    if not raw:
        return []

    projected = gpd.GeoSeries(gpd.points_from_xy(lons, lats), crs=WGS84).to_crs(RD_NEW)
    for candidate, x, y in zip(raw, projected.x.to_numpy(), projected.y.to_numpy()):
        candidate["x"] = float(x)
        candidate["y"] = float(y)

    # Dedupe by priority: drop a candidate within DEDUPE_M of an accepted one.
    raw.sort(key=lambda c: (c["prio"], c["type"], -len(c["naam"])))
    kept: list[dict] = []
    kx: list[float] = []
    ky: list[float] = []
    limit = DEDUPE_M * DEDUPE_M
    for candidate in raw:
        if kx:
            dx = np.asarray(kx) - candidate["x"]
            dy = np.asarray(ky) - candidate["y"]
            if float(np.min(dx * dx + dy * dy)) <= limit:
                continue
        kept.append(candidate)
        kx.append(candidate["x"])
        ky.append(candidate["y"])
    return kept


def attach_flags(candidates: list[dict]) -> None:
    """Transparent suitability flags. Nothing is filtered out on these."""
    ov_types = {"ns_station", "metro_station", "ov_knooppunt", "tram_halte", "bus_halte"}
    ovx = np.asarray([c["x"] for c in candidates if c["type"] in ov_types])
    ovy = np.asarray([c["y"] for c in candidates if c["type"] in ov_types])
    shopx = np.asarray([
        c["x"] for c in candidates if c["type"] in ("supermarkt", "winkelcentrum")
    ])
    shopy = np.asarray([
        c["y"] for c in candidates if c["type"] in ("supermarkt", "winkelcentrum")
    ])

    for candidate in candidates:
        meta = TYPE_META[candidate["type"]]
        flags: list[str] = []
        if candidate["type"] in ov_types:
            flags.append("ov")
        elif ovx.size:
            d2 = (ovx - candidate["x"]) ** 2 + (ovy - candidate["y"]) ** 2
            if float(np.min(d2)) <= 150 * 150:
                flags.append("ov")

        control = meta["sociale_controle"]
        if control < 2 and shopx.size:
            d2 = (shopx - candidate["x"]) ** 2 + (shopy - candidate["y"]) ** 2
            if float(np.min(d2)) <= 100 * 100:
                control = 2
        if control >= 2:
            flags.append("sociale_controle")
        if meta["buiten_24_7"]:
            flags.append("24_7")
        if control == 0:
            flags.append("aandachtspunt_sociale_veiligheid")
        if meta["combi_geschikt"]:
            flags.append("combi_geschikt")
        candidate["flags"] = flags


def _to_wgs84(xs: np.ndarray, ys: np.ndarray) -> dict:
    """RD coordinate arrays → rounded lat/lon lists for the JSON payload."""
    series = gpd.GeoSeries(gpd.points_from_xy(xs, ys), crs=RD_NEW).to_crs(WGS84)
    return {
        "lat": [round(float(v), 5) for v in series.y],
        "lon": [round(float(v), 5) for v in series.x],
    }


def cells_in_boundary(polygon) -> np.ndarray:
    minx, miny, maxx, maxy = polygon.bounds
    box = np.nonzero(
        (_CBS_X >= minx) & (_CBS_X <= maxx) & (_CBS_Y >= miny) & (_CBS_Y <= maxy)
    )[0]
    if box.size == 0:
        return box
    prepared = prep(polygon)
    return np.asarray(
        [i for i in box if prepared.contains(Point(_CBS_X[i], _CBS_Y[i]))], dtype=int
    )


def covered_mask(cx, cy, px, py, radius: float) -> np.ndarray:
    """Which cells sit within `radius` of any of the given points?"""
    covered = np.zeros(cx.shape[0], dtype=bool)
    r2 = radius * radius
    for x, y in zip(px, py):
        near = np.nonzero(
            (np.abs(cx - x) <= radius) & (np.abs(cy - y) <= radius) & (~covered)
        )[0]
        if near.size == 0:
            continue
        d2 = (cx[near] - x) ** 2 + (cy[near] - y) ** 2
        covered[near[d2 <= r2]] = True
    return covered


def cover_index(cx, cy, cand_x, cand_y, radius: float) -> list[np.ndarray]:
    """Cell indices within `radius` of each candidate."""
    out: list[np.ndarray] = []
    r2 = radius * radius
    for x, y in zip(cand_x, cand_y):
        near = np.nonzero((np.abs(cx - x) <= radius) & (np.abs(cy - y) <= radius))[0]
        if near.size:
            d2 = (cx[near] - x) ** 2 + (cy[near] - y) ** 2
            near = near[d2 <= r2]
        out.append(near)
    return out


def greedy_single(cpop, cover_idx, start_covered, cand_x, cand_y, cand_prio,
                  max_picks: int, min_gain: int, min_spacing: int) -> dict:
    """Plain greedy set-cover on one coverage state."""
    n_cand = len(cover_idx)
    covered = start_covered.copy()
    cell_rank = np.where(start_covered, 0, -1).astype(int)
    active = np.ones(n_cand, dtype=bool)
    picks: list[dict] = []
    cumulative = float(cpop[start_covered].sum())
    total = float(cpop.sum())
    spacing2 = min_spacing * min_spacing

    while len(picks) < max_picks and cumulative < COVERAGE_STOP * total:
        best_i, best_gain, best_prio = -1, 0.0, 99
        for i in range(n_cand):
            if not active[i]:
                continue
            cells = cover_idx[i]
            if cells.size == 0:
                active[i] = False
                continue
            gain = float(cpop[cells[~covered[cells]]].sum())
            if gain > best_gain or (
                gain == best_gain and gain > 0 and cand_prio[i] < best_prio
            ):
                best_i, best_gain, best_prio = i, gain, int(cand_prio[i])
        if best_i < 0 or best_gain < min_gain:
            break

        rank = len(picks) + 1
        cells = cover_idx[best_i]
        cell_rank[cells[~covered[cells]]] = rank
        covered[cells] = True
        cumulative += best_gain
        picks.append({
            "c": best_i,
            "gain": int(round(best_gain)),
            "cum": int(round(cumulative)),
        })
        d2 = (cand_x - cand_x[best_i]) ** 2 + (cand_y - cand_y[best_i]) ** 2
        active[d2 <= spacing2] = False

    return {
        "start_covered": int(round(float(cpop[start_covered].sum()))),
        "picks": picks,
        "cell_rank": cell_rank.tolist(),
    }


def greedy_combi(cpop, cover_idx, covered_i0, covered_p0, cand_x, cand_y, cand_prio,
                 combi_ok, rule: str, alpha: float,
                 max_picks: int, min_gain: int, min_spacing: int) -> dict:
    """Greedy set-cover over two coverage states at once.

    `rule` is 'gewogen' (α·gain_i + (1−α)·gain_p) or 'synergie'
    (min(gain_i, gain_p), restricted to types that can host both).
    """
    n_cand = len(cover_idx)
    covered_i = covered_i0.copy()
    covered_p = covered_p0.copy()
    rank_i = np.where(covered_i0, 0, -1).astype(int)
    rank_p = np.where(covered_p0, 0, -1).astype(int)
    active = np.ones(n_cand, dtype=bool)
    if rule == "synergie":
        active &= combi_ok
    picks: list[dict] = []
    total = float(cpop.sum())
    cum_i = float(cpop[covered_i0].sum())
    cum_p = float(cpop[covered_p0].sum())
    spacing2 = min_spacing * min_spacing

    while len(picks) < max_picks:
        # Stop when neither network has meaningful headroom left.
        if cum_i >= COVERAGE_STOP * total and cum_p >= COVERAGE_STOP * total:
            break
        best_i, best_score, best_prio = -1, 0.0, 99
        best_gi = best_gp = 0.0
        for i in range(n_cand):
            if not active[i]:
                continue
            cells = cover_idx[i]
            if cells.size == 0:
                active[i] = False
                continue
            gain_i = float(cpop[cells[~covered_i[cells]]].sum())
            gain_p = float(cpop[cells[~covered_p[cells]]].sum())
            score = (
                min(gain_i, gain_p) if rule == "synergie"
                else alpha * gain_i + (1.0 - alpha) * gain_p
            )
            if score > best_score or (
                score == best_score and score > 0 and cand_prio[i] < best_prio
            ):
                best_i, best_score, best_prio = i, score, int(cand_prio[i])
                best_gi, best_gp = gain_i, gain_p
        if best_i < 0 or best_score < min_gain:
            break

        rank = len(picks) + 1
        cells = cover_idx[best_i]
        rank_i[cells[~covered_i[cells]]] = rank
        rank_p[cells[~covered_p[cells]]] = rank
        covered_i[cells] = True
        covered_p[cells] = True
        cum_i += best_gi
        cum_p += best_gp
        denominator = best_gi + best_gp
        picks.append({
            "c": best_i,
            "gain_i": int(round(best_gi)),
            "gain_p": int(round(best_gp)),
            "cum_i": int(round(cum_i)),
            "cum_p": int(round(cum_p)),
            "synergie": round(2 * min(best_gi, best_gp) / denominator, 3)
            if denominator > 0 else 0.0,
        })
        d2 = (cand_x - cand_x[best_i]) ** 2 + (cand_y - cand_y[best_i]) ** 2
        active[d2 <= spacing2] = False

    return {
        "rule": rule,
        "alpha": alpha if rule == "gewogen" else None,
        "start_covered_i": int(round(float(cpop[covered_i0].sum()))),
        "start_covered_p": int(round(float(cpop[covered_p0].sum()))),
        "picks": picks,
        "cell_rank_i": rank_i.tolist(),
        "cell_rank_p": rank_p.tolist(),
    }


def process_municipality(muni: dict) -> tuple[str, str]:
    slug = muni["slug"]
    args = _ARGS

    polygon = _BOUNDARIES.get(slug)
    if polygon is None:
        return slug, "skip: geen gemeentegrens in de cache"

    cell_idx = cells_in_boundary(polygon)
    if cell_idx.size == 0:
        return slug, "skip: geen bewoonde CBS-cellen"
    cx = _CBS_X[cell_idx]
    cy = _CBS_Y[cell_idx]
    cpop = _CBS_POP[cell_idx].astype(float)
    population_total = float(cpop.sum())

    candidates = load_candidates(slug, set(args.types))
    if not candidates:
        return slug, "skip: geen POI-kandidaten"
    attach_flags(candidates)
    cand_x = np.asarray([c["x"] for c in candidates])
    cand_y = np.asarray([c["y"] for c in candidates])
    cand_prio = np.asarray([c["prio"] for c in candidates])
    combi_ok = np.asarray([TYPE_META[c["type"]]["combi_geschikt"] for c in candidates])

    existing = _POINTS_BY_SUBSET.get(slug, {})
    pakket_x, pakket_y = _PAKKET_POINTS.get(slug, (np.empty(0), np.empty(0)))

    # Cap picks by population: a village does not need 300 collection points.
    max_picks = min(args.max_picks, max(20, math.ceil(population_total / 2000)))

    scenarios: dict[str, dict] = {}
    combi_scenarios: dict[str, dict] = {}

    for radius in args.distances:
        cover_idx = cover_index(cx, cy, cand_x, cand_y, radius)

        if args.mode in ("single", "both"):
            for start in args.starts:
                subset = START_SUBSETS[start]
                if subset is None:
                    start_covered = np.zeros(cx.shape[0], dtype=bool)
                else:
                    px, py = existing.get(subset, (np.empty(0), np.empty(0)))
                    start_covered = covered_mask(cx, cy, px, py, radius)
                scenarios[f"{radius}|{start}"] = greedy_single(
                    cpop, cover_idx, start_covered, cand_x, cand_y, cand_prio,
                    max_picks, args.min_gain, args.min_spacing,
                )

        if args.mode in ("combi", "both"):
            ix, iy = existing.get("alles", (np.empty(0), np.empty(0)))
            covered_i0 = covered_mask(cx, cy, ix, iy, radius)
            covered_p0 = covered_mask(cx, cy, pakket_x, pakket_y, radius)
            for rule in ("gewogen", "synergie"):
                combi_scenarios[f"{radius}|combi-{rule}"] = greedy_combi(
                    cpop, cover_idx, covered_i0, covered_p0, cand_x, cand_y,
                    cand_prio, combi_ok, rule, args.alpha,
                    max_picks, args.min_gain, args.min_spacing,
                )

    n_cells = int(cell_idx.size)
    for key, scenario in {**scenarios, **combi_scenarios}.items():
        for field in ("cell_rank", "cell_rank_i", "cell_rank_p"):
            if field in scenario:
                assert len(scenario[field]) == n_cells, f"{field} mismatch in {slug} {key}"

    out = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "slug": slug,
        "gemeente": muni["name"],
        "methodology": METHODOLOGY,
        "params": {
            "distances": args.distances,
            "starts": args.starts if args.mode in ("single", "both") else [],
            "mode": args.mode,
            "alpha": args.alpha,
            "kandidaat_types": sorted(args.types),
            "min_gain": args.min_gain,
            "min_spacing_m": args.min_spacing,
            "dedupe_m": DEDUPE_M,
            "max_picks": max_picks,
        },
        "type_meta": TYPE_META,
        "capacity_defaults": CAPACITY_DEFAULTS,
        "materiaal_stromen": {k: list(v) for k, v in MATERIAAL_STROMEN.items()},
        "population_total": int(round(population_total)),
        "cells": {
            "lat": [round(float(v), 5) for v in _CBS_LAT[cell_idx]],
            "lon": [round(float(v), 5) for v in _CBS_LON[cell_idx]],
            "pop": [int(v) for v in cpop],
        },
        "candidates": [
            {
                "lat": c["lat"], "lon": c["lon"], "type": c["type"],
                "naam": c["naam"], "flags": c["flags"],
            }
            for c in candidates
        ],
        "existing": {
            subset: int(coords[0].size) for subset, coords in existing.items()
        },
        "existing_pakketpunten": int(pakket_x.size),
        # Coordinates too, so the combi map can draw the layer the planner is
        # reasoning about. Small: a few hundred points per municipality.
        "pakketpunten": _to_wgs84(pakket_x, pakket_y) if pakket_x.size else {
            "lat": [], "lon": [],
        },
        "pakketpunten_snapshot": _pakketpunten_snapshot_meta(),
        "scenarios": scenarios,
        "combi_scenarios": combi_scenarios,
    }

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out_path = OUT_DIR / f"{slug}.json"
    out_path.write_text(json.dumps(out, separators=(",", ":"), allow_nan=False))

    kb = out_path.stat().st_size / 1024
    reference = scenarios.get("400|alle-punten") or next(iter(scenarios.values()), None)
    n_picks = len(reference["picks"]) if reference else 0
    combi = combi_scenarios.get("400|combi-synergie")
    combi_note = f", {len(combi['picks'])} combi-picks" if combi else ""
    return slug, (
        f"ok: {len(candidates)} kandidaten, {n_cells} cellen, "
        f"{n_picks} picks{combi_note}, {kb:.0f} KB"
    )


_SNAPSHOT_META: dict | None = None


def _pakketpunten_snapshot_meta() -> dict | None:
    global _SNAPSHOT_META
    if _SNAPSHOT_META is None and PAKKETPUNTEN_SNAPSHOT_PATH.exists():
        with open(PAKKETPUNTEN_SNAPSHOT_PATH, encoding="utf-8") as handle:
            _SNAPSHOT_META = json.load(handle).get("metadata", {})
    return _SNAPSHOT_META


def main() -> int:
    global _ARGS, _BOUNDARIES, _POINTS_BY_SUBSET, _PAKKET_POINTS

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--only", type=str, default="pilot",
                        help="Comma-separated slugs, 'pilot', or 'all'")
    parser.add_argument("--mode", choices=("single", "combi", "both"), default="both",
                        help="single = alleen inleverpunten, combi = ook de "
                             "gecombineerde inleverpunt/pakketpunt-planner")
    parser.add_argument("--distances", type=str, default="300,400,500")
    parser.add_argument("--starts", type=str, default=",".join(DEFAULT_STARTS))
    parser.add_argument("--alpha", type=float, default=0.5,
                        help="Gewicht van inleverpunten in de gewogen combi-regel")
    parser.add_argument("--types", type=str, default=None,
                        help="Comma-separated kandidaat-types, of 'alle'. Standaard "
                             "elk type met standaard_actief=True — dat sluit bus- en "
                             "tramhaltes uit, die anders het greedy-resultaat "
                             "domineren zonder een realistische gastheer te zijn.")
    parser.add_argument("--max-picks", type=int, default=300)
    parser.add_argument("--min-gain", type=int, default=MIN_GAIN_DEFAULT)
    parser.add_argument("--min-spacing", type=int, default=MIN_SPACING_DEFAULT)
    parser.add_argument("--jobs", type=int, default=max(1, mp.cpu_count() - 1))
    args = parser.parse_args()

    args.distances = [int(d) for d in args.distances.split(",")]
    args.starts = [s.strip() for s in args.starts.split(",") if s.strip()]
    unknown = [s for s in args.starts if s not in START_SUBSETS]
    if unknown:
        parser.error(f"onbekende start {unknown} (kies uit {sorted(START_SUBSETS)})")
    if not 0.0 <= args.alpha <= 1.0:
        parser.error("--alpha moet tussen 0 en 1 liggen")

    if args.types in (None, ""):
        args.types = [k for k, v in TYPE_META.items() if v["standaard_actief"]]
    elif args.types == "alle":
        args.types = list(TYPE_META)
    else:
        args.types = [t.strip() for t in args.types.split(",") if t.strip()]
        unknown_types = [t for t in args.types if t not in TYPE_META]
        if unknown_types:
            parser.error(f"onbekende types {unknown_types} "
                         f"(kies uit {sorted(TYPE_META)})")
    _ARGS = args

    municipalities = load_webapp_municipalities()
    by_slug = {m["slug"]: m for m in municipalities}
    slugs = resolve_slugs(args.only, all_slugs=by_slug)
    assert_poi_bundles_exist(slugs)
    selected = [by_slug[s] for s in slugs]

    print(f"CBS 100 m-raster laden…")
    load_grid()
    print(f"  {_CBS_POP.size:,} bewoonde cellen")

    print("Gemeentegrenzen laden (volledige resolutie)…")
    _BOUNDARIES = load_boundaries(set(slugs))
    print(f"  {len(_BOUNDARIES)} grenzen")

    print("Bestaande inleverpunten laden…")
    _POINTS_BY_SUBSET = load_existing_points(set(slugs))

    if args.mode in ("combi", "both"):
        print("Pakketpunten-momentopname laden…")
        _PAKKET_POINTS = load_pakketpunten(_BOUNDARIES)
        total = sum(x.size for x, _ in _PAKKET_POINTS.values())
        print(f"  {total} pakketpunten binnen de geselecteerde gemeenten")
    else:
        _PAKKET_POINTS = {}

    print(f"\nNetwerken plannen voor {len(selected)} gemeenten "
          f"(mode={args.mode}, R={args.distances})…")
    ok = skipped = 0
    if args.jobs > 1 and len(selected) > 1:
        ctx = mp.get_context("fork")
        with ctx.Pool(min(args.jobs, len(selected))) as pool:
            for slug, message in pool.imap_unordered(process_municipality, selected):
                print(f"  {slug}: {message}", flush=True)
                ok, skipped = (ok + 1, skipped) if message.startswith("ok") else (ok, skipped + 1)
    else:
        for muni in selected:
            slug, message = process_municipality(muni)
            print(f"  {slug}: {message}", flush=True)
            ok, skipped = (ok + 1, skipped) if message.startswith("ok") else (ok, skipped + 1)

    # An index so the webapp knows which municipalities have a network without
    # probing 342 URLs.
    if OUT_DIR.exists():
        index = {}
        for path in sorted(OUT_DIR.glob("*.json")):
            if path.name == "index.json":
                continue
            payload = json.loads(path.read_text())
            index[payload["slug"]] = {
                "gemeente": payload["gemeente"],
                "population_total": payload["population_total"],
                "candidates": len(payload["candidates"]),
                "has_combi": bool(payload.get("combi_scenarios")),
                "generated_at": payload["generated_at"],
            }
        (OUT_DIR / "index.json").write_text(
            json.dumps(index, indent=2, ensure_ascii=False)
        )
        total_mb = sum(p.stat().st_size for p in OUT_DIR.glob("*.json")) / 1e6
        print(f"\n✅ {ok} gemeenten geschreven, {skipped} overgeslagen "
              f"→ {OUT_DIR} ({total_mb:.1f} MB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
