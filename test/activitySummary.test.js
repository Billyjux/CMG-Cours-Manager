const test = require('node:test');
const assert = require('node:assert/strict');

const { start, reset, cleanup, db } = require('./helpers/harness');
const {
  expect, makeCourse, makeTree, makeStudySession,
} = require('./helpers/fixtures');

let request;
let close;

test.before(async () => {
  ({ request, close } = await start());
});

test.after(async () => {
  await close();
  cleanup();
});

test.beforeEach(reset);

/** The same local calendar day the server computes, offset by whole days. */
function localDay(offset = 0) {
  const date = new Date();
  if (offset) date.setDate(date.getDate() + offset);
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

const complete = (courseId, chapterId, lessonId, isComplete = true) =>
  request(
    'PATCH',
    `/api/courses/${courseId}/chapters/${chapterId}/sub-lessons/${lessonId}/complete`,
    { is_complete: isComplete },
  );

/**
 * Moves a completion to another day. There is no API for backdating one — the
 * server always stamps today — so the tests that need history write it
 * directly, which is also the only way to prove the read query groups by the
 * stored day rather than by "now".
 */
const backdate = (lessonId, day) =>
  db.prepare('UPDATE sub_lessons SET completed_on = ? WHERE id = ?').run(day, lessonId);

const dayIn = (summary, date) => summary.activity.find((entry) => entry.date === date);

test('GET /activity-summary shape', async (t) => {
  await t.test('covers 365 days ending today by default', async () => {
    const summary = expect(await request('GET', '/api/activity-summary'), 200);

    assert.equal(summary.days, 365);
    assert.equal(summary.to, localDay());
    assert.equal(summary.from, localDay(-364));
    assert.equal(summary.activity.length, 365);
    assert.equal(summary.activity[0].date, summary.from);
    assert.equal(summary.activity.at(-1).date, summary.to);
  });

  await t.test('honours ?days=', async () => {
    const summary = expect(await request('GET', '/api/activity-summary?days=7'), 200);

    assert.equal(summary.days, 7);
    assert.equal(summary.activity.length, 7);
    assert.equal(summary.from, localDay(-6));
  });

  await t.test('days run forward without gaps or repeats', async () => {
    const summary = expect(await request('GET', '/api/activity-summary?days=40'), 200);
    const dates = summary.activity.map((entry) => entry.date);

    assert.equal(new Set(dates).size, 40);
    assert.deepEqual([...dates].sort(), dates);
  });

  await t.test('an empty database is 365 quiet days, not an empty list', async () => {
    const summary = expect(await request('GET', '/api/activity-summary'), 200);

    assert.ok(summary.activity.every((entry) => entry.level === 0));
    assert.deepEqual(summary.totals, {
      sub_lessons_completed: 0,
      hours: 0,
      active_days: 0,
    });
  });

  await t.test('rejects a days value that is not a positive integer in range', async () => {
    for (const value of ['0', '-5', 'abc', '3.5', '10000']) {
      const res = await request('GET', `/api/activity-summary?days=${value}`);
      assert.equal(res.status, 400, `expected 400 for days=${value}`);
      assert.match(res.body.error, /days/);
    }
  });
});

test('activity is counted on the day it happened', async (t) => {
  await t.test('completing a sub-lesson today marks today', async () => {
    const { course, chapter, lessons } = await makeTree(request, 2);
    expect(await complete(course.id, chapter.id, lessons[0].id), 200);

    const summary = expect(await request('GET', '/api/activity-summary?days=7'), 200);
    const today = dayIn(summary, localDay());

    assert.equal(today.sub_lessons_completed, 1);
    assert.equal(today.hours, 0);
    assert.ok(today.level > 0);
  });

  await t.test('study hours land on the session date, not the date entered', async () => {
    const course = await makeCourse(request);
    await makeStudySession(request, course.id, { date: localDay(-3), hours: 2 });

    const summary = expect(await request('GET', '/api/activity-summary?days=7'), 200);

    assert.equal(dayIn(summary, localDay(-3)).hours, 2);
    assert.equal(dayIn(summary, localDay()).hours, 0);
  });

  await t.test('hours on one day are summed across courses and sessions', async () => {
    const first = await makeCourse(request);
    const second = await makeCourse(request, { name: 'Second' });
    await makeStudySession(request, first.id, { date: localDay(), hours: 0.42 });
    await makeStudySession(request, first.id, { date: localDay(), hours: 0.42 });
    await makeStudySession(request, second.id, { date: localDay(), hours: 1.1 });

    const summary = expect(await request('GET', '/api/activity-summary?days=7'), 200);

    // Rounded to 2dp like every other REAL sum in the API: 1.94, not 1.9400000002.
    assert.equal(dayIn(summary, localDay()).hours, 1.94);
  });

  await t.test('lessons and hours on the same day stack into a stronger shade', async () => {
    const { course, chapter, lessons } = await makeTree(request, 2);
    expect(await complete(course.id, chapter.id, lessons[0].id), 200);
    const lessonOnly = dayIn(
      expect(await request('GET', '/api/activity-summary?days=7'), 200),
      localDay(),
    );

    await makeStudySession(request, course.id, { date: localDay(), hours: 0.42 });
    const both = dayIn(
      expect(await request('GET', '/api/activity-summary?days=7'), 200),
      localDay(),
    );

    assert.equal(lessonOnly.level, 1);
    assert.equal(both.level, 2);
    assert.equal(both.sub_lessons_completed, 1);
    assert.equal(both.hours, 0.42);
  });

  await t.test('a heavy day is capped at level 4', async () => {
    const { course, chapter, lessons } = await makeTree(request, 6);
    for (const lesson of lessons) {
      expect(await complete(course.id, chapter.id, lesson.id), 200);
    }
    await makeStudySession(request, course.id, { date: localDay(), hours: 8 });

    const today = dayIn(
      expect(await request('GET', '/api/activity-summary?days=7'), 200),
      localDay(),
    );

    assert.equal(today.sub_lessons_completed, 6);
    assert.equal(today.level, 4);
  });

  await t.test('days outside the window are excluded, not folded into an edge', async () => {
    const { course, chapter, lessons } = await makeTree(request, 2);
    expect(await complete(course.id, chapter.id, lessons[0].id), 200);
    backdate(lessons[0].id, localDay(-30));
    await makeStudySession(request, course.id, { date: localDay(-30), hours: 3 });

    const week = expect(await request('GET', '/api/activity-summary?days=7'), 200);
    const year = expect(await request('GET', '/api/activity-summary?days=365'), 200);

    assert.ok(week.activity.every((entry) => entry.level === 0));
    assert.deepEqual(week.totals, { sub_lessons_completed: 0, hours: 0, active_days: 0 });
    assert.equal(dayIn(year, localDay(-30)).sub_lessons_completed, 1);
    assert.equal(dayIn(year, localDay(-30)).hours, 3);
  });

  await t.test('totals count every day in the window once', async () => {
    const { course, chapter, lessons } = await makeTree(request, 3);
    expect(await complete(course.id, chapter.id, lessons[0].id), 200);
    expect(await complete(course.id, chapter.id, lessons[1].id), 200);
    backdate(lessons[1].id, localDay(-5));
    await makeStudySession(request, course.id, { date: localDay(), hours: 1.5 });
    await makeStudySession(request, course.id, { date: localDay(-5), hours: 0.5 });

    const summary = expect(await request('GET', '/api/activity-summary?days=30'), 200);

    assert.deepEqual(summary.totals, {
      sub_lessons_completed: 2,
      hours: 2,
      active_days: 2,
    });
  });

  await t.test('deleting a course takes its activity with it', async () => {
    const { course, chapter, lessons } = await makeTree(request, 2);
    expect(await complete(course.id, chapter.id, lessons[0].id), 200);
    await makeStudySession(request, course.id, { date: localDay(), hours: 2 });

    expect(await request('DELETE', `/api/courses/${course.id}`), 204);
    const summary = expect(await request('GET', '/api/activity-summary?days=7'), 200);

    assert.deepEqual(summary.totals, { sub_lessons_completed: 0, hours: 0, active_days: 0 });
  });
});

test('completed_on is stamped by the completion routes', async (t) => {
  const dayOf = async (courseId, chapterId, lessonId) => {
    const res = await request(
      'GET',
      `/api/courses/${courseId}/chapters/${chapterId}/sub-lessons/${lessonId}`,
    );
    return expect(res, 200).completed_on;
  };

  await t.test('a new sub-lesson starts with no completion day', async () => {
    const { course, chapter, lessons } = await makeTree(request, 1);
    assert.equal(await dayOf(course.id, chapter.id, lessons[0].id), null);
  });

  await t.test('the complete toggle sets it, and unticking clears it', async () => {
    const { course, chapter, lessons } = await makeTree(request, 1);
    const lesson = lessons[0];

    expect(await complete(course.id, chapter.id, lesson.id), 200);
    assert.equal(await dayOf(course.id, chapter.id, lesson.id), localDay());

    expect(await complete(course.id, chapter.id, lesson.id, false), 200);
    assert.equal(await dayOf(course.id, chapter.id, lesson.id), null);
  });

  await t.test('re-completing something already done keeps its original day', async () => {
    const { course, chapter, lessons } = await makeTree(request, 1);
    const lesson = lessons[0];

    expect(await complete(course.id, chapter.id, lesson.id), 200);
    backdate(lesson.id, localDay(-10));

    // The idempotent retry this API is built for must not drag the lesson
    // forward into today's square.
    expect(await complete(course.id, chapter.id, lesson.id), 200);
    assert.equal(await dayOf(course.id, chapter.id, lesson.id), localDay(-10));

    // Nor may the bodyless flip, which reads the current state and re-asserts it.
    expect(
      await request(
        'PATCH',
        `/api/courses/${course.id}/chapters/${chapter.id}/sub-lessons/${lesson.id}/complete`,
      ),
      200,
    );
    assert.equal(await dayOf(course.id, chapter.id, lesson.id), null);
  });

  await t.test('creating a sub-lesson already complete stamps today', async () => {
    const course = await makeCourse(request);
    const chapter = expect(
      await request('POST', `/api/courses/${course.id}/chapters`, { title: 'C' }),
      201,
    );
    const lesson = expect(
      await request('POST', `/api/courses/${course.id}/chapters/${chapter.id}/sub-lessons`, {
        title: 'Done already',
        is_complete: true,
      }),
      201,
    );

    assert.equal(lesson.completed_on, localDay());
  });

  await t.test('PUT and PATCH keep the day in step with is_complete', async () => {
    const { course, chapter, lessons } = await makeTree(request, 1);
    const lesson = lessons[0];
    const base = `/api/courses/${course.id}/chapters/${chapter.id}/sub-lessons/${lesson.id}`;

    expect(await request('PATCH', base, { is_complete: true }), 200);
    assert.equal(await dayOf(course.id, chapter.id, lesson.id), localDay());

    // PATCH leaving is_complete out must not disturb the day it was finished.
    backdate(lesson.id, localDay(-4));
    expect(await request('PATCH', base, { title: 'Renamed' }), 200);
    assert.equal(await dayOf(course.id, chapter.id, lesson.id), localDay(-4));

    // PUT replaces: an omitted is_complete resets to false, so the day goes too.
    expect(await request('PUT', base, { title: 'Replaced' }), 200);
    assert.equal(await dayOf(course.id, chapter.id, lesson.id), null);
  });

  await t.test('a completion made through PUT shows up in the summary', async () => {
    const { course, chapter, lessons } = await makeTree(request, 1);
    expect(
      await request(
        'PUT',
        `/api/courses/${course.id}/chapters/${chapter.id}/sub-lessons/${lessons[0].id}`,
        { title: 'Finished', is_complete: true },
      ),
      200,
    );

    const summary = expect(await request('GET', '/api/activity-summary?days=7'), 200);
    assert.equal(dayIn(summary, localDay()).sub_lessons_completed, 1);
  });
});
