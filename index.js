require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const db = require('./db');
const { classifyIncident } = require('./classify');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const DEPARTMENTS = {
  fire: 'Fire & Rescue',
  police: 'Police',
  medical: 'Medical / EMS',
  child_services: 'Child Protection Services',
  other: 'General Response',
};

function makeReference() {
  const year = new Date().getFullYear();
  const row = db
    .prepare(`SELECT COUNT(*) as n FROM incidents WHERE reference LIKE ?`)
    .get(`INC-${year}-%`);
  const seq = String(row.n + 1).padStart(4, '0');
  return `INC-${year}-${seq}`;
}

// Create a new incident from an inbound message (web form today; same
// endpoint shape would work for an SMS/email webhook later).
app.post('/api/incidents', async (req, res) => {
  const { message, sender_name, sender_contact, source } = req.body;

  if (!message || !message.trim()) {
    return res.status(400).json({ error: 'message is required' });
  }

  try {
    const classification = await classifyIncident(message.trim());
    const reference = makeReference();

    const stmt = db.prepare(`
      INSERT INTO incidents
        (reference, source, sender_name, sender_contact, raw_message,
         category, severity, summary, location, department, status, confidence, ai_notes)
      VALUES (@reference, @source, @sender_name, @sender_contact, @raw_message,
              @category, @severity, @summary, @location, @department, 'new', @confidence, @ai_notes)
    `);

    const info = stmt.run({
      reference,
      source: source || 'web',
      sender_name: sender_name || null,
      sender_contact: sender_contact || null,
      raw_message: message.trim(),
      category: classification.category,
      severity: classification.severity,
      summary: classification.summary,
      location: classification.location,
      department: DEPARTMENTS[classification.category] || 'General Response',
      confidence: classification.confidence,
      ai_notes: classification.ai_notes,
    });

    const incident = db.prepare('SELECT * FROM incidents WHERE id = ?').get(info.lastInsertRowid);
    res.status(201).json(incident);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create incident' });
  }
});

app.get('/api/incidents', (req, res) => {
  const { status, category, severity } = req.query;
  let query = 'SELECT * FROM incidents WHERE 1=1';
  const params = [];

  if (status) { query += ' AND status = ?'; params.push(status); }
  if (category) { query += ' AND category = ?'; params.push(category); }
  if (severity) { query += ' AND severity = ?'; params.push(severity); }

  query += ' ORDER BY created_at DESC';
  const incidents = db.prepare(query).all(...params);
  res.json(incidents);
});

app.get('/api/incidents/:id', (req, res) => {
  const incident = db.prepare('SELECT * FROM incidents WHERE id = ?').get(req.params.id);
  if (!incident) return res.status(404).json({ error: 'Not found' });
  const history = db
    .prepare('SELECT * FROM status_history WHERE incident_id = ? ORDER BY created_at ASC')
    .all(req.params.id);
  res.json({ ...incident, history });
});

// Update status / department / notes on an incident, logging each change.
app.patch('/api/incidents/:id', (req, res) => {
  const incident = db.prepare('SELECT * FROM incidents WHERE id = ?').get(req.params.id);
  if (!incident) return res.status(404).json({ error: 'Not found' });

  const { status, department, note } = req.body;
  const logStmt = db.prepare(`
    INSERT INTO status_history (incident_id, field, old_value, new_value, note)
    VALUES (?, ?, ?, ?, ?)
  `);

  if (status && status !== incident.status) {
    logStmt.run(incident.id, 'status', incident.status, status, note || null);
  }
  if (department && department !== incident.department) {
    logStmt.run(incident.id, 'department', incident.department, department, note || null);
  }
  if (!status && !department && note) {
    logStmt.run(incident.id, 'note', null, note, note);
  }

  db.prepare(`
    UPDATE incidents SET
      status = COALESCE(?, status),
      department = COALESCE(?, department),
      updated_at = datetime('now')
    WHERE id = ?
  `).run(status || null, department || null, incident.id);

  const updated = db.prepare('SELECT * FROM incidents WHERE id = ?').get(incident.id);
  res.json(updated);
});

app.get('/api/stats', (req, res) => {
  const byStatus = db.prepare('SELECT status, COUNT(*) as n FROM incidents GROUP BY status').all();
  const byCategory = db.prepare('SELECT category, COUNT(*) as n FROM incidents GROUP BY category').all();
  const bySeverity = db.prepare('SELECT severity, COUNT(*) as n FROM incidents GROUP BY severity').all();
  res.json({ byStatus, byCategory, bySeverity });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Incident reporting server running at http://localhost:${PORT}`);
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log('No ANTHROPIC_API_KEY set — falling back to keyword classification.');
  }
});
