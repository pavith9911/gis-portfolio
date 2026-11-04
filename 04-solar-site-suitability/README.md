# Solar Site Suitability

A weighted-overlay suitability model on a 48x48 grid: adjustable criteria weights, presets, exclusion constraints, ranked top-10 sites, cell breakdown and CSV export.

## Run it

Open `index.html` in a browser (or host the folder on GitHub Pages). No build step. Needs internet for the Leaflet CDN and map tiles.

## Built with

Leaflet 1.9.4, canvas rendering, reclassification functions, non-maximum suppression for site ranking.

## Data

**DEMO synthetic raster** generated in the browser from seeded noise (clearly labelled in the UI). For client work, swap in real GHI, SRTM slope, grid and road layers.

## Notes

Same method as ArcGIS/QGIS weighted overlay: reclassify each layer to 1-10, multiply by weight, sum.
