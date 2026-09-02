const { test, before, after, beforeEach, describe } = require('node:test');
const assert = require('node:assert/strict');
const { start, reset, cleanup, sleep } = require('./helpers/harness');
const { makeCourse, makeNote } = require('./helpers/fixtures');

let request;
let close;

before(async () => { ({ request, close } = await start()); });
after(async () => { await close(); cleanup(); });
beforeEach(reset);

describe('POST /api/courses/:courseId/notes', () => {
  test('creates a note with matching timestamps', async () => {
    const course = await makeCourse(request);
    const res = await request('POST', `/api/courses/${course.id}/notes`, {
      content: 'https://example.com/lecture-3',
    });

    assert.equal(res.status, 201);
    assert.equal(res.body.content, 'https://example.com/lecture-3');
    assert.equal(res.body.course_id, course.id);
    // Never edited yet, so the two stamps are identical — that is what the
    // frontend uses to decide whether to show "edited".
    assert.equal(res.body.created_at, res.body.updated_at);
  });

  test('rejects empty content', async () => {
    const course = await makeCourse(request);
    const res = await request('POST', `/api/courses/${course.id}/notes`, { content: '   ' });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /"content" must not be empty/);
  });

  test('rejects missing content', async () => {
    const course = await makeCourse(request);
    const res = await request('POST', `/api/courses/${course.id}/notes`, {});
    assert.equal(res.status, 400);
    assert.match(res.body.error, /"content" is required/);
  });

  test('accepts 20000 characters and rejects 20001', async () => {
    const course = await makeCourse(request);

    const ok = await request('POST', `/api/courses/${course.id}/notes`, {
      content: 'x'.repeat(20000),
    });
    assert.equal(ok.status, 201);

    const tooLong = await request('POST', `/api/courses/${course.id}/notes`, {
      content: 'x'.repeat(20001),
    });
    assert.equal(tooLong.status, 400);
    assert.match(tooLong.body.error, /at most 20000 characters/);
  });

  test('404s when the course does not exist', async () => {
    const res = await request('POST', '/api/courses/9999/notes', { content: 'Orphan' });
    assert.equal(res.status, 404);
  });
});

describe('GET /api/courses/:courseId/notes', () => {
  test('lists newest first', async () => {
    const course = await makeCourse(request);
    const first = await makeNote(request, course.id, { content: 'First' });
    const second = await makeNote(request, course.id, { content: 'Second' });

    const res = await request('GET', `/api/courses/${course.id}/notes`);
    assert.deepEqual(res.body.map((n) => n.id), [second.id, first.id]);
  });

  test('only returns notes of that course', async () => {
    const a = await makeCourse(request, { name: 'A' });
    const b = await makeCourse(request, { name: 'B' });
    const mine = await makeNote(request, a.id, { content: 'Mine' });
    await makeNote(request, b.id, { content: 'Theirs' });

    const res = await request('GET', `/api/courses/${a.id}/notes`);
    assert.deepEqual(res.body.map((n) => n.id), [mine.id]);
  });
});

describe('updating a note', () => {
  test('PATCH rewrites the content and advances updated_at', async () => {
    const course = await makeCourse(request);
    const note = await makeNote(request, course.id, { content: 'Draft' });

    // ISO timestamps carry milliseconds; pause so the new stamp cannot land
    // in the same millisecond as the original.
    await sleep(10);

    const res = await request('PATCH', `/api/courses/${course.id}/notes/${note.id}`, {
      content: 'Revised',
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.content, 'Revised');
    assert.equal(res.body.created_at, note.created_at);
    assert.ok(
      Date.parse(res.body.updated_at) > Date.parse(note.updated_at),
      `expected ${res.body.updated_at} to be later than ${note.updated_at}`,
    );
  });

  test('PUT requires content, PATCH does not', async () => {
    const course = await makeCourse(request);
    const note = await makeNote(request, course.id, { content: 'Original' });

    const put = await request('PUT', `/api/courses/${course.id}/notes/${note.id}`, {});
    assert.equal(put.status, 400);
    assert.match(put.body.error, /"content" is required/);

    const patch = await request('PATCH', `/api/courses/${course.id}/notes/${note.id}`, {});
    assert.equal(patch.status, 200);
    assert.equal(patch.body.content, 'Original');
  });

  test('rejects blanking the content', async () => {
    const course = await makeCourse(request);
    const note = await makeNote(request, course.id);

    const res = await request('PATCH', `/api/courses/${course.id}/notes/${note.id}`, {
      content: '',
    });
    assert.equal(res.status, 400);
  });
});

describe('cross-parent isolation', () => {
  test('a note of another course is a 404 on this path', async () => {
    const mine = await makeCourse(request, { name: 'Mine' });
    const theirs = await makeCourse(request, { name: 'Theirs' });
    const note = await makeNote(request, theirs.id, { content: 'Not yours' });

    const path = `/api/courses/${mine.id}/notes/${note.id}`;
    assert.equal((await request('GET', path)).status, 404);
    assert.equal((await request('PATCH', path, { content: 'Hijack' })).status, 404);
    assert.equal((await request('DELETE', path)).status, 404);

    const still = await request('GET', `/api/courses/${theirs.id}/notes/${note.id}`);
    assert.equal(still.body.content, 'Not yours');
  });
});

describe('DELETE a note', () => {
  test('returns 204 and removes it', async () => {
    const course = await makeCourse(request);
    const note = await makeNote(request, course.id);

    const res = await request('DELETE', `/api/courses/${course.id}/notes/${note.id}`);
    assert.equal(res.status, 204);

    const list = await request('GET', `/api/courses/${course.id}/notes`);
    assert.deepEqual(list.body, []);
  });
});
