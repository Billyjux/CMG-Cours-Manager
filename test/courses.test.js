const { test, before, after, beforeEach, describe } = require('node:test');
const assert = require('node:assert/strict');
const { start, reset, cleanup, db } = require('./helpers/harness');
const { makeCourse, makeChapter, makeSubLesson, makeNote } = require('./helpers/fixtures');

let request;
let close;

before(async () => { ({ request, close } = await start()); });
after(async () => { await close(); cleanup(); });
beforeEach(reset);

describe('POST /api/courses', () => {
  test('creates a course and echoes it back with an id', async () => {
    const res = await request('POST', '/api/courses', {
      name: 'Electronique Numerique',
      description: 'Logic gates and flip-flops',
    });

    assert.equal(res.status, 201);
    assert.ok(Number.isInteger(res.body.id));
    assert.equal(res.body.name, 'Electronique Numerique');
    assert.equal(res.body.description, 'Logic gates and flip-flops');
    assert.ok(!Number.isNaN(Date.parse(res.body.created_at)));
  });

  test('description is optional and stored as null', async () => {
    const course = await makeCourse(request, { description: undefined });
    assert.equal(course.description, null);
  });

  test('trims the name', async () => {
    const course = await makeCourse(request, { name: '  Padded  ' });
    assert.equal(course.name, 'Padded');
  });

  test('rejects a missing name, naming the field', async () => {
    const res = await request('POST', '/api/courses', { description: 'no name' });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /"name" is required/);
  });

  test('rejects a whitespace-only name', async () => {
    const res = await request('POST', '/api/courses', { name: '   ' });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /"name" must not be empty/);
  });

  test('rejects a non-string name', async () => {
    const res = await request('POST', '/api/courses', { name: 42 });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /"name" must be a string/);
  });

  test('rejects a name over the 500 character cap', async () => {
    const res = await request('POST', '/api/courses', { name: 'x'.repeat(501) });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /at most 500 characters/);
  });
});

describe('GET /api/courses', () => {
  test('returns an empty array when there is nothing', async () => {
    const res = await request('GET', '/api/courses');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, []);
  });

  test('lists newest first', async () => {
    const first = await makeCourse(request, { name: 'First' });
    const second = await makeCourse(request, { name: 'Second' });

    const res = await request('GET', '/api/courses');
    assert.equal(res.status, 200);
    // created_at DESC, id DESC — same-millisecond creates still order by id.
    assert.deepEqual(res.body.map((c) => c.id), [second.id, first.id]);
  });
});

describe('GET /api/courses/:courseId', () => {
  test('returns the course', async () => {
    const course = await makeCourse(request, { name: 'Signals' });
    const res = await request('GET', `/api/courses/${course.id}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.name, 'Signals');
  });

  test('404s for an id that does not exist', async () => {
    const res = await request('GET', '/api/courses/9999');
    assert.equal(res.status, 404);
    assert.match(res.body.error, /Course 9999 not found/);
  });

  test('400s for a non-numeric id', async () => {
    const res = await request('GET', '/api/courses/abc');
    assert.equal(res.status, 400);
    assert.match(res.body.error, /"courseId" must be a positive integer/);
  });
});

describe('PUT vs PATCH', () => {
  test('PUT replaces: an omitted description is cleared', async () => {
    const course = await makeCourse(request, { name: 'Old', description: 'Present' });

    const res = await request('PUT', `/api/courses/${course.id}`, { name: 'New' });
    assert.equal(res.status, 200);
    assert.equal(res.body.name, 'New');
    assert.equal(res.body.description, null);
  });

  test('PUT requires a name', async () => {
    const course = await makeCourse(request);
    const res = await request('PUT', `/api/courses/${course.id}`, { description: 'only this' });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /"name" is required/);
  });

  test('PATCH merges: an omitted description is preserved', async () => {
    const course = await makeCourse(request, { name: 'Old', description: 'Keep me' });

    const res = await request('PATCH', `/api/courses/${course.id}`, { name: 'New' });
    assert.equal(res.status, 200);
    assert.equal(res.body.name, 'New');
    assert.equal(res.body.description, 'Keep me');
  });

  test('PATCH with an explicit null clears the description', async () => {
    const course = await makeCourse(request, { description: 'Present' });

    const res = await request('PATCH', `/api/courses/${course.id}`, { description: null });
    assert.equal(res.status, 200);
    assert.equal(res.body.description, null);
  });

  test('PATCH on a missing course 404s', async () => {
    const res = await request('PATCH', '/api/courses/9999', { name: 'Nope' });
    assert.equal(res.status, 404);
  });
});

describe('DELETE /api/courses/:courseId', () => {
  test('returns 204 and the course is gone', async () => {
    const course = await makeCourse(request);

    const del = await request('DELETE', `/api/courses/${course.id}`);
    assert.equal(del.status, 204);
    assert.equal(del.body, null);

    const after = await request('GET', `/api/courses/${course.id}`);
    assert.equal(after.status, 404);
  });

  test('cascades to chapters, sub-lessons and notes', async () => {
    const course = await makeCourse(request);
    const chapter = await makeChapter(request, course.id);
    await makeSubLesson(request, course.id, chapter.id);
    await makeSubLesson(request, course.id, chapter.id);
    await makeNote(request, course.id);

    const count = (table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
    assert.equal(count('chapters'), 1);
    assert.equal(count('sub_lessons'), 2);
    assert.equal(count('notes'), 1);

    await request('DELETE', `/api/courses/${course.id}`);

    assert.equal(count('chapters'), 0);
    assert.equal(count('sub_lessons'), 0);
    assert.equal(count('notes'), 0);
  });
});
