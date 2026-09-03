const express = require('express');
const { db } = require('../db');
const { loadCourse } = require('../db/lookups');
const {
  wrap, requireBody, readString, readOptionalText, now,
} = require('../util/validate');
const chaptersRouter = require('./chapters');
const notesRouter = require('./notes');
const studySessionsRouter = require('./studySessions');
const deadlinesRouter = require('./deadlines');

const router = express.Router();

const stmt = {
  list: db.prepare('SELECT * FROM courses ORDER BY created_at DESC, id DESC'),
  get: db.prepare('SELECT * FROM courses WHERE id = ?'),
  insert: db.prepare(
    'INSERT INTO courses (name, description, created_at) VALUES (@name, @description, @created_at)',
  ),
  update: db.prepare('UPDATE courses SET name = @name, description = @description WHERE id = @id'),
  remove: db.prepare('DELETE FROM courses WHERE id = ?'),
  progress: db.prepare(`
    SELECT
      COUNT(sl.id)                                  AS total,
      COALESCE(SUM(sl.is_complete), 0)              AS completed
    FROM chapters c
    LEFT JOIN sub_lessons sl ON sl.chapter_id = c.id
    WHERE c.course_id = ?
  `),
  studyTime: db.prepare(`
    SELECT
      COALESCE(SUM(hours), 0) AS total_hours,
      COUNT(*)                AS session_count
    FROM study_session
    WHERE course_id = ?
  `),
};

router.get('/', wrap((req, res) => {
  res.json(stmt.list.all());
}));

router.post('/', wrap((req, res) => {
  const body = requireBody(req);
  const name = readString(body, 'name', { required: true });
  const description = readOptionalText(body, 'description') ?? null;

  const info = stmt.insert.run({ name, description, created_at: now() });
  res.status(201).json(stmt.get.get(info.lastInsertRowid));
}));

router.get('/:courseId', wrap((req, res) => {
  res.json(loadCourse(req.params.courseId));
}));

// PUT replaces, PATCH merges; both share a handler that knows which it is.
const writeCourse = (replace) => wrap((req, res) => {
  const course = loadCourse(req.params.courseId);
  const body = requireBody(req);

  const name = readString(body, 'name', { required: replace });
  const description = readOptionalText(body, 'description');

  stmt.update.run({
    id: course.id,
    name: name ?? course.name,
    description: replace
      ? (description ?? null)
      : (description === undefined ? course.description : description),
  });
  res.json(stmt.get.get(course.id));
});

router.put('/:courseId', writeCourse(true));
router.patch('/:courseId', writeCourse(false));

router.delete('/:courseId', wrap((req, res) => {
  const course = loadCourse(req.params.courseId);
  stmt.remove.run(course.id);
  res.status(204).end();
}));

router.get('/:courseId/progress', wrap((req, res) => {
  const course = loadCourse(req.params.courseId);
  const { total, completed } = stmt.progress.get(course.id);

  res.json({
    course_id: course.id,
    total_sub_lessons: total,
    completed_sub_lessons: completed,
    // A course with no sub-lessons is 0% done, not a division by zero.
    progress_percent: total === 0 ? 0 : Math.round((completed / total) * 1000) / 10,
  });
}));

router.get('/:courseId/study-time', wrap((req, res) => {
  const course = loadCourse(req.params.courseId);
  const { total_hours: totalHours, session_count: sessionCount } = stmt.studyTime.get(course.id);

  res.json({
    course_id: course.id,
    session_count: sessionCount,
    // Summing REALs drifts (0.1 + 0.2), so round to the 2dp the API accepts.
    total_hours: Math.round(totalHours * 100) / 100,
  });
}));

router.use('/:courseId/chapters', chaptersRouter);
router.use('/:courseId/notes', notesRouter);
router.use('/:courseId/study-sessions', studySessionsRouter);
router.use('/:courseId/deadlines', deadlinesRouter);

module.exports = router;
