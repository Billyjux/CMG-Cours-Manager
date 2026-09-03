const express = require('express');
const { db } = require('../db');
const { loadCourse, loadStudySession } = require('../db/lookups');
const {
  wrap, requireBody, readString, readNumber, readDate, readBoolean, now,
} = require('../util/validate');
const { toStudySession } = require('../util/serialize');

const router = express.Router({ mergeParams: true });

const stmt = {
  // Newest day first; id breaks ties so several sessions on one day keep a
  // stable, most-recently-entered-first order.
  listByCourse: db.prepare(
    'SELECT * FROM study_session WHERE course_id = ? ORDER BY date DESC, id DESC',
  ),
  get: db.prepare('SELECT * FROM study_session WHERE id = ?'),
  insert: db.prepare(`
    INSERT INTO study_session (course_id, date, hours, note, created_at, is_live_tracked)
    VALUES (@course_id, @date, @hours, @note, @created_at, @is_live_tracked)
  `),
  update: db.prepare(
    'UPDATE study_session SET date = @date, hours = @hours, note = @note WHERE id = @id',
  ),
  remove: db.prepare('DELETE FROM study_session WHERE id = ?'),
};

router.get('/', wrap((req, res) => {
  const course = loadCourse(req.params.courseId);
  res.json(stmt.listByCourse.all(course.id).map(toStudySession));
}));

router.post('/', wrap((req, res) => {
  const course = loadCourse(req.params.courseId);
  const body = requireBody(req);

  const date = readDate(body, 'date', { required: true });
  const hours = readNumber(body, 'hours', { required: true, min: 0, max: 24 });
  const note = readString(body, 'note', { maxLength: 500 }) ?? null;
  // Set by the live timer when it stops; manual entries leave it false.
  const isLiveTracked = readBoolean(body, 'is_live_tracked') ?? false;

  const info = stmt.insert.run({
    course_id: course.id,
    date,
    hours,
    note,
    created_at: now(),
    is_live_tracked: isLiveTracked ? 1 : 0,
  });
  res.status(201).json(toStudySession(stmt.get.get(info.lastInsertRowid)));
}));

router.get('/:sessionId', wrap((req, res) => {
  const course = loadCourse(req.params.courseId);
  res.json(toStudySession(loadStudySession(req.params.sessionId, course)));
}));

// PATCH merges: any field left out keeps its current value. `note` accepts an
// explicit null to clear it.
router.patch('/:sessionId', wrap((req, res) => {
  const course = loadCourse(req.params.courseId);
  const session = loadStudySession(req.params.sessionId, course);
  const body = requireBody(req);

  const date = readDate(body, 'date');
  const hours = readNumber(body, 'hours', { min: 0, max: 24 });
  const note = body.note === null ? null : readString(body, 'note', { maxLength: 500 });

  stmt.update.run({
    id: session.id,
    date: date ?? session.date,
    hours: hours ?? session.hours,
    note: note === undefined ? session.note : note,
  });
  res.json(toStudySession(stmt.get.get(session.id)));
}));

router.delete('/:sessionId', wrap((req, res) => {
  const course = loadCourse(req.params.courseId);
  const session = loadStudySession(req.params.sessionId, course);
  stmt.remove.run(session.id);
  res.status(204).end();
}));

module.exports = router;
