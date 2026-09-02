const { test, before, after, beforeEach, describe } = require('node:test');
const assert = require('node:assert/strict');
const { start, reset, cleanup, db } = require('./helpers/harness');
const { makeCourse, makeChapter, makeSubLesson } = require('./helpers/fixtures');

let request;
let close;

before(async () => { ({ request, close } = await start()); });
after(async () => { await close(); cleanup(); });
beforeEach(reset);

describe('POST /api/courses/:courseId/chapters', () => {
  test('creates a chapter under the course', async () => {
    const course = await makeCourse(request);
    const res = await request('POST', `/api/courses/${course.id}/chapters`, {
      title: 'Combinational logic',
    });

    assert.equal(res.status, 201);
    assert.equal(res.body.title, 'Combinational logic');
    assert.equal(res.body.course_id, course.id);
  });

  test('an omitted order_index appends to the end (MAX + 1)', async () => {
    const course = await makeCourse(request);
    const first = await makeChapter(request, course.id, { title: 'One' });
    const second = await makeChapter(request, course.id, { title: 'Two' });
    const third = await makeChapter(request, course.id, { title: 'Three' });

    assert.deepEqual([first.order_index, second.order_index, third.order_index], [0, 1, 2]);
  });

  test('appends after an explicitly high order_index', async () => {
    const course = await makeCourse(request);
    await makeChapter(request, course.id, { order_index: 40 });
    const next = await makeChapter(request, course.id);

    assert.equal(next.order_index, 41);
  });

  test('honours an explicit order_index', async () => {
    const course = await makeCourse(request);
    const chapter = await makeChapter(request, course.id, { order_index: 7 });
    assert.equal(chapter.order_index, 7);
  });

  test('order_index numbering is per course, not global', async () => {
    const a = await makeCourse(request, { name: 'A' });
    const b = await makeCourse(request, { name: 'B' });
    await makeChapter(request, a.id);
    await makeChapter(request, a.id);
    const firstOfB = await makeChapter(request, b.id);

    assert.equal(firstOfB.order_index, 0);
  });

  test('rejects a missing title', async () => {
    const course = await makeCourse(request);
    const res = await request('POST', `/api/courses/${course.id}/chapters`, {});
    assert.equal(res.status, 400);
    assert.match(res.body.error, /"title" is required/);
  });

  test('rejects a non-integer order_index', async () => {
    const course = await makeCourse(request);
    const res = await request('POST', `/api/courses/${course.id}/chapters`, {
      title: 'Bad',
      order_index: 1.5,
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /"order_index" must be an integer/);
  });

  test('404s when the parent course does not exist', async () => {
    const res = await request('POST', '/api/courses/9999/chapters', { title: 'Orphan' });
    assert.equal(res.status, 404);
    assert.match(res.body.error, /Course 9999 not found/);
  });
});

describe('GET /api/courses/:courseId/chapters', () => {
  test('sorts by order_index, then id as a tiebreak', async () => {
    const course = await makeCourse(request);
    const last = await makeChapter(request, course.id, { title: 'Last', order_index: 9 });
    const first = await makeChapter(request, course.id, { title: 'First', order_index: 1 });
    const tiedA = await makeChapter(request, course.id, { title: 'TiedA', order_index: 5 });
    const tiedB = await makeChapter(request, course.id, { title: 'TiedB', order_index: 5 });

    const res = await request('GET', `/api/courses/${course.id}/chapters`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.map((c) => c.id), [first.id, tiedA.id, tiedB.id, last.id]);
  });

  test('only returns chapters of that course', async () => {
    const a = await makeCourse(request, { name: 'A' });
    const b = await makeCourse(request, { name: 'B' });
    const mine = await makeChapter(request, a.id, { title: 'Mine' });
    await makeChapter(request, b.id, { title: 'Theirs' });

    const res = await request('GET', `/api/courses/${a.id}/chapters`);
    assert.deepEqual(res.body.map((c) => c.id), [mine.id]);
  });
});

describe('cross-parent isolation', () => {
  test('a chapter of another course is a 404 on this path, not a 200', async () => {
    const mine = await makeCourse(request, { name: 'Mine' });
    const theirs = await makeCourse(request, { name: 'Theirs' });
    const chapter = await makeChapter(request, theirs.id, { title: 'Not yours' });

    const res = await request('GET', `/api/courses/${mine.id}/chapters/${chapter.id}`);
    assert.equal(res.status, 404);
    assert.match(res.body.error, /not found in course/);
  });

  test('the same isolation applies to PATCH, PUT and DELETE', async () => {
    const mine = await makeCourse(request, { name: 'Mine' });
    const theirs = await makeCourse(request, { name: 'Theirs' });
    const chapter = await makeChapter(request, theirs.id, { title: 'Not yours' });

    const path = `/api/courses/${mine.id}/chapters/${chapter.id}`;
    assert.equal((await request('PATCH', path, { title: 'Hijack' })).status, 404);
    assert.equal((await request('PUT', path, { title: 'Hijack' })).status, 404);
    assert.equal((await request('DELETE', path)).status, 404);

    // And the chapter itself is untouched.
    const still = await request('GET', `/api/courses/${theirs.id}/chapters/${chapter.id}`);
    assert.equal(still.status, 200);
    assert.equal(still.body.title, 'Not yours');
  });
});

describe('updating a chapter', () => {
  test('PATCH merges: an omitted order_index is preserved', async () => {
    const course = await makeCourse(request);
    const chapter = await makeChapter(request, course.id, { title: 'Old', order_index: 3 });

    const res = await request('PATCH', `/api/courses/${course.id}/chapters/${chapter.id}`, {
      title: 'New',
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.title, 'New');
    assert.equal(res.body.order_index, 3);
  });

  test('PUT requires a title but keeps the existing order_index', async () => {
    const course = await makeCourse(request);
    const chapter = await makeChapter(request, course.id, { title: 'Old', order_index: 3 });

    const missing = await request('PUT', `/api/courses/${course.id}/chapters/${chapter.id}`, {});
    assert.equal(missing.status, 400);

    const res = await request('PUT', `/api/courses/${course.id}/chapters/${chapter.id}`, {
      title: 'New',
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.order_index, 3);
  });

  test('order_index can be moved explicitly', async () => {
    const course = await makeCourse(request);
    const chapter = await makeChapter(request, course.id, { order_index: 0 });

    const res = await request('PATCH', `/api/courses/${course.id}/chapters/${chapter.id}`, {
      order_index: 5,
    });
    assert.equal(res.body.order_index, 5);
  });
});

describe('DELETE a chapter', () => {
  test('returns 204 and cascades to its sub-lessons', async () => {
    const course = await makeCourse(request);
    const keep = await makeChapter(request, course.id, { title: 'Keep' });
    const drop = await makeChapter(request, course.id, { title: 'Drop' });
    await makeSubLesson(request, course.id, keep.id);
    await makeSubLesson(request, course.id, drop.id);
    await makeSubLesson(request, course.id, drop.id);

    const count = () => db.prepare('SELECT COUNT(*) AS n FROM sub_lessons').get().n;
    assert.equal(count(), 3);

    const res = await request('DELETE', `/api/courses/${course.id}/chapters/${drop.id}`);
    assert.equal(res.status, 204);
    assert.equal(count(), 1);

    const remaining = await request('GET', `/api/courses/${course.id}/chapters`);
    assert.deepEqual(remaining.body.map((c) => c.id), [keep.id]);
  });
});
