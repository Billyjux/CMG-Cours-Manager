const { test, before, after, beforeEach, describe } = require('node:test');
const assert = require('node:assert/strict');
const { start, reset, cleanup } = require('./helpers/harness');
const { makeCourse, makeReminder } = require('./helpers/fixtures');

let request;
let close;

before(async () => { ({ request, close } = await start()); });
after(async () => { await close(); cleanup(); });
beforeEach(reset);

describe('POST /api/reminders', () => {
  test('creates a general reminder with no course', async () => {
    const res = await request('POST', '/api/reminders', {
      text: 'Rendre les livres a la bibliotheque',
      remind_date: '2026-09-20',
    });

    assert.equal(res.status, 201);
    assert.equal(res.body.course_id, null);
    assert.equal(res.body.text, 'Rendre les livres a la bibliotheque');
    assert.equal(res.body.remind_date, '2026-09-20');
    assert.equal(res.body.is_done, false);
    assert.ok(res.body.created_at);
  });

  test('creates a reminder tied to a course', async () => {
    const course = await makeCourse(request);
    const reminder = await makeReminder(request, { course_id: course.id });
    assert.equal(reminder.course_id, course.id);
  });

  test('an explicit null course_id is a general reminder', async () => {
    const reminder = await makeReminder(request, { course_id: null });
    assert.equal(reminder.course_id, null);
  });

  test('requires text and a remind_date', async () => {
    const noText = await request('POST', '/api/reminders', { remind_date: '2026-09-20' });
    const noDate = await request('POST', '/api/reminders', { text: 'Something' });
    const blank = await request('POST', '/api/reminders', {
      text: '   ',
      remind_date: '2026-09-20',
    });

    assert.equal(noText.status, 400);
    assert.match(noText.body.error, /text/);
    assert.equal(noDate.status, 400);
    assert.match(noDate.body.error, /remind_date/);
    assert.equal(blank.status, 400);
  });

  test('rejects malformed and impossible dates', async () => {
    for (const remind_date of ['20/09/2026', '2026-9-20', 'soon', '2026-02-30']) {
      const res = await request('POST', '/api/reminders', { text: 'x', remind_date });
      assert.equal(res.status, 400, `expected 400 for ${remind_date}`);
    }
  });

  test('404s when course_id points at a course that does not exist', async () => {
    const res = await request('POST', '/api/reminders', {
      text: 'x',
      remind_date: '2026-09-20',
      course_id: 9999,
    });
    assert.equal(res.status, 404);
  });
});

describe('GET /api/reminders', () => {
  test('returns everything, general reminders included, sorted by date', async () => {
    const course = await makeCourse(request);
    await makeReminder(request, { text: 'C', remind_date: '2026-12-01' });
    await makeReminder(request, { text: 'A', remind_date: '2026-01-15', course_id: course.id });
    await makeReminder(request, { text: 'B', remind_date: '2026-06-30' });

    const res = await request('GET', '/api/reminders');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.map((r) => r.text), ['A', 'B', 'C']);
  });

  test('?course_id= narrows to that course only', async () => {
    const a = await makeCourse(request, { name: 'A' });
    const b = await makeCourse(request, { name: 'B' });
    await makeReminder(request, { text: 'for A', course_id: a.id });
    await makeReminder(request, { text: 'for B', course_id: b.id });
    await makeReminder(request, { text: 'general' });

    const res = await request('GET', `/api/reminders?course_id=${a.id}`);
    assert.equal(res.body.length, 1);
    assert.equal(res.body[0].text, 'for A');
  });

  test('?course_id= for an unknown course is a 404, not an empty list', async () => {
    const res = await request('GET', '/api/reminders?course_id=9999');
    assert.equal(res.status, 404);
  });

  test('?course_id= must be a number', async () => {
    const res = await request('GET', '/api/reminders?course_id=abc');
    assert.equal(res.status, 400);
  });
});

describe('PATCH /api/reminders/:reminderId', () => {
  test('toggles is_done both ways with an explicit boolean', async () => {
    const reminder = await makeReminder(request);
    assert.equal(reminder.is_done, false);

    const done = await request('PATCH', `/api/reminders/${reminder.id}`, { is_done: true });
    assert.equal(done.status, 200);
    assert.equal(done.body.is_done, true);

    const undone = await request('PATCH', `/api/reminders/${reminder.id}`, { is_done: false });
    assert.equal(undone.body.is_done, false);
  });

  test('repeating the same value is idempotent', async () => {
    const reminder = await makeReminder(request);
    await request('PATCH', `/api/reminders/${reminder.id}`, { is_done: true });
    const again = await request('PATCH', `/api/reminders/${reminder.id}`, { is_done: true });
    assert.equal(again.body.is_done, true);
  });

  test('marking done leaves the row in place', async () => {
    const reminder = await makeReminder(request);
    await request('PATCH', `/api/reminders/${reminder.id}`, { is_done: true });

    const list = await request('GET', '/api/reminders');
    assert.equal(list.body.length, 1, 'a done reminder is not deleted');
    assert.equal(list.body[0].is_done, true);
  });

  test('merges: omitted fields keep their value', async () => {
    const reminder = await makeReminder(request, {
      text: 'Original',
      remind_date: '2026-09-15',
    });

    const res = await request('PATCH', `/api/reminders/${reminder.id}`, { is_done: true });
    assert.equal(res.body.text, 'Original');
    assert.equal(res.body.remind_date, '2026-09-15');
  });

  test('still validates what it is given', async () => {
    const reminder = await makeReminder(request);
    const badDate = await request('PATCH', `/api/reminders/${reminder.id}`, {
      remind_date: 'tomorrow',
    });
    const badFlag = await request('PATCH', `/api/reminders/${reminder.id}`, { is_done: 'yes' });

    assert.equal(badDate.status, 400);
    assert.equal(badFlag.status, 400);
  });

  test('404s for a reminder that does not exist', async () => {
    const res = await request('PATCH', '/api/reminders/9999', { is_done: true });
    assert.equal(res.status, 404);
  });
});

describe('DELETE /api/reminders/:reminderId', () => {
  test('returns 204 and removes only that reminder', async () => {
    const keep = await makeReminder(request, { text: 'Keep' });
    const scrap = await makeReminder(request, { text: 'Scrap' });

    const res = await request('DELETE', `/api/reminders/${scrap.id}`);
    assert.equal(res.status, 204);

    const list = await request('GET', '/api/reminders');
    assert.deepEqual(list.body.map((r) => r.id), [keep.id]);
  });
});

describe('cascade', () => {
  test('deleting a course removes its reminders but not the general ones', async () => {
    const course = await makeCourse(request);
    await makeReminder(request, { text: 'tied', course_id: course.id });
    await makeReminder(request, { text: 'general' });

    assert.equal((await request('DELETE', `/api/courses/${course.id}`)).status, 204);

    const list = await request('GET', '/api/reminders');
    assert.deepEqual(list.body.map((r) => r.text), ['general']);
  });

  test('does not disturb the deadlines or study sessions of that course', async () => {
    const course = await makeCourse(request);
    const reminder = await makeReminder(request, { course_id: course.id });
    await request('POST', `/api/courses/${course.id}/deadlines`, {
      title: 'Rapport',
      due_date: '2026-09-15',
    });
    await request('POST', `/api/courses/${course.id}/study-sessions`, {
      date: '2026-09-01',
      hours: 2,
    });

    await request('DELETE', `/api/reminders/${reminder.id}`);

    const deadlines = await request('GET', `/api/courses/${course.id}/deadlines`);
    const studyTime = await request('GET', `/api/courses/${course.id}/study-time`);
    assert.equal(deadlines.body.length, 1);
    assert.equal(studyTime.body.total_hours, 2);
  });
});
