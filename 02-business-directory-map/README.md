# Business Directory Map

A searchable local-business map with a list/map split, category chips, price and open-now filters, clustering, Near me and an add-a-place form.

## Run it

Open `index.html` in a browser (or host the folder on GitHub Pages). No build step. Needs internet for the Leaflet CDN and map tiles.

## Built with

Leaflet 1.9.4, vanilla JS, custom pixel-grid clustering, localStorage.

## Data

74 **synthetic** businesses in Colombo, Kandy and Galle (fictional names). Replace `data/places.js` with a client's real list.

## Notes

Search ignores accents, 'in view' filter limits the list to the visible map, new places are saved in the browser and can be exported as JSON.
