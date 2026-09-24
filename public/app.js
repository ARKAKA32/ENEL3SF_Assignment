const sb = window.supabase.createClient(
  window.SENTRY_CONFIG.SUPABASE_URL,
  window.SENTRY_CONFIG.SUPABASE_ANON_KEY
);

const CATEGORY_LABEL = { fire: 'Fire', police: 'Police', medical: 'Medical', child_services: 'Child Services', other: 'Other' };
const STATUS_LABEL = { new: 'New', acknowledged: 'Acknowledged', assigned: 'Assigned', in_progress: 'In progress', resolved: 'Resolved', closed: 'Closed' };
const STATUS_FLOW = ['new', 'acknowledged', 'assigned', 'in_progress', 'resolved', 'closed'];
const SEV_CLASS = { critical: 'sev-critical', high: 'sev-high', medium: 'sev-medium', low: 'sev-low' };

let state = { statusFilter: '', incidents: [], selectedId: null };

// ============ AUTH GATE ============
async function init() {
  const { data: { session } } = await sb.auth.getSession();
  if (session) {
    const isStaff = await checkStaff(session.user.id);
    if (isStaff) return showDashboard();
  }
  showPublicView();
}

async function checkStaff(userId) {
  const { data, error } = await sb.from('users').select('role').eq('user_id', userId).single();
  if (error || !data) return false;
  return ['operator', 'responder', 'admin'].includes(data.role);
}

function showPublicView() {
  document.getElementById('publicView').hidden = false;
  document.getElementById('dashboardView').hidden = true;
}

function showDashboard() {
  document.getElementById('publicView').hidden = true;
  document.getElementById('dashboardView').hidden = false;
  tickClock();
  setInterval(tickClock, 1000);
  loadIncidents();
  subscribeRealtime();
}

// ============ PUBLIC REPORT FORM ============
let capturedLocation = null;

document.getElementById('useLocationBtn').addEventListener('click', () => {
  const status = document.getElementById('locationStatus');
  if (!navigator.geolocation) {
    status.textContent = 'Location not supported on this device.';
    return;
  }
  status.textContent = 'Getting location…';
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      capturedLocation = { latitude: pos.coords.latitude, longitude: pos.coords.longitude, source: 'gps' };
      status.textContent = 'Location captured ✓';
    },
    () => { status.textContent = 'Could not get location — you can still submit without it.'; },
    { timeout: 8000 }
  );
});

document.getElementById('reportForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const message = document.getElementById('messageInput').value.trim();
  if (!message) return;

  const isAnon = document.getElementById('anonToggle').checked;
  const btn = document.getElementById('submitBtn');
  const resultBox = document.getElementById('submitResult');
  btn.disabled = true;
  resultBox.textContent = 'Submitting…';

  try {
    const { data: { session } } = await sb.auth.getSession();
    const incidentId = crypto.randomUUID();

    const { error } = await sb.from('incidents').insert({
      incident_id: incidentId,
      reporter_id: isAnon ? null : (session?.user?.id || null),
      description: message,
      status: 'new',
      is_anon: isAnon,
      latitude: capturedLocation?.latitude || null,
      longitude: capturedLocation?.longitude || null,
      location_source: capturedLocation?.source || null,
    });

    if (error) throw error;

    // Trigger AI classification (server-side, holds the Claude API key)
    await fetch('/api/classify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ incident_id: incidentId, message }),
    });

    resultBox.textContent = `Report submitted. Reference: ${incidentId.slice(0, 8)}`;
    resultBox.classList.remove('error');
    document.getElementById('reportForm').reset();
    capturedLocation = null;
    document.getElementById('locationStatus').textContent = '';
  } catch (err) {
    console.error(err);
    resultBox.textContent = 'Something went wrong — please try again.';
    resultBox.classList.add('error');
  } finally {
    btn.disabled = false;
  }
});

// ============ STAFF LOGIN ============
const loginOverlay = document.getElementById('loginModalOverlay');
document.getElementById('staffLoginBtn').addEventListener('click', () => { loginOverlay.hidden = false; });
document.getElementById('closeLoginBtn').addEventListener('click', () => { loginOverlay.hidden = true; });
loginOverlay.addEventListener('click', (e) => { if (e.target === loginOverlay) loginOverlay.hidden = true; });

document.getElementById('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = document.getElementById('loginEmail').value.trim();
  const password = document.getElementById('loginPassword').value;
  const hint = document.getElementById('loginHint');
  hint.textContent = 'Logging in…';

  const { data, error } = await sb.auth.signInWithPassword({ email, password });
  if (error) { hint.textContent = error.message; return; }

  const isStaff = await checkStaff(data.user.id);
  if (!isStaff) {
    await sb.auth.signOut();
    hint.textContent = 'This account does not have dashboard access.';
    return;
  }

  loginOverlay.hidden = true;
  showDashboard();
});

document.getElementById('logoutBtn').addEventListener('click', async () => {
  await sb.auth.signOut();
  location.reload();
});

// ============ DASHBOARD ============
function tickClock() {
  document.getElementById('clock').textContent = new Date().toLocaleTimeString('en-GB');
}

async function loadIncidents() {
  let query = sb.from('incidents').select('*').order('created_at', { ascending: false });
  if (state.statusFilter) query = query.eq('status', state.statusFilter);
  const { data, error } = await query;
  if (error) { console.error(error); return; }
  state.incidents = data;
  renderQueue();
  renderStats();
}

function subscribeRealtime() {
  sb.channel('incidents-changes')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'incidents' }, () => loadIncidents())
    .subscribe();
}

function timeAgo(iso) {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  return hrs < 24 ? `${hrs}h ago` : `${Math.floor(hrs / 24)}d ago`;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

function renderQueue() {
  const list = document.getElementById('queueList');
  document.getElementById('queueCount').textContent = `${state.incidents.length} report${state.incidents.length === 1 ? '' : 's'}`;

  if (!state.incidents.length) {
    list.innerHTML = '<div class="empty-state">No incidents match this view.</div>';
    return;
  }

  list.innerHTML = state.incidents.map((inc) => `
    <div class="incident-row ${inc.incident_id === state.selectedId ? 'selected' : ''}" data-id="${inc.incident_id}">
      <div class="sev-bar ${SEV_CLASS[inc.severity] || 'sev-other'}"></div>
      <div class="row-ref">${inc.incident_id.slice(0, 8)}</div>
      <div class="row-category">${CATEGORY_LABEL[inc.category] || 'Pending'}</div>
      <div class="row-summary">${inc.status === 'new' ? '<span class="pulse-dot"></span>' : ''}${escapeHtml(inc.title || inc.description)}</div>
      <div class="row-time">${timeAgo(inc.created_at)}</div>
    </div>
  `).join('');

  list.querySelectorAll('.incident-row').forEach((row) => {
    row.addEventListener('click', () => selectIncident(row.dataset.id));
  });
}

function renderStats() {
  const open = state.incidents.filter((i) => !['resolved', 'closed'].includes(i.status)).length;
  const critical = state.incidents.filter((i) => i.severity === 'critical').length;
  document.getElementById('statOpen').textContent = open;
  document.getElementById('statCritical').textContent = critical;
}

async function selectIncident(id) {
  state.selectedId = id;
  renderQueue();

  const { data: incident } = await sb.from('incidents').select('*').eq('incident_id', id).single();
  const { data: history } = await sb.from('incident_updates').select('*').eq('incident_id', id).order('created_at', { ascending: false });

  renderDrawer(incident, history || []);
  document.getElementById('detailDrawer').classList.add('open');
}

function renderDrawer(inc, history) {
  document.getElementById('drawerEmpty').hidden = true;
  const content = document.getElementById('drawerContent');
  content.hidden = false;

  const statusOptions = STATUS_FLOW.map((s) => `<option value="${s}" ${s === inc.status ? 'selected' : ''}>${STATUS_LABEL[s]}</option>`).join('');
  const timeline = history.map((h) => `
    <div class="timeline-item">
      <div class="timeline-time">${new Date(h.created_at).toLocaleString()}</div>
      <div><b>${h.update_type}</b> ${h.old_status ? `${h.old_status} &rarr; ${h.new_status}` : (h.note || '')}</div>
    </div>
  `).join('') || '<div class="timeline-item">No updates yet.</div>';

  content.innerHTML = `
    <button class="drawer-back-btn" id="drawerBackBtn">&larr; Back to queue</button>
    <h2>${CATEGORY_LABEL[inc.category] || 'Uncategorised'} report</h2>
    <div class="drawer-ref">${inc.incident_id.slice(0, 8)} &middot; ${timeAgo(inc.created_at)}</div>

    <div class="drawer-section">
      <div class="drawer-section-label">DESCRIPTION</div>
      <div class="drawer-message">${escapeHtml(inc.description)}</div>
    </div>

    <div class="drawer-section">
      <div class="drawer-meta-row"><span>Severity</span><span>${inc.severity || 'Pending classification'}</span></div>
      <div class="drawer-meta-row"><span>Location</span><span>${inc.latitude ? `${inc.latitude.toFixed(4)}, ${inc.longitude.toFixed(4)}` : 'Not provided'}</span></div>
      <div class="drawer-meta-row"><span>Anonymous</span><span>${inc.is_anon ? 'Yes' : 'No'}</span></div>
    </div>

    <div class="drawer-section">
      <div class="drawer-section-label">UPDATE</div>
      <select class="select-field" id="statusSelect">${statusOptions}</select>
      <textarea class="textarea-field" id="noteInput" rows="2" placeholder="Add a note (optional)"></textarea>
      <button class="btn btn-primary" id="saveUpdateBtn" style="width:100%">Save update</button>
    </div>

    <div class="drawer-section">
      <div class="drawer-section-label">TIMELINE</div>
      <div class="timeline">${timeline}</div>
    </div>
  `;

  document.getElementById('drawerBackBtn').addEventListener('click', () => {
    document.getElementById('detailDrawer').classList.remove('open');
  });

  document.getElementById('saveUpdateBtn').addEventListener('click', async () => {
    const newStatus = document.getElementById('statusSelect').value;
    const note = document.getElementById('noteInput').value.trim();
    const { data: { session } } = await sb.auth.getSession();

    if (newStatus !== inc.status) {
      await sb.from('incidents').update({ status: newStatus, updated_at: new Date().toISOString() }).eq('incident_id', inc.incident_id);
      await sb.from('incident_updates').insert({
        incident_id: inc.incident_id, user_id: session.user.id,
        update_type: 'STATUS_CHANGE', old_status: inc.status, new_status: newStatus, note: note || null,
      });
    } else if (note) {
      await sb.from('incident_updates').insert({
        incident_id: inc.incident_id, user_id: session.user.id, update_type: 'NOTE', note,
      });
    }

    await loadIncidents();
    selectIncident(inc.incident_id);
  });
}

// ============ Filters / mobile nav (same as before) ============
const sidebar = document.getElementById('sidebar');
const sidebarBackdrop = document.getElementById('sidebarBackdrop');
function openSidebar() { sidebar.classList.add('open'); sidebarBackdrop.classList.add('open'); }
function closeSidebar() { sidebar.classList.remove('open'); sidebarBackdrop.classList.remove('open'); }
document.getElementById('menuToggleBtn').addEventListener('click', openSidebar);
document.getElementById('sidebarCloseBtn').addEventListener('click', closeSidebar);
sidebarBackdrop.addEventListener('click', closeSidebar);

document.getElementById('statusNav').addEventListener('click', (e) => {
  const btn = e.target.closest('.status-item');
  if (!btn) return;
  document.querySelectorAll('.status-item').forEach((b) => b.classList.remove('active'));
  btn.classList.add('active');
  state.statusFilter = btn.dataset.status;
  document.getElementById('queueTitle').textContent = btn.textContent;
  loadIncidents();
  closeSidebar();
});

init();
