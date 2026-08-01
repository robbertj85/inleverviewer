"""Fit linear models predicting inleverpunten per PC4, per material stream.

Three targets are modelled separately rather than as one lump:

    statiegeld  — follows retail; a deposit machine lives in a supermarket
    batterijen  — follows retail too, but a much denser and cheaper network
    elektro     — follows municipal policy; a milieustraat per town

One model over "all inleverpunten" averages a supermarket network against a
handful of municipal recycling centres and predicts neither well. The total is
modelled too, but as a fourth target, not as the only one.

Per target, three feature sets:

    base      population + area_km2
    extended  base + income + SES-WOA
    ruim      base + density, household composition and amenity proximity

Every model is scored twice: in-sample R² and 5-fold cross-validated R². Only
the second says anything about generalisation. R² cannot fall when you add a
feature, so a feature set chosen on in-sample R² is chosen by its size — which
is how the sister project ends up recommending its eight-feature model over
its two-feature one on evidence that cannot distinguish them.

Writes predictions and model metadata back into pc4_stats.json.

    python scripts/fit_pc4_model.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402
from sklearn.linear_model import LinearRegression  # noqa: E402
from sklearn.model_selection import KFold, cross_val_score  # noqa: E402

from utils import WEBAPP_DATA_DIR  # noqa: E402

STATS_PATH = WEBAPP_DATA_DIR / "pc4_stats.json"

# Training-set thresholds: skip empty industrial PC4s and degenerate polygons.
MIN_POPULATION = 10
MIN_AREA_KM2 = 0.05

CV_FOLDS = 5
CV_SEED = 20260801  # fixed so reruns are comparable

BASE_FEATURES = ["population", "area_km2"]
EXTENDED_FEATURES = BASE_FEATURES + ["avg_income_household", "ses_woa_total"]
RUIM_FEATURES = BASE_FEATURES + [
    "oad", "pct_single_hh", "pct_multi_family", "pct_owner_occupied",
    "supermarket_1km", "horeca_1km",
]

FEATURE_SETS = {
    "base": BASE_FEATURES,
    "extended": EXTENDED_FEATURES,
    "ruim": RUIM_FEATURES,
}
FEATURE_SET_LABELS = {
    "base": "Basis (inwoners + oppervlakte)",
    "extended": "Uitgebreid (+ inkomen, SES-WOA)",
    "ruim": "Ruim (+ dichtheid, huishoudens, voorzieningen)",
}

TARGETS = ("alles", "statiegeld", "batterijen", "elektro")
TARGET_LABELS = {
    "alles": "Alle inleverpunten",
    "statiegeld": "Statiegeld",
    "batterijen": "Batterijen & lampen",
    "elektro": "Elektrische apparaten",
}

ALL_FEATURES = sorted({f for fs in FEATURE_SETS.values() for f in fs})


def compute_vif(frame: pd.DataFrame, features: list[str]) -> dict[str, float]:
    """Variance inflation factors, 1 / (1 − R²) of each feature on the others.

    Above 5 is a yellow flag, above 10 red. Computed here rather than pulled in
    from statsmodels, which this project does not otherwise need.
    """
    vifs: dict[str, float] = {}
    for i, target in enumerate(features):
        others = [f for j, f in enumerate(features) if j != i]
        if not others:
            vifs[target] = 1.0
            continue
        y = frame[target].to_numpy()
        if np.var(y) == 0:
            vifs[target] = float("inf")
            continue
        r2 = LinearRegression().fit(frame[others].to_numpy(), y).score(
            frame[others].to_numpy(), y
        )
        vifs[target] = float("inf") if r2 >= 0.9999 else round(1 / (1 - r2), 2)
    return vifs


def flag_high_vif(vifs: dict[str, float]) -> None:
    hits = [(k, v) for k, v in vifs.items() if v > 5]
    if hits:
        print("     ⚠  verhoogde VIF — features delen variantie:")
        for name, value in hits:
            print(f"        {name}: {value} ({'ROOD' if value > 10 else 'geel'})")


def fit_one(frame: pd.DataFrame, features: list[str], target_column: str,
            base_mask: pd.Series) -> dict | None:
    """Fit one (feature set × target) model and report both R² flavours."""
    mask = base_mask.copy()
    for feature in features:
        mask &= frame[feature].notna()
    if int(mask.sum()) < 100:
        return None

    train = frame[mask]
    X = train[features].to_numpy()
    y = train[target_column].to_numpy()
    model = LinearRegression().fit(X, y)

    r2_in_sample = model.score(X, y)
    folds = KFold(n_splits=CV_FOLDS, shuffle=True, random_state=CV_SEED)
    cv_scores = cross_val_score(LinearRegression(), X, y, cv=folds, scoring="r2")

    # Predict wherever every feature is present, including PC4s below the
    # training thresholds — the map shows them, so they need a number.
    predictable = frame[features].notna().all(axis=1)
    predictions = pd.Series(np.nan, index=frame.index)
    if predictable.any():
        predictions.loc[predictable] = np.clip(
            model.predict(frame.loc[predictable, features].to_numpy()), 0, None
        ).round(2)

    vifs = compute_vif(train, features)
    return {
        "meta": {
            "type": "OLS",
            "features": features,
            "target": target_column,
            "r2": round(float(r2_in_sample), 4),
            "r2_cv_mean": round(float(cv_scores.mean()), 4),
            "r2_cv_std": round(float(cv_scores.std()), 4),
            "cv_folds": CV_FOLDS,
            "intercept": float(model.intercept_),
            "coefficients": {
                name: float(coef) for name, coef in zip(features, model.coef_)
            },
            "vif": vifs,
            "training_size": int(mask.sum()),
            "coverage_pct": round(100 * mask.sum() / max(1, base_mask.sum()), 1),
        },
        "predictions": predictions,
    }


def main() -> int:
    with open(STATS_PATH, encoding="utf-8") as handle:
        payload = json.load(handle)
    stats: dict[str, dict] = payload["stats"]

    rows = []
    for pc4, entry in stats.items():
        row = {
            "pc4": pc4,
            "population": entry["population"],
            "area_km2": entry["area_km2"],
        }
        by_subset = entry["inleverpunten"]["by_subset"]
        for target in TARGETS:
            row[f"n_{target}"] = by_subset.get(target, 0)
        for feature in ALL_FEATURES:
            row.setdefault(feature, entry.get(feature))
        rows.append(row)
    frame = pd.DataFrame(rows)
    print(f"{len(frame)} PC4-rijen geladen")

    base_mask = (
        (frame["population"] >= MIN_POPULATION)
        & (frame["area_km2"] >= MIN_AREA_KM2)
    )
    print(f"Trainingsset: {int(base_mask.sum())} PC4's "
          f"(≥{MIN_POPULATION} inwoners, ≥{MIN_AREA_KM2} km²)\n")

    models: dict[str, dict] = {}
    predictions: dict[str, dict[str, pd.Series]] = {}

    for target in TARGETS:
        target_column = f"n_{target}"
        print(f"── {TARGET_LABELS[target]} ({int(frame[target_column].sum())} punten)")
        models[target] = {}
        predictions[target] = {}
        for set_name, features in FEATURE_SETS.items():
            result = fit_one(frame, features, target_column, base_mask)
            if result is None:
                print(f"   {set_name:<9} overgeslagen — te weinig complete rijen")
                models[target][set_name] = None
                continue
            meta = result["meta"]
            meta["label"] = FEATURE_SET_LABELS[set_name]
            models[target][set_name] = meta
            predictions[target][set_name] = result["predictions"]
            print(f"   {set_name:<9} R² {meta['r2']:.4f} | "
                  f"R²(cv) {meta['r2_cv_mean']:.4f} ±{meta['r2_cv_std']:.4f} | "
                  f"n={meta['training_size']}")
            flag_high_vif(meta["vif"])

        # Which feature set actually generalises best for this target?
        scored = [
            (name, meta["r2_cv_mean"])
            for name, meta in models[target].items() if meta
        ]
        if scored:
            best = max(scored, key=lambda kv: kv[1])[0]
            models[target]["recommended"] = best
            print(f"   → beste op cross-validatie: {best}")
        print()

    # Nationwide rates as an independent sanity check on the models.
    totals = {
        target: {
            "points": int(frame[f"n_{target}"].sum()),
            "per_inhabitant": None,
            "per_km2": None,
        }
        for target in TARGETS
    }
    total_population = float(frame["population"].sum())
    total_area = float(frame["area_km2"].sum())
    for target, block in totals.items():
        if total_population:
            block["per_inhabitant"] = round(block["points"] / total_population, 6)
        if total_area:
            block["per_km2"] = round(block["points"] / total_area, 4)

    # Write predictions back per PC4.
    index_by_pc4 = {pc4: i for i, pc4 in enumerate(frame["pc4"])}
    for pc4, entry in stats.items():
        i = index_by_pc4[pc4]
        area = entry["area_km2"]
        population = entry["population"]
        by_subset = entry["inleverpunten"]["by_subset"]
        total = entry["inleverpunten"]["total"]
        entry["points_per_km2"] = round(total / area, 3) if area > 0 else None
        entry["points_per_1000_inw"] = (
            round(total / population * 1000, 3) if population > 0 else None
        )

        entry["model"] = {}
        for target in TARGETS:
            actual = by_subset.get(target, 0)
            block = {"actual": actual}
            for set_name in FEATURE_SETS:
                series = predictions[target].get(set_name)
                value = None if series is None else series.iloc[i]
                if value is None or pd.isna(value):
                    block[set_name] = None
                    block[f"delta_{set_name}"] = None
                else:
                    block[set_name] = float(value)
                    block[f"delta_{set_name}"] = round(actual - float(value), 2)
            # Simple-rate alternative: a 50/50 blend of the per-capita and
            # per-km² expectations. Either rate alone already distributes the
            # national total, so summing both would double-count; the halves
            # keep the nationwide sum equal to the national total.
            rate = totals[target]
            block["simple_rate"] = round(
                0.5 * (rate["per_inhabitant"] or 0) * population
                + 0.5 * (rate["per_km2"] or 0) * area, 2
            )
            entry["model"][target] = block

    payload["models"] = models
    payload["model_meta"] = {
        "targets": {t: TARGET_LABELS[t] for t in TARGETS},
        "feature_sets": {k: FEATURE_SET_LABELS[k] for k in FEATURE_SETS},
        "training_filters": {
            "min_population": MIN_POPULATION,
            "min_area_km2": MIN_AREA_KM2,
        },
        "cv": {
            "folds": CV_FOLDS,
            "seed": CV_SEED,
            "note": (
                "R² op de trainingsset kan niet dalen als je een feature "
                "toevoegt. Vergelijk feature-sets daarom op r2_cv_mean, niet "
                "op r2."
            ),
        },
        "nationwide_rates": totals,
    }
    payload["stats"] = stats

    STATS_PATH.write_text(json.dumps(payload, separators=(",", ":"), allow_nan=False))
    print(f"✓ voorspellingen + modelmetadata → {STATS_PATH} "
          f"({STATS_PATH.stat().st_size / 1024:.0f} KB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
