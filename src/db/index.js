const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DB_FILE = process.env.DB_FILE
  ? path.resolve(process.env.DB_FILE)
  : path.join(__dirname, '..', '..', 'data', 'courses.db');

fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });

const db = new Database(DB_FILE);

// WAL keeps reads fast while a write is in flight; foreign_keys must be set
// per-connection in SQLite or ON DELETE CASCADE silently does nothing.
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Applied at require-time, not from server.js: the routers call db.prepare() as
// they load, and prepare() fails if the tables do not exist yet.
db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));

module.exports = { db, DB_FILE };
