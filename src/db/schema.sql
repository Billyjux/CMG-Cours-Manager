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
  order_index INTEGER NOT NULL DEFAULT 0
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

CREATE INDEX IF NOT EXISTS idx_chapters_course     ON chapters(course_id, order_index);
CREATE INDEX IF NOT EXISTS idx_sub_lessons_chapter ON sub_lessons(chapter_id, order_index);
CREATE INDEX IF NOT EXISTS idx_notes_course        ON notes(course_id, created_at);
