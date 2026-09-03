PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS courses (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  description TEXT,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chapters (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id   INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  order_index INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sub_lessons (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  chapter_id  INTEGER NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  is_complete INTEGER NOT NULL DEFAULT 0 CHECK (is_complete IN (0, 1)),
  order_index INTEGER NOT NULL DEFAULT 0,
  -- The plain YYYY-MM-DD day the lesson was finished, in the user's own
  -- timezone, or NULL while it is outstanding. A day rather than a timestamp,
  -- matching study_session.date, because the only question ever asked of it is
  -- "what happened on this square of the calendar". Nullable also because rows
  -- ticked off before this column existed have no day to give; they simply do
  -- not appear in the activity summary. Kept in step with the ALTER TABLE in
  -- index.js, which adds it to databases created before it.
  completed_on TEXT
);

CREATE TABLE IF NOT EXISTS notes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id  INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  content    TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Single-row bookmark for "resume where I left off". The CHECK pins it to one
-- row so an upsert on id = 1 is the only way to write it. The cascades do the
-- cleanup work: deleting the course drops the row, deleting the chapter just
-- clears the chapter half, so a stale id can never be handed back.
CREATE TABLE IF NOT EXISTS last_viewed (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  course_id  INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  chapter_id INTEGER REFERENCES chapters(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL
);

-- Manually logged study time. `date` is a plain YYYY-MM-DD calendar day (the
-- day the user studied, in their own timezone) and is deliberately not a
-- timestamp; `created_at` records when the row was entered. `hours` is REAL so
-- half-hours and quarter-hours round-trip exactly as typed.
CREATE TABLE IF NOT EXISTS study_session (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id  INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  date       TEXT NOT NULL,
  hours      REAL NOT NULL CHECK (hours > 0 AND hours <= 24),
  note       TEXT,
  created_at TEXT NOT NULL,
  -- Nullable on purpose: rows written before the live timer existed carry NULL,
  -- which reads as "not live tracked". Kept in step with the ALTER TABLE in
  -- index.js, which adds this column to databases created before it.
  is_live_tracked INTEGER DEFAULT 0 CHECK (is_live_tracked IN (0, 1))
);

-- Coursework deadlines. `due_date` is a plain YYYY-MM-DD calendar day, not a
-- timestamp: "due Friday" means the whole day, and urgency is judged against
-- the user's local today rather than a UTC instant.
CREATE TABLE IF NOT EXISTS deadline (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id  INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  title      TEXT NOT NULL,
  due_date   TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Standalone reminders. course_id is nullable: a reminder is either tied to a
-- course or general ("renew library card"). Tied ones cascade away with their
-- course, matching notes, deadlines and study sessions.
CREATE TABLE IF NOT EXISTS reminder (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id   INTEGER REFERENCES courses(id) ON DELETE CASCADE,
  text        TEXT NOT NULL,
  remind_date TEXT NOT NULL,
  is_done     INTEGER NOT NULL DEFAULT 0 CHECK (is_done IN (0, 1)),
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chapters_course     ON chapters(course_id, order_index);
CREATE INDEX IF NOT EXISTS idx_sub_lessons_chapter ON sub_lessons(chapter_id, order_index);
CREATE INDEX IF NOT EXISTS idx_notes_course        ON notes(course_id, created_at);
CREATE INDEX IF NOT EXISTS idx_study_session_course ON study_session(course_id, date);
CREATE INDEX IF NOT EXISTS idx_deadline_course      ON deadline(course_id, due_date);
CREATE INDEX IF NOT EXISTS idx_reminder_course      ON reminder(course_id, remind_date);
