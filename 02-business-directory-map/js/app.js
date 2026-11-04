/* Lanka Local - business directory map (Leaflet, plain JS) */
(function (root) {
  'use strict';

  var CATS = {
    'Restaurant': { color: '#e4572e', icon: 'R' },
    'Café':       { color: '#8d5a2b', icon: 'C' },
    'Shop':       { color: '#2a9d8f', icon: 'S' },
    'Pharmacy':   { color: '#3a7bd5', icon: '+' },
    'Salon':      { color: '#c05299', icon: 'B' },
    'Hotel':      { color: '#6b5b95', icon: 'H' }
  };
  var CELL = 56; // clustering grid size in screen pixels
  var STORE_KEY = 'lanka-local-user-places';

  /* ---------------- pure helpers (unit-tested in Node) ---------------- */
  function isOpen(p, hour) {
    if (p.open === 0 && p.close === 24) return true;
    if (p.close > p.open) return hour >= p.open && hour < p.close;
    return hour >= p.open || hour < p.close;
  }
  function plain(s) { return String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase(); }
  function matches(p, f, hour) {
    if (f.cats.length && f.cats.indexOf(p.category) === -1) return false;
    if (p.price > f.price) return false;
    if (f.openNow && !isOpen(p, hour)) return false;
    if (f.q) {
      var hay = plain(p.name + ' ' + p.category + ' ' + p.city + ' ' + (p.address || ''));
      var toks = plain(f.q).split(/\s+/).filter(Boolean);
      for (var i = 0; i < toks.length; i++) if (hay.indexOf(toks[i]) === -1) return false;
    }
    return true;
  }
  function clusterPoints(pts, cell) {
    var groups = {};
    pts.forEach(function (p) {
      var key = Math.floor(p.x / cell) + ':' + Math.floor(p.y / cell);
      (groups[key] = groups[key] || []).push(p);
    });
    return Object.keys(groups).map(function (k) { return groups[k]; });
  }
  function haversineKm(a, b, c, d) {
    var r = 6371, p1 = a * Math.PI / 180, p2 = c * Math.PI / 180;
    var dp = p2 - p1, dl = (d - b) * Math.PI / 180;
    var h = Math.sin(dp / 2) * Math.sin(dp / 2) + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) * Math.sin(dl / 2);
    return 2 * r * Math.asin(Math.sqrt(h));
  }
  function hoursText(p) {
    if (p.open === 0 && p.close === 24) return 'Open 24 hours';
    return p.open + ':00 - ' + (p.close % 24) + ':00';
  }
  var api = { isOpen: isOpen, matches: matches, clusterPoints: clusterPoints, haversineKm: haversineKm, hoursText: hoursText };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof document === 'undefined') return;

  /* --------------------------------- UI --------------------------------- */
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  if (typeof L === 'undefined') {
    $('map').innerHTML = '<p style="padding:24px">Leaflet could not be loaded. Check your connection and reload.</p>';
    return;
  }

  var places = (root.PLACES || []).slice();
  function loadUser() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY) || '[]'); } catch (e) { return []; }
  }
  function saveUser(arr) { try { localStorage.setItem(STORE_KEY, JSON.stringify(arr)); } catch (e) { /* private mode */ } }
  var userPlaces = loadUser();
  places = places.concat(userPlaces);

  var state = { q: '', cats: [], price: 3, openNow: false, inView: true, sort: 'rating', selected: null, user: null, pending: null };

  var map = L.map('map', { zoomControl: false }).setView([7.05, 80.2], 8);
  L.control.zoom({ position: 'bottomright' }).addTo(map);
  L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
    subdomains: 'abcd', maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors &copy; CARTO'
  }).addTo(map);
  var layer = L.layerGroup().addTo(map);
  var markerById = {};
  var userMarker = null;

  function fitAll() {
    var pts = places.map(function (p) { return [p.lat, p.lng]; });
    if (pts.length) map.fitBounds(pts, { padding: [40, 40] });
  }
  fitAll();

  function filtered(ignoreView) {
    var hour = new Date().getHours();
    var list = places.filter(function (p) { return matches(p, state, hour); });
    if (state.inView && !ignoreView) {
      var b = map.getBounds();
      list = list.filter(function (p) { return b.contains([p.lat, p.lng]); });
    }
    if (state.user) {
      list.forEach(function (p) { p._d = haversineKm(state.user.lat, state.user.lng, p.lat, p.lng); });
    }
    list.sort(function (a, b) {
      if (state.sort === 'name') return a.name.localeCompare(b.name);
      if (state.sort === 'reviews') return (b.reviews || 0) - (a.reviews || 0);
      if (state.sort === 'dist' && state.user) return a._d - b._d;
      return (b.rating || 0) - (a.rating || 0);
    });
    return list;
  }

  function pinIcon(p, selected) {
    var c = CATS[p.category] || { color: '#555', icon: '?' };
    return L.divIcon({
      className: 'pin-wrap',
      html: '<span class="pin' + (selected ? ' sel' : '') + '" style="background:' + c.color + '">' + c.icon + '</span>',
      iconSize: [30, 30], iconAnchor: [15, 15], popupAnchor: [0, -14]
    });
  }
  function popupHtml(p) {
    return '<div class="pop"><b>' + esc(p.name) + '</b><div class="sub">' + esc(p.category) + ' &middot; ' + esc(p.city) + '</div>' +
      '<div>' + (p.rating ? '&#9733; ' + p.rating + ' (' + p.reviews + ')' : 'New listing') + ' &middot; ' + priceDots(p.price) + '</div>' +
      '<div class="sub">' + esc(hoursText(p)) + '</div><div class="sub">' + esc(p.address || '') + '</div>' +
      '<a target="_blank" rel="noopener" href="https://www.google.com/maps/dir/?api=1&destination=' + p.lat + ',' + p.lng + '">Directions</a></div>';
  }
  function priceDots(n) { return '<span class="dots">' + '&#9679;'.repeat(n) + '<i>' + '&#9679;'.repeat(3 - n) + '</i></span>'; }

  function renderMarkers() {
    layer.clearLayers();
    markerById = {};
    var z = map.getZoom();
    var pts = filtered(true).map(function (p) {
      var pt = map.project([p.lat, p.lng], z);
      return { x: pt.x, y: pt.y, p: p };
    });
    clusterPoints(pts, CELL).forEach(function (g) {
      if (g.length === 1) {
        var p = g[0].p;
        var m = L.marker([p.lat, p.lng], { icon: pinIcon(p, state.selected === p.id), title: p.name, riseOnHover: true });
        m.bindPopup(function () { return popupHtml(p); });
        m.on('click', function () { select(p.id, true); });
        m.addTo(layer);
        markerById[p.id] = m;
      } else {
        var lat = g.reduce(function (s, o) { return s + o.p.lat; }, 0) / g.length;
        var lng = g.reduce(function (s, o) { return s + o.p.lng; }, 0) / g.length;
        var size = 34 + Math.min(18, g.length * 2);
        var cm = L.marker([lat, lng], {
          icon: L.divIcon({ className: 'cl-wrap', html: '<span class="cl" style="width:' + size + 'px;height:' + size + 'px">' + g.length + '</span>',
                            iconSize: [size, size], iconAnchor: [size / 2, size / 2] })
        });
        cm.on('click', function () {
          map.fitBounds(L.latLngBounds(g.map(function (o) { return [o.p.lat, o.p.lng]; })), { padding: [60, 60], maxZoom: 17 });
        });
        cm.addTo(layer);
      }
    });
    if (state.pending != null && markerById[state.pending]) {
      var pm = markerById[state.pending];
      state.pending = null;
      pm.openPopup();
    }
  }

  function renderList() {
    var list = filtered(false);
    $('count').textContent = list.length + (list.length === 1 ? ' place' : ' places') + (state.inView ? ' in this map view' : '');
    if (!list.length) {
      $('list').innerHTML = '<li class="empty">No places match. Try clearing a filter or zooming out.</li>';
      return;
    }
    $('list').innerHTML = list.map(function (p) {
      var c = CATS[p.category] || { color: '#555', icon: '?' };
      var open = isOpen(p, new Date().getHours());
      return '<li><button type="button" class="card' + (state.selected === p.id ? ' sel' : '') + '" data-id="' + p.id + '">' +
        '<span class="ico" style="background:' + c.color + '">' + c.icon + '</span>' +
        '<span class="body"><b>' + esc(p.name) + '</b>' +
        '<span class="sub">' + esc(p.category) + ' &middot; ' + esc(p.city) + (p._d != null && state.user ? ' &middot; ' + p._d.toFixed(1) + ' km' : '') + '</span>' +
        '<span class="meta">' + (p.rating ? '<em>&#9733; ' + p.rating + '</em> (' + p.reviews + ')' : '<em>New</em>') +
        ' &middot; ' + priceDots(p.price) + ' &middot; <span class="' + (open ? 'open' : 'closed') + '">' + (open ? 'Open' : 'Closed') + '</span></span>' +
        '</span></button></li>';
    }).join('');
  }

  function renderChips() {
    $('chips').innerHTML = Object.keys(CATS).map(function (c) {
      var on = state.cats.indexOf(c) > -1;
      return '<button type="button" class="chip' + (on ? ' on' : '') + '" data-cat="' + esc(c) + '" aria-pressed="' + on + '">' +
        '<i style="background:' + CATS[c].color + '"></i>' + esc(c) + '</button>';
    }).join('');
  }

  function refresh(markersToo) {
    if (markersToo) renderMarkers();
    renderList();
  }

  function select(id, fromMarker) {
    state.selected = id;
    var p = places.filter(function (x) { return x.id === id; })[0];
    renderList();
    if (!p) return;
    var sel = document.querySelector('.card.sel');
    if (sel && sel.scrollIntoView) sel.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    if (fromMarker) { renderMarkers(); openPopup(id); return; }
    if ($('split').getAttribute('data-view') === 'list') setView('map');
    state.pending = id;                         // popup opens as soon as the marker is unclustered
    map.flyTo([p.lat, p.lng], Math.max(map.getZoom(), 16), { duration: 0.8 });
    setTimeout(function () { if (state.pending != null) renderMarkers(); }, 1200);  // fallback if the map did not move
    setTimeout(function () { state.pending = null; }, 3000);
  }
  function openPopup(id) {
    var m = markerById[id];
    if (m) m.openPopup();
  }

  /* ---------------------------- events ---------------------------- */
  var qTimer;
  $('q').addEventListener('input', function (e) {
    clearTimeout(qTimer);
    qTimer = setTimeout(function () { state.q = e.target.value.trim(); refresh(true); }, 120);
  });
  $('chips').addEventListener('click', function (e) {
    var b = e.target.closest('.chip');
    if (!b) return;
    var c = b.getAttribute('data-cat'), i = state.cats.indexOf(c);
    if (i > -1) state.cats.splice(i, 1); else state.cats.push(c);
    renderChips(); refresh(true);
  });
  $('price').addEventListener('change', function (e) { state.price = parseInt(e.target.value, 10); refresh(true); });
  $('open').addEventListener('change', function (e) { state.openNow = e.target.checked; refresh(true); });
  $('inview').addEventListener('change', function (e) { state.inView = e.target.checked; refresh(false); });
  $('sort').addEventListener('change', function (e) { state.sort = e.target.value; refresh(false); });
  $('list').addEventListener('click', function (e) {
    var b = e.target.closest('.card');
    if (b) select(parseInt(b.getAttribute('data-id'), 10) || b.getAttribute('data-id'), false);
  });
  map.on('moveend', function () { renderList(); });
  map.on('zoomend', function () { renderMarkers(); });

  $('near').addEventListener('click', function () {
    var btn = $('near');
    if (!navigator.geolocation) { btn.textContent = 'Not available'; return; }
    btn.textContent = 'Locating...';
    navigator.geolocation.getCurrentPosition(function (pos) {
      state.user = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      if (userMarker) map.removeLayer(userMarker);
      userMarker = L.circleMarker([state.user.lat, state.user.lng], { radius: 8, color: '#fff', weight: 3, fillColor: '#2563eb', fillOpacity: 1 }).addTo(map);
      map.setView([state.user.lat, state.user.lng], 14);
      $('sort').value = 'dist'; state.sort = 'dist';
      btn.textContent = 'Near me';
      refresh(true);
    }, function () { btn.textContent = 'Location blocked'; setTimeout(function () { btn.textContent = 'Near me'; }, 2000); },
    { timeout: 8000 });
  });

  /* tabs (mobile) */
  function setView(v) {
    $('split').setAttribute('data-view', v);
    $('tab-list').setAttribute('aria-selected', v === 'list');
    $('tab-map').setAttribute('aria-selected', v === 'map');
    if (v === 'map') setTimeout(function () { map.invalidateSize(); }, 50);
  }
  $('tab-list').addEventListener('click', function () { setView('list'); });
  $('tab-map').addEventListener('click', function () { setView('map'); });

  /* add-a-place */
  var pending = null, pendingMarker = null, adding = false;
  $('f-cat').innerHTML = Object.keys(CATS).map(function (c) { return '<option>' + esc(c) + '</option>'; }).join('');
  function closeForm() {
    adding = false; pending = null;
    $('modal').hidden = true; $('form').reset();
    if (pendingMarker) { map.removeLayer(pendingMarker); pendingMarker = null; }
    $('coords').textContent = 'No location picked yet.';
    $('map').classList.remove('picking');
  }
  $('add').addEventListener('click', function () {
    adding = true; $('modal').hidden = false; $('map').classList.add('picking'); setView('map');
  });
  $('cancel').addEventListener('click', closeForm);
  map.on('click', function (e) {
    if (!adding) return;
    pending = e.latlng;
    if (pendingMarker) pendingMarker.setLatLng(e.latlng);
    else {
      pendingMarker = L.marker(e.latlng, { draggable: true }).addTo(map);
      pendingMarker.on('dragend', function () { pending = pendingMarker.getLatLng(); showCoords(); });
    }
    showCoords();
  });
  function showCoords() { $('coords').textContent = 'Location: ' + pending.lat.toFixed(5) + ', ' + pending.lng.toFixed(5) + ' (drag the pin to adjust)'; }
  $('form').addEventListener('submit', function (e) {
    e.preventDefault();
    var f = e.target, name = f.name.value.trim();
    if (!name) { $('coords').textContent = 'Please enter a name.'; return; }
    if (!pending) { $('coords').textContent = 'Click the map to place the pin first.'; return; }
    var p = { id: 'u' + Date.now(), name: name, category: f.category.value, city: 'Your place', lat: +pending.lat.toFixed(5),
              lng: +pending.lng.toFixed(5), rating: 0, reviews: 0, price: parseInt(f.price.value, 10), open: 8, close: 20,
              address: f.address.value.trim() };
    userPlaces.push(p); saveUser(userPlaces); places.push(p);
    closeForm(); refresh(true); select(p.id, true);
  });
  $('export').addEventListener('click', function () {
    var blob = new Blob([JSON.stringify(userPlaces, null, 2)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = 'my-places.json';
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  });

  renderChips();
  refresh(true);
})(typeof window !== 'undefined' ? window : globalThis);
