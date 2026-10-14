// Fill these in with your Supabase project's URL and anon (public) key —
// Project Settings → API in the Supabase dashboard.
// The anon key is safe to expose in frontend code; access is controlled
// by the RLS policies in supabase/schema.sql, not by keeping this secret.
window.SENTRY_CONFIG = {
  SUPABASE_URL: 'https://wyzvtgizqsvdflrpkhqs.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Ind5enZ0Z2l6cXN2ZGZscnBraHFzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk5MDE0NDIsImV4cCI6MjEwNTQ3NzQ0Mn0.kUxDmmUYsGz0L6QhYzuHzsftSimGHeGGrPu_QGIWVf8',
};
// Optional map defaults. The view fits geolocated incidents when first opened.
// You can replace the tile URL/attribution with another provider before wider deployment.
window.SENTRY_CONFIG.MAP_CENTER = [-29, 25];
window.SENTRY_CONFIG.MAP_ZOOM = 5;
window.SENTRY_CONFIG.MAP_TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
window.SENTRY_CONFIG.MAP_TILE_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors';
