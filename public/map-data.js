(function (root) {
  const weights = { low: 0.25, medium: 0.5, high: 0.75, critical: 1 };
  function coordinates(incident) {
    const values = [incident.latitude, incident.longitude];
    if (values.some((value) => value == null || !['string', 'number'].includes(typeof value) || String(value).trim() === '')) return null;
    const [lat, lng] = values.map(Number);
    return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? [lat, lng] : null;
  }
  function filterIncidents(incidents, filters = {}, now = Date.now()) {
    return incidents.filter((incident) => {
      const finished = ['resolved', 'closed'].includes(incident.status);
      if (filters.status === 'active' && finished) return false;
      if (filters.status === 'finished' && !finished) return false;
      if (filters.status && !['all', 'active', 'finished'].includes(filters.status) && incident.status !== filters.status) return false;
      if (filters.category && incident.category !== filters.category) return false;
      if (filters.severity && incident.severity !== filters.severity) return false;
      if (filters.days) {
        const date = Date.parse(incident.created_at);
        if (!Number.isFinite(date) || date > now || date < now - Number(filters.days) * 86400000) return false;
      }
      return true;
    });
  }
  function heatPoints(incidents, weighted = false) {
    return incidents.flatMap((incident) => {
      const coords = coordinates(incident);
      return coords ? [[...coords, weighted ? weights[incident.severity] || 0.25 : 1]] : [];
    });
  }
  const api = { coordinates, filterIncidents, heatPoints };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SentryMapData = api;
})(typeof window !== 'undefined' ? window : globalThis);
