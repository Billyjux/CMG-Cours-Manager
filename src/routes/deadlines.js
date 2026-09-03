const express = require('express');
const { db } = require('../db');
const { loadCourse, loadDeadline } = require('../db/lookups');
const {
  wrap, requireBody, readString, readDate, now,
} = require('../util/validate');

const router = express.Router({ mergeParams: true });

const stmt = {
  // Chronological, soonest first — which puts anything overdue at the top,
  // where it belongs. id breaks ties within a day.
  listByCourse: db.prepare(
    'SELECT * FROM deadline WHERE course_id = ? ORDER BY due_date ASC, id ASC',
  ),
  get: db.prepare('SELECT * FROM deadline WHERE id = ?'),
  insert: db.prepare(`
    INSERT INTO deadline (course_id, title, due_date, created_at)
    VALUES (@course_id, @title, @due_date, @created_at)
  `),
  update: db.prepare('UPDATE deadline SET title = @title, due_date = @due_date WHERE id = @id'),
  remove: db.prepare('DELETE FROM deadline WHERE id = ?'),
};

router.get('/', wrap((req, res) => {
  const course = loadCourse(req.params.courseId);
  res.json(stmt.listByCourse.all(course.id));
}));

router.post('/', wrap((req, res) => {
  const course = loadCourse(req.params.courseId);
  const body = requireBody(req);

  const title = readString(body, 'title', { required: true, maxLength: 200 });
  const dueDate = readDate(body, 'due_date', { required: true });

  const info = stmt.insert.run({
    course_id: course.id,
    title,
    due_date: dueDate,
    created_at: now(),
  });
  res.status(201).json(stmt.get.get(info.lastInsertRowid));
}));

router.get('/:deadlineId', wrap((req, res) => {
  const course = loadCourse(req.params.courseId);
  res.json(loadDeadline(req.params.deadlineId, course));
}));

// PATCH merges: any field left out keeps its current value.
router.patch('/:deadlineId', wrap((req, res) => {
  const course = loadCourse(req.params.courseId);
  const deadline = loadDeadline(req.params.deadlineId, course);
  const body = requireBody(req);

  const title = readString(body, 'title', { maxLength: 200 });
  const dueDate = readDate(body, 'due_date');

  stmt.update.run({
    id: deadline.id,
    title: title ?? deadline.title,
    due_date: dueDate ?? deadline.due_date,
  });
  res.json(stmt.get.get(deadline.id));
}));

router.delete('/:deadlineId', wrap((req, res) => {
  const course = loadCourse(req.params.courseId);
  const deadline = loadDeadline(req.params.deadlineId, course);
  stmt.remove.run(deadline.id);
  res.status(204).end();
}));

module.exports = router;
