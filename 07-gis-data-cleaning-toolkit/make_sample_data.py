#!/usr/bin/env python3
"""
make_sample_data.py - creates a deliberately messy field-survey CSV for testing gis_clean.py.

Everything is synthetic (random points inside Sri Lanka's district polygons, invented village
names). Known errors are injected so the cleaning results can be checked against
data/sample_expected.json.

Usage: python make_sample_data.py
"""
import csv
import json
import math
import random
from pathlib import Path

HERE = Path(__file__).resolve().parent
random.seed(42)

CATEGORIES = {
    "School": ["Scool", "school ", "SCHOOL", "Schol"],
    "Health Post": ["health post", "Helth Post", "HEALTH POST", "Hlth Post"],
    "Water Point": ["water point", "Water Pt", "WATER POINT", "Watter Point"],
    "Community Hall": ["community hall", "Comunity Hall", "COMMUNITY HALL", "Comm. Hall"],
    "Place of Worship": ["place of worship", "Place of Worhsip", "PLACE OF WORSHIP", "Worship Place"],
}
VILLAGES = ["Halpe", "Madiha", "Weli", "Ambalam", "Kotuwa", "Gal Oya", "Pitiya", "Nuga", "Bogaha",
            "Mahawela", "Ihala", "Palle", "Kele", "Diya", "Wewa", "Mawatha", "Godagama", "Ratmal",
            "Uduwela", "Thotupola", "Kanda", "Pahala", "Medagama", "Siyambala"]
SUFFIX = {"School": "Vidyalaya", "Health Post": "Health Post", "Water Point": "Tube Well",
          "Community Hall": "Community Hall", "Place of Worship": "Temple"}


def ring_contains(ring, x, y):
    inside = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i]
        xj, yj = ring[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


def polys(geom):
    return [geom["coordinates"]] if geom["type"] == "Polygon" else geom["coordinates"]


def random_point(feature):
    best = max(polys(feature["geometry"]), key=lambda p: len(p[0]))
    xs = [c[0] for c in best[0]]
    ys = [c[1] for c in best[0]]
    for _ in range(2000):
        x = random.uniform(min(xs), max(xs))
        y = random.uniform(min(ys), max(ys))
        if ring_contains(best[0], x, y) and not any(ring_contains(h, x, y) for h in best[1:]):
            return y, x
    raise RuntimeError("no point found")


def to_dms(value, pos, neg):
    hemi = pos if value >= 0 else neg
    v = abs(value)
    d = int(v)
    m = int((v - d) * 60)
    s = round((v - d - m / 60) * 3600, 1)
    style = random.choice(["sym", "space", "letters"])
    if style == "sym":
        return f"{d}°{m}'{s}\"{hemi}"
    if style == "space":
        return f"{d} {m} {s} {hemi}"
    return f"{d}d{m}m{s}s{hemi}"


def jitter(lat, lon, metres):
    dlat = random.uniform(-metres, metres) / 111320
    dlon = random.uniform(-metres, metres) / (111320 * math.cos(math.radians(lat)))
    return lat + dlat, lon + dlon


def fmt_date(i):
    y, m, d = 2025, random.randint(1, 12), random.randint(1, 28)
    style = random.choices(["iso", "dmy", "mon"], weights=[5, 3, 2])[0]
    months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
    if style == "iso":
        return f"{y}-{m:02d}-{d:02d}"
    if style == "dmy":
        return f"{d:02d}/{m:02d}/{y}"
    return f"{d}-{months[m - 1]}-{y}"


def main():
    gj = json.load(open(HERE / "data" / "lk_districts.geojson", encoding="utf-8"))
    feats = gj["features"]
    n = 260
    records = []
    for i in range(n):
        f = feats[i % len(feats)]
        lat, lon = random_point(f)
        cat = random.choice(list(CATEGORIES))
        name = f"{random.choice(VILLAGES)} {random.choice(VILLAGES)} {SUFFIX[cat]}"
        records.append({"id": f"S{i + 1:04d}", "name": name, "cat_true": cat, "lat": lat, "lon": lon,
                        "district_true": f["properties"]["district"]})

    idx = list(range(n))
    random.shuffle(idx)
    take = lambda k: [idx.pop() for _ in range(k)]
    dms_i, swap_i, comma_i = take(22), take(14), take(12)
    missing_i, outside_i = take(9), take(7)
    dup_src = random.sample([i for i in range(n) if i not in set(missing_i) | set(outside_i)], 16)

    rows = []
    for i, r in enumerate(records):
        lat, lon = f"{r['lat']:.6f}", f"{r['lon']:.6f}"
        if i in dms_i:
            lat, lon = to_dms(r["lat"], "N", "S"), to_dms(r["lon"], "E", "W")
        elif i in swap_i:
            lat, lon = lon, lat
        elif i in comma_i:
            lat, lon = lat.replace(".", ","), lon.replace(".", ",")
        elif i in missing_i:
            lat, lon = ("", "") if i % 2 else ("N/A", "N/A")
        elif i in outside_i:
            lat, lon = (f"{r['lat'] * 10:.6f}", lon) if i % 2 else ("0", "0")
        cat = r["cat_true"]
        if random.random() < 0.3:
            cat = random.choice(CATEGORIES[cat])
        rows.append({"record_id": r["id"], "site_name": r["name"], "category": cat, "lat": lat, "lon": lon,
                     "surveyed_on": fmt_date(i), "notes": random.choice(["", "", "checked", "needs revisit", ""])})

    for k, src in enumerate(dup_src):
        r = records[src]
        la, lo = jitter(r["lat"], r["lon"], 15)
        name = r["name"].upper() if k % 2 else r["name"] + " "
        rows.append({"record_id": f"S{n + k + 1:04d}", "site_name": name, "category": r["cat_true"],
                     "lat": f"{la:.6f}", "lon": f"{lo:.6f}", "surveyed_on": fmt_date(k), "notes": "duplicate entry"})

    out = HERE / "data" / "field_survey_raw.csv"
    with open(out, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0]))
        w.writeheader()
        w.writerows(rows)

    cat_fixes = sum(1 for r, rec in zip(rows, records) if r["category"] != rec["cat_true"]
                    and records.index(rec) not in set(missing_i) | set(outside_i))
    expected = {
        "input_rows": len(rows),
        "rejected_missing_coordinates": len(missing_i),
        "rejected_outside_sri_lanka": len(outside_i),
        "rejected_duplicates": len(dup_src),
        "kept_rows": len(rows) - len(missing_i) - len(outside_i) - len(dup_src),
        "dms_converted": len(dms_i),
        "swapped_lat_lon": len(swap_i),
        "decimal_comma": len(comma_i),
        "category_standardised_at_least": cat_fixes,
    }
    json.dump(expected, open(HERE / "data" / "sample_expected.json", "w"), indent=2)
    print("Wrote", out, len(rows), "rows")
    print(json.dumps(expected, indent=2))


if __name__ == "__main__":
    main()
