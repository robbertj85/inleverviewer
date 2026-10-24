"""
The analysis layers (bereik, schatting, plaatsingsadvies, netwerkplanner, POI's)
as a stage of the weekly run, for every municipality.

Order, and what each step costs on the VPS-sized data (measured locally):

    POIs        fetch_pois.py (Overpass, 10-40 min; 35 on the first VPS run): monthly, or as soon as a
                municipality has no bundle. Then every week:
                classify_poi_ownership.py (publiek/privaat terrein; BGT lookups
                cached per POI, so only new POIs cost a request) and
                split_pois_by_municipality.py --only all.
    national    build_analysis_points → compute_population_coverage →
                build_pc4_stats → fit_pc4_model, ~1.5 min together. Always
                rerun: the regression refits on the whole country, so every
                municipality's prediction moves when any point changes.
    suggest_placements --only all
                One file per municipality with every variant (stream or all
                streams, with or without parcel points, terrain choice); about
                a second per municipality. Always rerun, for the same reason.
    plan_inleverpunt_network --only <changed>
                The expensive one: 4-25 s per municipality. It reads only that
                municipality's own points (load_existing_points filters on
                gemeenteSlug) and the parcel points inside its boundary, so a
                municipality is recomputed only when its fingerprint changes:
                its inleverpunten, its pakketpunten, its POI bundle, or a
                shared input (code, CBS grid, boundaries).

The stage is optional for the release: points still publish when it fails. A
failure puts the previous release's analysis files back into the staging copy,
so the site never shows coverage from this week next to suggestions from last
week, and the fingerprints are only saved after the release is published.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
from collections.abc import Callable
from datetime import datetime, timedelta
from pathlib import Path

RunStep = Callable[[str, int, Path, list[str]], int]
Log = Callable[[str], None]

# Inputs no script in the repo fetches. Put them on the data volume once with
# deploy/push-analysis-inputs.sh; until then the stage is skipped, not failed.
REQUIRED_INPUTS = [
    "cbs/cbs_vk100_2024_inhabited.gpkg",
    "cbs_pc4.json",
    "cbs_pc4_income.json",
    "cbs_pc4_ses_woa.json",
    "cbs_pc4_extra.json",
    "municipality_polygon_cache.json",
]
REQUIRED_SITE_INPUTS = ["data/pc4.geojson"]

# What the stage writes into the release, relative to it. Restored from the
# live release as a unit when any step fails.
OUTPUTS = [
    "data/population_coverage.json",
    "data/pc4_stats.json",
    "data/placement_suggestions",
    "data/inleverpunt_network",
    "data/poi",
]

NATIONAL = [
    ("scripts/build_analysis_points.py", 10),
    ("scripts/compute_population_coverage.py", 30),
    ("scripts/build_pc4_stats.py", 10),
    ("scripts/fit_pc4_model.py", 10),
]

POI_MAX_AGE = timedelta(days=int(os.environ.get("INLEVER_POI_MAX_AGE_DAYS", "28")))
JOBS = int(os.environ.get("INLEVER_ANALYSIS_JOBS", "6"))

# Anything the planner's output depends on besides the per-municipality points
# and POI bundle. Code is included so a change to the planner recomputes all.
SHARED_CODE = [
    "scripts/plan_inleverpunt_network.py",
    "scripts/classify_poi_ownership.py",
    "analysis.py",
    "normalize.py",
    "utils.py",
]
SHARED_DATA = [
    "cbs/cbs_vk100_2024_inhabited.gpkg",
    "municipality_polygon_cache.json",
]


def _sha_file(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


class AnalysisStage:
    def __init__(self, app_dir: Path, data_dir: Path, current: Path,
                 run_step: RunStep, log: Log) -> None:
        self.app_dir = app_dir
        self.data_dir = data_dir
        self.current = current
        self.run_step = run_step
        self.log = log
        self.state_file = data_dir / "analysis-state.json"

    # --- state ----------------------------------------------------------------

    def load_state(self) -> dict:
        try:
            return json.loads(self.state_file.read_text())
        except (FileNotFoundError, json.JSONDecodeError):
            return {}

    def save_state(self, state: dict) -> None:
        tmp = self.state_file.with_suffix(".tmp")
        tmp.write_text(json.dumps(state, indent=1, sort_keys=True))
        os.replace(tmp, self.state_file)

    # --- helpers --------------------------------------------------------------

    def missing_inputs(self, staging: Path) -> list[str]:
        missing = [name for name in REQUIRED_INPUTS if not (self.data_dir / name).exists()]
        missing += [name for name in REQUIRED_SITE_INPUTS if not (staging / name).exists()]
        return missing

    @staticmethod
    def slugs(staging: Path) -> list[str]:
        entries = json.loads((staging / "municipalities.json").read_text())
        return sorted(e["slug"] for e in entries if e.get("slug") != "nederland")

    def restore_outputs(self, staging: Path) -> None:
        """Put the live release's analysis files back over a half-built set."""
        live = self.current.resolve() if self.current.exists() else None
        for name in OUTPUTS:
            target = staging / name
            if target.is_dir():
                shutil.rmtree(target)
            else:
                target.unlink(missing_ok=True)
            source = live / name if live else None
            if source and source.is_dir():
                shutil.copytree(source, target, symlinks=True)
            elif source and source.exists():
                shutil.copy2(source, target)

    def fingerprints(self, staging: Path, slugs: list[str]) -> dict[str, str]:
        """One hash per municipality over everything its network plan reads."""
        shared = hashlib.sha256()
        for name in SHARED_CODE:
            shared.update(_sha_file(self.app_dir / name).encode())
        for name in SHARED_DATA:
            path = self.data_dir / name
            shared.update((_sha_file(path) if path.exists() else "absent").encode())
        shared_hex = shared.hexdigest()

        points: dict[str, list] = {slug: [] for slug in slugs}
        collection = json.loads((self.data_dir / "analysis_points.geojson").read_text())
        for feature in collection["features"]:
            props = feature["properties"]
            bucket = points.get(props.get("gemeenteSlug"))
            if bucket is None:
                continue
            lon, lat = feature["geometry"]["coordinates"][:2]
            bucket.append((round(lon, 6), round(lat, 6), sorted(props.get("subsets") or [])))

        parcels = self.parcels_by_slug(slugs)

        bundles = staging / "data" / "poi" / "by-municipality"
        result = {}
        for slug in slugs:
            digest = hashlib.sha256(shared_hex.encode())
            digest.update(json.dumps(sorted(points[slug])).encode())
            digest.update(json.dumps(parcels.get(slug, [])).encode())
            bundle = bundles / f"{slug}.geojson"
            digest.update((_sha_file(bundle) if bundle.exists() else "absent").encode())
            result[slug] = digest.hexdigest()
        return result

    def parcels_by_slug(self, slugs: list[str]) -> dict[str, list]:
        """Parcel points per municipality, by the planner's own rule.

        The parcel file changes every week somewhere in the country; hashing it
        whole would replan all 342 municipalities each time. Point-in-polygon
        against the same boundary cache the planner clips to (load_pakketpunten)
        keeps the fingerprint local.
        """
        import numpy as np
        from shapely import contains_xy, wkt

        snapshot = self.data_dir / "pakketpunten_snapshot.geojson"
        if not snapshot.exists():
            return {}
        coords = np.array([
            feature["geometry"]["coordinates"][:2]
            for feature in json.loads(snapshot.read_text())["features"]
            if feature.get("properties", {}).get("type") == "pakketpunt"
        ]).reshape(-1, 2)
        cache = json.loads((self.data_dir / "municipality_polygon_cache.json").read_text())

        out: dict[str, list] = {}
        for slug in slugs:
            entry = cache.get(slug)
            if not entry or coords.size == 0:
                continue
            polygon = wkt.loads(entry["geometry_wkt"])
            minx, miny, maxx, maxy = polygon.bounds
            box = coords[
                (coords[:, 0] >= minx) & (coords[:, 0] <= maxx)
                & (coords[:, 1] >= miny) & (coords[:, 1] <= maxy)
            ]
            inside = box[contains_xy(polygon, box[:, 0], box[:, 1])] if len(box) else box
            out[slug] = sorted((round(float(x), 6), round(float(y), 6)) for x, y in inside)
        return out

    # --- the stage ------------------------------------------------------------

    def run(self, staging: Path, force_all: bool = False) -> tuple[list[str], Callable[[], None]]:
        """Build the layers into `staging`.

        Returns (anomalies, commit). Call commit() once the release is
        published; it records the fingerprints of what went live.
        """
        noop = lambda: None  # noqa: E731
        missing = self.missing_inputs(staging)
        if missing:
            self.log(f"⚠ analysis skipped, inputs missing on the data volume: {' '.join(missing)}")
            return ["analysis:inputs-missing"], noop

        state = self.load_state()
        try:
            slugs = self.slugs(staging)
            pois_refreshed = self._pois(staging, slugs, state)

            for script, timeout in NATIONAL:
                if self.run_step(script, timeout, staging, []):
                    raise RuntimeError(script)
            if self.run_step("scripts/suggest_placements.py", 60, staging,
                             ["--only", "all", "--jobs", str(JOBS)]):
                raise RuntimeError("suggest_placements")

            prints = self.fingerprints(staging, slugs)
            done = state.get("network", {})
            network_dir = staging / "data" / "inleverpunt_network"
            changed = [
                slug for slug in slugs
                if force_all
                or done.get(slug) != prints[slug]
                or not (network_dir / f"{slug}.json").exists()
            ]
            if changed:
                self.log(f"network planner: {len(changed)} of {len(slugs)} municipalities changed")
                only = "all" if len(changed) == len(slugs) else ",".join(changed)
                args = ["--only", only, "--mode", "both", "--jobs", str(JOBS)]
                if self.run_step("scripts/plan_inleverpunt_network.py", 240, staging, args):
                    raise RuntimeError("plan_inleverpunt_network")
            else:
                self.log("network planner: no municipality changed")
        except Exception as error:  # noqa: BLE001 — never let analysis sink the points
            self.log(f"✗ analysis step {error} failed; keeping last week's analysis layers")
            self.restore_outputs(staging)
            return [f"analysis:{error}"], noop

        # Only municipalities that actually have a plan count as done; one the
        # planner skipped is retried next week. Decided now: once published,
        # `staging` has been renamed and these paths no longer exist.
        done_prints = {
            slug: fp for slug, fp in prints.items() if (network_dir / f"{slug}.json").exists()
        }

        def commit() -> None:
            new_state = self.load_state()
            new_state["network"] = done_prints
            if pois_refreshed:
                new_state["pois_fetched_at"] = datetime.now().astimezone().isoformat()
            self.save_state(new_state)

        return [], commit

    def _pois(self, staging: Path, slugs: list[str], state: dict) -> bool:
        """Refresh the POI layer when it is old or a municipality lacks a bundle,
        then classify publiek/privaat and rebuild the bundles.

        Returns whether a fresh download happened (and its date should be saved).
        """
        fetched_ok = self._fetch_pois(staging, slugs, state)
        # Weekly even without a download: cached lookups make it cheap, and it
        # retries the BGT lookups that failed last time.
        if self.run_step("scripts/classify_poi_ownership.py", 240, staging, []):
            raise RuntimeError("classify_poi_ownership")
        if self.run_step("scripts/split_pois_by_municipality.py", 30, staging, ["--only", "all"]):
            raise RuntimeError("split_pois_by_municipality")
        return fetched_ok

    def _fetch_pois(self, staging: Path, slugs: list[str], state: dict) -> bool:
        bundles = staging / "data" / "poi" / "by-municipality"
        missing = [s for s in slugs if not (bundles / f"{s}.geojson").exists()]
        fetched = state.get("pois_fetched_at")
        stale = not fetched or datetime.now().astimezone() - datetime.fromisoformat(fetched) > POI_MAX_AGE
        if not missing and not stale:
            return False

        self.log(f"POIs: {'stale' if stale else 'fresh'}, {len(missing)} municipalities without a bundle")
        # Overpass rate-limits: the first full download took 35 min.
        fetched_ok = self.run_step("scripts/fetch_pois.py", 75, staging, []) == 0
        if not fetched_ok:
            # Overpass is flaky; the previous download still makes usable
            # bundles, and the next run tries the fetch again.
            if not (staging / "data" / "poi" / "index.json").exists():
                raise RuntimeError("fetch_pois")
            self.log("⚠ fetch_pois failed; splitting the previous POI download")
        return fetched_ok
