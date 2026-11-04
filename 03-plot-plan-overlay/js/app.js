/* Green Valley Estate - plot explorer (Leaflet, plain JS). Sample data only. */
(function (root) {
  'use strict';

  var STATUS = {
    Available: { color: '#2e9e5b', badge: 'ok' },
    Reserved:  { color: '#e0a526', badge: 'warn' },
    Sold:      { color: '#b8483a', badge: 'bad' }
  };

  /* ---------------- pure helpers (unit-tested in Node) ---------------- */
  function fmtPrice(n) {
    if (n >= 1e6) return 'Rs ' + (n / 1e6).toFixed(2) + 'M';
    return 'Rs ' + Math.round(n / 1000) + 'K';
  }
  function fmtInt(n) { return Math.round(n).toLocaleString('en-US'); }

  function passes(p, f) {
    return f.statuses.indexOf(p.status) > -1 && p.price <= f.maxPrice && p.perches >= f.minPerch;
  }
  function sortPlots(arr, mode) {
    var a = arr.slice();
    var by = {
      'no': function (x, y) { return x.id - y.id; },
      'price-asc': function (x, y) { return x.price - y.price; },
      'price-desc': function (x, y) { return y.price - x.price; },
      'size-desc': function (x, y) { return y.perches - x.perches; }
    }[mode] || function (x, y) { return x.id - y.id; };
    return a.sort(by);
  }
  function summarise(plots) {
    var av = plots.filter(function (p) { return p.status === 'Available'; });
    var perches = av.reduce(function (s, p) { return s + p.perches; }, 0);
    var value = av.reduce(function (s, p) { return s + p.price; }, 0);
    return {
      total: plots.length, available: av.length,
      reserved: plots.filter(function (p) { return p.status === 'Reserved'; }).length,
      sold: plots.filter(function (p) { return p.status === 'Sold'; }).length,
      availablePerches: perches,
      avgPerPerch: perches ? value / perches : 0,
      minPrice: av.length ? Math.min.apply(null, av.map(function (p) { return p.price; })) : 0,
      maxPrice: av.length ? Math.max.apply(null, av.map(function (p) { return p.price; })) : 0
    };
  }
  function toCsv(plots) {
    var cols = ['no', 'status', 'perches', 'area_m2', 'ppp', 'price', 'frontage_m', 'facing', 'corner'];
    return [cols.join(',')].concat(plots.map(function (p) {
      return cols.map(function (c) { return p[c]; }).join(',');
    })).join('\n');
  }
  var api = { fmtPrice: fmtPrice, passes: passes, sortPlots: sortPlots, summarise: summarise, toCsv: toCsv };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof document === 'undefined') return;

  /* --------------------------------- UI --------------------------------- */
  function $(id) { return document.getElementById(id); }
  if (typeof L === 'undefined' || !root.SITE) {
    $('map').innerHTML = '<p style="padding:24px">The map library or the data file could not be loaded.</p>';
    return;
  }

  var SITE = root.SITE;
  var FEATS = SITE.plots.features;
  var PLOTS = FEATS.map(function (f) { return f.properties; });
  var byId = {};
  FEATS.forEach(function (f) { byId[f.properties.id] = f; });
  var maxPriceAll = Math.max.apply(null, PLOTS.map(function (p) { return p.price; }));
  var maxPriceStep = Math.ceil(maxPriceAll / 1e6) * 1e6;

  var state = { statuses: ['Available', 'Reserved', 'Sold'], maxPrice: maxPriceStep, minPerch: 0, sort: 'no', selected: null, measuring: false };

  /* map */
  var map = L.map('map', { zoomSnap: 0.25, maxZoom: 21 }).setView(SITE.center, 18);
  var bases = {
    sat: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      { maxNativeZoom: 19, maxZoom: 21, attribution: 'Tiles &copy; Esri, Maxar, Earthstar Geographics' }),
    map: L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
      { subdomains: 'abcd', maxNativeZoom: 19, maxZoom: 21, attribution: '&copy; OpenStreetMap contributors &copy; CARTO' })
  };
  var base = bases.sat.addTo(map);

  var plan = L.imageOverlay('data/site_plan.svg', SITE.bounds, { opacity: 0.6, interactive: false, alt: 'Site plan' }).addTo(map);
  var roads = L.geoJSON(SITE.roads, { style: { color: '#5b5b4d', weight: 1, fillColor: '#8c8872', fillOpacity: 0.45 }, interactive: false }).addTo(map);
  L.geoJSON(SITE.boundary, { style: { color: '#f4d35e', weight: 3, dashArray: '10 7', fill: false }, interactive: false }).addTo(map);
  L.geoJSON(SITE.park, { style: { color: '#3f7d2c', weight: 1, fillColor: '#6bbf59', fillOpacity: 0.35 }, interactive: false }).addTo(map);

  var plotLayers = {};
  function plotStyle(f) {
    var p = f.properties, on = passes(p, state), sel = state.selected === p.id;
    return {
      fillColor: STATUS[p.status].color, fillOpacity: on ? 0.55 : 0.06,
      color: sel ? '#ffffff' : (on ? '#1d1d1b' : '#999999'), weight: sel ? 4 : 1.5, opacity: on ? 1 : 0.5
    };
  }
  var plotsGroup = L.geoJSON(SITE.plots, {
    style: plotStyle,
    onEachFeature: function (f, layer) {
      var p = f.properties;
      plotLayers[p.id] = layer;
      layer.bindTooltip(p.no + ' &middot; ' + p.perches + ' perches &middot; ' + p.status, { sticky: true });
      layer.on('click', function () { if (!state.measuring) select(p.id, true); });
    }
  }).addTo(map);
  map.fitBounds(SITE.bounds, { padding: [30, 30] });

  /* ------------------------- sidebar rendering ------------------------- */
  function visible() { return sortPlots(PLOTS.filter(function (p) { return passes(p, state); }), state.sort); }

  function renderStats() {
    var s = summarise(PLOTS);
    $('stats').innerHTML =
      '<div><b>' + s.available + '</b><span>available</span></div>' +
      '<div><b>' + fmtPrice(s.avgPerPerch) + '</b><span>avg per perch</span></div>' +
      '<div><b>' + fmtInt(s.availablePerches) + '</b><span>perches for sale</span></div>' +
      '<div class="wide"><span>From ' + fmtPrice(s.minPrice) + ' to ' + fmtPrice(s.maxPrice) + ' &middot; ' + s.reserved + ' reserved &middot; ' + s.sold + ' sold</span></div>';
  }
  function renderChips() {
    $('status-chips').innerHTML = Object.keys(STATUS).map(function (k) {
      var on = state.statuses.indexOf(k) > -1;
      return '<button type="button" class="schip' + (on ? ' on' : '') + '" data-s="' + k + '" aria-pressed="' + on + '">' +
        '<i style="background:' + STATUS[k].color + '"></i>' + k + '</button>';
    }).join('');
  }
  function renderList() {
    var list = visible();
    $('count').textContent = list.length + ' of ' + PLOTS.length;
    $('plot-list').innerHTML = list.length ? list.map(function (p) {
      return '<li><button type="button" class="prow' + (state.selected === p.id ? ' sel' : '') + '" data-id="' + p.id + '">' +
        '<b>' + p.no + '</b><span>' + p.perches + ' perches</span><span class="pr">' + fmtPrice(p.price) + '</span>' +
        '<em class="badge ' + STATUS[p.status].badge + '">' + p.status + '</em></button></li>';
    }).join('') : '<li class="none">No plots match these filters.</li>';
  }
  function renderLegend() {
    $('legend').innerHTML = Object.keys(STATUS).map(function (k) {
      return '<span><i style="background:' + STATUS[k].color + '"></i>' + k + '</span>';
    }).join('');
  }
  function restyle() { plotsGroup.setStyle(plotStyle); renderList(); }

  /* ------------------------------ drawer ------------------------------ */
  function renderDrawer() {
    var d = $('drawer');
    if (state.selected == null) { d.hidden = true; return; }
    var p = byId[state.selected].properties;
    var msg = 'Hello, I am interested in plot ' + p.no + ' at Green Valley Estate (' + p.perches + ' perches, ' + fmtPrice(p.price) +
      '). Please share availability and viewing times.';
    d.hidden = false;
    d.innerHTML =
      '<div class="d-top"><div><small>Plot</small><h2>' + p.no + '</h2></div>' +
      '<button type="button" class="x" id="d-close" aria-label="Close details">&times;</button></div>' +
      '<em class="badge ' + STATUS[p.status].badge + '">' + p.status + '</em>' +
      '<div class="price">' + fmtPrice(p.price) + '<small>' + fmtPrice(p.ppp) + ' per perch</small></div>' +
      '<table><tr><th>Size</th><td>' + p.perches + ' perches (' + fmtInt(p.area_m2) + ' m&sup2;)</td></tr>' +
      '<tr><th>Road frontage</th><td>' + p.frontage_m + ' m</td></tr>' +
      '<tr><th>Facing</th><td>' + p.facing + '</td></tr>' +
      '<tr><th>Position</th><td>' + (p.corner ? 'Corner plot' : 'Inner plot') + '</td></tr>' +
      '<tr><th>Title</th><td>Sample: clear deed</td></tr></table>' +
      '<div class="d-actions"><button type="button" class="solid" id="d-enq">Enquire about ' + p.no + '</button>' +
      '<button type="button" class="outline" id="d-next">Next available</button></div>' +
      '<div class="enq" id="enq" hidden><label>Your message<textarea id="enq-msg" rows="4">' + msg + '</textarea></label>' +
      '<button type="button" class="solid" id="enq-copy">Copy message</button>' +
      '<p class="fine">Sample project: nothing is sent. In a live version this would post to your CRM or WhatsApp.</p></div>';
    $('d-close').onclick = function () { select(null); };
    $('d-enq').onclick = function () { $('enq').hidden = !$('enq').hidden; };
    $('enq-copy').onclick = function () {
      var t = $('enq-msg').value, b = $('enq-copy');
      function ok() { b.textContent = 'Copied'; setTimeout(function () { b.textContent = 'Copy message'; }, 1500); }
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(t).then(ok, ok); else { $('enq-msg').select(); ok(); }
    };
    $('d-next').onclick = function () {
      var av = sortPlots(PLOTS.filter(function (x) { return x.status === 'Available'; }), 'no');
      var i = av.findIndex(function (x) { return x.id > p.id; });
      select((av[i < 0 ? 0 : i] || p).id, false);
    };
  }

  function select(id, fromMap) {
    state.selected = id;
    plotsGroup.setStyle(plotStyle);
    if (id != null && plotLayers[id]) {
      plotLayers[id].bringToFront();
      if (!fromMap) map.fitBounds(plotLayers[id].getBounds(), { padding: [120, 120], maxZoom: 20 });
    }
    renderList(); renderDrawer();
    var sel = document.querySelector('.prow.sel');
    if (sel && sel.scrollIntoView) sel.scrollIntoView({ block: 'nearest' });
  }

  /* ---------------------------- controls ---------------------------- */
  var mp = $('maxprice');
  mp.min = 1e6; mp.max = maxPriceStep; mp.step = 250000; mp.value = maxPriceStep;
  function outs() {
    $('maxprice-out').textContent = fmtPrice(state.maxPrice);
    $('minsize-out').textContent = state.minPerch + ' perches';
  }
  mp.addEventListener('input', function (e) { state.maxPrice = +e.target.value; outs(); restyle(); });
  $('minsize').addEventListener('input', function (e) { state.minPerch = +e.target.value; outs(); restyle(); });
  $('sort').addEventListener('change', function (e) { state.sort = e.target.value; renderList(); });
  $('status-chips').addEventListener('click', function (e) {
    var b = e.target.closest('.schip'); if (!b) return;
    var s = b.getAttribute('data-s'), i = state.statuses.indexOf(s);
    if (i > -1) state.statuses.splice(i, 1); else state.statuses.push(s);
    renderChips(); restyle();
  });
  $('plot-list').addEventListener('click', function (e) {
    var b = e.target.closest('.prow'); if (b) select(+b.getAttribute('data-id'), false);
  });

  $('l-plan').addEventListener('change', function (e) { if (e.target.checked) plan.addTo(map); else map.removeLayer(plan); });
  $('plan-op').addEventListener('input', function (e) { plan.setOpacity(+e.target.value); });
  $('l-plots').addEventListener('change', function (e) { if (e.target.checked) plotsGroup.addTo(map); else map.removeLayer(plotsGroup); });
  $('l-roads').addEventListener('change', function (e) { if (e.target.checked) roads.addTo(map); else map.removeLayer(roads); });
  document.querySelectorAll('input[name="base"]').forEach(function (r) {
    r.addEventListener('change', function (e) {
      map.removeLayer(base); base = bases[e.target.value].addTo(map); base.bringToBack();
    });
  });
  L.DomEvent.disableClickPropagation($('layers'));
  L.DomEvent.disableScrollPropagation($('layers'));
  L.DomEvent.disableClickPropagation($('drawer'));

  $('dl').addEventListener('click', function () {
    var blob = new Blob([toCsv(visible())], { type: 'text/csv' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = 'green-valley-price-list.csv';
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  });

  /* ------------------------- measure distance ------------------------- */
  var mPts = [], mLine = null, mDots = L.layerGroup().addTo(map);
  function mUpdate() {
    var chip = $('measure-chip');
    if (!state.measuring) { chip.hidden = true; return; }
    var len = 0;
    for (var i = 1; i < mPts.length; i++) len += map.distance(mPts[i - 1], mPts[i]);
    chip.hidden = false;
    chip.innerHTML = mPts.length < 2 ? 'Click the map to start measuring' :
      'Distance: <b>' + len.toFixed(1) + ' m</b> (' + (len / 0.3048).toFixed(0) + ' ft)' +
      ' <button type="button" id="m-clear">Clear</button>';
    var c = $('m-clear'); if (c) c.onclick = function () { mReset(); mUpdate(); };
  }
  function mReset() { mPts = []; mDots.clearLayers(); if (mLine) { map.removeLayer(mLine); mLine = null; } }
  $('measure').addEventListener('click', function () {
    state.measuring = !state.measuring;
    this.classList.toggle('on', state.measuring);
    this.textContent = state.measuring ? 'Stop measuring' : 'Measure distance';
    document.getElementById('map').style.cursor = state.measuring ? 'crosshair' : '';
    if (!state.measuring) mReset();
    mUpdate();
  });
  map.on('click', function (e) {
    if (!state.measuring) return;
    mPts.push(e.latlng);
    L.circleMarker(e.latlng, { radius: 4, color: '#fff', weight: 2, fillColor: '#f4d35e', fillOpacity: 1, interactive: false }).addTo(mDots);
    if (mLine) mLine.setLatLngs(mPts);
    else mLine = L.polyline(mPts, { color: '#f4d35e', weight: 3, dashArray: '6 6', interactive: false }).addTo(map);
    mUpdate();
  });

  /* start */
  renderStats(); renderChips(); renderLegend(); outs(); renderList();
})(typeof window !== 'undefined' ? window : globalThis);
