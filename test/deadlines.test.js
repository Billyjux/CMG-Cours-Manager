const { test, before, after, beforeEach, describe } = require('node:test');
const assert = require('node:assert/strict');
const { start, reset, cleanup } = require('./helpers/harness');
const { makeCourse, makeDeadline } = require('./helpers/fixtures');

let request;
let close;

before(async () => { ({ request, close } = await start()); });
after(async () => { await close(); cleanup(); });
beforeEach(reset);

describe('POST /api/courses/:courseId/deadlines', () => {
  test('creates a deadline', async () => {
    const course = await makeCourse(request);
    const res = await request('POST', `/api/courses/${course.id}/deadlines`, {
      title: 'Rapport de TP',
      due_date: '2026-09-15',
    });

    assert.equal(res.status, 201);
    assert.equal(res.body.course_id, course.id);
    assert.equal(res.body.title, 'Rapport de TP');
    assert.equal(res.body.due_date, '2026-09-15');
    assert.ok(res.body.created_at);
  });

  test('requires a title and a due date', async () => {
    const course = await makeCourse(request);
    const noTitle = await request('POST', `/api/courses/${course.id}/deadlines`, {
      due_date: '2026-09-15',
    });
    const noDate = await request('POST', `/api/courses/${course.id}/deadlines`, {
      title: 'Rapport',
    });

    assert.equal(noTitle.status, 400);
    assert.match(noTitle.body.error, /title/);
    assert.equal(noDate.status, 400);
    assert.match(noDate.body.error, /due_date/);
  });

  test('rejects a blank title and malformed or impossible dates', async () => {
    const course = await makeCourse(request);
    const blank = await request('POST', `/api/courses/${course.id}/deadlines`, {
      title: '   ',
      due_date: '2026-09-15',
    });
    assert.equal(blank.status, 400);

    for (const due_date of ['15/09/2026', '2026-9-15', 'friday', '2026-02-30']) {
      const res = await request('POST', `/api/courses/${course.id}/deadlines`, {
        title: 'Rapport',
        due_date,
      });
      assert.equal(res.status, 400, `expected 400 for ${due_date}`);
    }
  });

  test('accepts a date in the past — overdue items must be recordable', async () => {
    const course = await makeCourse(request);
    const res = await request('POST', `/api/courses/${course.id}/deadlines`, {
      title: 'Devoir rendu en retard',
      due_date: '2020-01-01',
    });
    assert.equal(res.status, 201);
  });

  test('404s for a course that does not exist', async () => {
    const res = await request('POST', '/api/courses/9999/deadlines', {
      title: 'Rapport',
      due_date: '2026-09-15',
    });
    assert.equal(res.status, 404);
  });
});

describe('GET /api/courses/:courseId/deadlines', () => {
  test('sorts chronologically, soonest first', async () => {
    const course = await makeCourse(request);
    await makeDeadline(request, course.id, { title: 'C', due_date: '2026-12-01' });
    await makeDeadline(request, course.id, { title: 'A', due_date: '2026-01-15' });
    await makeDeadline(request, course.id, { title: 'B', due_date: '2026-06-30' });

    const res = await request('GET', `/api/courses/${course.id}/deadlines`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.map((d) => d.title), ['A', 'B', 'C']);
  });

  test('only returns deadlines of that course', async () => {
    const a = await makeCourse(request, { name: 'A' });
    const b = await makeCourse(request, { name: 'B' });
    await makeDeadline(request, a.id, { title: 'Belongs to A' });
    await makeDeadline(request, b.id, { title: 'Belongs to B' });

    const res = await request('GET', `/api/courses/${a.id}/deadlines`);
    assert.equal(res.body.length, 1);
    assert.equal(res.body[0].title, 'Belongs to A');
  });

  test('is an empty list for a course with none', async () => {
    const course = await makeCourse(request);
    const res = await request('GET', `/api/courses/${course.id}/deadlines`);
    assert.deepEqual(res.body, []);
  });
});

describe('PATCH /api/courses/:courseId/deadlines/:deadlineId', () => {
  test('merges: omitted fields keep their value', async () => {
    const course = await makeCourse(request);
    const deadline = await makeDeadline(request, course.id, {
      title: 'Original',
      due_date: '2026-09-15',
    });

    const res = await request(
      'PATCH',
      `/api/courses/${course.id}/deadlines/${deadline.id}`,
      { due_date: '2026-09-20' },
    );

    assert.equal(res.status, 200);
    assert.equal(res.body.due_date, '2026-09-20');
    assert.equal(res.body.title, 'Original');
  });

  test('still validates what it is given', async () => {
    const course = await makeCourse(request);
    const deadline = await makeDeadline(request, course.id);

    const badDate = await request(
      'PATCH',
      `/api/courses/${course.id}/deadlines/${deadline.id}`,
      { due_date: 'next friday' },
    );
    const blankTitle = await request(
      'PATCH',
      `/api/courses/${course.id}/deadlines/${deadline.id}`,
      { title: '  ' },
    );

    assert.equal(badDate.status, 400);
    assert.equal(blankTitle.status, 400);
  });
});

describe('cross-course isolation', () => {
  test('a deadline reached through the wrong course is a 404', async () => {
    const a = await makeCourse(request, { name: 'A' });
    const b = await makeCourse(request, { name: 'B' });
    const deadline = await makeDeadline(request, a.id);

    const read = await request('GET', `/api/courses/${b.id}/deadlines/${deadline.id}`);
    const patch = await request(
      'PATCH',
      `/api/courses/${b.id}/deadlines/${deadline.id}`,
      { title: 'Hijacked' },
    );
    const del = await request('DELETE', `/api/courses/${b.id}/deadlines/${deadline.id}`);

    assert.equal(read.status, 404);
    assert.equal(patch.status, 404);
    assert.equal(del.status, 404);

    const still = await request('GET', `/api/courses/${a.id}/deadlines/${deadline.id}`);
    assert.equal(still.status, 200);
    assert.equal(still.body.title, 'Test deadline');
  });
});

describe('DELETE /api/courses/:courseId/deadlines/:deadlineId', () => {
  test('returns 204 and drops it from the list', async () => {
    const course = await makeCourse(request);
    const keep = await makeDeadline(request, course.id, { title: 'Keep' });
    const scrap = await makeDeadline(request, course.id, { title: 'Scrap' });

    const res = await request('DELETE', `/api/courses/${course.id}/deadlines/${scrap.id}`);
    assert.equal(res.status, 204);

    const list = await request('GET', `/api/courses/${course.id}/deadlines`);
    assert.deepEqual(list.body.map((d) => d.id), [keep.id]);
  });
});

describe('cascade', () => {
  test('deleting the course removes its deadlines', async () => {
    const course = await makeCourse(request);
    await makeDeadline(request, course.id);

    assert.equal((await request('DELETE', `/api/courses/${course.id}`)).status, 204);
    const res = await request('GET', `/api/courses/${course.id}/deadlines`);
    assert.equal(res.status, 404, 'the course itself is gone');
  });

  test('does not disturb the study sessions of the same course', async () => {
    const course = await makeCourse(request);
    const deadline = await makeDeadline(request, course.id);
    await request('POST', `/api/courses/${course.id}/study-sessions`, {
      date: '2026-09-01',
      hours: 2,
    });

    await request('DELETE', `/api/courses/${course.id}/deadlines/${deadline.id}`);

    const studyTime = await request('GET', `/api/courses/${course.id}/study-time`);
    assert.equal(studyTime.body.total_hours, 2);
  });
});
