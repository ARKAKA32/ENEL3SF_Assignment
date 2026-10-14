// All incident data comes from the existing staff/RLS feed; tile servers only supply the basemap.
window.createIncidentMap = function ({ canOpen, onSelect, categoryLabels, severityLabels, statusLabels }) {
  const el = (id) => document.getElementById(id);
  const overlay = el('mapModalOverlay');
  const colours = { low: '#4fa3e3', medium: '#e9c64b', high: '#f0a83a', critical: '#e5484d' };
  const config = window.SENTRY_CONFIG || {};
  let map = null, markers = null, heat = null, tiles = null, observer = null;
  let incidents = [], mapped = [], matching = [], returnFocus = null;
  const filterIds = ['mapStatus', 'mapCategory', 'mapSeverity', 'mapDays'];
  const filters = () => ({ status: el('mapStatus').value, category: el('mapCategory').value, severity: el('mapSeverity').value, days: el('mapDays').value });
  function tileWarning(text) { el('mapError').hidden = !text; el('mapError').textContent = text; }
  function summary() {
    if (!map) return;
    const visible = mapped.filter((incident) => map.getBounds().contains(window.SentryMapData.coordinates(incident))).length;
    const unmapped = matching.length - mapped.length;
    el('mapSummary').textContent = `${visible} in this area · ${mapped.length} mapped · ${unmapped} without valid coordinates · ${matching.length} match the filters.${mapped.length && !visible ? ' Use Fit filtered incidents to find them.' : ''}${!matching.length ? ' No incidents match these filters.' : ''}`;
  }
  function popup(incident) {
    const container = document.createElement('div');
    const title = document.createElement('h3'); title.className = 'map-popup-title'; title.textContent = incident.title || 'Incident report';
    const meta = document.createElement('p'); meta.className = 'map-popup-meta';
    meta.textContent = `${categoryLabels[incident.category] || 'Pending'} · ${severityLabels[incident.severity] || 'Pending'} · ${statusLabels[incident.status] || 'Unknown'}\n${incident.incident_id.slice(0,8)}${incident.location_text ? ` · ${incident.location_text}` : ''}`;
    const button = document.createElement('button'); button.type = 'button'; button.className = 'map-popup-button'; button.textContent = 'Open incident';
    button.addEventListener('click', () => { const id = incident.incident_id; close(); onSelect(id); });
    container.append(title,meta,button); return container;
  }
  function fit() {
    if (!map || !mapped.length) return;
    map.fitBounds(window.L.latLngBounds(mapped.map(window.SentryMapData.coordinates)), { padding: [35,35], maxZoom: 15, animate: false });
  }
  function removeHeat() {
    if (!heat) return;
    // Leaflet.heat 0.2.0 does not cancel its queued redraw when removed.
    // Cancel it before hiding the modal, so it cannot render a zero-sized canvas.
    window.L.Util.cancelAnimFrame(heat._frame);
    if (map?.hasLayer(heat)) map.removeLayer(heat);
    heat = null;
  }
  function draw() {
    if (!map || !canOpen()) return;
    matching = window.SentryMapData.filterIncidents(incidents, filters());
    mapped = matching.filter((incident) => window.SentryMapData.coordinates(incident));
    const openId = markers.getLayers().find((marker) => marker.isPopupOpen())?.incidentId;
    markers.clearLayers();
    for (const incident of mapped) {
      const severity = colours[incident.severity] ? incident.severity : 'other';
      const marker = window.L.marker(window.SentryMapData.coordinates(incident), {
        icon: window.L.divIcon({ className: 'map-pin-icon', html: `<span class="map-pin sev-${severity}"></span>`, iconSize: [26,26], iconAnchor: [13,13], popupAnchor: [0,-12] }),
        title: `${incident.title || 'Incident'} (${severityLabels[incident.severity] || 'Pending'})`,
        alt: 'Incident marker', keyboard: true,
      }).bindPopup(popup(incident));
      marker.incidentId = incident.incident_id;
      markers.addLayer(marker);
      if (incident.incident_id === openId) marker.openPopup();
    }
    const enabled = el('mapHeatToggle').checked && Boolean(window.L.heatLayer);
    el('heatLegend').hidden = !enabled;
    el('mapHeatMeasure').disabled = !enabled;
    if (enabled) {
      const points = window.SentryMapData.heatPoints(mapped, el('mapHeatMeasure').value === 'severity');
      if (heat) heat.setLatLngs(points);
      else heat = window.L.heatLayer(points, { radius: 30, blur: 22, maxZoom: 12, max: 1, minOpacity: 0.3, gradient: { 0.25: '#3987ef', 0.5: '#35d07f', 0.75: '#f5dc4c', 1: '#e5484d' } }).addTo(map);
    } else removeHeat();
    el('mapFitBtn').disabled = !mapped.length;
    summary();
  }
  function initialize() {
    if (map) return;
    if (!window.L || !window.SentryMapData) throw new Error('Map libraries could not load. Refresh the page after checking the server dependencies.');
    const center = window.SentryMapData.coordinates({ latitude: config.MAP_CENTER?.[0], longitude: config.MAP_CENTER?.[1] }) || [-29,25];
    map = window.L.map('incidentMap', { zoomControl: true }).setView(center, Number.isFinite(config.MAP_ZOOM) ? config.MAP_ZOOM : 5);
    tiles = window.L.tileLayer(config.MAP_TILE_URL || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: config.MAP_TILE_ATTRIBUTION || '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
    }).addTo(map);
    tiles.on('tileerror', () => tileWarning('Some map tiles could not load. Incident markers are still available; check your connection and use Retry map tiles.'));
    markers = window.L.layerGroup().addTo(map);
    if (!window.L.heatLayer) { el('mapHeatToggle').disabled = true; tileWarning('Heatmap library unavailable. Markers remain available.'); }
    map.on('moveend', summary);
    observer = new ResizeObserver(() => { if (!overlay.hidden) map?.invalidateSize({ animate: false }); });
    observer.observe(el('incidentMap'));
  }
  function open() {
    if (!canOpen()) return;
    returnFocus = document.activeElement; const first = !map;
    overlay.hidden = false; el('closeMapBtn').focus();
    requestAnimationFrame(() => {
      if (overlay.hidden || !canOpen()) return;
      try { initialize(); map.invalidateSize({ animate: false }); draw(); if (first) fit(); }
      catch (error) { tileWarning(error.message); }
    });
  }
  function close() { removeHeat(); overlay.hidden = true; if (returnFocus?.isConnected) returnFocus.focus(); }
  function reset() {
    close(); observer?.disconnect(); map?.remove(); map = markers = heat = tiles = observer = null;
    incidents = mapped = matching = []; el('mapSummary').textContent = ''; tileWarning('');
    el('mapStatus').value = 'active'; el('mapCategory').value = ''; el('mapSeverity').value = ''; el('mapDays').value = '';
    el('mapHeatToggle').checked = false; el('heatLegend').hidden = true;
  }
  for (const id of [...filterIds,'mapHeatToggle','mapHeatMeasure']) el(id).addEventListener('change', draw);
  el('mapFitBtn').addEventListener('click', fit);
  el('mapRetryBtn').addEventListener('click', () => { tileWarning(''); tiles?.redraw(); });
  el('closeMapBtn').addEventListener('click', close);
  overlay.addEventListener('click', (event) => { if (event.target === overlay) close(); });
  overlay.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { event.preventDefault(); close(); return; }
    if (event.key !== 'Tab') return;
    const controls = Array.from(overlay.querySelectorAll('button:not(:disabled),select:not(:disabled),input:not(:disabled),a[href],[tabindex="0"]')).filter((element) => element.getClientRects().length);
    const first = controls[0], last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });
  return { open, close, reset, update(data) { incidents = canOpen() ? data.slice() : []; if (!overlay.hidden) draw(); } };
};
