const { db } = require('./index');
const { notFound } = require('../middleware/errors');
const { readId } = require('../util/validate');

const stmt = {
  course: db.prepare('SELECT * FROM courses WHERE id = ?'),
  chapter: db.prepare('SELECT * FROM chapters WHERE id = ?'),
  subLesson: db.prepare('SELECT * FROM sub_lessons WHERE id = ?'),
  note: db.prepare('SELECT * FROM notes WHERE id = ?'),
};

function loadCourse(courseId) {
  const id = readId(courseId, 'courseId');
  const course = stmt.course.get(id);
  if (!course) throw notFound(`Course ${id} not found`);
  return course;
}

/** A chapter that exists but belongs to another course is a 404 on this path. */
function loadChapter(chapterId, course) {
  const id = readId(chapterId, 'chapterId');
  const chapter = stmt.chapter.get(id);
  if (!chapter || chapter.course_id !== course.id) {
    throw notFound(`Chapter ${id} not found in course ${course.id}`);
  }
  return chapter;
}

function loadSubLesson(subLessonId, chapter) {
  const id = readId(subLessonId, 'subLessonId');
  const subLesson = stmt.subLesson.get(id);
  if (!subLesson || subLesson.chapter_id !== chapter.id) {
    throw notFound(`Sub-lesson ${id} not found in chapter ${chapter.id}`);
  }
  return subLesson;
}

function loadNote(noteId, course) {
  const id = readId(noteId, 'noteId');
  const note = stmt.note.get(id);
  if (!note || note.course_id !== course.id) {
    throw notFound(`Note ${id} not found in course ${course.id}`);
  }
  return note;
}

module.exports = { loadCourse, loadChapter, loadSubLesson, loadNote };
