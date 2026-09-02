const express = require('express');
const { db } = require('../db');
const { loadCourse, loadNote } = require('../db/lookups');
const { wrap, requireBody, readString, now } = require('../util/validate');

const router = express.Router({ mergeParams: true });

const stmt = {
  listByCourse: db.prepare(
    'SELECT * FROM notes WHERE course_id = ? ORDER BY created_at DESC, id DESC',
  ),
  get: db.prepare('SELECT * FROM notes WHERE id = ?'),
  insert: db.prepare(`
    INSERT INTO notes (course_id, content, created_at, updated_at)
    VALUES (@course_id, @content, @created_at, @updated_at)
  `),
  update: db.prepare('UPDATE notes SET content = @content, updated_at = @updated_at WHERE id = @id'),
  remove: db.prepare('DELETE FROM notes WHERE id = ?'),
};

router.get('/', wrap((req, res) => {
  const course = loadCourse(req.params.courseId);
  res.json(stmt.listByCourse.all(course.id));
}));

router.post('/', wrap((req, res) => {
  const course = loadCourse(req.params.courseId);
  const body = requireBody(req);
  // A note is free text or a pasted link; only the length cap differs from a title.
  const content = readString(body, 'content', { required: true, maxLength: 20000 });

  const timestamp = now();
  const info = stmt.insert.run({
    course_id: course.id,
    content,
    created_at: timestamp,
    updated_at: timestamp,
  });
  res.status(201).json(stmt.get.get(info.lastInsertRowid));
}));

router.get('/:noteId', wrap((req, res) => {
  const course = loadCourse(req.params.courseId);
  res.json(loadNote(req.params.noteId, course));
}));

const writeNote = (replace) => wrap((req, res) => {
  const course = loadCourse(req.params.courseId);
  const note = loadNote(req.params.noteId, course);
  const body = requireBody(req);

  const content = readString(body, 'content', { required: replace, maxLength: 20000 });

  stmt.update.run({
    id: note.id,
    content: content ?? note.content,
    updated_at: now(),
  });
  res.json(stmt.get.get(note.id));
});

router.put('/:noteId', writeNote(true));
router.patch('/:noteId', writeNote(false));

router.delete('/:noteId', wrap((req, res) => {
  const course = loadCourse(req.params.courseId);
  const note = loadNote(req.params.noteId, course);
  stmt.remove.run(note.id);
  res.status(204).end();
}));

module.exports = router;
