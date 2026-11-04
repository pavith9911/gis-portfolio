/* QuakeWatch - live earthquake dashboard (USGS GeoJSON feeds + Leaflet, plain JS) */
(function (root) {
  'use strict';

  var FEED_URL = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/';
  var REFRESH_S = 60;
  var DEPTH_CLASSES = [
    { max: 10,  color: '#f472b6', label: '0-10 km' },
    { max: 35,  color: '#fb923c', label: '10-35' },
    { max: 70,  color: '#facc15', label: '35-70' },
    { max: 300, color: '#4ade80', label: '70-300' },
    { max: Infinity, color: '#22d3ee', label: '300+' }
  ];

  /* ---------------- pure functions (unit-tested in Node) ---------------- */
  function depthColor(d) {
    for (var i = 0; i < DEPTH_CLASSES.length; i++) if (d < DEPTH_CLASSES[i].max) return DEPTH_CLASSES[i].color;
    return DEPTH_CLASSES[DEPTH_CLASSES.length - 1].color;
  }
  function magRadius(m) { return Math.max(3, Math.pow(Math.max(m, 0) + 1, 1.55) * 0.95); }

  function parseFeed(gj) {
    return (gj.features || []).filter(function (f) {
      return f.geometry && f.properties && typeof f.properties.mag === 'number';
    }).map(function (f) {
      var c = f.geometry.coordinates;
      return { id: f.id, mag: f.properties.mag, place: f.properties.place || 'Unknown location', time: f.properties.time,
               url: f.properties.url, lng: c[0], lat: c[1], depth: c[2] == null ? 0 : c[2] };
    });
  }
  function timeAgo(ms, now) {
    var s = Math.max(0, Math.round((now - ms) / 1000));
    if (s < 60) return s + 's ago';
    if (s < 3600) return Math.floor(s / 60) + ' min ago';
    if (s < 86400) return Math.floor(s / 3600) + ' h ago';
    return Math.floor(s / 86400) + ' d ago';
  }
  function magHistogram(events) {
    var bins = [0, 0, 0, 0, 0, 0, 0, 0]; // <1, 1-2, ... 6-7, 7+
    events.forEach(function (e) { bins[Math.max(0, Math.min(7, Math.floor(e.mag)))]++; });
    return bins;
  }
  function timeBuckets(events, now) {
    if (!events.length) return { step: 3600000, counts: [], start: now, label: 'hour' };
    var oldest = Math.min.apply(null, events.map(function (e) { return e.time; }));
    var span = now - oldest, step, label;
    if (span <= 36 * 3600000) { step = 3600000; label = 'hour'; }
    else if (span <= 10 * 86400000) { step = 86400000; label = 'day'; }
    else { step = 3 * 86400000; label = '3 days'; }
    var n = Math.ceil((now - oldest) / step) || 1, counts = [];
    for (var i = 0; i < n; i++) counts.push(0);
    events.forEach(function (e) {
      var k = n - 1 - Math.floor((now - e.time) / step);
      counts[Math.max(0, Math.min(n - 1, k))]++;
    });
    return { step: step, counts: counts, start: now - n * step, label: label };
  }
  function summary(events, now) {
    if (!events.length) return { n: 0, max: null, avgDepth: 0, latest: null };
    var max = events.reduce(function (a, b) { return b.mag > a.mag ? b : a; });
    var latest = events.reduce(function (a, b) { return b.time > a.time ? b : a; });
    return { n: events.length, max: max, latest: latest,
             avgDepth: events.reduce(function (s, e) { return s + e.depth; }, 0) / events.length };
  }
  function sampleFeed(now) {
    var seed = 20260101;
    function rnd() { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; }
    var zones = [[36, 140, 'Honshu, Japan'], [-30, -71, 'Coquimbo, Chile'], [-3, 128, 'Banda Sea'], [61, -150, 'Southern Alaska'],
                 [-20, -176, 'Tonga'], [15, -94, 'Chiapas, Mexico'], [38, 22, 'Greece'], [28, 84, 'Nepal'], [-8, 107, 'Java, Indonesia']];
    var feats = [];
    for (var i = 0; i < 90; i++) {
      var z = zones[Math.floor(rnd() * zones.length)];
      feats.push({ id: 'demo' + i, properties: { mag: Math.round((2.5 + Math.pow(rnd(), 3) * 4.2) * 10) / 10,
        place: Math.round(rnd() * 120) + ' km of ' + z[2], time: now - Math.floor(rnd() * 7 * 86400000), url: '' },
        geometry: { type: 'Point', coordinates: [z[1] + (rnd() - 0.5) * 6, z[0] + (rnd() - 0.5) * 5, Math.round(rnd() * rnd() * 250)] } });
    }
    return { type: 'FeatureCollection', features: feats };
  }
  var api = { depthColor: depthColor, magRadius: magRadius, parseFeed: parseFeed, timeAgo: timeAgo, magHistogram: magHistogram,
              timeBuckets: timeBuckets, summary: summary, sampleFeed: sampleFeed };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof document === 'undefined') return;

  /* --------------------------------- UI --------------------------------- */
  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  if (typeof L === 'undefined') { $('map').innerHTML = '<p style="padding:24px">Leaflet could not be loaded.</p>'; return; }

  var state = { events: [], minMag: 0, sort: 'time', feed: '2.5_week', left: REFRESH_S, demo: false, selected: null };
  var map = L.map('map', { worldCopyJump: true, minZoom: 1.5, zoomSnap: 0.5 }).setView([15, 20], 2);
  // Esri Dark Gray Canvas: free tiles, no API key needed
  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', {
    maxNativeZoom: 16, maxZoom: 12, attribution: 'Tiles &copy; Esri &mdash; Esri, HERE, Garmin, OpenStreetMap contributors'
  }).addTo(map);
  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}', {
    maxNativeZoom: 16, maxZoom: 12
  }).addTo(map);
  var layer = L.layerGroup().addTo(map);
  var markers = {};
  $('legend').innerHTML = '<span>depth</span>' + DEPTH_CLASSES.map(function (d) {
    return '<span><i style="background:' + d.color + '"></i>' + d.label + '</span>';
  }).join('');

  function visible() {
    var list = state.events.filter(function (e) { return e.mag >= state.minMag; });
    var by = { time: function (a, b) { return b.time - a.time; }, mag: function (a, b) { return b.mag - a.mag; },
               depth: function (a, b) { return a.depth - b.depth; } }[state.sort];
    return list.sort(by);
  }

  function renderKpis(list) {
    var now = Date.now(), s = summary(list, now);
    $('kpis').innerHTML =
      '<div><span>Events</span><b>' + s.n + '</b></div>' +
      '<div><span>Largest</span><b>' + (s.max ? 'M ' + s.max.mag.toFixed(1) : '-') + '</b><small>' + (s.max ? esc(s.max.place) : '') + '</small></div>' +
      '<div><span>Average depth</span><b>' + (s.n ? s.avgDepth.toFixed(0) + ' km' : '-') + '</b></div>' +
      '<div><span>Latest</span><b>' + (s.latest ? timeAgo(s.latest.time, now) : '-') + '</b><small>' + (s.latest ? esc(s.latest.place) : '') + '</small></div>';
  }

  function renderMap(list) {
    layer.clearLayers(); markers = {};
    var now = Date.now();
    list.slice().sort(function (a, b) { return b.mag - a.mag; }).forEach(function (e) {
      var recent = now - e.time < 3600000;
      var m = L.circleMarker([e.lat, e.lng], {
        radius: magRadius(e.mag), color: '#ffffff', weight: recent ? 2 : 0.8, opacity: recent ? 1 : 0.7,
        fillColor: depthColor(e.depth), fillOpacity: 0.72, className: recent ? 'recent' : ''
      });
      m.bindPopup('<b>M ' + e.mag.toFixed(1) + '</b> ' + esc(e.place) + '<br>' + new Date(e.time).toUTCString() + '<br>Depth ' + e.depth.toFixed(1) + ' km' +
        (e.url ? '<br><a href="' + esc(e.url) + '" target="_blank" rel="noopener">USGS event page</a>' : ''));
      m.on('click', function () { state.selected = e.id; renderEvents(list); });
      m.addTo(layer); markers[e.id] = m;
    });
  }

  function renderEvents(list) {
    var now = Date.now();
    $('events').innerHTML = list.length ? list.slice(0, 150).map(function (e) {
      return '<li><button type="button" class="ev' + (state.selected === e.id ? ' sel' : '') + '" data-id="' + esc(e.id) + '">' +
        '<b class="mg" style="border-color:' + depthColor(e.depth) + '">' + e.mag.toFixed(1) + '</b>' +
        '<span class="pl">' + esc(e.place) + '</span><span class="tm">' + timeAgo(e.time, now) + ' &middot; ' + e.depth.toFixed(0) + ' km</span></button></li>';
    }).join('') : '<li class="none">No events at this magnitude.</li>';
  }

  /* ------------------------------ charts ------------------------------ */
  function sizeCanvas(c) {
    var dpr = window.devicePixelRatio || 1, w = c.clientWidth, h = 150;
    c.width = w * dpr; c.height = h * dpr;
    var g = c.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { g: g, w: w, h: h };
  }
  function bars(c, values, labels, color) {
    var s = sizeCanvas(c), g = s.g, w = s.w, h = s.h, pad = { l: 34, r: 8, t: 8, b: 22 };
    g.clearRect(0, 0, w, h);
    var max = Math.max.apply(null, values.concat([1])), bw = (w - pad.l - pad.r) / values.length;
    g.font = '11px "JetBrains Mono", monospace'; g.fillStyle = '#7f8aa3'; g.strokeStyle = '#1d2536';
    [0, 0.5, 1].forEach(function (t) {
      var y = pad.t + (h - pad.t - pad.b) * (1 - t);
      g.beginPath(); g.moveTo(pad.l, y); g.lineTo(w - pad.r, y); g.stroke();
      g.textAlign = 'right'; g.fillText(Math.round(max * t), pad.l - 6, y + 4);
    });
    values.forEach(function (v, i) {
      var bh = (h - pad.t - pad.b) * v / max, x = pad.l + i * bw + 2;
      g.fillStyle = color; g.fillRect(x, h - pad.b - bh, Math.max(1, bw - 4), bh);
      if (labels[i] != null) { g.fillStyle = '#7f8aa3'; g.textAlign = 'center'; g.fillText(labels[i], x + (bw - 4) / 2, h - 6); }
    });
  }
  var lastList = [];
  function renderCharts(list) {
    lastList = list;
    var hist = magHistogram(list);
    bars($('c-mag'), hist, ['<1', '1', '2', '3', '4', '5', '6', '7+'], '#22d3ee');
    var tb = timeBuckets(list, Date.now());
    $('tl-cap').textContent = 'Events per ' + tb.label;
    var n = tb.counts.length, labels = tb.counts.map(function (_, i) {
      if (n > 12 && i % Math.ceil(n / 8) !== 0 && i !== n - 1) return null;
      var d = new Date(tb.start + i * tb.step);
      return tb.step < 86400000 ? d.getHours() + 'h' : (d.getMonth() + 1) + '/' + d.getDate();
    });
    bars($('c-time'), tb.counts, labels, '#f472b6');
  }

  function renderAll() {
    var list = visible();
    renderKpis(list); renderMap(list); renderEvents(list); renderCharts(list);
  }

  /* ------------------------------ data ------------------------------ */
  var inflight = null;
  function load() {
    $('updated').textContent = 'Updating...';
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    if (inflight && inflight.abort) inflight.abort();
    inflight = ctrl;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, 12000);
    fetch(FEED_URL + state.feed + '.geojson', ctrl ? { signal: ctrl.signal } : {}).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (gj) {
      state.events = parseFeed(gj); state.demo = false;
      $('src').textContent = '';
      $('updated').textContent = 'Updated ' + new Date().toLocaleTimeString();
    }).catch(function () {
      state.events = parseFeed(sampleFeed(Date.now())); state.demo = true;
      $('src').textContent = ' Showing built-in SAMPLE data because the live feed could not be reached.';
      $('updated').textContent = 'Offline: sample data';
    }).then(function () { clearTimeout(timer); state.left = REFRESH_S; renderAll(); });
  }

  /* ------------------------------ events ------------------------------ */
  $('feed').addEventListener('change', function (e) { state.feed = e.target.value; load(); });
  $('mag').addEventListener('input', function (e) { state.minMag = +e.target.value; $('mag-out').textContent = (+e.target.value).toFixed(1); renderAll(); });
  $('sort').addEventListener('change', function (e) { state.sort = e.target.value; renderEvents(visible()); });
  $('refresh').addEventListener('click', load);
  $('region').addEventListener('click', function () { map.setView([7.8, 80.7], 5); });
  $('world').addEventListener('click', function () { map.setView([15, 20], 2); });
  $('events').addEventListener('click', function (e) {
    var b = e.target.closest('.ev'); if (!b) return;
    var id = b.getAttribute('data-id'), m = markers[id]; state.selected = id;
    renderEvents(visible());
    if (m) { map.setView(m.getLatLng(), Math.max(map.getZoom(), 5)); m.openPopup(); }
  });
  window.addEventListener('resize', function () { renderCharts(lastList); });

  setInterval(function () {
    if (!$('live').checked) { $('count').textContent = '-'; return; }
    state.left -= 1; $('count').textContent = state.left;
    $('pulse').classList.toggle('on', !state.demo);
    if (state.left <= 0) load();
  }, 1000);

  load();
})(typeof window !== 'undefined' ? window : globalThis);
