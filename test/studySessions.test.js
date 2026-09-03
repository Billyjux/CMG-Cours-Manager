const { test, before, after, beforeEach, describe } = require('node:test');
const assert = require('node:assert/strict');
const { start, reset, cleanup, db } = require('./helpers/harness');
const { makeCourse, makeStudySession } = require('./helpers/fixtures');

let request;
let close;

before(async () => { ({ request, close } = await start()); });
after(async () => { await close(); cleanup(); });
beforeEach(reset);

describe('POST /api/courses/:courseId/study-sessions', () => {
  test('logs a session and echoes it back', async () => {
    const course = await makeCourse(request);
    const res = await request('POST', `/api/courses/${course.id}/study-sessions`, {
      date: '2026-09-02',
      hours: 2,
      note: 'Chapitre 3, exercices',
    });

    assert.equal(res.status, 201);
    assert.equal(res.body.course_id, course.id);
    assert.equal(res.body.date, '2026-09-02');
    assert.equal(res.body.hours, 2);
    assert.equal(res.body.note, 'Chapitre 3, exercices');
    assert.ok(res.body.created_at, 'created_at is stamped');
  });

  test('keeps fractional hours exactly as entered', async () => {
    const course = await makeCourse(request);
    for (const hours of [0.25, 1.5, 3.75]) {
      const session = await makeStudySession(request, course.id, { hours });
      assert.equal(session.hours, hours);
    }
  });

  test('the note is optional and comes back as null', async () => {
    const course = await makeCourse(request);
    const session = await makeStudySession(request, course.id, { note: undefined });
    assert.equal(session.note, null);
  });

  test('requires a date and hours', async () => {
    const course = await makeCourse(request);
    const noDate = await request('POST', `/api/courses/${course.id}/study-sessions`, { hours: 1 });
    const noHours = await request('POST', `/api/courses/${course.id}/study-sessions`, {
      date: '2026-09-02',
    });

    assert.equal(noDate.status, 400);
    assert.match(noDate.body.error, /date/);
    assert.equal(noHours.status, 400);
    assert.match(noHours.body.error, /hours/);
  });

  test('rejects malformed and impossible dates', async () => {
    const course = await makeCourse(request);
    for (const date of ['02/09/2026', '2026-9-2', 'today', '2026-02-31', '2026-13-01']) {
      const res = await request('POST', `/api/courses/${course.id}/study-sessions`, {
        date,
        hours: 1,
      });
      assert.equal(res.status, 400, `expected 400 for date ${date}`);
    }
  });

  test('rejects hours outside (0, 24]', async () => {
    const course = await makeCourse(request);
    for (const hours of [0, -2, 24.5, 100]) {
      const res = await request('POST', `/api/courses/${course.id}/study-sessions`, {
        date: '2026-09-02',
        hours,
      });
      assert.equal(res.status, 400, `expected 400 for hours ${hours}`);
    }

    const asString = await request('POST', `/api/courses/${course.id}/study-sessions`, {
      date: '2026-09-02',
      hours: '2',
    });
    assert.equal(asString.status, 400);
  });

  test('404s for a course that does not exist', async () => {
    const res = await request('POST', '/api/courses/9999/study-sessions', {
      date: '2026-09-02',
      hours: 1,
    });
    assert.equal(res.status, 404);
  });
});

describe('GET /api/courses/:courseId/study-sessions', () => {
  test('lists newest day first, ties broken by newest entry', async () => {
    const course = await makeCourse(request);
    await makeStudySession(request, course.id, { date: '2026-08-30', hours: 1 });
    await makeStudySession(request, course.id, { date: '2026-09-02', hours: 2 });
    const sameDayLater = await makeStudySession(request, course.id, {
      date: '2026-09-02',
      hours: 3,
    });

    const res = await request('GET', `/api/courses/${course.id}/study-sessions`);
    assert.equal(res.status, 200);
    assert.deepEqual(
      res.body.map((s) => [s.date, s.hours]),
      [['2026-09-02', 3], ['2026-09-02', 2], ['2026-08-30', 1]],
    );
    assert.equal(res.body[0].id, sameDayLater.id);
  });

  test('only returns sessions belonging to that course', async () => {
    const a = await makeCourse(request, { name: 'A' });
    const b = await makeCourse(request, { name: 'B' });
    await makeStudySession(request, a.id, { hours: 1 });
    await makeStudySession(request, b.id, { hours: 2 });

    const res = await request('GET', `/api/courses/${a.id}/study-sessions`);
    assert.equal(res.body.length, 1);
    assert.equal(res.body[0].hours, 1);
  });
});

describe('GET /api/courses/:courseId/study-time', () => {
  test('is zero for a course with no sessions', async () => {
    const course = await makeCourse(request);
    const res = await request('GET', `/api/courses/${course.id}/study-time`);

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { course_id: course.id, session_count: 0, total_hours: 0 });
  });

  test('sums the sessions of that course only', async () => {
    const course = await makeCourse(request);
    const other = await makeCourse(request, { name: 'Other' });
    await makeStudySession(request, course.id, { hours: 2 });
    await makeStudySession(request, course.id, { hours: 1.5 });
    await makeStudySession(request, other.id, { hours: 9 });

    const res = await request('GET', `/api/courses/${course.id}/study-time`);
    assert.equal(res.body.total_hours, 3.5);
    assert.equal(res.body.session_count, 2);
  });

  test('does not leak floating-point drift into the total', async () => {
    const course = await makeCourse(request);
    await makeStudySession(request, course.id, { hours: 0.1 });
    await makeStudySession(request, course.id, { hours: 0.2 });

    const res = await request('GET', `/api/courses/${course.id}/study-time`);
    // 0.1 + 0.2 is 0.30000000000000004 in IEEE 754; the endpoint rounds it.
    assert.equal(res.body.total_hours, 0.3);
  });

  test('404s for a course that does not exist', async () => {
    const res = await request('GET', '/api/courses/9999/study-time');
    assert.equal(res.status, 404);
  });
});

describe('PATCH /api/courses/:courseId/study-sessions/:sessionId', () => {
  test('merges: omitted fields keep their value', async () => {
    const course = await makeCourse(request);
    const session = await makeStudySession(request, course.id, {
      date: '2026-09-01',
      hours: 1.5,
      note: 'original',
    });

    const res = await request(
      'PATCH',
      `/api/courses/${course.id}/study-sessions/${session.id}`,
      { hours: 2.25 },
    );

    assert.equal(res.status, 200);
    assert.equal(res.body.hours, 2.25);
    assert.equal(res.body.date, '2026-09-01');
    assert.equal(res.body.note, 'original');
  });

  test('an explicit null clears the note', async () => {
    const course = await makeCourse(request);
    const session = await makeStudySession(request, course.id, { note: 'temporary' });

    const res = await request(
      'PATCH',
      `/api/courses/${course.id}/study-sessions/${session.id}`,
      { note: null },
    );
    assert.equal(res.body.note, null);
  });

  test('still validates the fields it is given', async () => {
    const course = await makeCourse(request);
    const session = await makeStudySession(request, course.id);

    const res = await request(
      'PATCH',
      `/api/courses/${course.id}/study-sessions/${session.id}`,
      { hours: 99 },
    );
    assert.equal(res.status, 400);
  });
});

describe('cross-course isolation', () => {
  test('a session reached through the wrong course is a 404', async () => {
    const a = await makeCourse(request, { name: 'A' });
    const b = await makeCourse(request, { name: 'B' });
    const session = await makeStudySession(request, a.id);

    const read = await request('GET', `/api/courses/${b.id}/study-sessions/${session.id}`);
    const patch = await request(
      'PATCH',
      `/api/courses/${b.id}/study-sessions/${session.id}`,
      { hours: 5 },
    );
    const del = await request('DELETE', `/api/courses/${b.id}/study-sessions/${session.id}`);

    assert.equal(read.status, 404);
    assert.equal(patch.status, 404);
    assert.equal(del.status, 404);

    // and the row survived the DELETE aimed through the wrong parent
    const still = await request('GET', `/api/courses/${a.id}/study-sessions/${session.id}`);
    assert.equal(still.status, 200);
  });
});

describe('DELETE /api/courses/:courseId/study-sessions/:sessionId', () => {
  test('returns 204 and the total drops by that session', async () => {
    const course = await makeCourse(request);
    await makeStudySession(request, course.id, { hours: 2 });
    const scrap = await makeStudySession(request, course.id, { hours: 3 });

    const before = await request('GET', `/api/courses/${course.id}/study-time`);
    assert.equal(before.body.total_hours, 5);

    const res = await request('DELETE', `/api/courses/${course.id}/study-sessions/${scrap.id}`);
    assert.equal(res.status, 204);

    const after = await request('GET', `/api/courses/${course.id}/study-time`);
    assert.equal(after.body.total_hours, 2);
    assert.equal(after.body.session_count, 1);
  });
});

describe('cascade', () => {
  test('deleting the course removes its study sessions', async () => {
    const course = await makeCourse(request);
    await makeStudySession(request, course.id);
    await makeStudySession(request, course.id);

    assert.equal((await request('DELETE', `/api/courses/${course.id}`)).status, 204);

    const res = await request('GET', `/api/courses/${course.id}/study-sessions`);
    assert.equal(res.status, 404, 'the course itself is gone');
  });
});

describe('is_live_tracked', () => {
  test('defaults to false for a manual entry', async () => {
    const course = await makeCourse(request);
    const session = await makeStudySession(request, course.id);
    assert.equal(session.is_live_tracked, false);
  });

  test('is stored and returned as true when the live timer logs it', async () => {
    const course = await makeCourse(request);
    const res = await request('POST', `/api/courses/${course.id}/study-sessions`, {
      date: '2026-09-02',
      hours: 0.01,
      is_live_tracked: true,
    });

    assert.equal(res.status, 201);
    assert.equal(res.body.is_live_tracked, true);

    const list = await request('GET', `/api/courses/${course.id}/study-sessions`);
    assert.equal(list.body[0].is_live_tracked, true);
  });

  test('rejects a non-boolean', async () => {
    const course = await makeCourse(request);
    const res = await request('POST', `/api/courses/${course.id}/study-sessions`, {
      date: '2026-09-02',
      hours: 1,
      is_live_tracked: 'yes',
    });
    assert.equal(res.status, 400);
  });

  test('a legacy NULL row reads as false, not null', async () => {
    const course = await makeCourse(request);
    // What a row written before the column existed looks like after migration.
    db.prepare(`
      INSERT INTO study_session (course_id, date, hours, note, created_at, is_live_tracked)
      VALUES (?, ?, ?, NULL, ?, NULL)
    `).run(course.id, '2026-08-30', 2, '2026-08-30T10:00:00.000Z');

    const res = await request('GET', `/api/courses/${course.id}/study-sessions`);
    assert.equal(res.body.length, 1);
    assert.equal(res.body[0].is_live_tracked, false);
  });

  test('does not disturb the hours total', async () => {
    const course = await makeCourse(request);
    await makeStudySession(request, course.id, { hours: 2 });
    await request('POST', `/api/courses/${course.id}/study-sessions`, {
      date: '2026-09-02',
      hours: 0.01,
      is_live_tracked: true,
    });

    const res = await request('GET', `/api/courses/${course.id}/study-time`);
    assert.equal(res.body.total_hours, 2.01);
  });
});
