const $ = (id) => document.getElementById(id);
const sb = window.supabase.createClient(window.SENTRY_CONFIG.SUPABASE_URL, window.SENTRY_CONFIG.SUPABASE_ANON_KEY);
const CATEGORY_LABEL = { fire: 'Fire', police: 'Police', medical: 'Medical', child_services: 'Child Services', other: 'Other' };
const STATUS_LABEL = { new: 'New', acknowledged: 'Acknowledged', assigned: 'Assigned', in_progress: 'In progress', resolved: 'Resolved', closed: 'Closed' };
const SEVERITY_LABEL = { low: 'Low', medium: 'Medium', high: 'High', critical: 'Critical' };
const state = { profile: null, incidents: [], staff: [], statusFilter: '', selectedId: null, mySelectedId: null, channel: null, detailRequest: 0, authRequest: 0 };
const staffUser = () => ['operator', 'responder', 'admin'].includes(state.profile?.role);
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const humanLabel = (value) => String(value || '').replaceAll('_', ' ');
function timeAgo(iso) { const mins = Math.max(0, Math.floor((Date.now() - new Date(iso)) / 60000)); return mins < 1 ? 'now' : mins < 60 ? `${mins}m ago` : mins < 1440 ? `${Math.floor(mins / 60)}h ago` : `${Math.floor(mins / 1440)}d ago`; }
function message(id, text, error = false) { if (!$(id)) return; $(id).textContent = text; $(id).classList.toggle('error', error); }
async function api(url, { body, method = 'GET' } = {}) {
  const { data: { session } } = await sb.auth.getSession();
  const headers = session ? { Authorization: `Bearer ${session.access_token}` } : {};
  if (body && !(body instanceof FormData)) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(body); }
  const response = await fetch(url, { method, headers, body });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'The request failed.');
  return result;
}
async function rows(query) { const result = await query; if (result.error) throw new Error(result.error.message); return result.data || []; }
function locationLabel(inc) {
  const coords = inc.latitude != null && inc.longitude != null ? `${Number(inc.latitude).toFixed(4)}, ${Number(inc.longitude).toFixed(4)}` : '';
  return [inc.location_text, coords].filter(Boolean).join(' · ') || 'Not provided';
}
function timelineHtml(history) {
  return history.map((item) => {
    let detail = item.old_status ? `${STATUS_LABEL[item.old_status] || humanLabel(item.old_status)} → ${STATUS_LABEL[item.new_status] || humanLabel(item.new_status)}` : item.note || '';
    if (['SEVERITY_CHANGE', 'CATEGORY_CHANGE'].includes(item.update_type)) detail = detail.split(' → ').map((v) => SEVERITY_LABEL[v] || CATEGORY_LABEL[v] || v).join(' → ');
    const label = ['STATUS_CHANGE', 'STATUS_CHANGED'].includes(item.update_type) ? 'STATUS CHANGED' : humanLabel(item.update_type);
    return `<div class="timeline-item"><div class="timeline-time">${escapeHtml(new Date(item.created_at).toLocaleString())}</div><b>${escapeHtml(label)}</b> ${escapeHtml(detail)}${staffUser() && item.update_type === 'NOTE' ? `<div class="help">${item.is_public ? 'Visible to reporter' : 'Staff only'}</div>` : ''}</div>`;
  }).join('') || '<p class="help">No updates yet.</p>';
}
function optionsHtml(labels, selected, pending = false) {
  return (pending ? `<option value="" ${selected == null ? 'selected' : ''}>Pending classification</option>` : '') + Object.entries(labels).map(([value,label]) => `<option value="${value}" ${value === selected ? 'selected' : ''}>${label}</option>`).join('');
}
const incidentMap = window.createIncidentMap({ canOpen: staffUser, onSelect: selectIncident, categoryLabels: CATEGORY_LABEL, severityLabels: SEVERITY_LABEL, statusLabels: STATUS_LABEL });
let registerMode = false;
function authMode(register) {
  registerMode = register;
  $('loginTitle').textContent = register ? 'Create an account' : 'Log in';
  $('loginSubmitBtn').textContent = register ? 'Register' : 'Log in';
  $('authModeBtn').textContent = register ? 'Already registered? Log in' : 'Create an account';
  for (const id of ['registerNameField', 'confirmPasswordField', 'passwordHelp']) $(id).hidden = !register;
  $('confirmPassword').required = register;
  $('loginPassword').autocomplete = register ? 'new-password' : 'current-password';
  message('loginHint', '');
}
function openLogin() { authMode(false); $('loginModalOverlay').hidden = false; $('loginEmail').focus(); }
$('userLoginBtn').addEventListener('click', openLogin);
$('staffLoginBtn').addEventListener('click', () => staffUser() ? showDashboard() : openLogin());
$('authModeBtn').addEventListener('click', () => authMode(!registerMode));
$('loginForm').addEventListener('submit', async (event) => {
  event.preventDefault(); state.authBusy = true;
  const email = $('loginEmail').value.trim(), password = $('loginPassword').value;
  $('loginSubmitBtn').disabled = true;
  message('loginHint', registerMode ? 'Creating account…' : 'Logging in…');
  try {
    if (registerMode) {
      if (password.length < 8 || !/[A-Za-z]/.test(password) || !/[0-9]/.test(password) || !/[^A-Za-z0-9\s]/.test(password)) throw new Error('Use 8+ characters with a letter, number and symbol.');
      if (password !== $('confirmPassword').value) throw new Error('Passwords do not match.');
      const { data, error } = await sb.auth.signUp({ email, password, options: { data: { name: $('registerName').value.trim() || null }, emailRedirectTo: location.origin } });
      if (error) throw error;
      if (!data.session) message('loginHint', 'Check your email to confirm your account, then log in.');
      else { $('loginModalOverlay').hidden = true; await applySession(data.session); }
    } else {
      const { data, error } = await sb.auth.signInWithPassword({ email, password });
      if (error) throw error;
      await applySession(data.session);
      $('loginModalOverlay').hidden = true;
    }
    $('loginPassword').value = ''; $('confirmPassword').value = '';
  } catch (error) { message('loginHint', error.message, true); }
  finally { state.authBusy = false; $('loginSubmitBtn').disabled = false; }
});
async function applySession(session) {
  const request = ++state.authRequest;
  let profile = null;
  if (session) {
    const result = await sb.from('users').select('*').eq('user_id', session.user.id).single();
    if (request !== state.authRequest) return;
    if (result.error || result.data.account_status !== 'active') {
      await sb.auth.signOut();
      throw new Error('This account is unavailable. Contact an administrator.');
    }
    profile = result.data;
  }
  incidentMap.reset(); state.incidents = [];
  state.profile = profile;
  if (state.channel) await sb.removeChannel(state.channel);
  if (request !== state.authRequest) return;
  state.channel = null; state.selectedId = null; state.mySelectedId = null;
  $('drawerEmpty').hidden = false; $('drawerContent').hidden = true; $('myReportDetail').hidden = true;
  $('userLoginBtn').hidden = Boolean(profile); $('publicLogoutBtn').hidden = !profile; $('accountSection').hidden = !profile;
  $('staffLoginBtn').hidden = Boolean(profile) && !staffUser();
  $('staffLoginBtn').textContent = staffUser() ? 'Incident console' : 'Staff login';
  $('accountHeading').textContent = profile ? `Welcome, ${profile.name || profile.email}` : 'My account';
  $('anonToggle').checked = !profile;
  if (staffUser()) {
    try { state.staff = await rows(sb.from('users').select('user_id,name,email,role,account_status').in('role', ['operator','responder','admin']).order('name')); }
    catch { state.staff = []; }
    showDashboard();
  } else showPublicView();
  await refreshFeeds();
  if (request !== state.authRequest) return;
  subscribeRealtime();
  await updatePushButton();
}
function showPublicView() { incidentMap.close(); $('publicView').hidden = false; $('dashboardView').hidden = true; }
function showDashboard() {
  if (!staffUser()) return;
  $('publicView').hidden = true; $('dashboardView').hidden = false;
  $('broadcastComposer').hidden = !['operator', 'admin'].includes(state.profile.role);
  loadIncidents();
}
$('reportViewBtn').addEventListener('click', showPublicView);
async function logout() {
  try {
    await disablePush();
    const { error } = await sb.auth.signOut(); if (error) throw error;
    await applySession(null);
  } catch (error) { message('pushHint', error.message, true); message('queueHint', error.message, true); }
}
$('logoutBtn').addEventListener('click', logout); $('publicLogoutBtn').addEventListener('click', logout);
// GPS and manual input are explicit alternatives.
let capturedLocation = null, gpsRequest = 0;
$('locationMode').addEventListener('change', () => {
  gpsRequest++; capturedLocation = null;
  $('gpsFields').hidden = $('locationMode').value !== 'gps'; $('manualFields').hidden = $('locationMode').value !== 'manual';
  message('locationStatus', '');
});
$('useLocationBtn').addEventListener('click', () => {
  if (!navigator.geolocation) return message('locationStatus', 'Geolocation is unavailable. Enter a location manually.');
  const request = ++gpsRequest; capturedLocation = null;
  message('locationStatus', 'Getting location…');
  navigator.geolocation.getCurrentPosition((position) => {
    if (request !== gpsRequest || $('locationMode').value !== 'gps') return;
    capturedLocation = { latitude: position.coords.latitude, longitude: position.coords.longitude };
    message('locationStatus', `GPS captured: ${position.coords.latitude.toFixed(4)}, ${position.coords.longitude.toFixed(4)}`);
  }, () => { if (request === gpsRequest) message('locationStatus', 'Could not get GPS. Enter a manual location or choose no location.'); }, { timeout: 8000 });
});
function appendFiles(form, input) {
  const files = Array.from(input.files);
  if (files.length > 5 || files.some((file) => file.size > 5 * 1024 * 1024 || !['image/png','image/jpeg'].includes(file.type))) throw new Error('Choose up to five PNG/JPEG images, each up to 5 MB.');
  files.forEach((file) => form.append('media', file));
}
$('reportForm').addEventListener('submit', async (event) => {
  event.preventDefault(); $('submitBtn').disabled = true; message('submitResult', 'Submitting…');
  try {
    const isAnon = $('anonToggle').checked;
    if (!isAnon && !state.profile) { openLogin(); throw new Error('Log in first or choose anonymous reporting.'); }
    const form = new FormData(); form.append('description', $('messageInput').value.trim()); form.append('is_anon', isAnon);
    const mode = $('locationMode').value;
    if (mode === 'gps') {
      if (!capturedLocation) throw new Error('Capture your GPS location, choose manual entry, or choose no location.');
      form.append('latitude', capturedLocation.latitude); form.append('longitude', capturedLocation.longitude); form.append('location_source', 'gps');
    } else if (mode === 'manual') {
      const text = $('locationText').value.trim(), lat = $('latitudeInput').value, lng = $('longitudeInput').value;
      if (!text && !lat && !lng) throw new Error('Enter an address/landmark or coordinates.');
      if (Boolean(lat) !== Boolean(lng)) throw new Error('Enter both latitude and longitude.');
      form.append('location_text', text); form.append('location_source', 'manual');
      if (lat && lng) { form.append('latitude', lat); form.append('longitude', lng); }
    }
    appendFiles(form, $('mediaInput'));
    const result = await api('/api/incidents', { method: 'POST', body: form });
    message('submitResult', `Report submitted. Reference: ${result.incident_id}. ${result.warnings.join(' ')}${isAnon ? ' Keep this reference; this report is not linked to your account.' : ' Track it below in My reports.'}`);
    $('reportForm').reset(); $('anonToggle').checked = !state.profile; capturedLocation = null; gpsRequest++;
    $('gpsFields').hidden = true; $('manualFields').hidden = true; message('locationStatus', '');
    await loadMyReports();
  } catch (error) { message('submitResult', error.message, true); }
  finally { $('submitBtn').disabled = false; }
});
async function loadBroadcasts() {
  try {
    const broadcasts = await rows(sb.from('notifications').select('*').eq('notification_type','PUBLIC_BROADCAST').or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`).order('created_at', { ascending: false }));
    $('publicBroadcasts').innerHTML = broadcasts.map((item) => `<article class="broadcast-card"><h3>${escapeHtml(item.title)}</h3><p>${escapeHtml(item.message)}</p><div class="help">${escapeHtml(SEVERITY_LABEL[item.severity] || 'Update')} · ${escapeHtml(new Date(item.created_at).toLocaleString())}${item.expires_at ? ` · Expires ${escapeHtml(new Date(item.expires_at).toLocaleString())}` : ''}</div></article>`).join('') || '<p class="help">No active broadcasts.</p>';
  } catch { $('publicBroadcasts').textContent = 'Could not load broadcasts. Please try again.'; }
}
async function loadMyReports() {
  if (!state.profile) return;
  try {
    const reports = await rows(sb.from('incidents').select('*').eq('reporter_id', state.profile.user_id).eq('is_anon',false).order('created_at', { ascending: false }));
    $('myReports').innerHTML = reports.map((inc) => `<button class="report-card" data-id="${inc.incident_id}"><b>${escapeHtml(inc.title || inc.description)}</b><span class="help">${inc.incident_id.slice(0,8)} · ${STATUS_LABEL[inc.status]} · ${SEVERITY_LABEL[inc.severity] || 'Pending classification'} · ${timeAgo(inc.created_at)}</span></button>`).join('') || '<p class="help">No identified reports yet.</p>';
    $('myReports').querySelectorAll('button').forEach((button) => button.addEventListener('click', () => selectMyReport(button.dataset.id)));
  } catch { $('myReports').textContent = 'Could not load your reports. Please try again.'; }
}
async function selectMyReport(id) {
  state.mySelectedId = id;
  try {
    const [incidents, history] = await Promise.all([rows(sb.from('incidents').select('*').eq('incident_id',id).eq('reporter_id',state.profile.user_id).eq('is_anon',false)), rows(sb.from('incident_updates').select('*').eq('incident_id',id).eq('is_public',true).order('created_at',{ ascending: false }))]);
    if (id !== state.mySelectedId) return;
    const inc = incidents[0]; if (!inc) throw new Error('Report not found.');
    $('myReportDetail').hidden = false;
    $('myReportDetail').innerHTML = `<h3>${escapeHtml(inc.title || 'Report details')}</h3><p class="help">${escapeHtml(inc.incident_id)} · ${STATUS_LABEL[inc.status]}</p><p class="drawer-message">${escapeHtml(inc.description)}</p><p class="help">Location: ${escapeHtml(locationLabel(inc))}</p><h3>Images</h3><div id="myMedia" class="media-gallery"></div><label class="field">Add images<input id="myMediaInput" type="file" accept="image/png,image/jpeg" multiple /></label><button class="btn btn-ghost" id="myMediaBtn">Upload images</button><p id="myMediaHint" class="help" role="status"></p><h3>Updates</h3><div class="timeline">${timelineHtml(history)}</div>`;
    wireMedia(id, 'myMediaInput', 'myMediaBtn', 'myMediaHint', 'myMedia');
    await loadMedia(id, 'myMedia');
  } catch (error) { if (id === state.mySelectedId) { $('myReportDetail').hidden = false; $('myReportDetail').textContent = error.message; } }
}
async function refreshFeeds() { await Promise.all([loadBroadcasts(), loadMyReports(), staffUser() ? loadIncidents() : Promise.resolve()]); }
function subscribeRealtime() {
  state.channel = sb.channel(`sentry-${state.profile?.user_id || 'public'}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'notifications' }, loadBroadcasts);
  if (state.profile) {
    state.channel.on('postgres_changes', { event: '*', schema: 'public', table: 'incidents' }, () => {
      loadMyReports(); if (staffUser()) loadIncidents();
      if (state.selectedId) message('drawerHint', 'Incident changed. Refresh details before editing.');
      if (state.mySelectedId) selectMyReport(state.mySelectedId);
    }).on('postgres_changes', { event: '*', schema: 'public', table: 'incident_updates' }, () => { if (state.mySelectedId) selectMyReport(state.mySelectedId); })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'incident_media' }, () => { if (state.selectedId) loadMedia(state.selectedId,'staffMedia'); if (state.mySelectedId) loadMedia(state.mySelectedId,'myMedia'); });
  }
  state.channel.subscribe((status) => { if (staffUser() && status === 'CHANNEL_ERROR') message('queueHint','Live connection interrupted; periodic refresh remains active.'); });
}
async function loadIncidents() {
  if (!staffUser()) return;
  try {
    const authRequest = state.authRequest;
    const incidents = await rows(sb.from('incidents').select('*').order('created_at',{ ascending: false }));
    if (authRequest !== state.authRequest || !staffUser()) return;
    state.incidents = incidents; incidentMap.update(incidents);
    renderQueue();
    const open = state.incidents.filter((inc) => !['resolved','closed'].includes(inc.status));
    $('statOpen').textContent = open.length; $('statCritical').textContent = open.filter((inc) => inc.severity === 'critical').length;
    message('queueHint','');
  } catch (error) { message('queueHint', `Could not load incidents: ${error.message}`, true); }
}
function renderQueue() {
  const search = $('searchInput').value.trim().toLowerCase();
  const filtered = state.incidents.filter((inc) => (!state.statusFilter || inc.status === state.statusFilter) && (!$('categoryFilter').value || inc.category === $('categoryFilter').value) && (!$('severityFilter').value || inc.severity === $('severityFilter').value) && (!search || [inc.incident_id,inc.title,inc.description,inc.location_text].join(' ').toLowerCase().includes(search)));
  $('queueCount').textContent = `${filtered.length} report${filtered.length === 1 ? '' : 's'}`;
  $('queueList').innerHTML = filtered.map((inc) => `<button class="incident-row ${inc.incident_id === state.selectedId ? 'selected' : ''}" data-id="${inc.incident_id}"><span class="sev-bar sev-${SEVERITY_LABEL[inc.severity] ? inc.severity : 'other'}" title="${SEVERITY_LABEL[inc.severity] || 'Pending'}"></span><span class="row-ref">${inc.incident_id.slice(0,8)}</span><span class="row-category">${CATEGORY_LABEL[inc.category] || 'Pending'}</span><span class="row-summary">${inc.status === 'new' ? '<span class="pulse-dot"></span>' : ''}${escapeHtml(inc.title || inc.description)}</span><span class="row-time">${timeAgo(inc.created_at)}</span></button>`).join('') || '<div class="empty-state">No incidents match this view.</div>';
  $('queueList').querySelectorAll('button').forEach((button) => button.addEventListener('click', () => selectIncident(button.dataset.id)));
}
async function selectIncident(id) {
  state.selectedId = id; const request = ++state.detailRequest; renderQueue();
  try {
    const [incidents, history] = await Promise.all([rows(sb.from('incidents').select('*').eq('incident_id',id)), rows(sb.from('incident_updates').select('*').eq('incident_id',id).order('created_at',{ascending:false}))]);
    if (request !== state.detailRequest || !staffUser()) return;
    if (!incidents[0]) throw new Error('Incident no longer available.');
    renderDrawer(incidents[0], history); $('detailDrawer').classList.add('open');
    await loadMedia(id, 'staffMedia');
  } catch (error) { message('queueHint',error.message,true); }
}
function renderDrawer(inc, history) {
  $('drawerEmpty').hidden = true; $('drawerContent').hidden = false;
  const assigned = state.staff.find((person) => person.user_id === inc.assigned_to);
  const assignees = state.staff.filter((person) => person.account_status === 'active' || person.user_id === inc.assigned_to);
  const assignmentOptions = '<option value="">Unassigned</option>' + (!assigned && inc.assigned_to ? `<option value="${inc.assigned_to}" selected>Current assignee (unavailable)</option>` : '') + assignees.map((person) => `<option value="${person.user_id}" ${person.user_id === inc.assigned_to ? 'selected' : ''}>${escapeHtml(person.name || person.email || person.user_id)} (${escapeHtml(person.role)})${person.account_status !== 'active' ? ' — inactive' : ''}</option>`).join('');
  $('drawerContent').innerHTML = `<button class="drawer-back-btn" id="drawerBackBtn">← Back to queue</button><h2>${escapeHtml(inc.title || `${CATEGORY_LABEL[inc.category] || 'Uncategorised'} report`)}</h2><div class="drawer-ref">${inc.incident_id.slice(0,8)} · ${timeAgo(inc.created_at)}</div>
    <div class="drawer-section"><div class="drawer-section-label">DESCRIPTION</div><div class="drawer-message">${escapeHtml(inc.description)}</div></div>
    <div class="drawer-section"><div class="drawer-meta-row"><span>Severity</span><span>${SEVERITY_LABEL[inc.severity] || 'Pending classification'}</span></div><div class="drawer-meta-row"><span>Location</span><span>${escapeHtml(locationLabel(inc))}</span></div><div class="drawer-meta-row"><span>Anonymous</span><span>${inc.is_anon ? 'Yes' : 'No'}</span></div><div class="drawer-meta-row"><span>Assigned to</span><span>${escapeHtml(assigned?.name || assigned?.email || (inc.assigned_to ? 'Unavailable staff profile' : 'Unassigned'))}</span></div></div>
    <div class="drawer-section"><div class="drawer-section-label">UPDATE</div><label class="field">Status<select class="select-field" id="statusSelect">${optionsHtml(STATUS_LABEL,inc.status)}</select></label><label class="field">Category<select class="select-field" id="categorySelect">${optionsHtml(CATEGORY_LABEL,inc.category,true)}</select></label><label class="field">Severity<select class="select-field" id="severitySelect">${optionsHtml(SEVERITY_LABEL,inc.severity,true)}</select></label><label class="field">Assigned to (admin only)<select class="select-field" id="assigneeSelect" ${state.profile.role !== 'admin' ? 'disabled' : ''}>${assignmentOptions}</select></label><label class="field">Note<textarea class="textarea-field" id="noteInput" rows="3" maxlength="2000" placeholder="Add a staff note"></textarea></label><label class="anon-toggle"><input type="checkbox" id="publicNoteToggle" />Make this note visible to the reporter</label><p class="help">Status, category and severity changes are visible to identified reporters. Assignment history and staff notes stay private.</p><button class="btn btn-primary" id="saveUpdateBtn">Save update</button> <button class="btn btn-ghost" id="refreshDetailBtn">Refresh details</button><p class="help" id="drawerHint" role="status"></p></div>
    <div class="drawer-section"><div class="drawer-section-label">IMAGES</div><div class="media-gallery" id="staffMedia"></div><label class="field">Add images<input type="file" id="staffMediaInput" multiple accept="image/png,image/jpeg" /></label><button class="btn btn-ghost" id="staffMediaBtn">Upload images</button><p class="help" id="staffMediaHint" role="status"></p></div><div class="drawer-section"><div class="drawer-section-label">TIMELINE</div><div class="timeline">${timelineHtml(history)}</div></div>`;
  $('drawerBackBtn').addEventListener('click', () => $('detailDrawer').classList.remove('open'));
  $('refreshDetailBtn').addEventListener('click', () => selectIncident(inc.incident_id));
  $('assigneeSelect').addEventListener('change', () => {
    if ($('assigneeSelect').value && ['new','acknowledged'].includes($('statusSelect').value)) $('statusSelect').value = 'assigned';
    if (!$('assigneeSelect').value && $('statusSelect').value === 'assigned') $('statusSelect').value = 'acknowledged';
  });
  $('saveUpdateBtn').addEventListener('click', async () => {
    const button = $('saveUpdateBtn'); button.disabled = true;
    try {
      message('drawerHint','Saving…');
      const result = await api(`/api/incidents/${inc.incident_id}`, { method: 'PATCH', body: { status: $('statusSelect').value, category: $('categorySelect').value || null, severity: $('severitySelect').value || null, assigned_to: $('assigneeSelect').value || null, note: $('noteInput').value.trim(), is_public: $('publicNoteToggle').checked, expected_updated_at: inc.updated_at } });
      await loadIncidents(); await selectIncident(inc.incident_id); message('drawerHint', result.warning || 'Update saved.');
    } catch (error) { message('drawerHint',error.message,true); }
    finally { button.disabled = false; }
  });
  wireMedia(inc.incident_id, 'staffMediaInput','staffMediaBtn','staffMediaHint','staffMedia');
}
async function loadMedia(id, target) {
  const element = $(target); if (!element) return;
  try {
    const media = await api(`/api/incidents/${id}/media`); if (!element.isConnected) return;
    element.innerHTML = media.map((item) => item.url ? `<a href="${escapeHtml(item.url)}" target="_blank" rel="noopener"><img src="${escapeHtml(item.url)}" alt="Incident attachment" loading="lazy" /></a>` : '<span class="help">Image unavailable</span>').join('') || '<p class="help">No images attached.</p>';
  } catch (error) { element.textContent = error.message; }
}
function wireMedia(id, input, button, hint, target) {
  $(button).addEventListener('click', async () => {
    const control = $(button); control.disabled = true;
    try {
      if (!$(input).files.length) throw new Error('Choose an image first.');
      const form = new FormData(); appendFiles(form, $(input));
      const result = await api(`/api/incidents/${id}/media`, { method: 'POST', body: form });
      message(hint, result.warnings.join(' ') || 'Images uploaded.'); $(input).value = ''; await loadMedia(id,target);
    } catch (error) { message(hint,error.message,true); }
    finally { control.disabled = false; }
  });
}
$('broadcastForm').addEventListener('submit', async (event) => {
  event.preventDefault(); const button = event.submitter; button.disabled = true;
  try {
    const result = await api('/api/broadcasts', { method: 'POST', body: { title: $('broadcastTitle').value.trim(), message: $('broadcastMessage').value.trim(), severity: $('broadcastSeverity').value, hours: Number($('broadcastHours').value) } });
    $('broadcastForm').reset(); message('broadcastHint',result.warning || 'Broadcast published and push notifications sent.'); await loadBroadcasts();
  } catch (error) { message('broadcastHint',error.message,true); }
  finally { button.disabled = false; }
});
let pushEnabled = false;
async function worker() { await navigator.serviceWorker.register('/sw.js'); return navigator.serviceWorker.ready; }
async function updatePushButton() {
  if (!state.profile) return;
  $('pushBtn').disabled = true;
  try {
    if (!window.isSecureContext || !('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) throw new Error('Push requires a supported browser and HTTPS (or localhost).');
    const config = await api('/api/push/config'); if (!config.enabled) throw new Error('Push notifications need server configuration.');
    const registration = await worker(); const subscription = await registration.pushManager.getSubscription();
    pushEnabled = Boolean(subscription);
    if (subscription) await api('/api/push/subscriptions', { method: 'POST', body: subscription.toJSON() });
    $('pushBtn').textContent = pushEnabled ? 'Disable push notifications' : 'Enable push notifications';
    message('pushHint', pushEnabled ? 'Broadcasts and updates to your identified reports are enabled on this device.' : 'Opt in for broadcasts and updates to your reports.');
    $('pushBtn').disabled = false;
  } catch (error) { message('pushHint',error.message,true); }
}
async function disablePush() {
  if (!('serviceWorker' in navigator)) return;
  const registration = await navigator.serviceWorker.getRegistration('/');
  const subscription = await registration?.pushManager.getSubscription();
  if (subscription) {
    await api('/api/push/subscriptions', { method: 'DELETE', body: { endpoint: subscription.endpoint } });
    await subscription.unsubscribe();
  }
  pushEnabled = false;
}
$('pushBtn').addEventListener('click', async () => {
  $('pushBtn').disabled = true;
  try {
    if (pushEnabled) await disablePush();
    else {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') throw new Error('Notifications were not allowed. Change your browser site permissions to enable them.');
      const config = await api('/api/push/config'); const registration = await worker();
      if (!config.enabled) throw new Error('Push is not configured on the server.');
      const raw = atob(config.public_key.replace(/-/g,'+').replace(/_/g,'/'));
      const key = Uint8Array.from(raw, (ch) => ch.charCodeAt(0));
      const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      try { await api('/api/push/subscriptions', { method: 'POST', body: subscription.toJSON() }); }
      catch (error) { await subscription.unsubscribe(); throw error; }
      pushEnabled = true;
    }
    await updatePushButton();
  } catch (error) { message('pushHint',error.message,true); $('pushBtn').disabled = false; }
});
function closeSidebar() { $('sidebar').classList.remove('open'); $('sidebarBackdrop').classList.remove('open'); }
$('menuToggleBtn').addEventListener('click', () => { $('sidebar').classList.add('open'); $('sidebarBackdrop').classList.add('open'); });
$('sidebarCloseBtn').addEventListener('click',closeSidebar); $('sidebarBackdrop').addEventListener('click',closeSidebar);
$('statusNav').addEventListener('click', (event) => {
  const button = event.target.closest('.status-item'); if (!button) return;
  document.querySelectorAll('.status-item').forEach((item) => item.classList.toggle('active',item === button));
  state.statusFilter = button.dataset.status; $('queueTitle').textContent = button.textContent; renderQueue(); closeSidebar();
});
for (const id of ['searchInput','categoryFilter','severityFilter']) $(id).addEventListener('input',renderQueue);
$('refreshBtn').addEventListener('click',refreshFeeds);
function wireModal(overlay, close) {
  $(close).addEventListener('click', () => { $(overlay).hidden = true; });
  $(overlay).addEventListener('click', (event) => { if (event.target === $(overlay)) $(overlay).hidden = true; });
}
wireModal('loginModalOverlay','closeLoginBtn');
$('mapBtn').addEventListener('click', () => { closeSidebar(); incidentMap.open(); });
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') { $('loginModalOverlay').hidden = true; incidentMap.close(); closeSidebar(); } });
setInterval(() => { $('clock').textContent = new Date().toLocaleTimeString('en-GB'); },1000);
// A fallback for interrupted realtime connections and broadcast expiry.
setInterval(() => { if (!document.hidden) refreshFeeds(); },30000);
sb.auth.onAuthStateChange((event, session) => {
  if (event === 'SIGNED_OUT') setTimeout(() => applySession(null).catch(console.error),0);
  if (event === 'SIGNED_IN' && !state.authBusy) setTimeout(() => { if (session?.user.id !== state.profile?.user_id) applySession(session).catch((error) => message('submitResult',error.message,true)); },0);
});
sb.auth.getSession().then(({ data, error }) => { if (error) throw error; return applySession(data.session); }).catch((error) => { showPublicView(); message('submitResult',error.message,true); loadBroadcasts(); });
