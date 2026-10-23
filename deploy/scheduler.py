"""
Data worker for the VPS deployment (replaces .github/workflows/update-data.yml).

    python deploy/scheduler.py serve              long-running: weekly run on a schedule
    python deploy/scheduler.py run                one weekly run, now
    python deploy/scheduler.py analyse [--all]    only the analysis layers, now;
                                                  --all recomputes every network plan
    python deploy/scheduler.py run-script scripts/suggest_placements.py [args]
                                                  one script, published the same way
    python deploy/scheduler.py seed < data.tar.gz fill missing files from a git archive
    python deploy/scheduler.py rollback           point current back at the previous release

Layout on the volumes (see docker-compose.yaml):

    $INLEVER_SITE_DIR/current -> releases/<stamp>   what nginx and the app read
    $INLEVER_SITE_DIR/releases/<stamp>/municipalities.json, data/...
    $INLEVER_DATA_DIR/                              source caches + analysis inputs
    $INLEVER_DATA_DIR/backups/totals_history-*.json the one file that accumulates

nginx serves the release while the pipeline runs, and the scripts write with a
plain open("w"). So a run never touches the live tree: it copies `current` to a
new release, points INLEVER_PUBLIC_DIR at the copy, and only when every
required step succeeded swaps the `current` symlink in one rename. A failed
run leaves the previous dataset live and the half-built release is deleted.

After the points, the weekly run rebuilds the analysis layers for every
municipality (deploy/analysis_stage.py), recomputing the expensive network
plans only where a municipality's inputs changed.
"""

from __future__ import annotations

import fcntl
import json
import os
import shutil
import subprocess
import sys
import tarfile
import time
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

from analysis_stage import AnalysisStage

APP_DIR = Path(__file__).resolve().parent.parent
SITE_DIR = Path(os.environ.get("INLEVER_SITE_DIR", "/srv/inlever/site"))
DATA_DIR = Path(os.environ.get("INLEVER_DATA_DIR", "/srv/inlever/data"))
CURRENT = SITE_DIR / "current"
RELEASES = SITE_DIR / "releases"
STATE_FILE = DATA_DIR / "worker-state.json"
LOCK_FILE = DATA_DIR / ".worker.lock"

TZ = ZoneInfo("Europe/Amsterdam")
# Same slot as the GitHub Action (Mon 02:00 UTC), in local time.
WEEKDAY = int(os.environ.get("INLEVER_WEEKDAY", "0"))  # 0 = Monday
RUN_AT = os.environ.get("INLEVER_RUN_AT", "04:00")
# A run that was missed (worker down on Monday) is caught up on start.
MAX_AGE = timedelta(days=8)
KEEP_RELEASES = 2  # current + one to roll back to
KEEP_BACKUPS = int(os.environ.get("INLEVER_BACKUP_KEEP", "14"))

# (script, timeout in minutes, required). Not required = the GitHub Action's
# continue-on-error: cache_guard exits 2 on an anomalous fetch and the previous
# cache stays in place, so the rest of the dataset still updates.
FETCHES = [
    ("scripts/statiegeld_fetch_all.py", 15, "StatiegeldNederland"),
    ("scripts/stibat_fetch_all.py", 15, "Stibat"),
    ("scripts/open_fetch_all.py", 30, "StichtingOPEN"),
    ("scripts/droppie_fetch_all.py", 5, "Droppie"),
    ("scripts/statiedrive_fetch_all.py", 5, "StatieDrive"),
    # Only the network planner's combi mode reads this; a failed download
    # keeps the previous file.
    ("scripts/fetch_pakketpunten.py", 5, "Pakketpunten"),
]
GENERATE = [
    ("scripts/batch_generate.py", 30),
    ("scripts/create_national_overview.py", 30),
    ("scripts/create_provincial_boundaries.py", 30),
    ("scripts/compute_statistics.py", 20),
    ("scripts/update_totals_history.py", 5),
]


def log(message: str) -> None:
    stamp = datetime.now(TZ).strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{stamp}] {message}", flush=True)


class StepFailed(Exception):
    pass


@contextmanager
def worker_lock():
    """One pipeline at a time: a manual run must not race the scheduled one."""
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with open(LOCK_FILE, "w") as handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise SystemExit("another pipeline run is in progress")
        yield


def run_step(script: str, timeout_min: int, public_dir: Path, args: list[str] = ()) -> int:
    env = {**os.environ, "INLEVER_PUBLIC_DIR": str(public_dir), "INLEVER_DATA_DIR": str(DATA_DIR)}
    log(f"▶ {script} {' '.join(args)}".rstrip())
    started = time.monotonic()
    try:
        code = subprocess.run(
            [sys.executable, script, *args], cwd=APP_DIR, env=env, timeout=timeout_min * 60
        ).returncode
    except subprocess.TimeoutExpired:
        log(f"✗ {script} timed out after {timeout_min} min")
        return 124
    log(f"{'✓' if code == 0 else '✗'} {script} exit {code} ({time.monotonic() - started:.0f}s)")
    return code


# --- releases ---------------------------------------------------------------


def stage_release() -> Path:
    """A private copy of the live tree to build into (empty on first run)."""
    RELEASES.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    staging = RELEASES / f".staging-{stamp}"
    if CURRENT.exists():
        # A real copy, not hard links: the scripts truncate files in place.
        shutil.copytree(CURRENT.resolve(), staging, symlinks=True)
    else:
        (staging / "data").mkdir(parents=True)
    return staging


def point_current_at(release: Path) -> None:
    tmp_link = SITE_DIR / ".current.tmp"
    tmp_link.unlink(missing_ok=True)
    tmp_link.symlink_to(Path("releases") / release.name)
    os.replace(tmp_link, CURRENT)  # atomic: readers see old or new, never neither


def publish(staging: Path) -> Path:
    release = RELEASES / staging.name.removeprefix(".staging-")
    staging.rename(release)
    point_current_at(release)
    log(f"published {release.name}")
    prune_releases()
    return release


def rollback() -> None:
    with worker_lock():
        live = CURRENT.resolve().name
        older = sorted(p for p in RELEASES.iterdir() if p.is_dir() and p.name < live and not p.name.startswith("."))
        if not older:
            raise SystemExit("no previous release to roll back to")
        point_current_at(older[-1])
        log(f"rolled back {live} -> {older[-1].name}")


def prune_releases() -> None:
    live = CURRENT.resolve().name if CURRENT.exists() else None
    releases = sorted(p for p in RELEASES.iterdir() if p.is_dir() and not p.name.startswith("."))
    for old in releases[:-KEEP_RELEASES]:
        if old.name != live:
            shutil.rmtree(old)
    for stale in RELEASES.glob(".staging-*"):
        # Leftovers from a run that was killed mid-way.
        if time.time() - stale.stat().st_mtime > 6 * 3600:
            shutil.rmtree(stale, ignore_errors=True)


def backup_history(release: Path) -> None:
    source = release / "data" / "totals_history.json"
    if not source.exists():
        return
    backups = DATA_DIR / "backups"
    backups.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, backups / f"totals_history-{datetime.now(TZ):%Y-%m-%d}.json")
    for old in sorted(backups.glob("totals_history-*.json"))[:-KEEP_BACKUPS]:
        old.unlink()


def save_state(**fields) -> None:
    state = load_state() | fields
    tmp = STATE_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, indent=2))
    os.replace(tmp, STATE_FILE)


def load_state() -> dict:
    try:
        return json.loads(STATE_FILE.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


# --- commands -----------------------------------------------------------------


def weekly_run() -> None:
    with worker_lock():
        started = datetime.now(TZ)
        staging = stage_release()
        try:
            # Boundaries only hit PDOK when the cache is empty or in a refresh
            # week; otherwise a no-op read.
            if run_step("scripts/fetch_pdok_boundaries.py", 15, staging):
                raise StepFailed("fetch_pdok_boundaries")

            anomalies = [name for script, timeout, name in FETCHES if run_step(script, timeout, staging)]
            if anomalies:
                log(f"⚠ previous cache used for: {' '.join(anomalies)}")

            if not list(DATA_DIR.glob("*_all_locations.json")):
                raise StepFailed("no source caches at all; refusing to generate an empty dataset")

            for script, timeout in GENERATE:
                if run_step(script, timeout, staging):
                    raise StepFailed(script)

            # Optional: a failure keeps last week's layers and still publishes.
            analysis_anomalies, commit_analysis = analysis_stage().run(staging)
            anomalies += analysis_anomalies
        except BaseException as error:
            shutil.rmtree(staging, ignore_errors=True)
            log(f"✗ run aborted ({error}); previous dataset stays live")
            save_state(last_failure=started.isoformat(), last_failure_reason=str(error))
            if isinstance(error, StepFailed):
                raise SystemExit(1)
            raise

        release = publish(staging)
        commit_analysis()
        backup_history(release)
        save_state(last_success=started.isoformat(), last_release=release.name, anomalies=anomalies)
        summary = release / "data" / "summary.json"
        if summary.exists():
            data = json.loads(summary.read_text())
            log(f"{data.get('total_points')} points in {data.get('total_municipalities')} municipalities")


def analysis_stage() -> AnalysisStage:
    return AnalysisStage(APP_DIR, DATA_DIR, CURRENT, run_step, log)


def analyse(force_all: bool) -> None:
    """Only the analysis layers, on the live points, published like a run."""
    with worker_lock():
        if not CURRENT.exists():
            raise SystemExit("no published dataset to analyse yet")
        staging = stage_release()
        try:
            anomalies, commit = analysis_stage().run(staging, force_all=force_all)
        except BaseException:
            shutil.rmtree(staging, ignore_errors=True)
            raise
        if anomalies:
            shutil.rmtree(staging, ignore_errors=True)
            raise SystemExit(f"analysis failed ({' '.join(anomalies)}); nothing published")
        publish(staging)
        commit()


def run_script(script: str, args: list[str]) -> None:
    """Re-run one (analysis) script against a copy, then publish it."""
    with worker_lock():
        staging = stage_release()
        if run_step(script, 180, staging, args):
            shutil.rmtree(staging, ignore_errors=True)
            raise SystemExit(f"{script} failed; nothing published")
        publish(staging)


def seed() -> None:
    """
    Fill the volumes from `git archive <rev> webapp/public data | gzip` on
    stdin. Never overwrites: a file the worker already produced is newer than
    anything in git, so seeding is safe before or after the first run, and
    re-runnable.
    """
    with worker_lock():
        staging = stage_release()
        added = {"site": 0, "data": 0}
        with tarfile.open(fileobj=sys.stdin.buffer, mode="r|gz") as archive:
            for member in archive:
                if not member.isfile():
                    continue
                name = Path(member.name)
                if name.parts[:2] == ("webapp", "public"):
                    target, bucket = staging.joinpath(*name.parts[2:]), "site"
                elif name.parts[:1] == ("data",):
                    target, bucket = DATA_DIR.joinpath(*name.parts[1:]), "data"
                else:
                    continue
                if ".." in name.parts or target.exists():
                    continue
                target.parent.mkdir(parents=True, exist_ok=True)
                with archive.extractfile(member) as source, open(target, "wb") as out:
                    shutil.copyfileobj(source, out)
                added[bucket] += 1
        log(f"seed: {added['site']} site files, {added['data']} data files added")
        if added["site"]:
            publish(staging)
        else:
            shutil.rmtree(staging)


def next_run(now: datetime) -> datetime:
    hour, minute = map(int, RUN_AT.split(":"))
    candidate = now.replace(hour=hour, minute=minute, second=0, microsecond=0)
    candidate += timedelta(days=(WEEKDAY - now.weekday()) % 7)
    return candidate if candidate > now else candidate + timedelta(days=7)


def overdue() -> bool:
    """No success in 8 days (worker was down on Monday, or freshly seeded),
    but not straight after a failure: back off 6 h rather than hammer the
    sources with a run that keeps failing."""
    if not CURRENT.exists():
        return False
    state, now = load_state(), datetime.now(TZ)
    last, failed = state.get("last_success"), state.get("last_failure")
    if last and now - datetime.fromisoformat(last) <= MAX_AGE:
        return False
    return not failed or now - datetime.fromisoformat(failed) > timedelta(hours=6)


def serve() -> None:
    log(f"worker up; site {SITE_DIR}, data {DATA_DIR}")
    if not CURRENT.exists():
        # An empty volume waits for deploy/seed-data.sh (which runs `seed`):
        # it brings the hand-made inputs along (CBS PC4 tables, polygon cache)
        # that the analysis stage needs next to the weekly fetches.
        log("no published dataset yet: waiting for deploy/seed-data.sh")
    due = next_run(datetime.now(TZ))
    log(f"next run {due:%a %Y-%m-%d %H:%M %Z}")
    while True:
        if overdue() or (CURRENT.exists() and datetime.now(TZ) >= due):
            try:
                weekly_run()
            except SystemExit as error:
                log(f"run failed: {error}")
            due = next_run(datetime.now(TZ))
            log(f"next run {due:%a %Y-%m-%d %H:%M %Z}")
        time.sleep(600)


def main(argv: list[str]) -> None:
    command = argv[0] if argv else "serve"
    if command == "serve":
        serve()
    elif command == "run":
        weekly_run()
    elif command == "analyse":
        analyse(force_all="--all" in argv[1:])
    elif command == "run-script" and len(argv) >= 2:
        run_script(argv[1], argv[2:])
    elif command == "seed":
        seed()
    elif command == "rollback":
        rollback()
    else:
        raise SystemExit(__doc__)


if __name__ == "__main__":
    main(sys.argv[1:])
