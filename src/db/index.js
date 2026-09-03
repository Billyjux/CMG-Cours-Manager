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

/**
 * Adds a column to an existing table if it is not there yet.
 *
 * schema.sql only ever runs CREATE TABLE IF NOT EXISTS, so a column added to a
 * table definition later never reaches a database that already exists. This
 * closes that gap on boot. Additive columns only: SQLite's ALTER TABLE cannot
 * drop or retype, and anything more involved needs a real migration file.
 */
function addColumnIfMissing(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (columns.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

// Live-timer flag. Existing rows take the DEFAULT, so study sessions logged
// before the timer existed simply read as not live tracked.
addColumnIfMissing(
  'study_session',
  'is_live_tracked',
  'INTEGER DEFAULT 0 CHECK (is_live_tracked IN (0, 1))',
);

// Completion day, for the activity summary. Existing rows keep NULL: there is
// no honest way to say when they were ticked, and guessing would draw activity
// on days that saw none.
addColumnIfMissing('sub_lessons', 'completed_on', 'TEXT');

module.exports = { db, DB_FILE };
