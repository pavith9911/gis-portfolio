/* SolarScope - weighted-overlay suitability workbench (Leaflet canvas, plain JS). Synthetic demo data. */
(function (root) {
  'use strict';

  var N = 48;                                   // grid is N x N cells
  var BOX = { west: 80.0, south: 8.0, east: 81.0, north: 9.0 };   // arbitrary demo extent
  var DX = (BOX.east - BOX.west) / N, DY = (BOX.north - BOX.south) / N;
  var KM_LAT = 111.32, KM_LON = 111.32 * Math.cos(8.5 * Math.PI / 180);
  var CELL_KM2 = DX * KM_LON * DY * KM_LAT;

  var CRITERIA = [
    { key: 'ghi',   label: 'Solar irradiation', unit: 'kWh/m²/day', dec: 2 },
    { key: 'slope', label: 'Terrain slope',     unit: '°',          dec: 1 },
    { key: 'grid',  label: 'Distance to grid',  unit: 'km',         dec: 1 },
    { key: 'road',  label: 'Distance to road',  unit: 'km',         dec: 1 }
  ];
  var PRESETS = {
    balanced: { ghi: 5, slope: 5, grid: 5, road: 3 },
    resource: { ghi: 10, slope: 4, grid: 3, road: 1 },
    grid:     { ghi: 3, slope: 4, grid: 10, road: 4 }
  };
  var CLASSES = [
    { name: 'Poor',      from: 0,  color: '#2b2d42' },
    { name: 'Fair',      from: 20, color: '#6d3b6f' },
    { name: 'Moderate',  from: 40, color: '#d1495b' },
    { name: 'Good',      from: 60, color: '#f5a524' },
    { name: 'Excellent', from: 72, color: '#ffe066' }
  ];

  /* ---------------- pure functions (unit-tested in Node) ---------------- */
  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      var t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  function makeNoise(seed, scale) {
    var rnd = mulberry32(seed), size = Math.ceil(N / scale) + 3, lat = [];
    for (var i = 0; i < size * size; i++) lat.push(rnd());
    function s(t) { return t * t * (3 - 2 * t); }
    return function (x, y) {
      var fx = x / scale, fy = y / scale, x0 = Math.floor(fx), y0 = Math.floor(fy);
      var tx = s(fx - x0), ty = s(fy - y0);
      var a = lat[y0 * size + x0], b = lat[y0 * size + x0 + 1], c = lat[(y0 + 1) * size + x0], d = lat[(y0 + 1) * size + x0 + 1];
      return (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
    };
  }
  function clamp01(v) { return Math.max(0, Math.min(1, v)); }
  var SCORE = {
    ghi:   function (v) { return clamp01((v - 4.8) / 0.6); },
    slope: function (v) { return clamp01(1 - (v - 2) / 8); },
    grid:  function (v) { return clamp01(1 - (v - 3) / 27); },
    road:  function (v) { return clamp01(1 - (v - 1) / 9); }
  };
  function weightedScore(values, w) {
    var sum = 0, tot = 0;
    CRITERIA.forEach(function (c) { sum += w[c.key] * SCORE[c.key](values[c.key]); tot += w[c.key]; });
    return tot > 0 ? 100 * sum / tot : 0;
  }
  function classOf(score) {
    var k = 0;
    for (var i = 0; i < CLASSES.length; i++) if (score >= CLASSES[i].from) k = i;
    return k;
  }
  function distToSegKm(lat, lng, a, b) {
    var px = (lng - a[1]) * KM_LON, py = (lat - a[0]) * KM_LAT;
    var vx = (b[1] - a[1]) * KM_LON, vy = (b[0] - a[0]) * KM_LAT;
    var len2 = vx * vx + vy * vy, t = len2 ? Math.max(0, Math.min(1, (px * vx + py * vy) / len2)) : 0;
    var dx = px - t * vx, dy = py - t * vy;
    return Math.sqrt(dx * dx + dy * dy);
  }
  function distToLinesKm(lat, lng, lines) {
    var best = Infinity;
    lines.forEach(function (l) {
      for (var i = 1; i < l.length; i++) best = Math.min(best, distToSegKm(lat, lng, l[i - 1], l[i]));
    });
    return best;
  }
  function pickSites(cells, n, minGap, minScore) {
    var order = cells.filter(function (c) { return !c.excl && c.score >= minScore; })
      .sort(function (a, b) { return b.score - a.score; });
    var chosen = [];
    for (var i = 0; i < order.length && chosen.length < n; i++) {
      var c = order[i];
      if (chosen.every(function (o) { return Math.max(Math.abs(o.i - c.i), Math.abs(o.j - c.j)) >= minGap; })) chosen.push(c);
    }
    return chosen;
  }

  /* synthetic landscape */
  var GRID_LINES = [[[8.12, 80.0], [8.45, 80.35], [8.55, 80.7], [8.9, 81.0]], [[8.95, 80.05], [8.7, 80.4], [8.6, 80.7]]];
  var ROAD_LINES = [[[8.0, 80.2], [8.4, 80.5], [8.5, 80.55], [8.97, 80.9]], [[8.3, 80.0], [8.5, 80.55], [8.4, 81.0]], [[8.7, 80.4], [8.62, 80.8], [8.55, 80.95]]];
  var PROTECTED = { west: 80.62, south: 8.05, east: 80.95, north: 8.38 };
  var TOWNS = [[8.5, 80.55, 0.06], [8.2, 80.25, 0.04], [8.85, 80.85, 0.05]];

  function buildCells() {
    var nBig = makeNoise(11, 14), nMid = makeNoise(23, 7), nFine = makeNoise(37, 3), nWet = makeNoise(51, 9), nRidge = makeNoise(63, 6);
    var cells = [];
    for (var j = 0; j < N; j++) {
      for (var i = 0; i < N; i++) {
        var lat = BOX.south + (j + 0.5) * DY, lng = BOX.west + (i + 0.5) * DX;
        var ghi = 5.0 + 0.45 * (nBig(i, j) - 0.5) * 2 + 0.15 * (nMid(i, j) - 0.5) * 2 + 0.25 * (j / N);
        var ridge = Math.max(0, nRidge(i, j) - 0.55) * 2.2;
        var slope = Math.max(0, 1 + 5 * nMid(i, j) + 14 * ridge * ridge + 2 * nFine(i, j));
        var water = nWet(i, j) > 0.78 ? 1 : 0;
        var prot = lng >= PROTECTED.west && lng <= PROTECTED.east && lat >= PROTECTED.south && lat <= PROTECTED.north ? 1 : 0;
        var urban = TOWNS.some(function (t) { return Math.hypot(lat - t[0], lng - t[1]) < t[2]; }) ? 1 : 0;
        cells.push({
          i: i, j: j, lat: lat, lng: lng, ghi: ghi, slope: slope,
          grid: distToLinesKm(lat, lng, GRID_LINES), road: distToLinesKm(lat, lng, ROAD_LINES),
          water: water, prot: prot, urban: urban
        });
      }
    }
    return cells;
  }

  var api = { N: N, SCORE: SCORE, weightedScore: weightedScore, classOf: classOf, pickSites: pickSites, buildCells: buildCells,
              mulberry32: mulberry32, distToSegKm: distToSegKm, CRITERIA: CRITERIA, CELL_KM2: CELL_KM2 };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof document === 'undefined') return;

  /* --------------------------------- UI --------------------------------- */
  function $(id) { return document.getElementById(id); }
  if (typeof L === 'undefined') { $('map').innerHTML = '<p style="padding:24px">Leaflet could not be loaded.</p>'; return; }

  var cells = buildCells();
  var state = { w: Object.assign({}, PRESETS.balanced), exW: true, exP: true, exU: true, slopeLim: 8, thr: 40, sel: null };

  var map = L.map('map', { zoomSnap: 0.25 });
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    subdomains: 'abcd', maxZoom: 14, attribution: '&copy; OpenStreetMap contributors &copy; CARTO'
  }).addTo(map);
  map.fitBounds([[BOX.south, BOX.west], [BOX.north, BOX.east]], { padding: [10, 10] });
  var canvas = L.canvas({ padding: 0.1 });
  var rects = cells.map(function (c) {
    return L.rectangle([[BOX.south + c.j * DY, BOX.west + c.i * DX], [BOX.south + (c.j + 1) * DY, BOX.west + (c.i + 1) * DX]],
      { renderer: canvas, stroke: false, fillOpacity: 0, interactive: false }).addTo(map);
  });
  var gridLayer = L.layerGroup(GRID_LINES.map(function (l) { return L.polyline(l, { color: '#6ec6ff', weight: 2, dashArray: '6 5', interactive: false }); })).addTo(map);
  var roadLayer = L.layerGroup(ROAD_LINES.map(function (l) { return L.polyline(l, { color: '#b8b8b8', weight: 1.5, opacity: .7, interactive: false }); })).addTo(map);
  L.rectangle([[PROTECTED.south, PROTECTED.west], [PROTECTED.north, PROTECTED.east]],
    { color: '#4ade80', weight: 1.5, dashArray: '3 4', fill: false, interactive: false }).addTo(map);
  var selBox = null;

  function fmt(v, d) { return v.toFixed(d); }

  function evaluate() {
    cells.forEach(function (c) {
      c.excl = (state.exW && c.water) || (state.exP && c.prot) || (state.exU && c.urban) || c.slope > state.slopeLim;
      c.score = c.excl ? null : weightedScore(c, state.w);
    });
  }
  function paint() {
    cells.forEach(function (c, k) {
      var r = rects[k];
      if (c.excl) r.setStyle({ fillColor: '#111827', fillOpacity: 0.55 });
      else if (c.score < state.thr) r.setStyle({ fillOpacity: 0 });
      else r.setStyle({ fillColor: CLASSES[classOf(c.score)].color, fillOpacity: 0.72 });
    });
  }
  function renderStats() {
    var total = cells.length, counts = CLASSES.map(function () { return 0; }), excl = 0;
    cells.forEach(function (c) { if (c.excl) excl++; else counts[classOf(c.score)]++; });
    var max = Math.max.apply(null, counts.concat([1]));
    var html = '';
    for (var k = CLASSES.length - 1; k >= 0; k--) {
      html += '<div class="cls"><i style="background:' + CLASSES[k].color + '"></i><span>' + CLASSES[k].name + '</span>' +
        '<b style="width:' + counts[k] / max * 100 + '%;background:' + CLASSES[k].color + '"></b>' +
        '<em>' + Math.round(counts[k] * CELL_KM2).toLocaleString('en-US') + ' km&sup2;</em></div>';
    }
    html += '<div class="cls ex"><i></i><span>Excluded</span><b></b><em>' + Math.round(excl * CELL_KM2).toLocaleString('en-US') + ' km&sup2;</em></div>';
    $('classes').innerHTML = html;
    $('legend').innerHTML = '<span>Suitability</span>' + CLASSES.map(function (c) {
      return '<i style="background:' + c.color + '" title="' + c.name + '"></i>';
    }).join('') + '<small>low &rarr; high</small>';
  }
  var topSites = [];
  function renderTop() {
    topSites = pickSites(cells, 10, 3, 0);
    $('top').innerHTML = topSites.length ? topSites.map(function (c, k) {
      return '<li><button type="button" data-k="' + k + '"><b>' + (k + 1) + '</b><span>' + fmt(c.lat, 3) + ', ' + fmt(c.lng, 3) +
        '</span><em style="color:' + CLASSES[classOf(c.score)].color + '">' + fmt(c.score, 1) + '</em></button></li>';
    }).join('') : '<li class="none">No cells satisfy the constraints.</li>';
  }
  function renderCell() {
    var c = state.sel;
    if (!c) { $('cell').textContent = 'Click a cell to see how its score is built.'; return; }
    if (c.excl) {
      var why = c.slope > state.slopeLim ? 'slope above limit' : c.water ? 'water body' : c.prot ? 'protected area' : 'built-up area';
      $('cell').innerHTML = '<b>Excluded</b> (' + why + ')<br><small>' + fmt(c.lat, 3) + ', ' + fmt(c.lng, 3) + '</small>';
      return;
    }
    var tot = CRITERIA.reduce(function (s, k) { return s + state.w[k.key]; }, 0) || 1;
    $('cell').innerHTML = '<div class="big" style="color:' + CLASSES[classOf(c.score)].color + '">' + fmt(c.score, 1) +
      '<small> / 100 &middot; ' + CLASSES[classOf(c.score)].name + '</small></div>' +
      CRITERIA.map(function (k) {
        var contrib = 100 * state.w[k.key] * SCORE[k.key](c[k.key]) / tot;
        return '<div class="crit"><span>' + k.label + '</span><em>' + fmt(c[k.key], k.dec) + ' ' + k.unit + '</em>' +
          '<b style="width:' + Math.min(100, contrib / Math.max(1, 100 * state.w[k.key] / tot) * 100) + '%"></b><i>+' + fmt(contrib, 1) + '</i></div>';
      }).join('');
  }
  function update() { evaluate(); paint(); renderStats(); renderTop(); renderCell(); }
  var raf = 0;
  function schedule() { if (!raf) raf = requestAnimationFrame(function () { raf = 0; update(); }); }

  /* controls */
  $('weights').innerHTML = CRITERIA.map(function (c) {
    return '<label class="w"><span>' + c.label + '</span><output id="o-' + c.key + '"></output>' +
      '<input type="range" min="0" max="10" step="1" id="w-' + c.key + '"></label>';
  }).join('');
  function syncWeights() {
    CRITERIA.forEach(function (c) { $('w-' + c.key).value = state.w[c.key]; $('o-' + c.key).textContent = state.w[c.key]; });
  }
  CRITERIA.forEach(function (c) {
    $('w-' + c.key).addEventListener('input', function (e) { state.w[c.key] = +e.target.value; $('o-' + c.key).textContent = e.target.value; schedule(); });
  });
  document.querySelectorAll('.presets button').forEach(function (b) {
    b.addEventListener('click', function () { state.w = Object.assign({}, PRESETS[b.getAttribute('data-p')]); syncWeights(); schedule(); });
  });
  $('ex-water').addEventListener('change', function (e) { state.exW = e.target.checked; schedule(); });
  $('ex-prot').addEventListener('change', function (e) { state.exP = e.target.checked; schedule(); });
  $('ex-urban').addEventListener('change', function (e) { state.exU = e.target.checked; schedule(); });
  $('slope-lim').addEventListener('input', function (e) { state.slopeLim = +e.target.value; $('slope-out').textContent = e.target.value + '°'; schedule(); });
  $('thr').addEventListener('input', function (e) { state.thr = +e.target.value; $('thr-out').textContent = e.target.value; schedule(); });
  $('show-grid').addEventListener('change', function (e) { if (e.target.checked) gridLayer.addTo(map); else map.removeLayer(gridLayer); });
  $('show-roads').addEventListener('change', function (e) { if (e.target.checked) roadLayer.addTo(map); else map.removeLayer(roadLayer); });

  function cellAt(latlng) {
    var i = Math.floor((latlng.lng - BOX.west) / DX), j = Math.floor((latlng.lat - BOX.south) / DY);
    return i >= 0 && j >= 0 && i < N && j < N ? cells[j * N + i] : null;
  }
  map.on('mousemove', function (e) {
    var c = cellAt(e.latlng), h = $('hover');
    if (!c) { h.textContent = 'Outside the demo extent'; return; }
    h.innerHTML = c.excl ? '<b>Excluded cell</b>' : '<b>Score ' + fmt(c.score, 1) + '</b> ' + CLASSES[classOf(c.score)].name;
    h.innerHTML += ' &middot; ' + fmt(c.ghi, 2) + ' kWh/m&sup2;/d &middot; ' + fmt(c.slope, 1) + '&deg; &middot; grid ' + fmt(c.grid, 1) + ' km';
  });
  function selectCell(c) {
    state.sel = c;
    if (selBox) { map.removeLayer(selBox); selBox = null; }
    if (c) selBox = L.rectangle([[BOX.south + c.j * DY, BOX.west + c.i * DX], [BOX.south + (c.j + 1) * DY, BOX.west + (c.i + 1) * DX]],
      { color: '#ffffff', weight: 2, fill: false, interactive: false }).addTo(map);
    renderCell();
  }
  map.on('click', function (e) { selectCell(cellAt(e.latlng)); });
  $('top').addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b) return;
    var c = topSites[+b.getAttribute('data-k')];
    selectCell(c); map.setView([c.lat, c.lng], Math.max(map.getZoom(), 11));
  });
  $('export').addEventListener('click', function () {
    var rows = ['rank,lat,lng,score,irradiation_kwh_m2_day,slope_deg,grid_km,road_km'];
    pickSites(cells, 25, 3, 0).forEach(function (c, k) {
      rows.push([k + 1, c.lat.toFixed(4), c.lng.toFixed(4), c.score.toFixed(1), c.ghi.toFixed(2), c.slope.toFixed(1), c.grid.toFixed(1), c.road.toFixed(1)].join(','));
    });
    var blob = new Blob([rows.join('\n')], { type: 'text/csv' }), a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = 'solarscope-top-sites-DEMO.csv';
    document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  });

  $('slope-out').textContent = state.slopeLim + '°'; $('thr-out').textContent = state.thr;
  syncWeights(); update();
})(typeof window !== 'undefined' ? window : globalThis);
