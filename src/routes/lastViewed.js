const express = require('express');
const { db } = require('../db');
const { loadCourse, loadChapter } = require('../db/lookups');
const { wrap, requireBody, readId, now } = require('../util/validate');

const router = express.Router();

const stmt = {
  // INNER JOIN on courses: if the course is gone the bookmark is worthless, so
  // the row simply does not come back. LEFT JOIN on chapters so a course-level
  // bookmark (chapter_id NULL) still resolves.
  get: db.prepare(`
    SELECT
      lv.course_id,
      c.name       AS course_name,
      lv.chapter_id,
      ch.title     AS chapter_title,
      lv.updated_at
    FROM last_viewed lv
    JOIN courses c        ON c.id = lv.course_id
    LEFT JOIN chapters ch ON ch.id = lv.chapter_id AND ch.course_id = lv.course_id
    WHERE lv.id = 1
  `),
  upsert: db.prepare(`
    INSERT INTO last_viewed (id, course_id, chapter_id, updated_at)
    VALUES (1, @course_id, @chapter_id, @updated_at)
    ON CONFLICT(id) DO UPDATE SET
      course_id  = excluded.course_id,
      chapter_id = excluded.chapter_id,
      updated_at = excluded.updated_at
  `),
};

router.get('/', wrap((req, res) => {
  const row = stmt.get.get();
  // Nothing recorded yet, or the course has since been deleted.
  if (!row) return res.json(null);

  // Belt-and-braces: ON DELETE SET NULL should already have cleared a deleted
  // chapter, but never hand back an id whose title could not be resolved.
  if (row.chapter_id !== null && row.chapter_title === null) {
    row.chapter_id = null;
  }
  return res.json(row);
}));

router.post('/', wrap((req, res) => {
  const body = requireBody(req);
  // readId first so a bad value names the body field, not the route param.
  const course = loadCourse(readId(body.course_id, 'course_id'));

  let chapterId = null;
  if (body.chapter_id !== undefined && body.chapter_id !== null) {
    // Validates that the chapter exists *and* belongs to this course.
    chapterId = loadChapter(readId(body.chapter_id, 'chapter_id'), course).id;
  }

  stmt.upsert.run({ course_id: course.id, chapter_id: chapterId, updated_at: now() });
  res.status(200).json(stmt.get.get());
}));

module.exports = router;
