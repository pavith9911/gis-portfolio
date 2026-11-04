# Live Earthquake Dashboard

A dark, live dashboard of USGS earthquakes: KPIs, depth-coloured map markers, event feed, magnitude histogram and activity timeline, plus a Sri Lanka region view.

## Run it

Open `index.html` in a browser (or host the folder on GitHub Pages). No build step. Needs internet for the Leaflet CDN and map tiles.

## Built with

Leaflet 1.9.4, USGS GeoJSON feed refreshed every 60 s, canvas charts.

## Data

Live USGS feed. If the feed cannot be reached the page falls back to an embedded sample and says so in the footer.

## Notes

Data: USGS Earthquake Hazards Program (public domain).
