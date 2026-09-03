const express = require('express');
const { db } = require('../db');
const { loadCourse, loadChapter, loadSubLesson } = require('../db/lookups');
const {
  wrap, requireBody, readString, readInteger, readBoolean, localDay,
} = require('../util/validate');
const { toSubLesson } = require('../util/serialize');

const router = express.Router({ mergeParams: true });

const stmt = {
  listByChapter: db.prepare(
    'SELECT * FROM sub_lessons WHERE chapter_id = ? ORDER BY order_index ASC, id ASC',
  ),
  get: db.prepare('SELECT * FROM sub_lessons WHERE id = ?'),
  nextIndex: db.prepare(
    'SELECT COALESCE(MAX(order_index), -1) + 1 AS next FROM sub_lessons WHERE chapter_id = ?',
  ),
  insert: db.prepare(`
    INSERT INTO sub_lessons (chapter_id, title, is_complete, order_index, completed_on)
    VALUES (@chapter_id, @title, @is_complete, @order_index, @completed_on)
  `),
  update: db.prepare(`
    UPDATE sub_lessons
    SET title = @title, is_complete = @is_complete, order_index = @order_index,
        completed_on = @completed_on
    WHERE id = @id
  `),
  setComplete: db.prepare(
    'UPDATE sub_lessons SET is_complete = @is_complete, completed_on = @completed_on WHERE id = @id',
  ),
  remove: db.prepare('DELETE FROM sub_lessons WHERE id = ?'),
};

/**
 * The day a sub-lesson was finished, or null while it is outstanding.
 *
 * Only a transition into complete stamps a new day. Re-sending
 * `{"is_complete": true}` for something already ticked keeps the day it was
 * really finished, so a double click or a retry — which this API is built to
 * make harmless — cannot drag last month's lesson into today's activity square.
 */
function completionDay(current, nextComplete) {
  if (!nextComplete) return null;
  if (current && current.is_complete === 1) return current.completed_on;
  return localDay();
}

/** Every route here is scoped by course -> chapter, so resolve both up front. */
function context(req) {
  const course = loadCourse(req.params.courseId);
  return loadChapter(req.params.chapterId, course);
}

router.get('/', wrap((req, res) => {
  const chapter = context(req);
  res.json(stmt.listByChapter.all(chapter.id).map(toSubLesson));
}));

router.post('/', wrap((req, res) => {
  const chapter = context(req);
  const body = requireBody(req);
  const title = readString(body, 'title', { required: true });
  const isComplete = readBoolean(body, 'is_complete') ?? false;
  const orderIndex = readInteger(body, 'order_index') ?? stmt.nextIndex.get(chapter.id).next;

  const info = stmt.insert.run({
    chapter_id: chapter.id,
    title,
    is_complete: isComplete ? 1 : 0,
    order_index: orderIndex,
    completed_on: completionDay(null, isComplete),
  });
  res.status(201).json(toSubLesson(stmt.get.get(info.lastInsertRowid)));
}));

router.get('/:subLessonId', wrap((req, res) => {
  const chapter = context(req);
  res.json(toSubLesson(loadSubLesson(req.params.subLessonId, chapter)));
}));

const writeSubLesson = (replace) => wrap((req, res) => {
  const chapter = context(req);
  const subLesson = loadSubLesson(req.params.subLessonId, chapter);
  const body = requireBody(req);

  const title = readString(body, 'title', { required: replace });
  const isComplete = readBoolean(body, 'is_complete');
  const orderIndex = readInteger(body, 'order_index');

  const nextComplete = isComplete === undefined
    ? (replace ? false : subLesson.is_complete === 1)
    : isComplete;

  stmt.update.run({
    id: subLesson.id,
    title: title ?? subLesson.title,
    is_complete: nextComplete ? 1 : 0,
    order_index: orderIndex ?? (replace ? 0 : subLesson.order_index),
    completed_on: completionDay(subLesson, nextComplete),
  });
  res.json(toSubLesson(stmt.get.get(subLesson.id)));
});

router.put('/:subLessonId', writeSubLesson(true));
router.patch('/:subLessonId', writeSubLesson(false));

// Dedicated toggle: flips when no body is sent, or sets an explicit is_complete.
router.patch('/:subLessonId/complete', wrap((req, res) => {
  const chapter = context(req);
  const subLesson = loadSubLesson(req.params.subLessonId, chapter);

  const requested = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
    ? readBoolean(req.body, 'is_complete')
    : undefined;
  const next = requested === undefined ? subLesson.is_complete === 0 : requested;

  stmt.setComplete.run({
    id: subLesson.id,
    is_complete: next ? 1 : 0,
    completed_on: completionDay(subLesson, next),
  });
  res.json(toSubLesson(stmt.get.get(subLesson.id)));
}));

router.delete('/:subLessonId', wrap((req, res) => {
  const chapter = context(req);
  const subLesson = loadSubLesson(req.params.subLessonId, chapter);
  stmt.remove.run(subLesson.id);
  res.status(204).end();
}));

module.exports = router;
