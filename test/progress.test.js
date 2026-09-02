const { test, before, after, beforeEach, describe } = require('node:test');
const assert = require('node:assert/strict');
const { start, reset, cleanup } = require('./helpers/harness');
const { makeCourse, makeChapter, makeSubLesson, makeTree } = require('./helpers/fixtures');

let request;
let close;

before(async () => { ({ request, close } = await start()); });
after(async () => { await close(); cleanup(); });
beforeEach(reset);

const setComplete = (courseId, chapterId, lessonId, isComplete) =>
  request(
    'PATCH',
    `/api/courses/${courseId}/chapters/${chapterId}/sub-lessons/${lessonId}/complete`,
    { is_complete: isComplete },
  );

const progressOf = async (courseId) => (await request('GET', `/api/courses/${courseId}/progress`)).body;

describe('GET /api/courses/:courseId/progress', () => {
  test('a course with no chapters is 0%, not a division by zero', async () => {
    const course = await makeCourse(request);

    const res = await request('GET', `/api/courses/${course.id}/progress`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, {
      course_id: course.id,
      total_sub_lessons: 0,
      completed_sub_lessons: 0,
      progress_percent: 0,
    });
  });

  test('chapters with no sub-lessons still count as 0%', async () => {
    const course = await makeCourse(request);
    await makeChapter(request, course.id);
    await makeChapter(request, course.id);

    const progress = await progressOf(course.id);
    assert.equal(progress.total_sub_lessons, 0);
    assert.equal(progress.progress_percent, 0);
  });

  test('walks 0 -> 25 -> 50 -> 25 as sub-lessons are ticked and unticked', async () => {
    const { course, chapter, lessons } = await makeTree(request, 4);

    assert.equal((await progressOf(course.id)).progress_percent, 0);

    await setComplete(course.id, chapter.id, lessons[0].id, true);
    assert.equal((await progressOf(course.id)).progress_percent, 25);

    await setComplete(course.id, chapter.id, lessons[1].id, true);
    const half = await progressOf(course.id);
    assert.equal(half.progress_percent, 50);
    assert.equal(half.completed_sub_lessons, 2);
    assert.equal(half.total_sub_lessons, 4);

    await setComplete(course.id, chapter.id, lessons[1].id, false);
    assert.equal((await progressOf(course.id)).progress_percent, 25);
  });

  test('rounds to one decimal server-side: 1 of 3 is 33.3, not 33', async () => {
    const { course, chapter, lessons } = await makeTree(request, 3);
    await setComplete(course.id, chapter.id, lessons[0].id, true);

    assert.equal((await progressOf(course.id)).progress_percent, 33.3);
  });

  test('2 of 3 is 66.7', async () => {
    const { course, chapter, lessons } = await makeTree(request, 3);
    await setComplete(course.id, chapter.id, lessons[0].id, true);
    await setComplete(course.id, chapter.id, lessons[1].id, true);

    assert.equal((await progressOf(course.id)).progress_percent, 66.7);
  });

  test('all complete is exactly 100', async () => {
    const { course, chapter, lessons } = await makeTree(request, 3);
    for (const lesson of lessons) {
      await setComplete(course.id, chapter.id, lesson.id, true);
    }
    assert.equal((await progressOf(course.id)).progress_percent, 100);
  });

  test('counts sub-lessons across every chapter of the course', async () => {
    const course = await makeCourse(request);
    const one = await makeChapter(request, course.id, { title: 'One' });
    const two = await makeChapter(request, course.id, { title: 'Two' });
    const a = await makeSubLesson(request, course.id, one.id);
    await makeSubLesson(request, course.id, two.id);

    await setComplete(course.id, one.id, a.id, true);

    const progress = await progressOf(course.id);
    assert.equal(progress.total_sub_lessons, 2);
    assert.equal(progress.progress_percent, 50);
  });

  test('recomputes over the remainder when a chapter is deleted', async () => {
    const course = await makeCourse(request);
    const keep = await makeChapter(request, course.id, { title: 'Keep' });
    const drop = await makeChapter(request, course.id, { title: 'Drop' });
    const kept = await makeSubLesson(request, course.id, keep.id);
    await makeSubLesson(request, course.id, keep.id);
    await makeSubLesson(request, course.id, drop.id);
    await makeSubLesson(request, course.id, drop.id);

    await setComplete(course.id, keep.id, kept.id, true);
    assert.equal((await progressOf(course.id)).progress_percent, 25);

    await request('DELETE', `/api/courses/${course.id}/chapters/${drop.id}`);

    const after = await progressOf(course.id);
    assert.equal(after.total_sub_lessons, 2);
    assert.equal(after.progress_percent, 50);
  });

  test('ignores sub-lessons belonging to a different course', async () => {
    const mine = await makeTree(request, 2);
    const theirs = await makeTree(request, 4);
    await setComplete(theirs.course.id, theirs.chapter.id, theirs.lessons[0].id, true);

    const progress = await progressOf(mine.course.id);
    assert.equal(progress.total_sub_lessons, 2);
    assert.equal(progress.completed_sub_lessons, 0);
  });

  test('404s for a course that does not exist', async () => {
    const res = await request('GET', '/api/courses/9999/progress');
    assert.equal(res.status, 404);
  });
});
