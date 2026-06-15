#!/usr/bin/env python3
"""
refresh_data.py — Energy Dashboard data pipeline.

Downloads Ember's "Yearly Electricity Data" (long format CSV) and transforms it
into the compact `public/energy.json` the dashboard reads.

Source : Ember — Yearly Electricity Data (CC BY 4.0)
         https://ember-energy.org/data/yearly-electricity-data/
Download: https://storage.googleapis.com/emb-prod-bkt-publicdata/public-downloads/yearly_full_release_long_format.csv

Run monthly via the scheduled task (see README). Designed to be robust:
  * If the download fails, it falls back to the cached raw CSV and keeps the
    previous energy.json rather than crashing.
  * `--skip-download` reuses the cached CSV (used for fast local rebuilds).

Usage:
  python scripts/refresh_data.py                # download + rebuild
  python scripts/refresh_data.py --skip-download # rebuild from cached CSV
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import json
import sys
import urllib.request
from collections import defaultdict
from pathlib import Path

# --------------------------------------------------------------------------- #
# Paths & constants
# --------------------------------------------------------------------------- #
ROOT = Path(__file__).resolve().parent.parent
RAW_CSV = ROOT / "data" / "raw" / "ember_yearly.csv"
COUNTRY_META = ROOT / "data" / "raw" / "mledoze_countries.json"
OUT_JSON = ROOT / "public" / "energy.json"
LOG_FILE = ROOT / "data" / "refresh.log"

SOURCE_URL = (
    "https://storage.googleapis.com/emb-prod-bkt-publicdata/"
    "public-downloads/yearly_full_release_long_format.csv"
)

# Ember "Variable" (fuel) name  ->  our canonical fuel id.
# These are the Subcategory == "Fuel" rows (the 9 mutually-exclusive fuels
# that sum to total capacity / generation).
EMBER_FUEL_MAP = {
    "Solar": "solar",
    "Wind": "wind",
    "Hydro": "hydro",
    "Bioenergy": "bioenergy",
    "Other Renewables": "other_renewables",
    "Coal": "coal",
    "Gas": "gas",
    "Other Fossil": "other_fossil",
    "Nuclear": "nuclear",
    # "Fusion" is not in the dataset today. If Ember ever publishes a
    # Subcategory=="Fuel" / Variable=="Fusion" row, add it here and it flows
    # through the whole pipeline + UI automatically.
    "Fusion": "fusion",
}

# Canonical fuel metadata for the dashboard. `order` controls stack order
# (renewables grouped at the bottom, then nuclear, then fossil, fusion last).
FUELS = [
    {"id": "solar",            "label": "Solar",                 "group": "renewable", "color": "#f59e0b", "order": 1},
    {"id": "wind",             "label": "Wind",                  "group": "renewable", "color": "#06b6d4", "order": 2},
    {"id": "hydro",            "label": "Hydro",                 "group": "renewable", "color": "#3b82f6", "order": 3},
    {"id": "bioenergy",        "label": "Bioenergy",             "group": "renewable", "color": "#65a30d", "order": 4},
    {"id": "other_renewables", "label": "Other renewables",      "group": "renewable", "color": "#14b8a6", "order": 5},
    {"id": "nuclear",          "label": "Nuclear",               "group": "nuclear",   "color": "#a855f7", "order": 6},
    {"id": "gas",              "label": "Gas",                   "group": "fossil",    "color": "#f97316", "order": 7},
    {"id": "coal",             "label": "Coal",                  "group": "fossil",    "color": "#64748b", "order": 8},
    {"id": "other_fossil",     "label": "Other fossil (incl. oil)", "group": "fossil", "color": "#92400e", "order": 9},
    {"id": "fusion",           "label": "Fusion",                "group": "fusion",    "color": "#ec4899", "order": 10},
]

GROUPS = [
    {"id": "renewable", "label": "Renewables",  "color": "#10b981"},
    {"id": "nuclear",   "label": "Nuclear",     "color": "#a855f7"},
    {"id": "fossil",    "label": "Fossil fuels", "color": "#6b7280"},
    {"id": "fusion",    "label": "Fusion",      "color": "#ec4899"},
]

FUEL_IDS = [f["id"] for f in FUELS]


def log(msg: str) -> None:
    stamp = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
    line = f"[{stamp}] {msg}"
    print(line)
    try:
        LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
        with open(LOG_FILE, "a", encoding="utf-8") as fh:
            fh.write(line + "\n")
    except OSError:
        pass


# --------------------------------------------------------------------------- #
# Download
# --------------------------------------------------------------------------- #
def download_csv() -> bool:
    """Download the Ember CSV to RAW_CSV. Returns True on success.

    Downloads to a temp file first, then atomically replaces RAW_CSV, so a
    failed/partial download never clobbers the last-known-good cache.
    """
    RAW_CSV.parent.mkdir(parents=True, exist_ok=True)
    tmp = RAW_CSV.with_suffix(".csv.tmp")
    try:
        log(f"Downloading {SOURCE_URL}")
        req = urllib.request.Request(SOURCE_URL, headers={"User-Agent": "energy-dashboard/1.0"})
        with urllib.request.urlopen(req, timeout=300) as resp, open(tmp, "wb") as out:
            total = 0
            while True:
                chunk = resp.read(1 << 20)  # 1 MB
                if not chunk:
                    break
                out.write(chunk)
                total += len(chunk)
        # Sanity check: a real CSV is many MB and starts with the header.
        if total < 1_000_000:
            raise ValueError(f"download too small ({total} bytes) — likely an error page")
        with open(tmp, "r", encoding="utf-8-sig") as fh:
            first = fh.readline()
        if "Area" not in first or "Variable" not in first:
            raise ValueError("downloaded file does not look like the Ember CSV")
        tmp.replace(RAW_CSV)
        log(f"Downloaded {total / 1_048_576:.1f} MB -> {RAW_CSV}")
        return True
    except Exception as exc:  # noqa: BLE001 — pipeline must degrade gracefully
        log(f"WARNING: download failed ({exc}). Falling back to cached CSV.")
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass
        return False


# --------------------------------------------------------------------------- #
# Transform
# --------------------------------------------------------------------------- #
def _to_float(s: str):
    if s is None or s == "":
        return None
    try:
        return float(s)
    except ValueError:
        return None


def load_country_meta() -> dict:
    """ISO3 -> {name, iso2, ccn3, flag, region} from the bundled mledoze list.

    Country codes are static, so this file is bundled (not re-downloaded
    monthly). If it's missing we degrade gracefully: countries keep their
    Ember names and simply get no flag / map join.
    """
    if not COUNTRY_META.exists():
        log(f"NOTE: {COUNTRY_META.name} not found — skipping flag/name enrichment.")
        return {}
    meta = {}
    try:
        with open(COUNTRY_META, encoding="utf-8") as fh:
            for rec in json.load(fh):
                iso3 = rec.get("cca3")
                if not iso3:
                    continue
                meta[iso3] = {
                    "name": (rec.get("name") or {}).get("common") or iso3,
                    "iso2": rec.get("cca2") or None,
                    "ccn3": rec.get("ccn3") or None,  # numeric id for map join
                    "flag": rec.get("flag") or None,
                    "region": rec.get("region") or None,
                    "subregion": rec.get("subregion") or None,
                }
    except (OSError, ValueError) as exc:
        log(f"NOTE: could not parse {COUNTRY_META.name} ({exc}) — skipping enrichment.")
        return {}
    log(f"Loaded enrichment metadata for {len(meta)} countries.")
    return meta


def _clean_ember_name(name: str) -> str:
    """Tidy Ember's official names for areas with no ISO match."""
    return name.replace(" (the)", "").strip()


def build():
    if not RAW_CSV.exists():
        log(f"ERROR: no raw CSV at {RAW_CSV} and download unavailable. Aborting.")
        return False

    # Per area, per metric ("Capacity"/"Electricity generation"), per year:
    #   fuels[fuel_id] = value (GW or TWh)
    # We only consume Subcategory == "Fuel" rows (the mutually-exclusive set).
    # Aggregate ("Clean"/"Fossil") rows are kept separately for a sanity check.
    METRIC_CAP = "Capacity"
    METRIC_GEN = "Electricity generation"

    # data[area][metric][year][fuel_id] = value
    data: dict = defaultdict(lambda: {METRIC_CAP: defaultdict(dict), METRIC_GEN: defaultdict(dict)})
    # aggregate check: aggcheck[area][metric][year] = {"Clean":x, "Fossil":y}
    aggcheck: dict = defaultdict(lambda: {METRIC_CAP: defaultdict(dict), METRIC_GEN: defaultdict(dict)})
    meta_by_area: dict = {}

    log(f"Parsing {RAW_CSV}")
    rows_used = 0
    with open(RAW_CSV, newline="", encoding="utf-8-sig") as fh:
        reader = csv.DictReader(fh)
        for row in reader:
            cat = row["Category"]
            if cat not in (METRIC_CAP, METRIC_GEN):
                continue
            area = row["Area"]
            try:
                year = int(row["Year"])
            except (ValueError, KeyError):
                continue
            sub = row["Subcategory"]
            var = row["Variable"]
            val = _to_float(row["Value"])
            if val is None:
                continue

            # Stash area-level metadata once.
            if area not in meta_by_area:
                meta_by_area[area] = {
                    "iso3": row.get("ISO 3 code", "") or None,
                    "area_type": row.get("Area type", ""),
                    "continent": row.get("Continent") or None,
                    "ember_region": row.get("Ember region") or None,
                    "eu": row.get("EU") == "1.0",
                    "oecd": row.get("OECD") == "1.0",
                    "g20": row.get("G20") == "1.0",
                    "g7": row.get("G7") == "1.0",
                    "asean": row.get("ASEAN") == "1.0",
                }

            if sub == "Fuel" and var in EMBER_FUEL_MAP:
                data[area][cat][year][EMBER_FUEL_MAP[var]] = val
                rows_used += 1
            elif sub == "Aggregate fuel" and var in ("Clean", "Fossil"):
                aggcheck[area][cat][year][var] = val

    log(f"Used {rows_used:,} fuel-level rows across {len(data)} areas")

    def snapshot(area: str, metric: str):
        """Return the latest-year snapshot for an area+metric, or None."""
        years = data[area][metric]
        if not years:
            return None
        year = max(years.keys())
        fuels_raw = years[year]
        # Fill every canonical fuel (missing => 0.0); fusion is ~always 0 today.
        fuels = {fid: round(float(fuels_raw.get(fid, 0.0)), 4) for fid in FUEL_IDS}
        total = round(sum(v for v in fuels.values() if v and v > 0), 4)
        out = {"year": year, "total": total, "fuels": fuels}
        # Sanity check vs Ember's own Clean+Fossil aggregate.
        agg = aggcheck[area][metric].get(year, {})
        if "Clean" in agg and "Fossil" in agg:
            agg_total = agg["Clean"] + agg["Fossil"]
            if agg_total > 0 and abs(agg_total - total) / agg_total > 0.02:
                log(f"  note: {area} {metric} {year} sum({total}) vs agg({agg_total:.2f}) differ >2%")
        return out

    def trend(area: str, metric: str):
        years = sorted(data[area][metric].keys())
        out = []
        for y in years:
            fr = data[area][metric][y]
            out.append(round(sum(v for v in fr.values() if v and v > 0), 3))
        return years, out

    # ---- Build per-country records ---------------------------------------- #
    cmeta = load_country_meta()
    countries = []
    unmatched = []
    for area, m in meta_by_area.items():
        if m["area_type"] != "Country or economy":
            continue
        cap = snapshot(area, METRIC_CAP)
        gen = snapshot(area, METRIC_GEN)
        if cap is None and gen is None:
            continue  # no usable energy data at all
        cap_years, cap_series = trend(area, METRIC_CAP)
        gen_years, gen_series = trend(area, METRIC_GEN)
        # Union of years for a single trend axis.
        all_years = sorted(set(cap_years) | set(gen_years))
        cap_map = dict(zip(cap_years, cap_series))
        gen_map = dict(zip(gen_years, gen_series))

        info = cmeta.get(m["iso3"] or "", {})
        if not info:
            unmatched.append(area)
        countries.append({
            "iso3": m["iso3"],
            "name": info.get("name") or _clean_ember_name(area),
            "name_ember": area,
            "iso2": info.get("iso2"),
            "ccn3": info.get("ccn3"),       # numeric ISO code -> world map feature id
            "flag": info.get("flag"),
            "continent": m["continent"],
            "region": info.get("region") or m["continent"],
            "subregion": info.get("subregion"),
            "eu": m["eu"], "oecd": m["oecd"], "g20": m["g20"], "g7": m["g7"], "asean": m["asean"],
            "capacity": cap,
            "generation": gen,
            "trend": {
                "years": all_years,
                "capacity": [cap_map.get(y) for y in all_years],
                "generation": [gen_map.get(y) for y in all_years],
            },
        })
    if unmatched:
        log(f"NOTE: {len(unmatched)} areas had no ISO-3166 match "
            f"(no flag/map): {', '.join(sorted(unmatched)[:15])}"
            + (" …" if len(unmatched) > 15 else ""))

    # ---- World aggregate (sum of country snapshots) ----------------------- #
    def world_totals(metric_key: str):
        total = 0.0
        fuels = {fid: 0.0 for fid in FUEL_IDS}
        latest = None
        for c in countries:
            snap = c[metric_key]
            if not snap:
                continue
            total += snap["total"]
            latest = snap["year"] if latest is None else max(latest, snap["year"])
            for fid, v in snap["fuels"].items():
                if v and v > 0:
                    fuels[fid] += v
        return {
            "year": latest,
            "total": round(total, 2),
            "fuels": {k: round(v, 2) for k, v in fuels.items()},
        }

    world_cap = world_totals("capacity")
    world_gen = world_totals("generation")

    # ---- Ranks + world share ---------------------------------------------- #
    def annotate(metric_key: str, world_total: float):
        ranked = sorted(
            (c for c in countries if c[metric_key]),
            key=lambda c: c[metric_key]["total"],
            reverse=True,
        )
        for i, c in enumerate(ranked, start=1):
            c[metric_key]["rank"] = i
            c[metric_key]["world_share"] = (
                round(c[metric_key]["total"] / world_total, 5) if world_total else None
            )
            # Dominant fuel + group for quick labels / map coloring.
            fuels = c[metric_key]["fuels"]
            dom_fuel = max(fuels, key=lambda k: fuels[k]) if c[metric_key]["total"] else None
            group_tot = defaultdict(float)
            for f in FUELS:
                group_tot[f["group"]] += max(fuels.get(f["id"], 0.0), 0.0)
            dom_group = max(group_tot, key=lambda k: group_tot[k]) if group_tot else None
            c[metric_key]["dominant_fuel"] = dom_fuel if (dom_fuel and fuels[dom_fuel] > 0) else None
            c[metric_key]["dominant_group"] = dom_group if (dom_group and group_tot[dom_group] > 0) else None

    annotate("capacity", world_cap["total"])
    annotate("generation", world_gen["total"])

    # ---- Data-quality scan: implausible capacity factors ------------------ #
    # CF = generation(TWh) / (capacity(GW) * 8.76).  A fuel generating more than
    # its stated capacity can physically produce (CF > 1) almost always means the
    # source's reported *capacity* lags its *generation* — typical for fast-growing
    # distributed solar (e.g. Pakistan, DR Congo). We do NOT alter the numbers
    # (that would be fabricating data); we flag material cases transparently so the
    # UI can show a caveat. Only flag fuels that are a meaningful share (>=3%) of
    # the country's generation, to avoid noise on trivial lines.
    HOURS_TWH = 8.76  # 1 GW running 8760 h = 8.76 TWh
    cf_anomaly_count = 0
    for c in countries:
        cap, gen = c["capacity"], c["generation"]
        if not cap or not gen or not gen["total"]:
            continue
        flags = []
        for fid in FUEL_IDS:
            cg = cap["fuels"].get(fid, 0.0)
            gg = gen["fuels"].get(fid, 0.0)
            if cg > 0 and gg > 0 and gg / gen["total"] >= 0.03:
                cf = gg / (cg * HOURS_TWH)
                if cf > 1.05:  # physically impossible
                    flags.append({"fuel": fid, "capacity_gw": round(cg, 3),
                                  "generation_twh": round(gg, 3), "cf": round(cf, 2)})
        if flags:
            c["cf_flags"] = flags
            cf_anomaly_count += len(flags)
            names = ", ".join(f["fuel"] for f in flags)
            log(f"  data-quality: {c['name']} reports more {names} generation than its "
                f"stated capacity can produce (capacity likely lags generation in source)")
    if cf_anomaly_count:
        log(f"Flagged {cf_anomaly_count} implausible capacity factor(s) across countries.")

    # Default sort for the UI: by capacity total desc, countries w/o capacity last.
    countries.sort(
        key=lambda c: (c["capacity"]["total"] if c["capacity"] else -1),
        reverse=True,
    )

    _metric_years = [y for y in (world_cap["year"], world_gen["year"]) if y]
    data_latest_year = max(_metric_years) if _metric_years else None

    payload = {
        "meta": {
            "source": "Ember — Yearly Electricity Data",
            "source_url": "https://ember-energy.org/data/yearly-electricity-data/",
            "download_url": SOURCE_URL,
            "license": "CC BY 4.0",
            "generated_utc": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
            "data_latest_year": data_latest_year,
            "country_count": len(countries),
            "fuels": FUELS,
            "groups": GROUPS,
            "world": {"capacity": world_cap, "generation": world_gen},
            "data_quality": {
                "capacity_factor_anomalies": cf_anomaly_count,
                "note": ("Fuels flagged in country.cf_flags report more generation than "
                         "their stated capacity can physically produce — an upstream "
                         "capacity-reporting lag (usually fast-growing solar). Values are "
                         "shown exactly as Ember published them, not altered."),
            },
            "notes": (
                "Capacity = installed generating capacity (GW). Generation = "
                "actual electricity generated (TWh/yr). 'Other fossil' includes "
                "oil. Each country uses its latest available year, which may "
                "differ between metrics and between countries. Fusion is reserved "
                "and reads 0 until grid-scale data is published."
            ),
        },
        "countries": countries,
    }

    OUT_JSON.parent.mkdir(parents=True, exist_ok=True)
    tmp = OUT_JSON.with_suffix(".json.tmp")
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, separators=(",", ":"))
    tmp.replace(OUT_JSON)
    size_kb = OUT_JSON.stat().st_size / 1024
    log(f"Wrote {OUT_JSON} ({size_kb:.0f} KB, {len(countries)} countries)")
    log(f"World capacity {world_cap['total']:.0f} GW ({world_cap['year']}), "
        f"generation {world_gen['total']:.0f} TWh ({world_gen['year']})")
    return True


def main():
    ap = argparse.ArgumentParser(description="Refresh energy dashboard data from Ember.")
    ap.add_argument("--skip-download", action="store_true",
                    help="Reuse the cached raw CSV instead of downloading.")
    args = ap.parse_args()

    log("=== refresh_data start ===")
    if not args.skip_download:
        download_csv()  # failure falls back to cache; build() handles missing file
    else:
        log("Skipping download (using cached CSV).")

    ok = build()
    log(f"=== refresh_data {'done' if ok else 'FAILED'} ===")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
