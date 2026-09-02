const { test, before, after, beforeEach, describe } = require('node:test');
const assert = require('node:assert/strict');
const { start, reset, cleanup, db } = require('./helpers/harness');
const { makeCourse, makeChapter, makeSubLesson } = require('./helpers/fixtures');

let request;
let close;

before(async () => { ({ request, close } = await start()); });
after(async () => { await close(); cleanup(); });
beforeEach(reset);

const lessonsPath = (courseId, chapterId) =>
  `/api/courses/${courseId}/chapters/${chapterId}/sub-lessons`;

describe('is_complete crosses the API as a real JSON boolean', () => {
  test('defaults to false on create, never 0', async () => {
    const course = await makeCourse(request);
    const chapter = await makeChapter(request, course.id);
    const lesson = await makeSubLesson(request, course.id, chapter.id);

    assert.equal(lesson.is_complete, false);
    assert.equal(typeof lesson.is_complete, 'boolean');
  });

  test('is stored as 0/1 underneath', async () => {
    const course = await makeCourse(request);
    const chapter = await makeChapter(request, course.id);
    const lesson = await makeSubLesson(request, course.id, chapter.id, { is_complete: true });

    assert.equal(lesson.is_complete, true);
    const row = db.prepare('SELECT is_complete FROM sub_lessons WHERE id = ?').get(lesson.id);
    assert.equal(row.is_complete, 1);
  });

  test('stays a boolean through GET one, GET list, PATCH and the toggle', async () => {
    const course = await makeCourse(request);
    const chapter = await makeChapter(request, course.id);
    const lesson = await makeSubLesson(request, course.id, chapter.id, { is_complete: true });
    const base = lessonsPath(course.id, chapter.id);

    const one = await request('GET', `${base}/${lesson.id}`);
    assert.equal(one.body.is_complete, true);

    const list = await request('GET', base);
    assert.equal(list.body[0].is_complete, true);

    const patched = await request('PATCH', `${base}/${lesson.id}`, { title: 'Renamed' });
    assert.equal(patched.body.is_complete, true);

    const toggled = await request('PATCH', `${base}/${lesson.id}/complete`);
    assert.equal(toggled.body.is_complete, false);
    assert.equal(typeof toggled.body.is_complete, 'boolean');
  });

  test('rejects a non-boolean is_complete on create', async () => {
    const course = await makeCourse(request);
    const chapter = await makeChapter(request, course.id);

    const res = await request('POST', lessonsPath(course.id, chapter.id), {
      title: 'Bad',
      is_complete: 'yes',
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /"is_complete" must be a boolean/);
  });
});

describe('PATCH .../complete', () => {
  test('flips when no body is sent', async () => {
    const course = await makeCourse(request);
    const chapter = await makeChapter(request, course.id);
    const lesson = await makeSubLesson(request, course.id, chapter.id);
    const path = `${lessonsPath(course.id, chapter.id)}/${lesson.id}/complete`;

    const first = await request('PATCH', path);
    assert.equal(first.status, 200);
    assert.equal(first.body.is_complete, true);

    const second = await request('PATCH', path);
    assert.equal(second.body.is_complete, false);
  });

  test('an explicit boolean is idempotent: repeats converge on the same state', async () => {
    const course = await makeCourse(request);
    const chapter = await makeChapter(request, course.id);
    const lesson = await makeSubLesson(request, course.id, chapter.id);
    const path = `${lessonsPath(course.id, chapter.id)}/${lesson.id}/complete`;

    // This is what the UI sends, precisely so a double click cannot desync.
    for (let i = 0; i < 3; i += 1) {
      const res = await request('PATCH', path, { is_complete: true });
      assert.equal(res.status, 200);
      assert.equal(res.body.is_complete, true);
    }

    const off = await request('PATCH', path, { is_complete: false });
    assert.equal(off.body.is_complete, false);
  });

  test('rejects a non-boolean is_complete', async () => {
    const course = await makeCourse(request);
    const chapter = await makeChapter(request, course.id);
    const lesson = await makeSubLesson(request, course.id, chapter.id);

    const res = await request(
      'PATCH',
      `${lessonsPath(course.id, chapter.id)}/${lesson.id}/complete`,
      { is_complete: 1 },
    );
    assert.equal(res.status, 400);
    assert.match(res.body.error, /"is_complete" must be a boolean/);
  });

  test('leaves the title and order_index alone', async () => {
    const course = await makeCourse(request);
    const chapter = await makeChapter(request, course.id);
    const lesson = await makeSubLesson(request, course.id, chapter.id, {
      title: 'Keep me',
      order_index: 4,
    });

    const res = await request(
      'PATCH',
      `${lessonsPath(course.id, chapter.id)}/${lesson.id}/complete`,
      { is_complete: true },
    );
    assert.equal(res.body.title, 'Keep me');
    assert.equal(res.body.order_index, 4);
  });
});

describe('ordering', () => {
  test('an omitted order_index appends to the end of the chapter', async () => {
    const course = await makeCourse(request);
    const chapter = await makeChapter(request, course.id);
    const a = await makeSubLesson(request, course.id, chapter.id, { title: 'A' });
    const b = await makeSubLesson(request, course.id, chapter.id, { title: 'B' });
    const c = await makeSubLesson(request, course.id, chapter.id, { title: 'C' });

    assert.deepEqual([a.order_index, b.order_index, c.order_index], [0, 1, 2]);
  });

  test('numbering is per chapter, not per course', async () => {
    const course = await makeCourse(request);
    const one = await makeChapter(request, course.id, { title: 'One' });
    const two = await makeChapter(request, course.id, { title: 'Two' });
    await makeSubLesson(request, course.id, one.id);
    await makeSubLesson(request, course.id, one.id);
    const firstOfTwo = await makeSubLesson(request, course.id, two.id);

    assert.equal(firstOfTwo.order_index, 0);
  });

  test('the list sorts by order_index, then id', async () => {
    const course = await makeCourse(request);
    const chapter = await makeChapter(request, course.id);
    const last = await makeSubLesson(request, course.id, chapter.id, { order_index: 9 });
    const first = await makeSubLesson(request, course.id, chapter.id, { order_index: 1 });
    const tied = await makeSubLesson(request, course.id, chapter.id, { order_index: 1 });

    const res = await request('GET', lessonsPath(course.id, chapter.id));
    assert.deepEqual(res.body.map((l) => l.id), [first.id, tied.id, last.id]);
  });
});

describe('PUT replaces, PATCH merges', () => {
  test('PUT resets an omitted is_complete and order_index', async () => {
    const course = await makeCourse(request);
    const chapter = await makeChapter(request, course.id);
    const lesson = await makeSubLesson(request, course.id, chapter.id, {
      is_complete: true,
      order_index: 6,
    });

    const res = await request('PUT', `${lessonsPath(course.id, chapter.id)}/${lesson.id}`, {
      title: 'Replaced',
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.title, 'Replaced');
    assert.equal(res.body.is_complete, false);
    assert.equal(res.body.order_index, 0);
  });

  test('PATCH preserves an omitted is_complete and order_index', async () => {
    const course = await makeCourse(request);
    const chapter = await makeChapter(request, course.id);
    const lesson = await makeSubLesson(request, course.id, chapter.id, {
      is_complete: true,
      order_index: 6,
    });

    const res = await request('PATCH', `${lessonsPath(course.id, chapter.id)}/${lesson.id}`, {
      title: 'Merged',
    });
    assert.equal(res.body.title, 'Merged');
    assert.equal(res.body.is_complete, true);
    assert.equal(res.body.order_index, 6);
  });

  test('PUT requires a title', async () => {
    const course = await makeCourse(request);
    const chapter = await makeChapter(request, course.id);
    const lesson = await makeSubLesson(request, course.id, chapter.id);

    const res = await request('PUT', `${lessonsPath(course.id, chapter.id)}/${lesson.id}`, {});
    assert.equal(res.status, 400);
    assert.match(res.body.error, /"title" is required/);
  });
});

describe('cross-parent isolation', () => {
  test('a sub-lesson reached through the wrong chapter is a 404', async () => {
    const course = await makeCourse(request);
    const mine = await makeChapter(request, course.id, { title: 'Mine' });
    const other = await makeChapter(request, course.id, { title: 'Other' });
    const lesson = await makeSubLesson(request, course.id, other.id, { title: 'Not here' });

    const res = await request('GET', `${lessonsPath(course.id, mine.id)}/${lesson.id}`);
    assert.equal(res.status, 404);
    assert.match(res.body.error, /not found in chapter/);
  });

  test('a chapter reached through the wrong course is a 404 for its sub-lessons too', async () => {
    const mine = await makeCourse(request, { name: 'Mine' });
    const theirs = await makeCourse(request, { name: 'Theirs' });
    const chapter = await makeChapter(request, theirs.id, { title: 'Not yours' });
    const lesson = await makeSubLesson(request, theirs.id, chapter.id);

    const list = await request('GET', lessonsPath(mine.id, chapter.id));
    assert.equal(list.status, 404);

    const one = await request('GET', `${lessonsPath(mine.id, chapter.id)}/${lesson.id}`);
    assert.equal(one.status, 404);

    const toggle = await request(
      'PATCH',
      `${lessonsPath(mine.id, chapter.id)}/${lesson.id}/complete`,
      { is_complete: true },
    );
    assert.equal(toggle.status, 404);

    // The lesson was not flipped by the rejected request.
    const still = await request('GET', `${lessonsPath(theirs.id, chapter.id)}/${lesson.id}`);
    assert.equal(still.body.is_complete, false);
  });

  test('DELETE through the wrong chapter leaves the row alone', async () => {
    const course = await makeCourse(request);
    const mine = await makeChapter(request, course.id, { title: 'Mine' });
    const other = await makeChapter(request, course.id, { title: 'Other' });
    const lesson = await makeSubLesson(request, course.id, other.id);

    const res = await request('DELETE', `${lessonsPath(course.id, mine.id)}/${lesson.id}`);
    assert.equal(res.status, 404);

    const still = await request('GET', `${lessonsPath(course.id, other.id)}/${lesson.id}`);
    assert.equal(still.status, 200);
  });
});

describe('DELETE a sub-lesson', () => {
  test('returns 204 and removes it from the list', async () => {
    const course = await makeCourse(request);
    const chapter = await makeChapter(request, course.id);
    const keep = await makeSubLesson(request, course.id, chapter.id, { title: 'Keep' });
    const drop = await makeSubLesson(request, course.id, chapter.id, { title: 'Drop' });

    const res = await request('DELETE', `${lessonsPath(course.id, chapter.id)}/${drop.id}`);
    assert.equal(res.status, 204);

    const list = await request('GET', lessonsPath(course.id, chapter.id));
    assert.deepEqual(list.body.map((l) => l.id), [keep.id]);
  });
});
