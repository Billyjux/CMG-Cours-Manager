// The weekly report. Split in two on purpose: the arithmetic is asserted
// against the plain data object, and the endpoint is checked only for being a
// real, downloadable PDF. Reading figures back out of a PDF would test the
// renderer's text layout far more than it tested the numbers.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  start, reset, cleanup, db,
} = require('./helpers/harness');
const {
  makeCourse, makeChapter, makeSubLesson, makeStudySession, makeDeadline,
} = require('./helpers/fixtures');

const { buildWeeklyReport } = require('../src/reports/weeklyReport');
const { localDay } = require('../src/util/validate');

let request;
let close;
let base;

test.before(async () => {
  ({ request, close, base } = await start());
});

test.after(async () => {
  await close();
  cleanup();
});

/** Marks a sub-lesson complete through the API, the way the app does. */
async function complete(courseId, chapterId, subLessonId) {
  const res = await request(
    'PATCH',
    `/api/courses/${courseId}/chapters/${chapterId}/sub-lessons/${subLessonId}/complete`,
    { is_complete: true },
  );
  assert.equal(res.status, 200);
}

test('weekly report data', async (t) => {
  await t.test('is empty but well formed with no courses', () => {
    reset();
    const report = buildWeeklyReport();

    assert.deepEqual(report.courses, []);
    assert.equal(report.totals.hours_this_week, 0);
    assert.equal(report.totals.session_count, 0);
    assert.equal(report.totals.course_count, 0);
    assert.equal(report.needs_attention, null);
    assert.equal(report.week.days, 7);
  });

  await t.test('the week is seven days inclusive, ending today', () => {
    reset();
    const report = buildWeeklyReport();

    assert.equal(report.week.to, localDay(0));
    assert.equal(report.week.from, localDay(-6));
  });

  await t.test('percentages and remaining counts match the progress endpoint', async () => {
    reset();
    const course = await makeCourse(request, { name: 'Signals' });
    const chapter = await makeChapter(request, course.id);
    const lessons = [];
    for (let i = 0; i < 8; i += 1) {
      lessons.push(await makeSubLesson(request, course.id, chapter.id, { title: `L${i}` }));
    }
    await complete(course.id, chapter.id, lessons[0].id);
    await complete(course.id, chapter.id, lessons[1].id);
    await complete(course.id, chapter.id, lessons[2].id);

    const report = buildWeeklyReport();
    const entry = report.courses.find((c) => c.id === course.id);

    // 3/8 = 37.5%, and the endpoint the app reads must agree exactly.
    const progress = await request('GET', `/api/courses/${course.id}/progress`);
    assert.equal(entry.progress_percent, 37.5);
    assert.equal(entry.progress_percent, progress.body.progress_percent);
    assert.equal(entry.total_sub_lessons, 8);
    assert.equal(entry.completed_sub_lessons, 3);
    assert.equal(entry.remaining_sub_lessons, 5);
  });

  await t.test('a course with no chapters is 0% with nothing remaining', async () => {
    reset();
    const course = await makeCourse(request, { name: 'Empty' });

    const entry = buildWeeklyReport().courses.find((c) => c.id === course.id);
    assert.equal(entry.progress_percent, 0);
    assert.equal(entry.total_sub_lessons, 0);
    assert.equal(entry.remaining_sub_lessons, 0);
  });

  await t.test('hours count only the last seven days, per course and in total', async () => {
    reset();
    const a = await makeCourse(request, { name: 'Alpha' });
    const b = await makeCourse(request, { name: 'Beta' });

    await makeStudySession(request, a.id, { date: localDay(0), hours: 1.5 });
    await makeStudySession(request, a.id, { date: localDay(-6), hours: 0.5 });
    await makeStudySession(request, b.id, { date: localDay(-2), hours: 2 });
    // Just outside the window on both sides.
    await makeStudySession(request, a.id, { date: localDay(-7), hours: 9 });

    const report = buildWeeklyReport();
    const alpha = report.courses.find((c) => c.id === a.id);
    const beta = report.courses.find((c) => c.id === b.id);

    assert.equal(alpha.hours_this_week, 2);
    assert.equal(beta.hours_this_week, 2);
    assert.equal(report.totals.hours_this_week, 4);
    assert.equal(report.totals.session_count, 3);
  });

  await t.test('the weekly total agrees with /dashboard-summary', async () => {
    reset();
    const course = await makeCourse(request);
    // Values chosen to drift if summed as floats: 0.1 + 0.2 !== 0.3.
    await makeStudySession(request, course.id, { date: localDay(0), hours: 0.1 });
    await makeStudySession(request, course.id, { date: localDay(-1), hours: 0.2 });

    const summary = await request('GET', '/api/dashboard-summary');
    const report = buildWeeklyReport();

    assert.equal(report.totals.hours_this_week, summary.body.study_time_this_week.total_hours);
    assert.equal(report.totals.hours_this_week, 0.3);
  });

  await t.test('deadlines inside the window are listed with a relative day', async () => {
    reset();
    const course = await makeCourse(request);
    await makeDeadline(request, course.id, { title: 'Soon', due_date: localDay(3) });
    await makeDeadline(request, course.id, { title: 'Edge', due_date: localDay(7) });
    await makeDeadline(request, course.id, { title: 'Later', due_date: localDay(8) });

    const entry = buildWeeklyReport().courses.find((c) => c.id === course.id);
    const titles = entry.deadlines.map((d) => d.title);

    assert.deepEqual(titles, ['Soon', 'Edge']);
    assert.equal(entry.deadlines[0].days_until, 3);
    assert.equal(entry.deadlines[0].is_overdue, false);
  });

  await t.test('an overdue deadline is kept and flagged, as on the dashboard', async () => {
    reset();
    const course = await makeCourse(request);
    await makeDeadline(request, course.id, { title: 'Missed', due_date: localDay(-2) });

    const entry = buildWeeklyReport().courses.find((c) => c.id === course.id);
    assert.equal(entry.deadlines.length, 1);
    assert.equal(entry.deadlines[0].days_until, -2);
    assert.equal(entry.deadlines[0].is_overdue, true);
  });

  await t.test('needs_attention picks the lowest completion', async () => {
    reset();
    const low = await makeCourse(request, { name: 'Low' });
    const high = await makeCourse(request, { name: 'High' });

    const lowChapter = await makeChapter(request, low.id);
    const l1 = await makeSubLesson(request, low.id, lowChapter.id);
    await makeSubLesson(request, low.id, lowChapter.id);
    await makeSubLesson(request, low.id, lowChapter.id);
    await makeSubLesson(request, low.id, lowChapter.id);
    await complete(low.id, lowChapter.id, l1.id);          // 25%

    const highChapter = await makeChapter(request, high.id);
    const h1 = await makeSubLesson(request, high.id, highChapter.id);
    await makeSubLesson(request, high.id, highChapter.id);
    await complete(high.id, highChapter.id, h1.id);        // 50%

    const report = buildWeeklyReport();
    assert.equal(report.needs_attention.course_id, low.id);
    assert.equal(report.needs_attention.progress_percent, 25);
    assert.equal(report.needs_attention.remaining_sub_lessons, 3);
  });

  await t.test('a course with no sub-lessons never wins needs_attention', async () => {
    reset();
    await makeCourse(request, { name: 'Shell with nothing in it' });
    const real = await makeCourse(request, { name: 'Real' });
    const chapter = await makeChapter(request, real.id);
    await makeSubLesson(request, real.id, chapter.id);

    // The shell sits at 0% and would win on percentage alone; it is skipped so
    // the report nominates work being neglected, not an empty placeholder.
    const report = buildWeeklyReport();
    assert.equal(report.needs_attention.course_id, real.id);
    assert.equal(report.needs_attention.progress_percent, 0);
  });

  await t.test('needs_attention is null when nothing has sub-lessons', async () => {
    reset();
    await makeCourse(request, { name: 'Only a name' });
    assert.equal(buildWeeklyReport().needs_attention, null);
  });

  await t.test('courses are listed alphabetically, case-insensitively', async () => {
    reset();
    await makeCourse(request, { name: 'zeta' });
    await makeCourse(request, { name: 'Alpha' });
    await makeCourse(request, { name: 'beta' });

    const names = buildWeeklyReport().courses.map((c) => c.name);
    assert.deepEqual(names, ['Alpha', 'beta', 'zeta']);
  });
});

test('GET /api/reports/weekly', async (t) => {
  await t.test('returns a downloadable PDF', async () => {
    reset();
    const course = await makeCourse(request, { name: 'Physics 101' });
    const chapter = await makeChapter(request, course.id);
    await makeSubLesson(request, course.id, chapter.id);
    await makeStudySession(request, course.id, { date: localDay(-1), hours: 1.25 });
    await makeDeadline(request, course.id, { title: 'Exam', due_date: localDay(4) });

    // Raw fetch: the harness helper decodes bodies as text/JSON, which a PDF
    // is not. Bytes are what the browser will be handed, so bytes are what is
    // checked here.
    const res = await fetch(`${base}/api/reports/weekly`);
    const bytes = Buffer.from(await res.arrayBuffer());

    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/pdf');
    assert.match(
      res.headers.get('content-disposition'),
      /^attachment; filename="weekly-study-report-\d{4}-\d{2}-\d{2}\.pdf"$/,
    );
    // A real PDF starts with %PDF- and ends with an EOF marker; a truncated
    // stream would still have the header, so both ends are checked.
    assert.equal(bytes.subarray(0, 5).toString('latin1'), '%PDF-');
    assert.match(bytes.subarray(-32).toString('latin1'), /%%EOF/);
    assert.ok(bytes.length > 1000, `suspiciously small PDF: ${bytes.length} bytes`);
  });

  await t.test('renders with no courses at all', async () => {
    reset();
    const res = await fetch(`${base}/api/reports/weekly`);
    const bytes = Buffer.from(await res.arrayBuffer());

    assert.equal(res.status, 200);
    assert.equal(bytes.subarray(0, 5).toString('latin1'), '%PDF-');
  });

  await t.test('is not cached', async () => {
    reset();
    const res = await fetch(`${base}/api/reports/weekly`);
    await res.arrayBuffer();
    assert.equal(res.headers.get('cache-control'), 'no-store');
  });

  await t.test('an unknown report is a 404, not a PDF', async () => {
    const res = await request('GET', '/api/reports/nope');
    assert.equal(res.status, 404);
  });

  await t.test('renders a course named outside Latin-1 without vanishing', async () => {
    // The standard PDF fonts are WinAnsi and pdfkit drops what they cannot
    // encode *silently*. This once swallowed a bullet and an em dash from the
    // deadline lines; the guard turns unencodable text into a visible marker
    // instead, so a name in another script cannot render as an empty heading.
    reset();
    await makeCourse(request, { name: '量子力学' });

    const res = await fetch(`${base}/api/reports/weekly`);
    const bytes = Buffer.from(await res.arrayBuffer());

    assert.equal(res.status, 200);
    assert.equal(bytes.subarray(0, 5).toString('latin1'), '%PDF-');
  });
});
