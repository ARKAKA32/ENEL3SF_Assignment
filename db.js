const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'incidents.db'));

db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS incidents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reference TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL DEFAULT 'web',
  sender_name TEXT,
  sender_contact TEXT,
  raw_message TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'other',
  severity TEXT NOT NULL DEFAULT 'medium',
  summary TEXT,
  location TEXT,
  department TEXT NOT NULL DEFAULT 'unassigned',
  status TEXT NOT NULL DEFAULT 'new',
  confidence REAL,
  ai_notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS status_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  incident_id INTEGER NOT NULL REFERENCES incidents(id),
  field TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

module.exports = db;
