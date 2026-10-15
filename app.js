const SEV_CLASS = { critical: 'sev-critical', high: 'sev-high', medium: 'sev-medium', low: 'sev-low' };
const CATEGORY_LABEL = {
  fire: 'Fire', police: 'Police', medical: 'Medical',
  child_services: 'Child Services', other: 'Other',
};
const STATUS_LABEL = {
  new: 'New', acknowledged: 'Acknowledged', assigned: 'Assigned',
  in_progress: 'In progress', resolved: 'Resolved', closed: 'Closed',
};
const STATUS_FLOW = ['new', 'acknowledged', 'assigned', 'in_progress', 'resolved', 'closed'];
const DEPARTMENTS = ['Fire & Rescue', 'Police', 'Medical / EMS', 'Child Protection Services', 'General Response'];

let state = { statusFilter: '', categoryFilter: '', incidents: [], selectedId: null };

// ---- Clock ----
function tickClock() {
  document.getElementById('clock').textContent = new Date().toLocaleTimeString('en-GB');
}
setInterval(tickClock, 1000);
tickClock();

// ---- Fetch + render ----
async function loadIncidents() {
  const params = new URLSearchParams();
  if (state.statusFilter) params.set('status', state.statusFilter);
  if (state.categoryFilter) params.set('category', state.categoryFilter);

  const res = await fetch(`/api/incidents?${params.toString()}`);
  state.incidents = await res.json();
  renderQueue();
  renderStats();
}

function timeAgo(iso) {
  const diffMs = Date.now() - new Date(iso + 'Z').getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function renderQueue() {
  const list = document.getElementById('queueList');
  document.getElementById('queueCount').textContent = `${state.incidents.length} report${state.incidents.length === 1 ? '' : 's'}`;

  if (!state.incidents.length) {
    list.innerHTML = '<div class="empty-state">No incidents match this view.</div>';
    return;
  }

  list.innerHTML = state.incidents.map((inc) => `
    <div class="incident-row ${inc.id === state.selectedId ? 'selected' : ''}" data-id="${inc.id}">
      <div class="sev-bar ${SEV_CLASS[inc.severity] || 'sev-other'}"></div>
      <div class="row-ref">${inc.reference}</div>
      <div class="row-category">${CATEGORY_LABEL[inc.category] || inc.category}</div>
      <div class="row-summary">${inc.status === 'new' ? '<span class="pulse-dot"></span>' : ''}${escapeHtml(inc.summary || inc.raw_message)}</div>
      <div class="row-dept">${inc.department}</div>
      <div class="row-time">${timeAgo(inc.created_at)}</div>
    </div>
  `).join('');

  list.querySelectorAll('.incident-row').forEach((row) => {
    row.addEventListener('click', () => selectIncident(Number(row.dataset.id)));
  });
}

function renderStats() {
  const open = state.incidents.filter((i) => !['resolved', 'closed'].includes(i.status)).length;
  const critical = state.incidents.filter((i) => i.severity === 'critical').length;
  const today = new Date().toISOString().slice(0, 10);
  const resolvedToday = state.incidents.filter((i) => i.status === 'resolved' && i.updated_at.startsWith(today)).length;
  document.getElementById('statOpen').textContent = open;
  document.getElementById('statCritical').textContent = critical;
  document.getElementById('statResolved').textContent = resolvedToday;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

// ---- Detail drawer ----
async function selectIncident(id) {
  state.selectedId = id;
  renderQueue();

  const res = await fetch(`/api/incidents/${id}`);
  const inc = await res.json();
  renderDrawer(inc);
  detailDrawer.classList.add('open'); // full-screen overlay on mobile; no-op on desktop
}

function renderDrawer(inc) {
  document.getElementById('drawerEmpty').hidden = true;
  const content = document.getElementById('drawerContent');
  content.hidden = false;

  const statusOptions = STATUS_FLOW.map((s) =>
    `<option value="${s}" ${s === inc.status ? 'selected' : ''}>${STATUS_LABEL[s]}</option>`).join('');
  const deptOptions = DEPARTMENTS.map((d) =>
    `<option value="${d}" ${d === inc.department ? 'selected' : ''}>${d}</option>`).join('');

  const timeline = (inc.history || []).slice().reverse().map((h) => `
    <div class="timeline-item">
      <div class="timeline-time">${new Date(h.created_at + 'Z').toLocaleString()}</div>
      <div><b>${h.field}</b> ${h.old_value ? `${h.old_value} &rarr; ` : ''}${h.new_value || ''}</div>
    </div>
  `).join('') || '<div class="timeline-item">No updates yet.</div>';

  content.innerHTML = `
    <button class="drawer-back-btn" id="drawerBackBtn">&larr; Back to queue</button>
    <h2>${CATEGORY_LABEL[inc.category] || inc.category} report</h2>
    <div class="drawer-ref">${inc.reference} &middot; ${timeAgo(inc.created_at)}</div>

    <div class="drawer-section">
      <div class="drawer-section-label">ORIGINAL MESSAGE</div>
      <div class="drawer-message">${escapeHtml(inc.raw_message)}</div>
    </div>

    ${inc.summary ? `
    <div class="drawer-section">
      <div class="drawer-section-label">AI SUMMARY</div>
      <div class="drawer-summary">${escapeHtml(inc.summary)}</div>
    </div>` : ''}

    <div class="drawer-section">
      <div class="drawer-meta-row"><span>Severity</span><span>${inc.severity}</span></div>
      <div class="drawer-meta-row"><span>Location</span><span>${inc.location || 'Not specified'}</span></div>
      <div class="drawer-meta-row"><span>Reported by</span><span>${inc.sender_name || 'Anonymous'}</span></div>
      <div class="drawer-meta-row"><span>Contact</span><span>${inc.sender_contact || '&mdash;'}</span></div>
      <div class="drawer-meta-row"><span>Confidence</span><span>${inc.confidence != null ? Math.round(inc.confidence * 100) + '%' : '&mdash;'}</span></div>
      ${inc.ai_notes ? `<div class="drawer-meta-row"><span>AI note</span><span>${escapeHtml(inc.ai_notes)}</span></div>` : ''}
    </div>

    <div class="drawer-section">
      <div class="drawer-section-label">UPDATE</div>
      <select class="select-field" id="statusSelect">${statusOptions}</select>
      <select class="select-field" id="deptSelect">${deptOptions}</select>
      <textarea class="textarea-field" id="noteInput" rows="2" placeholder="Add a note (optional)"></textarea>
      <button class="btn btn-primary" id="saveUpdateBtn" style="width:100%">Save update</button>
    </div>

    <div class="drawer-section">
      <div class="drawer-section-label">TIMELINE</div>
      <div class="timeline">${timeline}</div>
    </div>
  `;

  document.getElementById('drawerBackBtn').addEventListener('click', closeDrawerMobile);

  document.getElementById('saveUpdateBtn').addEventListener('click', async () => {
    const status = document.getElementById('statusSelect').value;
    const department = document.getElementById('deptSelect').value;
    const note = document.getElementById('noteInput').value.trim();

    await fetch(`/api/incidents/${inc.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status, department, note: note || undefined }),
    });

    await loadIncidents();
    selectIncident(inc.id);
  });
}

// ---- Mobile sidebar toggle ----
const sidebar = document.getElementById('sidebar');
const sidebarBackdrop = document.getElementById('sidebarBackdrop');

function openSidebar() {
  sidebar.classList.add('open');
  sidebarBackdrop.classList.add('open');
}
function closeSidebar() {
  sidebar.classList.remove('open');
  sidebarBackdrop.classList.remove('open');
}
document.getElementById('menuToggleBtn').addEventListener('click', openSidebar);
document.getElementById('sidebarCloseBtn').addEventListener('click', closeSidebar);
sidebarBackdrop.addEventListener('click', closeSidebar);

// ---- Mobile detail drawer open/close ----
const detailDrawer = document.getElementById('detailDrawer');
function closeDrawerMobile() {
  detailDrawer.classList.remove('open');
}

// ---- Filters ----
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

document.getElementById('categoryLegend').addEventListener('click', (e) => {
  const btn = e.target.closest('.legend-item');
  if (!btn) return;
  document.querySelectorAll('.legend-item').forEach((b) => b.classList.remove('active'));
  btn.classList.add('active');
  state.categoryFilter = btn.dataset.category;
  loadIncidents();
  closeSidebar();
});

// ---- New report modal ----
const overlay = document.getElementById('reportModalOverlay');
document.getElementById('openReportBtn').addEventListener('click', () => { overlay.hidden = false; });
document.getElementById('closeReportBtn').addEventListener('click', () => { overlay.hidden = true; });
overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.hidden = true; });

document.getElementById('reportForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const message = document.getElementById('messageInput').value.trim();
  if (!message) return;

  const btn = document.getElementById('submitReportBtn');
  const hint = document.getElementById('submitHint');
  btn.disabled = true;
  hint.textContent = 'Classifying with AI\u2026';

  try {
    const res = await fetch('/api/incidents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message,
        sender_name: document.getElementById('nameInput').value.trim() || null,
        sender_contact: document.getElementById('contactInput').value.trim() || null,
        source: 'web',
      }),
    });
    const incident = await res.json();
    hint.textContent = '';
    overlay.hidden = true;
    document.getElementById('reportForm').reset();
    await loadIncidents();
    selectIncident(incident.id);
  } catch (err) {
    hint.textContent = 'Something went wrong. Try again.';
  } finally {
    btn.disabled = false;
  }
});

// ---- Init ----
loadIncidents();
setInterval(loadIncidents, 15000);
