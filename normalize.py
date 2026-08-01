"""
The canonical inleverpunt record, and the vocabulary every source maps onto.

Each fetcher in scripts/ pulls its own shape from its own API and emits records
in the format `make_record` produces. Everything downstream — the geo pipeline,
the GeoJSON output, the webapp types — speaks only this vocabulary.
"""

from __future__ import annotations

import re
from typing import Any, Iterable

# --------------------------------------------------------------------------
# Vocabulary
# --------------------------------------------------------------------------

# Brands. Keep these in sync with Merk in webapp/types/inleverpunten.ts.
MERKEN = (
    "StatiegeldNederland",
    "StichtingOPEN",
    "Stibat",
    "Droppie",
    "StatieDrive",
)

MERK_LABELS = {
    "StatiegeldNederland": "Statiegeld Nederland",
    "StichtingOPEN": "Stichting OPEN / Wecycle",
    "Stibat": "Stibat / Lege Batterijen",
    "Droppie": "Droppie",
    "StatieDrive": "StatieDrive",
}

# What can you hand in here?
MATERIALEN = (
    "pet-groot",       # large PET bottles (statiegeld)
    "pet-klein",       # small PET bottles (statiegeld)
    "blik",            # cans (statiegeld)
    "glas",            # glass
    "krat",            # crates
    "batterijen",      # batteries
    "elektro-klein",   # small appliances
    "elektro-middel",  # medium appliances
    "elektro-groot",   # large appliances
    "lampen",          # energy-saving and LED lamps
    "tl-buizen",       # fluorescent tubes
    "armaturen",       # light fixtures
)

MATERIAAL_LABELS = {
    "pet-groot": "Grote PET-fles",
    "pet-klein": "Kleine PET-fles",
    "blik": "Blik",
    "glas": "Glas",
    "krat": "Krat",
    "batterijen": "Batterijen",
    "elektro-klein": "Kleine apparaten",
    "elektro-middel": "Middelgrote apparaten",
    "elektro-groot": "Grote apparaten",
    "lampen": "Spaar- & LED-lampen",
    "tl-buizen": "TL-buizen",
    "armaturen": "Armaturen",
}

# What kind of point is it?
PUNT_CATEGORIEEN = ("automaat", "balie", "inzamelbak", "milieustraat")

CATEGORIE_LABELS = {
    "automaat": "Inleverautomaat",
    "balie": "Balie / winkel",
    "inzamelbak": "Inzamelbak",
    "milieustraat": "Milieustraat",
}

# --------------------------------------------------------------------------
# Analysis subsets
# --------------------------------------------------------------------------
#
# The coverage, regression and network-planning layers all slice the point set
# the same way, along two independent axes. A point belongs to `alles`, to
# exactly one punttype, and to zero or more material streams — a supermarket
# machine that takes PET and cans is `statiegeld` only, a milieustraat is
# usually all three.
#
# Deliberately not crossed (no `statiegeld × automaat`): 36 combinations where
# most cells stay empty. Use the map filters for that.
#
# Keep in sync with SUBSETS in webapp/types/analyse.ts.

MATERIAAL_STROMEN = {
    "statiegeld": ("pet-groot", "pet-klein", "blik", "glas", "krat"),
    "batterijen": ("batterijen", "lampen", "tl-buizen", "armaturen"),
    "elektro": ("elektro-klein", "elektro-middel", "elektro-groot"),
}

SUBSETS = (
    "alles",
    # material-stream axis
    "statiegeld", "batterijen", "elektro",
    # facility-type axis
    "automaat", "balie", "inzamelbak", "milieustraat",
)

SUBSET_LABELS = {
    "alles": "Alle inleverpunten",
    "statiegeld": "Statiegeld",
    "batterijen": "Batterijen & lampen",
    "elektro": "Elektrische apparaten",
    "automaat": "Inleverautomaat",
    "balie": "Balie / winkel",
    "inzamelbak": "Inzamelbak",
    "milieustraat": "Milieustraat",
}

SUBSET_AXES = {
    "materiaal": ("alles", "statiegeld", "batterijen", "elektro"),
    "punttype": ("alles", "automaat", "balie", "inzamelbak", "milieustraat"),
}


def subsets_of(punt_type: str, materialen: Iterable[str]) -> list[str]:
    """Which analysis subsets does this point belong to?

    Always includes 'alles'. Adds the punttype when it is a known category, and
    every material stream the point serves at least one material of.
    """
    found = ["alles"]
    if punt_type in PUNT_CATEGORIEEN:
        found.append(punt_type)
    materials = set(materialen or ())
    for stream, members in MATERIAAL_STROMEN.items():
        if materials.intersection(members):
            found.append(stream)
    return found


# How do you get paid back?
UITBETALING_LABELS = {
    "bonnetje": "Bon",
    "donatie": "Donatie aan goed doel",
    "tikkie": "Tikkie",
    "droppie": "Droppie-app",
    "retourpinnen": "Retourpinnen",
    "contant": "Contant",
}

DAY_KEYS = ("ma", "di", "wo", "do", "vr", "za", "zo")


# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------

def clean(value: Any) -> str:
    """Collapse whitespace and coerce None to an empty string."""
    if value is None:
        return ""
    return re.sub(r"\s+", " ", str(value)).strip()


# Dutch particles that stay lowercase inside a place name ('Bergen op Zoom').
DUTCH_PARTICLES = {
    "aan", "aan't", "bij", "de", "den", "der", "het", "in", "op",
    "over", "te", "ten", "ter", "tot", "van", "'t", "'s",
}


def _capitalise_part(part: str, is_first: bool) -> str:
    """Capitalise one whitespace-delimited part, respecting hyphens and particles."""
    if not part:
        return part

    if not is_first and part.lower() in DUTCH_PARTICLES:
        return part.lower()

    # Handle hyphenated names ('Berkel-Enschot') and the leading Dutch
    # apostrophe ("'s-Hertogenbosch"), where each segment is capitalised.
    segments = part.split("-")
    rebuilt = []
    for segment in segments:
        if segment.lower().startswith("'") and len(segment) > 1:
            rebuilt.append("'" + segment[1].lower() + segment[2:].capitalize()
                           if len(segment) > 2 else segment.lower())
        else:
            rebuilt.append(segment.capitalize())
    return "-".join(rebuilt)


def title_case_city(value: Any) -> str:
    """Normalise SHOUTED or lowercased city names ('AMSTERDAM' -> 'Amsterdam').

    Mixed-case values are left alone: the source already made a deliberate
    choice there, and re-casing would mangle names like "'s-Hertogenbosch".
    """
    text = clean(value)
    if not text:
        return ""
    if not (text.isupper() or text.islower()):
        return text

    parts = text.split(" ")
    return " ".join(
        _capitalise_part(part, index == 0)
        for index, part in enumerate(parts)
    )


def clean_postcode(value: Any) -> str:
    """Normalise a Dutch postcode to '1234 AB'."""
    text = clean(value).upper().replace(" ", "")
    match = re.fullmatch(r"(\d{4})([A-Z]{2})", text)
    if match:
        return f"{match.group(1)} {match.group(2)}"
    return clean(value).upper()


def split_street(value: Any) -> tuple[str, str]:
    """Split a combined 'Kerkstraat 12A' into ('Kerkstraat', '12A')."""
    text = clean(value)
    if not text:
        return "", ""
    match = re.match(r"^(.*?)[\s,]+(\d+[\w\-/]*)$", text)
    if match:
        return match.group(1).strip(), match.group(2).strip()
    return text, ""


def split_postcode_city(value: Any) -> tuple[str, str]:
    """Split a combined '1066 TT Amsterdam' into ('1066 TT', 'Amsterdam')."""
    text = clean(value)
    match = re.match(r"^\s*(\d{4}\s*[A-Za-z]{2})\s+(.*)$", text)
    if match:
        return clean_postcode(match.group(1)), title_case_city(match.group(2))
    return "", title_case_city(text)


def yes(value: Any) -> bool:
    """Interpret the many ways these APIs spell 'true'."""
    if isinstance(value, bool):
        return value
    return clean(value).lower() in {"ja", "yes", "true", "1", "y"}


def normalise_hours(raw: dict[str, str] | str | None) -> dict[str, str] | str | None:
    """Return per-day opening hours, dropping the 'NA' placeholders sources use."""
    if raw is None:
        return None
    if isinstance(raw, str):
        return clean(raw) or None

    hours = {}
    for day in DAY_KEYS:
        value = clean(raw.get(day))
        if value and value.upper() not in {"NA", "N/A", "-", "GESLOTEN?"}:
            hours[day] = value

    return hours or None


def make_record(
    *,
    merk: str,
    bron_id: str,
    locatie_naam: str,
    latitude: float,
    longitude: float,
    punt_type: str,
    materialen: list[str],
    straat_naam: str = "",
    straat_nr: str = "",
    postcode: str = "",
    plaats: str = "",
    uitbetaling: list[str] | None = None,
    vrij_toegankelijk: bool = False,
    gemeente_beperking: list[str] | None = None,
    openingstijden: dict | str | None = None,
) -> dict[str, Any]:
    """Build one canonical inleverpunt record.

    Unknown materials and categories are dropped rather than passed through, so
    a source that starts emitting a new waste type cannot silently break the
    webapp's filter vocabulary — it shows up as a gap in the counts instead.
    """
    if merk not in MERKEN:
        raise ValueError(f"Unknown merk: {merk}")
    if punt_type not in PUNT_CATEGORIEEN:
        raise ValueError(f"Unknown punt_type: {punt_type}")

    known_materials = [m for m in dict.fromkeys(materialen) if m in MATERIALEN]

    return {
        "merk": merk,
        "bronId": str(bron_id),
        "locatieNaam": clean(locatie_naam) or "Inleverpunt",
        "straatNaam": clean(straat_naam),
        "straatNr": clean(straat_nr),
        "postcode": clean_postcode(postcode),
        "plaats": title_case_city(plaats),
        "latitude": round(float(latitude), 7),
        "longitude": round(float(longitude), 7),
        "puntType": punt_type,
        "materialen": known_materials,
        "uitbetaling": list(dict.fromkeys(uitbetaling or [])),
        "vrijToegankelijk": bool(vrij_toegankelijk),
        "gemeenteBeperking": list(dict.fromkeys(gemeente_beperking)) if gemeente_beperking else None,
        "openingstijden": openingstijden,
    }


def in_netherlands(latitude: float, longitude: float) -> bool:
    """Rough bounding-box test, used to drop obvious junk coordinates early."""
    return 50.5 <= latitude <= 53.8 and 3.2 <= longitude <= 7.3
