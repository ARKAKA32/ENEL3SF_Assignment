const { CATEGORIES, SEVERITIES } = require('./classify');
const MAX_FILE_SIZE = 5 * 1024 * 1024;
const MAX_FILES = 5;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function badRequest(message) { return Object.assign(new Error(message), { status: 400 }); }
function reportInput(body, userId) {
  const description = String(body.description || '').trim();
  if (!description || description.length > 5000) throw badRequest('Describe the incident in 1–5000 characters.');
  if (!['true', 'false', true, false].includes(body.is_anon)) throw badRequest('Choose whether to report anonymously.');
  const isAnon = body.is_anon === 'true' || body.is_anon === true;
  if (!isAnon && !userId) throw Object.assign(new Error('Log in to submit an identified report.'), { status: 401 });
  const locationText = String(body.location_text || '').trim();
  if (locationText.length > 500) throw badRequest('Location must be 500 characters or less.');
  const hasLat = body.latitude !== undefined && body.latitude !== '';
  const hasLng = body.longitude !== undefined && body.longitude !== '';
  if (hasLat !== hasLng) throw badRequest('Provide both latitude and longitude.');
  let latitude = null, longitude = null;
  if (hasLat) {
    latitude = Number(body.latitude); longitude = Number(body.longitude);
    if (body.latitude === null || body.longitude === null || !Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) throw badRequest('Coordinates must be valid latitude (-90 to 90) and longitude (-180 to 180).');
  }
  const source = hasLat ? body.location_source : (locationText ? 'manual' : null);
  if (source !== null && !['gps', 'manual'].includes(source)) throw badRequest('Invalid location source.');
  return { description, is_anon: isAnon, reporter_id: isAnon ? null : userId, location_text: locationText || null, latitude, longitude, location_source: source };
}
function validateFiles(files = []) {
  if (files.length > MAX_FILES) throw badRequest(`Attach up to ${MAX_FILES} images at a time.`);
  for (const file of files) {
    const bytes = file.buffer;
    const png = bytes?.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const jpeg = bytes?.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    if (!file.size || file.size > MAX_FILE_SIZE) throw badRequest('Each image must be between 1 byte and 5 MB.');
    if (!((file.mimetype === 'image/png' && png) || (file.mimetype === 'image/jpeg' && jpeg))) throw badRequest('Attach PNG or JPEG images only.');
  }
}
function validateUpdate(body) {
  if (!['new', 'acknowledged', 'assigned', 'in_progress', 'resolved', 'closed'].includes(body.status)) throw badRequest('Invalid status.');
  if (body.category !== null && !CATEGORIES.includes(body.category)) throw badRequest('Invalid category.');
  if (body.severity !== null && !SEVERITIES.includes(body.severity)) throw badRequest('Invalid severity.');
  if (body.assigned_to !== null && !UUID.test(body.assigned_to || '')) throw badRequest('Invalid assignee.');
  if (typeof body.note !== 'string' || body.note.length > 2000 || typeof body.is_public !== 'boolean') throw badRequest('Invalid note.');
  if (typeof body.expected_updated_at !== 'string' || !Number.isFinite(Date.parse(body.expected_updated_at))) throw badRequest('Refresh the incident before saving.');
}
module.exports = { reportInput, validateFiles, validateUpdate, badRequest, UUID, MAX_FILE_SIZE, MAX_FILES };
