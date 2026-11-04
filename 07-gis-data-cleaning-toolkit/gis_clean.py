#!/usr/bin/env python3
"""
gis_clean.py - cleans a messy point dataset (CSV) and produces QA outputs.

Steps (each fix is logged):
  1. Parse coordinates: decimals, decimal commas, degrees-minutes-seconds, N/S/E/W suffixes
  2. Validate against the Sri Lanka bounding box; repair swapped lat/lon
  3. Reject rows without usable coordinates or outside Sri Lanka
  4. Assign each point to a district (point-in-polygon)
  5. Standardise category spellings and normalise dates to ISO 8601
  6. Remove duplicates (same name + category within --dup-metres)

Outputs (in --out): cleaned.csv, cleaned.geojson, rejected.csv, changes_log.csv, report.html

Only the Python standard library is required.

Usage:
  python gis_clean.py data/field_survey_raw.csv
  python gis_clean.py my_points.csv --lat-col latitude --lon-col longitude --name-col site --out output
"""
import argparse
import csv
import difflib
import html
import json
import math
import re
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
BBOX = {"lat": (5.7, 10.0), "lon": (79.4, 82.1)}  # Sri Lanka incl. offshore islands
CANONICAL = ["School", "Health Post", "Water Point", "Community Hall", "Place of Worship"]
ALIASES = {"worshipplace": "Place of Worship", "commhall": "Community Hall", "hlthpost": "Health Post",
           "waterpt": "Water Point", "temple": "Place of Worship", "church": "Place of Worship",
           "mosque": "Place of Worship", "tubewell": "Water Point", "well": "Water Point"}
MISSING = {"", "n/a", "na", "null", "none", "-", "?", "unknown", "nan"}
DATE_FORMATS = ["%Y-%m-%d", "%d/%m/%Y", "%d-%m-%Y", "%d-%b-%Y", "%d %b %Y", "%Y/%m/%d"]


# ------------------------------------------------------------------ parsing

def parse_coord(raw):
    """Return (value, tag). tag is None, 'dms_converted', 'decimal_comma', 'suffix_removed' or 'missing'."""
    s = "" if raw is None else str(raw).strip()
    if s.lower() in MISSING:
        return None, "missing"
    hemi = re.search(r"[NSEWnsew]\s*$", s)
    nums = re.findall(r"\d+(?:[.,]\d+)?", s)
    if not nums:
        return None, "missing"
    is_dms = bool(re.search(r"[°'′\"″]", s)) or len(nums) >= 2 or bool(re.search(r"\d\s*[dD]\s*\d", s))
    tag = None
    try:
        if is_dms:
            parts = [float(n.replace(",", ".")) for n in nums[:3]] + [0.0, 0.0]
            value = parts[0] + parts[1] / 60 + parts[2] / 3600
            tag = "dms_converted"
        else:
            value = float(nums[0].replace(",", "."))
            if "," in nums[0]:
                tag = "decimal_comma"
    except ValueError:
        return None, "missing"
    if s.startswith("-"):
        value = -value
    if hemi:
        if hemi.group(0).strip().upper() in ("S", "W"):
            value = -abs(value)
        tag = tag or "suffix_removed"
    return value, tag


def in_bbox(lat, lon):
    return BBOX["lat"][0] <= lat <= BBOX["lat"][1] and BBOX["lon"][0] <= lon <= BBOX["lon"][1]


def haversine_m(lat1, lon1, lat2, lon2):
    r = 6371008.8
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def parse_date(raw):
    s = (raw or "").strip()
    for fmt in DATE_FORMATS:
        try:
            return datetime.strptime(s, fmt).date().isoformat()
        except ValueError:
            continue
    return None


def norm_key(s):
    return re.sub(r"[^a-z0-9]", "", (s or "").lower())


def standard_category(raw):
    key = norm_key(raw)
    if not key:
        return None
    lookup = {norm_key(c): c for c in CANONICAL}
    if key in ALIASES:
        return ALIASES[key]
    if key in lookup:
        return lookup[key]
    close = difflib.get_close_matches(key, lookup.keys(), n=1, cutoff=0.7)
    return lookup[close[0]] if close else None


# ----------------------------------------------------------------- geometry

def ring_contains(ring, x, y):
    inside, j = False, len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i]
        xj, yj = ring[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


class Districts:
    def __init__(self, path):
        gj = json.load(open(path, encoding="utf-8"))
        self.items = []
        for f in gj["features"]:
            g = f["geometry"]
            polys = [g["coordinates"]] if g["type"] == "Polygon" else g["coordinates"]
            for poly in polys:
                xs = [c[0] for c in poly[0]]
                ys = [c[1] for c in poly[0]]
                self.items.append((f["properties"]["district"], f["properties"].get("province", ""), poly,
                                   (min(xs), min(ys), max(xs), max(ys))))
        self.gj = gj

    def lookup(self, lat, lon):
        for name, prov, poly, (x0, y0, x1, y1) in self.items:
            if x0 <= lon <= x1 and y0 <= lat <= y1 and ring_contains(poly[0], lon, lat) \
                    and not any(ring_contains(h, lon, lat) for h in poly[1:]):
                return name, prov
        return None, None


# --------------------------------------------------------------------- main

def clean(rows, cols, districts, dup_metres):
    log, kept, rejected = [], [], []
    stats = Counter()

    def note(rid, field, before, after, rule):
        log.append({"record_id": rid, "field": field, "before": before, "after": after, "rule": rule})
        stats[rule] += 1

    for row in rows:
        rid = row.get(cols["id"], "") or f"row{len(kept) + len(rejected) + 1}"
        lat, lat_tag = parse_coord(row.get(cols["lat"]))
        lon, lon_tag = parse_coord(row.get(cols["lon"]))
        if lat is None or lon is None:
            rejected.append({**row, "reject_reason": "missing_or_unparseable_coordinates"})
            stats["rejected: missing coordinates"] += 1
            continue
        for field, tag, raw in (("lat", lat_tag, row[cols["lat"]]), ("lon", lon_tag, row[cols["lon"]])):
            if tag:
                note(rid, field, raw, round(lat if field == "lat" else lon, 6), tag)
        if not in_bbox(lat, lon):
            if in_bbox(lon, lat):
                note(rid, "lat/lon", f"{lat},{lon}", f"{lon},{lat}", "swapped_lat_lon")
                lat, lon = lon, lat
            else:
                rejected.append({**row, "reject_reason": "outside_sri_lanka"})
                stats["rejected: outside Sri Lanka"] += 1
                continue

        district, province = districts.lookup(lat, lon)
        if district is None:
            district, province = "(unmatched)", ""
            note(rid, "district", "", "(unmatched)", "no_district_match")

        raw_cat = row.get(cols["category"], "")
        cat = standard_category(raw_cat)
        if cat is None:
            cat = "Other"
            note(rid, "category", raw_cat, "Other", "category_unmapped")
        elif cat != raw_cat:
            note(rid, "category", raw_cat, cat, "category_standardised")

        raw_date = row.get(cols["date"], "") if cols["date"] else ""
        date = parse_date(raw_date) if raw_date else ""
        if raw_date and date is None:
            note(rid, "date", raw_date, "", "date_unparseable")
            date = ""
        elif date and date != raw_date:
            note(rid, "date", raw_date, date, "date_normalised")

        name_raw = row.get(cols["name"], "")
        name = re.sub(r"\s+", " ", name_raw).strip()
        if name != name_raw:
            note(rid, "name", name_raw, name, "name_whitespace_trimmed")

        kept.append({**row, cols["lat"]: round(lat, 6), cols["lon"]: round(lon, 6), cols["name"]: name,
                     cols["category"]: cat, **({cols["date"]: date} if cols["date"] else {}),
                     "district": district, "province": province, "_key": (norm_key(name), cat)})

    # duplicates: same name key + category and closer than dup_metres; the first record wins
    groups, final = defaultdict(list), []
    for r in kept:
        dup_of = None
        for other in groups[r["_key"]]:
            if haversine_m(r[cols["lat"]], r[cols["lon"]], other[cols["lat"]], other[cols["lon"]]) <= dup_metres:
                dup_of = other
                break
        if dup_of is None:
            groups[r["_key"]].append(r)
            final.append(r)
        else:
            rid = r.get(cols["id"], "")
            rejected.append({**{k: v for k, v in r.items() if k != "_key"},
                             "reject_reason": f"duplicate_of_{dup_of.get(cols['id'], '')}"})
            stats["rejected: duplicates"] += 1
            log.append({"record_id": rid, "field": "record", "before": "", "after": "",
                        "rule": "duplicate_removed"})
    for r in final:
        r.pop("_key", None)
    return final, rejected, log, stats


def write_csv(path, rows, fields=None):
    fields = fields or (list(rows[0]) if rows else [])
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore")
        w.writeheader()
        w.writerows(rows)


def write_geojson(path, rows, cols):
    feats = [{"type": "Feature",
              "properties": {k: v for k, v in r.items() if k not in (cols["lat"], cols["lon"])},
              "geometry": {"type": "Point", "coordinates": [r[cols["lon"]], r[cols["lat"]]]}} for r in rows]
    json.dump({"type": "FeatureCollection", "features": feats}, open(path, "w", encoding="utf-8"))


# ------------------------------------------------------------------- report

PALETTE = ["#1d4e89", "#c8553d", "#2a9d8f", "#b08900", "#7b4b94", "#555555"]


def svg_map(districts, kept, cols, w=380, h=560):
    lon0, lon1, lat0, lat1 = 79.6, 82.0, 5.85, 9.9
    k = math.cos(math.radians(7.8))
    s = min(w / ((lon1 - lon0) * k), h / (lat1 - lat0))

    def P(lon, lat):
        return (lon - lon0) * k * s, (lat1 - lat) * s

    paths = []
    for f in districts.gj["features"]:
        g = f["geometry"]
        polys = [g["coordinates"]] if g["type"] == "Polygon" else g["coordinates"]
        d = "".join("M" + "L".join("%.1f,%.1f" % P(*c) for c in ring) + "Z" for poly in polys for ring in poly)
        paths.append(f'<path d="{d}" fill="#f4f1ea" stroke="#b9b3a3" stroke-width=".7"/>')
    cats = sorted({r[cols["category"]] for r in kept})
    colour = {c: PALETTE[i % len(PALETTE)] for i, c in enumerate(cats)}
    dots = "".join('<circle cx="%.1f" cy="%.1f" r="2.4" fill="%s" fill-opacity=".85"/>'
                   % (*P(r[cols["lon"]], r[cols["lat"]]), colour[r[cols["category"]]]) for r in kept)
    legend = "".join(f'<span><i style="background:{colour[c]}"></i>{html.escape(c)}</span>' for c in cats)
    return (f'<svg viewBox="0 0 {w} {h}" width="{w}" height="{h}" role="img" '
            f'aria-label="Map of cleaned points">{"".join(paths)}{dots}</svg>'
            f'<div class="legend">{legend}</div>')


def build_report(path, n_in, final, rejected, stats, districts, cols, source_name, dup_metres):
    fixes = {k: v for k, v in stats.items() if not k.startswith("rejected")}
    rej = {k: v for k, v in stats.items() if k.startswith("rejected")}
    by_district = Counter(r["district"] for r in final)
    by_cat = Counter(r[cols["category"]] for r in final)
    maxfix = max(list(fixes.values()) + [1])

    def bars(d, mx):
        return "".join(f'<tr><td>{html.escape(k)}</td><td class="num">{v}</td>'
                       f'<td><b style="width:{v / mx * 100:.0f}%"></b></td></tr>'
                       for k, v in sorted(d.items(), key=lambda kv: -kv[1]))

    rej_rows = "".join(f'<tr><td>{html.escape(str(r.get(cols["id"], "")))}</td>'
                       f'<td>{html.escape(str(r.get(cols["name"], "")))}</td>'
                       f'<td>{html.escape(str(r.get(cols["lat"], "")))}, {html.escape(str(r.get(cols["lon"], "")))}</td>'
                       f'<td>{html.escape(r["reject_reason"])}</td></tr>' for r in rejected[:15])
    page = f"""<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Data quality report | {html.escape(source_name)}</title>
<style>
:root{{--ink:#1c1c1c;--muted:#6a6a62;--line:#d9d5c9;--paper:#fbfaf6;--acc:#1d4e89;--bad:#c8553d}}
*{{box-sizing:border-box}}body{{margin:0;background:#e9e6dc;color:var(--ink);font:15px/1.55 Georgia,'Times New Roman',serif}}
.sheet{{max-width:960px;margin:28px auto;background:var(--paper);padding:48px 56px;border:1px solid var(--line);box-shadow:0 2px 14px rgba(0,0,0,.08)}}
h1{{font-size:30px;margin:0 0 4px;letter-spacing:-.01em}}h2{{font-size:19px;margin:34px 0 8px;border-bottom:2px solid var(--ink);padding-bottom:4px}}
.meta{{color:var(--muted);font:13px ui-monospace,Consolas,monospace}}
.kpis{{display:grid;grid-template-columns:repeat(4,1fr);gap:0;border:1px solid var(--line);margin:22px 0}}
.kpis div{{padding:14px 16px;border-right:1px solid var(--line)}}.kpis div:last-child{{border:0}}
.kpis b{{display:block;font-size:30px;font-family:ui-monospace,Consolas,monospace}}.kpis span{{color:var(--muted);font-size:13px}}
table{{width:100%;border-collapse:collapse;font:13px ui-monospace,Consolas,monospace}}th,td{{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line)}}
th{{color:var(--muted);font-weight:600}}td.num{{text-align:right;width:56px}}td:last-child b{{display:block;height:9px;background:var(--acc)}}
.bad td:last-child b{{background:var(--bad)}}
.cols{{display:grid;grid-template-columns:1fr 400px;gap:30px;align-items:start}}
.legend{{display:flex;flex-wrap:wrap;gap:4px 14px;font:12px ui-monospace,Consolas,monospace;margin-top:6px}}
.legend i{{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:5px}}
svg{{background:#e3edf2;border:1px solid var(--line);max-width:100%;height:auto}}
p.note{{color:var(--muted);font-size:13px}}
@media(max-width:800px){{.sheet{{padding:24px 18px;margin:0}}.cols{{grid-template-columns:1fr}}.kpis{{grid-template-columns:1fr 1fr}}}}
@media print{{body{{background:#fff}}.sheet{{box-shadow:none;border:0;margin:0}}}}
</style></head><body><main class="sheet">
<h1>Data quality report</h1>
<div class="meta">source: {html.escape(source_name)} &middot; generated {datetime.now().strftime('%Y-%m-%d %H:%M')} &middot; duplicate radius {dup_metres:g} m</div>
<div class="kpis">
<div><b>{n_in}</b><span>rows received</span></div>
<div><b>{len(final)}</b><span>rows kept ({len(final) / max(n_in, 1) * 100:.0f}%)</span></div>
<div><b>{len(rejected)}</b><span>rows rejected</span></div>
<div><b>{sum(fixes.values())}</b><span>automatic fixes logged</span></div></div>
<h2>1. What was fixed</h2>
<table><tr><th>Rule</th><th>Count</th><th></th></tr>{bars(fixes, maxfix) or '<tr><td colspan=3>No fixes needed.</td></tr>'}</table>
<h2>2. What was rejected</h2>
<table class="bad"><tr><th>Reason</th><th>Count</th><th></th></tr>{bars({k.replace('rejected: ', ''): v for k, v in rej.items()}, max(list(rej.values()) + [1])) or '<tr><td colspan=3>Nothing rejected.</td></tr>'}</table>
<p class="note">Full list with reasons: <code>rejected.csv</code>. Every individual change: <code>changes_log.csv</code>. First rejected rows:</p>
<table><tr><th>ID</th><th>Name</th><th>Coordinates as received</th><th>Reason</th></tr>{rej_rows}</table>
<h2>3. Result</h2>
<div class="cols"><div>
<table><tr><th>District</th><th>Points</th><th></th></tr>{bars(by_district, max(by_district.values()) if by_district else 1)}</table>
<br><table><tr><th>Category</th><th>Points</th><th></th></tr>{bars(by_cat, max(by_cat.values()) if by_cat else 1)}</table>
</div><div>{svg_map(districts, final, cols)}</div></div>
<h2>Method</h2>
<p class="note">Coordinates are parsed from decimal, decimal-comma and degrees-minutes-seconds notation. Points outside the Sri Lanka bounding box are retried with latitude and longitude swapped; if they still fall outside they are rejected. Districts come from point-in-polygon tests against simplified geoBoundaries ADM2 polygons (CC BY 4.0); points that fall in a coastal sliver outside the simplified outline are kept and flagged <code>(unmatched)</code>. Categories are matched to a controlled list with fuzzy matching. Duplicates are records with the same normalised name and category within {dup_metres:g} m of an earlier record.</p>
</main></body></html>"""
    Path(path).write_text(page, encoding="utf-8")


def main():
    ap = argparse.ArgumentParser(description="Clean a messy point CSV and write QA outputs.")
    ap.add_argument("input", help="input CSV")
    ap.add_argument("--boundaries", default=str(HERE / "data" / "lk_districts.geojson"))
    ap.add_argument("--out", default=str(HERE / "output"))
    ap.add_argument("--id-col", default="record_id")
    ap.add_argument("--name-col", default="site_name")
    ap.add_argument("--category-col", default="category")
    ap.add_argument("--lat-col", default="lat")
    ap.add_argument("--lon-col", default="lon")
    ap.add_argument("--date-col", default="surveyed_on", help="set to '' if there is no date column")
    ap.add_argument("--dup-metres", type=float, default=50.0)
    a = ap.parse_args()
    cols = {"id": a.id_col, "name": a.name_col, "category": a.category_col,
            "lat": a.lat_col, "lon": a.lon_col, "date": a.date_col}

    with open(a.input, newline="", encoding="utf-8-sig") as f:
        rows = list(csv.DictReader(f))
    districts = Districts(a.boundaries)
    final, rejected, log, stats = clean(rows, cols, districts, a.dup_metres)

    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    write_csv(out / "cleaned.csv", final)
    write_geojson(out / "cleaned.geojson", final, cols)
    write_csv(out / "rejected.csv", rejected)
    write_csv(out / "changes_log.csv", log, ["record_id", "field", "before", "after", "rule"])
    build_report(out / "report.html", len(rows), final, rejected, stats, districts, cols,
                 Path(a.input).name, a.dup_metres)

    print(f"{len(rows)} rows in -> {len(final)} kept, {len(rejected)} rejected, {len(log)} changes logged")
    for k, v in sorted(stats.items()):
        print(f"  {k:32s} {v}")
    print("Report:", out / "report.html")


if __name__ == "__main__":
    main()
