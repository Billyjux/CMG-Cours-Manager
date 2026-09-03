// Builders for the nested shapes the API deals in. Each takes the `request`
// helper from the harness and returns the created row, so a test can set up a
// course -> chapter -> sub-lessons tree in one line.

const assert = require('node:assert/strict');

/** Asserts the status and returns the body, so a bad setup fails loudly. */
function expect(res, status) {
  assert.equal(res.status, status, `expected ${status}, got ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body;
}

async function makeCourse(request, payload = {}) {
  const res = await request('POST', '/api/courses', { name: 'Test course', ...payload });
  return expect(res, 201);
}

async function makeChapter(request, courseId, payload = {}) {
  const res = await request('POST', `/api/courses/${courseId}/chapters`, {
    title: 'Test chapter',
    ...payload,
  });
  return expect(res, 201);
}

async function makeSubLesson(request, courseId, chapterId, payload = {}) {
  const res = await request(
    'POST',
    `/api/courses/${courseId}/chapters/${chapterId}/sub-lessons`,
    { title: 'Test sub-lesson', ...payload },
  );
  return expect(res, 201);
}

async function makeNote(request, courseId, payload = {}) {
  const res = await request('POST', `/api/courses/${courseId}/notes`, {
    content: 'Test note',
    ...payload,
  });
  return expect(res, 201);
}

async function makeStudySession(request, courseId, payload = {}) {
  const res = await request('POST', `/api/courses/${courseId}/study-sessions`, {
    date: '2026-09-01',
    hours: 1.5,
    ...payload,
  });
  return expect(res, 201);
}

async function makeDeadline(request, courseId, payload = {}) {
  const res = await request('POST', `/api/courses/${courseId}/deadlines`, {
    title: 'Test deadline',
    due_date: '2026-09-15',
    ...payload,
  });
  return expect(res, 201);
}

async function makeReminder(request, payload = {}) {
  const res = await request('POST', '/api/reminders', {
    text: 'Test reminder',
    remind_date: '2026-09-15',
    ...payload,
  });
  return expect(res, 201);
}

/** A course with one chapter holding `count` sub-lessons, all incomplete. */
async function makeTree(request, count = 4) {
  const course = await makeCourse(request);
  const chapter = await makeChapter(request, course.id);
  const lessons = [];
  for (let i = 1; i <= count; i += 1) {
    lessons.push(await makeSubLesson(request, course.id, chapter.id, { title: `Lesson ${i}` }));
  }
  return { course, chapter, lessons };
}

module.exports = {
  expect,
  makeCourse,
  makeChapter,
  makeSubLesson,
  makeNote,
  makeStudySession,
  makeDeadline,
  makeReminder,
  makeTree,
};
