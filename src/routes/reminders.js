const express = require('express');
const { db } = require('../db');
const { loadCourse, loadReminder } = require('../db/lookups');
const {
  wrap, requireBody, readString, readDate, readBoolean, readId, now,
} = require('../util/validate');
const { toReminder } = require('../util/serialize');

// Top level, not nested under a course: a reminder may have no course at all.
const router = express.Router();

const stmt = {
  listAll: db.prepare('SELECT * FROM reminder ORDER BY remind_date ASC, id ASC'),
  listByCourse: db.prepare(
    'SELECT * FROM reminder WHERE course_id = ? ORDER BY remind_date ASC, id ASC',
  ),
  get: db.prepare('SELECT * FROM reminder WHERE id = ?'),
  insert: db.prepare(`
    INSERT INTO reminder (course_id, text, remind_date, is_done, created_at)
    VALUES (@course_id, @text, @remind_date, @is_done, @created_at)
  `),
  update: db.prepare(`
    UPDATE reminder
    SET text = @text, remind_date = @remind_date, is_done = @is_done
    WHERE id = @id
  `),
  remove: db.prepare('DELETE FROM reminder WHERE id = ?'),
};

router.get('/', wrap((req, res) => {
  // ?course_id=<id> narrows to one course; omitting it returns everything,
  // general reminders included.
  if (req.query.course_id !== undefined) {
    const course = loadCourse(readId(req.query.course_id, 'course_id'));
    return res.json(stmt.listByCourse.all(course.id).map(toReminder));
  }
  return res.json(stmt.listAll.all().map(toReminder));
}));

router.post('/', wrap((req, res) => {
  const body = requireBody(req);

  const text = readString(body, 'text', { required: true, maxLength: 300 });
  const remindDate = readDate(body, 'remind_date', { required: true });
  const isDone = readBoolean(body, 'is_done') ?? false;

  // A missing or null course_id means a general reminder; anything else has to
  // point at a course that exists.
  let courseId = null;
  if (body.course_id !== undefined && body.course_id !== null) {
    courseId = loadCourse(readId(body.course_id, 'course_id')).id;
  }

  const info = stmt.insert.run({
    course_id: courseId,
    text,
    remind_date: remindDate,
    is_done: isDone ? 1 : 0,
    created_at: now(),
  });
  res.status(201).json(toReminder(stmt.get.get(info.lastInsertRowid)));
}));

router.get('/:reminderId', wrap((req, res) => {
  res.json(toReminder(loadReminder(req.params.reminderId)));
}));

// PATCH merges. Passing only { is_done } is the done/not-done toggle: an
// explicit boolean rather than a flip, so repeated clicks converge.
router.patch('/:reminderId', wrap((req, res) => {
  const reminder = loadReminder(req.params.reminderId);
  const body = requireBody(req);

  const text = readString(body, 'text', { maxLength: 300 });
  const remindDate = readDate(body, 'remind_date');
  const isDone = readBoolean(body, 'is_done');

  stmt.update.run({
    id: reminder.id,
    text: text ?? reminder.text,
    remind_date: remindDate ?? reminder.remind_date,
    is_done: isDone === undefined ? reminder.is_done : (isDone ? 1 : 0),
  });
  res.json(toReminder(stmt.get.get(reminder.id)));
}));

router.delete('/:reminderId', wrap((req, res) => {
  const reminder = loadReminder(req.params.reminderId);
  stmt.remove.run(reminder.id);
  res.status(204).end();
}));

module.exports = router;
