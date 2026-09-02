const express = require('express');
const { db } = require('../db');
const { loadCourse, loadChapter } = require('../db/lookups');
const { wrap, requireBody, readString, readInteger } = require('../util/validate');
const subLessonsRouter = require('./subLessons');

// mergeParams lets this router read :courseId from the mount path in courses.js.
const router = express.Router({ mergeParams: true });

const stmt = {
  listByCourse: db.prepare(
    'SELECT * FROM chapters WHERE course_id = ? ORDER BY order_index ASC, id ASC',
  ),
  get: db.prepare('SELECT * FROM chapters WHERE id = ?'),
  nextIndex: db.prepare(
    'SELECT COALESCE(MAX(order_index), -1) + 1 AS next FROM chapters WHERE course_id = ?',
  ),
  insert: db.prepare(
    'INSERT INTO chapters (course_id, title, order_index) VALUES (@course_id, @title, @order_index)',
  ),
  update: db.prepare('UPDATE chapters SET title = @title, order_index = @order_index WHERE id = @id'),
  remove: db.prepare('DELETE FROM chapters WHERE id = ?'),
};

router.get('/', wrap((req, res) => {
  const course = loadCourse(req.params.courseId);
  res.json(stmt.listByCourse.all(course.id));
}));

router.post('/', wrap((req, res) => {
  const course = loadCourse(req.params.courseId);
  const body = requireBody(req);
  const title = readString(body, 'title', { required: true });
  // Omitting order_index appends to the end of the course.
  const orderIndex = readInteger(body, 'order_index') ?? stmt.nextIndex.get(course.id).next;

  const info = stmt.insert.run({ course_id: course.id, title, order_index: orderIndex });
  res.status(201).json(stmt.get.get(info.lastInsertRowid));
}));

router.get('/:chapterId', wrap((req, res) => {
  const course = loadCourse(req.params.courseId);
  res.json(loadChapter(req.params.chapterId, course));
}));

const writeChapter = (replace) => wrap((req, res) => {
  const course = loadCourse(req.params.courseId);
  const chapter = loadChapter(req.params.chapterId, course);
  const body = requireBody(req);

  const title = readString(body, 'title', { required: replace });
  const orderIndex = readInteger(body, 'order_index');

  stmt.update.run({
    id: chapter.id,
    title: title ?? chapter.title,
    order_index: orderIndex ?? chapter.order_index,
  });
  res.json(stmt.get.get(chapter.id));
});

router.put('/:chapterId', writeChapter(true));
router.patch('/:chapterId', writeChapter(false));

router.delete('/:chapterId', wrap((req, res) => {
  const course = loadCourse(req.params.courseId);
  const chapter = loadChapter(req.params.chapterId, course);
  stmt.remove.run(chapter.id);
  res.status(204).end();
}));

router.use('/:chapterId/sub-lessons', subLessonsRouter);

module.exports = router;
