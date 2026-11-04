/* Orbit Compare - before/after satellite swipe viewer (NASA GIBS + Leaflet, plain JS) */
(function (root) {
  'use strict';

  var GIBS = 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/{layer}/default/{time}/{matrix}/{z}/{y}/{x}.{ext}';
  var BLANK = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

  var LAYERS = [
    { key: 'terra',  id: 'MODIS_Terra_CorrectedReflectance_TrueColor',  label: 'True colour: MODIS Terra (250 m)', matrix: 'GoogleMapsCompatible_Level9', ext: 'jpg', min: '2000-02-24' },
    { key: 'aqua',   id: 'MODIS_Aqua_CorrectedReflectance_TrueColor',   label: 'True colour: MODIS Aqua (250 m)',  matrix: 'GoogleMapsCompatible_Level9', ext: 'jpg', min: '2002-07-04' },
    { key: 'viirs',  id: 'VIIRS_SNPP_CorrectedReflectance_TrueColor',   label: 'True colour: VIIRS (250 m)',       matrix: 'GoogleMapsCompatible_Level9', ext: 'jpg', min: '2015-11-24' },
    { key: 'f721',   id: 'MODIS_Terra_CorrectedReflectance_Bands721',   label: 'False colour 7-2-1: water shows dark', matrix: 'GoogleMapsCompatible_Level9', ext: 'jpg', min: '2000-02-24' }
  ];
  var PLACES = [
    { name: 'Sri Lanka', lat: 7.8, lng: 80.7, z: 7 },
    { name: 'Colombo and Kelani basin', lat: 7.0, lng: 80.0, z: 9 },
    { name: 'Northern Province', lat: 9.2, lng: 80.4, z: 8 },
    { name: 'Aral Sea (long-term shrinkage)', lat: 45.0, lng: 60.0, z: 7, dates: ['2002-08-20', '2025-08-20'] },
    { name: 'Bangladesh delta', lat: 23.6, lng: 90.0, z: 7 },
    { name: 'Rondonia, Brazil (deforestation)', lat: -10.5, lng: -62.5, z: 8 }
  ];

  /* ---------------- pure helpers (unit-tested in Node) ---------------- */
  function iso(d) { return d.toISOString().slice(0, 10); }
  function addDays(isoStr, n) {
    var d = new Date(isoStr + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return iso(d);
  }
  function addYears(isoStr, n) {
    var d = new Date(isoStr + 'T00:00:00Z');
    d.setUTCFullYear(d.getUTCFullYear() + n);
    return iso(d);
  }
  function clampDate(s, min, max) { return s < min ? min : s > max ? max : s; }
  function validDate(s) { return /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(new Date(s + 'T00:00:00Z').getTime()); }
  function clipRects(nw, se, x) {
    return {
      left:  [nw.y, x, se.y, nw.x],
      right: [nw.y, se.x, se.y, x]
    };
  }
  var api = { iso: iso, addDays: addDays, addYears: addYears, clampDate: clampDate, validDate: validDate, clipRects: clipRects, LAYERS: LAYERS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof document === 'undefined') return;

  /* --------------------------------- UI --------------------------------- */
  function $(id) { return document.getElementById(id); }
  if (typeof L === 'undefined') { $('map').innerHTML = '<p style="padding:24px;color:#fff">Leaflet could not be loaded.</p>'; return; }

  var today = new Date();
  var MAX = addDays(iso(today), -1);                   // yesterday (UTC): today's mosaic is incomplete
  var state = { layer: LAYERS[0], left: addYears(MAX, -1), right: MAX, ratio: 0.5 };
  state.left = addDays(state.left, 0);

  var map = L.map('map', { zoomSnap: 0.5, minZoom: 3, maxZoom: 11, zoomControl: false, worldCopyJump: true }).setView([PLACES[0].lat, PLACES[0].lng], PLACES[0].z);
  L.control.zoom({ position: 'bottomleft' }).addTo(map);
  map.getContainer().style.background = '#05080f';

  map.createPane('left').style.zIndex = 210;
  map.createPane('right').style.zIndex = 211;
  map.createPane('labels').style.zIndex = 450;
  map.getPane('labels').style.pointerEvents = 'none';
  // Esri place labels for imagery: free tiles, no API key needed
  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}', {
    pane: 'labels', maxZoom: 12, attribution: 'Labels Tiles &copy; Esri'
  }).addTo(map);

  var leftLayer = null, rightLayer = null;
  function makeLayer(date, pane) {
    var l = state.layer;
    return L.tileLayer(GIBS, {
      layer: l.id, time: date, matrix: l.matrix, ext: l.ext, pane: pane, tileSize: 256,
      maxNativeZoom: 9, maxZoom: 11, errorTileUrl: BLANK, attribution: 'Imagery: NASA GIBS'
    });
  }
  function setLayers() {
    if (leftLayer) map.removeLayer(leftLayer);
    if (rightLayer) map.removeLayer(rightLayer);
    leftLayer = makeLayer(state.left, 'left').addTo(map);
    rightLayer = makeLayer(state.right, 'right').addTo(map);
    updateClip();
    $('tag-l').textContent = state.left;
    $('tag-r').textContent = state.right;
  }

  function updateClip() {
    var size = map.getSize();
    var nw = map.containerPointToLayerPoint([0, 0]), se = map.containerPointToLayerPoint(size);
    var x = nw.x + size.x * state.ratio;
    var r = clipRects(nw, se, x);
    map.getPane('left').style.clip = 'rect(' + r.left.join('px,') + 'px)';
    map.getPane('right').style.clip = 'rect(' + r.right.join('px,') + 'px)';
    var px = size.x * state.ratio;
    $('handle').style.left = px + 'px';
    $('handle').setAttribute('aria-valuenow', Math.round(state.ratio * 100));
    $('tag-l').style.maxWidth = Math.max(0, px - 20) + 'px';
    $('tag-r').style.maxWidth = Math.max(0, size.x - px - 20) + 'px';
  }
  map.on('move zoom resize viewreset', updateClip);

  /* swipe handle */
  var dragging = false;
  var handle = $('handle');
  function setRatioFromX(clientX) {
    var rect = $('stage').getBoundingClientRect();
    state.ratio = Math.max(0.02, Math.min(0.98, (clientX - rect.left) / rect.width));
    updateClip();
  }
  handle.addEventListener('pointerdown', function (e) { dragging = true; handle.setPointerCapture(e.pointerId); e.preventDefault(); });
  handle.addEventListener('pointermove', function (e) { if (dragging) setRatioFromX(e.clientX); });
  handle.addEventListener('pointerup', function (e) { dragging = false; try { handle.releasePointerCapture(e.pointerId); } catch (x) { /* ignore */ } });
  handle.addEventListener('keydown', function (e) {
    var step = e.shiftKey ? 0.1 : 0.02;
    if (e.key === 'ArrowLeft') state.ratio = Math.max(0.02, state.ratio - step);
    else if (e.key === 'ArrowRight') state.ratio = Math.min(0.98, state.ratio + step);
    else if (e.key === 'Home') state.ratio = 0.02;
    else if (e.key === 'End') state.ratio = 0.98;
    else return;
    e.preventDefault(); updateClip();
  });
  window.addEventListener('resize', function () { map.invalidateSize(); updateClip(); });

  /* panel */
  $('layer').innerHTML = LAYERS.map(function (l) { return '<option value="' + l.key + '">' + l.label + '</option>'; }).join('');
  $('place').innerHTML = PLACES.map(function (p, i) { return '<option value="' + i + '">' + p.name + '</option>'; }).join('');
  ['d-l', 'd-r'].forEach(function (id) { $(id).max = MAX; $(id).min = LAYERS[0].min; });

  function syncInputs() {
    $('d-l').value = state.left; $('d-r').value = state.right;
    $('d-l').min = $('d-r').min = state.layer.min;
    $('note').textContent = 'Daily mosaics can contain clouds or gaps. If an area looks empty, step a day or switch sensor. Earliest date for this layer: ' + state.layer.min + '.';
  }
  function setDate(side, v) {
    if (!validDate(v)) return;
    v = clampDate(v, state.layer.min, MAX);
    state[side === 'l' ? 'left' : 'right'] = v;
    syncInputs(); setLayers();
  }
  $('d-l').addEventListener('change', function (e) { setDate('l', e.target.value); });
  $('d-r').addEventListener('change', function (e) { setDate('r', e.target.value); });
  document.querySelectorAll('.step button').forEach(function (b) {
    b.addEventListener('click', function () {
      var side = b.getAttribute('data-side'), cur = side === 'l' ? state.left : state.right;
      setDate(side, addDays(cur, parseInt(b.getAttribute('data-d'), 10)));
    });
  });
  $('swap').addEventListener('click', function () { var t = state.left; state.left = state.right; state.right = t; syncInputs(); setLayers(); });
  $('yearago').addEventListener('click', function () { state.left = clampDate(addYears(state.right, -1), state.layer.min, MAX); syncInputs(); setLayers(); });
  $('layer').addEventListener('change', function (e) {
    state.layer = LAYERS.filter(function (l) { return l.key === e.target.value; })[0];
    state.left = clampDate(state.left, state.layer.min, MAX); state.right = clampDate(state.right, state.layer.min, MAX);
    syncInputs(); setLayers();
  });
  $('place').addEventListener('change', function (e) {
    var p = PLACES[+e.target.value];
    map.setView([p.lat, p.lng], p.z);
    if (p.dates) { state.left = p.dates[0]; state.right = clampDate(p.dates[1], state.layer.min, MAX); syncInputs(); setLayers(); }
  });
  $('fold').addEventListener('click', function () {
    var open = $('body').hidden; $('body').hidden = !open; $('fold').setAttribute('aria-expanded', String(open));
  });

  syncInputs(); setLayers();
})(typeof window !== 'undefined' ? window : globalThis);
