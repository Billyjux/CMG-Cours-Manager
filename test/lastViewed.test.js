const { test, before, after, beforeEach, describe } = require('node:test');
const assert = require('node:assert/strict');
const { start, reset, cleanup, db } = require('./helpers/harness');
const { makeCourse, makeChapter } = require('./helpers/fixtures');

let request;
let close;

before(async () => { ({ request, close } = await start()); });
after(async () => { await close(); cleanup(); });
beforeEach(reset);

const rowCount = () => db.prepare('SELECT COUNT(*) AS n FROM last_viewed').get().n;

describe('GET /api/last-viewed', () => {
  test('returns 200 with a null body when nothing is bookmarked', async () => {
    const res = await request('GET', '/api/last-viewed');
    assert.equal(res.status, 200);
    assert.equal(res.body, null);
  });
});

describe('POST /api/last-viewed', () => {
  test('records a course-level bookmark', async () => {
    const course = await makeCourse(request, { name: 'Electronique' });

    const res = await request('POST', '/api/last-viewed', { course_id: course.id });
    assert.equal(res.status, 200);
    assert.equal(res.body.course_id, course.id);
    assert.equal(res.body.course_name, 'Electronique');
    assert.equal(res.body.chapter_id, null);
    assert.equal(res.body.chapter_title, null);

    const read = await request('GET', '/api/last-viewed');
    assert.equal(read.body.course_id, course.id);
  });

  test('records a chapter-level bookmark and resolves its title', async () => {
    const course = await makeCourse(request, { name: 'Electronique' });
    const chapter = await makeChapter(request, course.id, { title: 'Flip-flops' });

    const res = await request('POST', '/api/last-viewed', {
      course_id: course.id,
      chapter_id: chapter.id,
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.chapter_id, chapter.id);
    assert.equal(res.body.chapter_title, 'Flip-flops');
  });

  test('an explicit null chapter_id means course level', async () => {
    const course = await makeCourse(request);
    const res = await request('POST', '/api/last-viewed', {
      course_id: course.id,
      chapter_id: null,
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.chapter_id, null);
  });

  test('stays a single row across many writes', async () => {
    const first = await makeCourse(request, { name: 'First' });
    const second = await makeCourse(request, { name: 'Second' });
    const chapter = await makeChapter(request, second.id, { title: 'Ch' });

    await request('POST', '/api/last-viewed', { course_id: first.id });
    await request('POST', '/api/last-viewed', { course_id: second.id });
    await request('POST', '/api/last-viewed', {
      course_id: second.id,
      chapter_id: chapter.id,
    });

    assert.equal(rowCount(), 1);
    const read = await request('GET', '/api/last-viewed');
    assert.equal(read.body.course_id, second.id);
    assert.equal(read.body.chapter_id, chapter.id);
  });

  test('moving back to course level clears the chapter half', async () => {
    const course = await makeCourse(request);
    const chapter = await makeChapter(request, course.id);

    await request('POST', '/api/last-viewed', { course_id: course.id, chapter_id: chapter.id });
    const res = await request('POST', '/api/last-viewed', { course_id: course.id });

    assert.equal(res.body.chapter_id, null);
  });

  test('404s for a chapter that belongs to another course', async () => {
    const mine = await makeCourse(request, { name: 'Mine' });
    const theirs = await makeCourse(request, { name: 'Theirs' });
    const chapter = await makeChapter(request, theirs.id, { title: 'Not yours' });

    const res = await request('POST', '/api/last-viewed', {
      course_id: mine.id,
      chapter_id: chapter.id,
    });
    assert.equal(res.status, 404);
    assert.equal(rowCount(), 0);
  });

  test('404s for a course that does not exist', async () => {
    const res = await request('POST', '/api/last-viewed', { course_id: 9999 });
    assert.equal(res.status, 404);
  });

  test('400s for a missing course_id, naming the body field not the route param', async () => {
    const res = await request('POST', '/api/last-viewed', {});
    assert.equal(res.status, 400);
    assert.match(res.body.error, /"course_id" must be a positive integer/);
  });

  test('400s for a non-numeric chapter_id', async () => {
    const course = await makeCourse(request);
    const res = await request('POST', '/api/last-viewed', {
      course_id: course.id,
      chapter_id: 'abc',
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /"chapter_id" must be a positive integer/);
  });
});

describe('staleness is handled by the schema, so a stale id never reaches the client', () => {
  test('deleting the bookmarked course cascades the row away', async () => {
    const course = await makeCourse(request);
    const chapter = await makeChapter(request, course.id);
    await request('POST', '/api/last-viewed', { course_id: course.id, chapter_id: chapter.id });
    assert.equal(rowCount(), 1);

    await request('DELETE', `/api/courses/${course.id}`);

    assert.equal(rowCount(), 0);
    const res = await request('GET', '/api/last-viewed');
    assert.equal(res.status, 200);
    assert.equal(res.body, null);
  });

  test('deleting the bookmarked chapter leaves a course-level bookmark', async () => {
    const course = await makeCourse(request, { name: 'Survivor' });
    const chapter = await makeChapter(request, course.id, { title: 'Doomed' });
    await request('POST', '/api/last-viewed', { course_id: course.id, chapter_id: chapter.id });

    await request('DELETE', `/api/courses/${course.id}/chapters/${chapter.id}`);

    const res = await request('GET', '/api/last-viewed');
    assert.equal(res.status, 200);
    assert.equal(res.body.course_id, course.id);
    assert.equal(res.body.course_name, 'Survivor');
    assert.equal(res.body.chapter_id, null);
  });

  test('a chapter_id whose title cannot be resolved is blanked on read', async () => {
    const course = await makeCourse(request, { name: 'Course' });
    const chapter = await makeChapter(request, course.id, { title: 'Ch' });
    await request('POST', '/api/last-viewed', { course_id: course.id, chapter_id: chapter.id });

    // Force the situation ON DELETE SET NULL is meant to prevent: a bookmark
    // pointing at a chapter row that is no longer reachable. The read path
    // must still refuse to hand the id back.
    db.pragma('foreign_keys = OFF');
    db.prepare('DELETE FROM chapters WHERE id = ?').run(chapter.id);
    db.pragma('foreign_keys = ON');

    const res = await request('GET', '/api/last-viewed');
    assert.equal(res.status, 200);
    assert.equal(res.body.course_id, course.id);
    assert.equal(res.body.chapter_id, null);
    assert.equal(res.body.chapter_title, null);
  });
});
