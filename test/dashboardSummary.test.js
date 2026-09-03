const { test, before, after, beforeEach, describe } = require('node:test');
const assert = require('node:assert/strict');
const { start, reset, cleanup } = require('./helpers/harness');
const { makeCourse, makeDeadline, makeReminder } = require('./helpers/fixtures');

let request;
let close;

before(async () => { ({ request, close } = await start()); });
after(async () => { await close(); cleanup(); });
beforeEach(reset);

/** Local calendar day offset from today, matching what the route computes. */
function day(offset) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const logStudy = (courseId, date, hours) =>
  request('POST', `/api/courses/${courseId}/study-sessions`, { date, hours });

describe('GET /api/dashboard-summary', () => {
  test('is well formed and empty on a fresh install', async () => {
    const res = await request('GET', '/api/dashboard-summary');

    assert.equal(res.status, 200);
    assert.deepEqual(res.body.upcoming, []);
    assert.equal(res.body.study_time_this_week.total_hours, 0);
    assert.equal(res.body.study_time_this_week.session_count, 0);
    assert.equal(res.body.today, day(0));
  });

  test('merges deadlines and undone reminders, soonest first', async () => {
    const course = await makeCourse(request, { name: 'Electronique' });
    await makeDeadline(request, course.id, { title: 'Rapport', due_date: day(5) });
    await makeReminder(request, { text: 'Calculatrice', remind_date: day(1), course_id: course.id });
    await makeDeadline(request, course.id, { title: 'Devoir', due_date: day(-3) });

    const res = await request('GET', '/api/dashboard-summary');
    assert.deepEqual(
      res.body.upcoming.map((i) => [i.type, i.title, i.date]),
      [
        ['deadline', 'Devoir', day(-3)],
        ['reminder', 'Calculatrice', day(1)],
        ['deadline', 'Rapport', day(5)],
      ],
    );
  });

  test('carries the course name, and null for a general reminder', async () => {
    const course = await makeCourse(request, { name: 'Thermodynamique' });
    await makeDeadline(request, course.id, { title: 'Examen', due_date: day(2) });
    await makeReminder(request, { text: 'Bibliotheque', remind_date: day(3) });

    const res = await request('GET', '/api/dashboard-summary');
    const [deadline, reminder] = res.body.upcoming;

    assert.equal(deadline.course_name, 'Thermodynamique');
    assert.equal(deadline.course_id, course.id);
    assert.equal(reminder.course_name, null);
    assert.equal(reminder.course_id, null);
  });

  test('includes anything overdue however old, and excludes beyond the window', async () => {
    const course = await makeCourse(request);
    await makeDeadline(request, course.id, { title: 'Ancient', due_date: '2020-01-01' });
    await makeDeadline(request, course.id, { title: 'Just inside', due_date: day(7) });
    await makeDeadline(request, course.id, { title: 'Too far', due_date: day(8) });

    const res = await request('GET', '/api/dashboard-summary');
    const titles = res.body.upcoming.map((i) => i.title);
    assert.ok(titles.includes('Ancient'), 'old overdue items stay');
    assert.ok(titles.includes('Just inside'));
    assert.ok(!titles.includes('Too far'), 'day 8 is outside the 7-day window');
  });

  test('leaves out reminders already marked done', async () => {
    const done = await makeReminder(request, { text: 'Done one', remind_date: day(1) });
    await makeReminder(request, { text: 'Still open', remind_date: day(2) });
    await request('PATCH', `/api/reminders/${done.id}`, { is_done: true });

    const res = await request('GET', '/api/dashboard-summary');
    assert.deepEqual(res.body.upcoming.map((i) => i.title), ['Still open']);
  });

  test('returns at most five items', async () => {
    const course = await makeCourse(request);
    for (let i = 0; i < 8; i += 1) {
      await makeDeadline(request, course.id, { title: `D${i}`, due_date: day(i % 7) });
    }

    const res = await request('GET', '/api/dashboard-summary');
    assert.equal(res.body.upcoming.length, 5);
  });

  test('sums study hours across all courses inside the 7-day window', async () => {
    const a = await makeCourse(request, { name: 'A' });
    const b = await makeCourse(request, { name: 'B' });

    await logStudy(a.id, day(0), 1.5);
    await logStudy(b.id, day(-3), 2);
    await logStudy(a.id, day(-6), 0.5);   // oldest day still inside the window
    await logStudy(b.id, day(-7), 4);     // one day too old
    await logStudy(a.id, day(1), 3);      // dated in the future

    const res = await request('GET', '/api/dashboard-summary');
    assert.equal(res.body.study_time_this_week.total_hours, 4);
    assert.equal(res.body.study_time_this_week.session_count, 3);
    assert.equal(res.body.study_time_this_week.from, day(-6));
    assert.equal(res.body.study_time_this_week.to, day(0));
  });

  test('does not leak floating-point drift into the week total', async () => {
    const course = await makeCourse(request);
    await logStudy(course.id, day(0), 0.1);
    await logStudy(course.id, day(-1), 0.2);

    const res = await request('GET', '/api/dashboard-summary');
    assert.equal(res.body.study_time_this_week.total_hours, 0.3);
  });

  test('drops a deleted course cleanly out of the summary', async () => {
    const course = await makeCourse(request);
    await makeDeadline(request, course.id, { title: 'Goes away', due_date: day(1) });
    await makeReminder(request, { text: 'Also goes', remind_date: day(1), course_id: course.id });
    await logStudy(course.id, day(0), 3);

    await request('DELETE', `/api/courses/${course.id}`);

    const res = await request('GET', '/api/dashboard-summary');
    assert.deepEqual(res.body.upcoming, []);
    assert.equal(res.body.study_time_this_week.total_hours, 0);
  });
});
