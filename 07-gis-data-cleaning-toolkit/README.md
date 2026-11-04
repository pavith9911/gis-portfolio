# GIS Data-Cleaning Toolkit

A Python script that takes a messy point dataset (field survey, asset register, customer list) and returns a clean, validated GIS layer plus a one-page data-quality report. Standard library only, no installation.

## What it fixes

| Problem in the raw file | What the script does |
|---|---|
| Coordinates as degrees-minutes-seconds (`6°55'30"N`, `79 51 12 E`, `6d55m30sN`) | converts to decimal degrees |
| Decimal commas (`6,9271`) and N/S/E/W suffixes | normalised |
| Latitude and longitude swapped | detected with the Sri Lanka bounding box and swapped back |
| Blank, `N/A`, `0,0`, typo'd coordinates (`69.27`) | rejected with a reason |
| Category misspellings (`Scool`, `Hlth Post`, `HEALTH POST`) | standardised to a controlled list |
| Mixed date formats (`15/12/2025`, `8-Apr-2025`) | ISO 8601 |
| Same site entered twice | duplicates (same name + category within 50 m) removed, first record kept |
| No district on the record | assigned by point-in-polygon against district boundaries |

Every single change is written to `changes_log.csv`, and every rejected row is kept in `rejected.csv` with its reason, so nothing disappears silently.

## Run it

```
python make_sample_data.py          # optional: regenerate the synthetic messy sample
python gis_clean.py data/field_survey_raw.csv
```

Outputs go to `output/`: `cleaned.csv`, `cleaned.geojson`, `rejected.csv`, `changes_log.csv`, `report.html`.

For your own file, tell the script the column names:

```
python gis_clean.py my_points.csv --id-col id --name-col site --category-col type \
       --lat-col latitude --lon-col longitude --date-col date --dup-metres 30
```

## Check against the known errors

The sample file is synthetic (random points in the district polygons, invented village names). `make_sample_data.py` injects a known number of each error and writes them to `data/sample_expected.json`, so the results can be verified:

| | Injected | Found |
|---|---|---|
| DMS coordinates | 22 | 22 |
| Swapped lat/lon | 14 | 14 |
| Decimal commas | 12 | 12 |
| Missing coordinates | 9 | 9 |
| Outside Sri Lanka | 7 | 7 |
| Duplicates | 16 | 16 |
| Rows kept | 244 | 244 |

## Adapting it

- Bounding box and district file are at the top of `gis_clean.py` and in `data/lk_districts.geojson` (simplified geoBoundaries ADM2, CC BY 4.0). Swap in another country's polygons and box to reuse the tool.
- The controlled category list is `CANONICAL` / `ALIASES` in `gis_clean.py`.
