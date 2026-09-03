// Data behind the weekly PDF report. Read-only: it opens no transaction and
// writes nothing.
//
// Deliberately separate from the rendering. The numbers are the part that can
// be wrong, and asserting them against a plain object is worth far more than
// trying to read them back out of a PDF — so the route builds this first, and
// only then hands it to a renderer that does no arithmetic of its own.
//
// Every figure here is computed the same way the endpoint that already shows it
// computes it, because the report is checked against the app: a percentage that
// rounds differently, or a week that starts on a different day, reads as a bug
// in the report even when both numbers are defensible.

const { db } = require('../db');
const { localDay } = require('../util/validate');

// Matches /dashboard-summary: seven days *inclusive*, ending today.
const WEEK_DAYS = 7;
// Matches the dashboard's "Upcoming" window.
const DEADLINE_WINDOW_DAYS = 7;

const stmt = {
  // Alphabetical rather than the app's newest-first: this is a document to be
  // scanned for a course by name, and the order should not change as courses
  // are added. The summary, not the ordering, says who needs attention.
  courses: db.prepare('SELECT id, name FROM courses ORDER BY name COLLATE NOCASE, id'),

  // Same shape as /courses/:courseId/progress, grouped so one query covers
  // every course. A course with no chapters produces no row at all, so callers
  // must default it rather than assume a hit.
  progress: db.prepare(`
    SELECT
      c.course_id                      AS course_id,
      COUNT(sl.id)                     AS total,
      COALESCE(SUM(sl.is_complete), 0) AS completed
    FROM chapters c
    LEFT JOIN sub_lessons sl ON sl.chapter_id = c.id
    GROUP BY c.course_id
  `),

  hoursByCourse: db.prepare(`
    SELECT course_id, COALESCE(SUM(hours), 0) AS hours
    FROM study_session
    WHERE date BETWEEN @from AND @to
    GROUP BY course_id
  `),

  // Totalled in SQL rather than by adding the per-course figures up in JS:
  // summing values that have each already been rounded to 2dp drifts away from
  // what /dashboard-summary prints, and these two numbers are compared.
  weekTotal: db.prepare(`
    SELECT
      COALESCE(SUM(hours), 0) AS total_hours,
      COUNT(*)                AS session_count
    FROM study_session
    WHERE date BETWEEN @from AND @to
  `),

  // No lower bound, exactly as /dashboard-summary does it: something that was
  // due last week has not stopped needing attention, and a report that quietly
  // dropped it would be worse than one that flags it as overdue.
  deadlines: db.prepare(`
    SELECT course_id, title, due_date
    FROM deadline
    WHERE due_date <= @until
    ORDER BY due_date, id
  `),
};

/** Whole days from one calendar day to another; negative when already past. */
function daysBetween(fromYmd, toYmd) {
  // Parsed as local midnight, never as a bare date string: `new Date('2026-09-02')`
  // is UTC midnight and lands on the previous day west of Greenwich.
  const from = new Date(`${fromYmd}T00:00:00`);
  const to = new Date(`${toYmd}T00:00:00`);
  return Math.round((to - from) / 86400000);
}

/** The same rounding /courses/:courseId/progress applies, to one decimal. */
const percentOf = (completed, total) =>
  (total === 0 ? 0 : Math.round((completed / total) * 1000) / 10);

/** REAL sums drift (0.1 + 0.2); every hours figure the API emits is 2dp. */
const round2 = (value) => Math.round(value * 100) / 100;

/**
 * The course to single out as needing the most attention.
 *
 * Only courses that actually have sub-lessons are eligible. A course with none
 * sits at 0% by definition, and letting it win would mean the report always
 * nominated the emptiest shell on the list instead of the work being neglected.
 *
 * Ties break on the most lessons outstanding, then on id, so the same data
 * always names the same course.
 */
function pickNeedsAttention(courses) {
  const eligible = courses.filter((course) => course.total_sub_lessons > 0);
  if (!eligible.length) return null;

  const worst = eligible.reduce((lowest, course) => {
    if (course.progress_percent !== lowest.progress_percent) {
      return course.progress_percent < lowest.progress_percent ? course : lowest;
    }
    if (course.remaining_sub_lessons !== lowest.remaining_sub_lessons) {
      return course.remaining_sub_lessons > lowest.remaining_sub_lessons ? course : lowest;
    }
    return course.id < lowest.id ? course : lowest;
  });

  return {
    course_id: worst.id,
    name: worst.name,
    progress_percent: worst.progress_percent,
    remaining_sub_lessons: worst.remaining_sub_lessons,
  };
}

/**
 * Builds the whole report as plain data. Takes `today` so tests can pin the
 * window instead of depending on the day they happen to run.
 */
function buildWeeklyReport({ today = localDay(0) } = {}) {
  const weekFrom = localDay(-(WEEK_DAYS - 1));
  const deadlineUntil = localDay(DEADLINE_WINDOW_DAYS);

  const progressByCourse = new Map(
    stmt.progress.all().map((row) => [row.course_id, row]),
  );
  const hoursByCourse = new Map(
    stmt.hoursByCourse.all({ from: weekFrom, to: today }).map((row) => [row.course_id, row.hours]),
  );

  const deadlinesByCourse = new Map();
  for (const row of stmt.deadlines.all({ until: deadlineUntil })) {
    const daysUntil = daysBetween(today, row.due_date);
    if (!deadlinesByCourse.has(row.course_id)) deadlinesByCourse.set(row.course_id, []);
    deadlinesByCourse.get(row.course_id).push({
      title: row.title,
      due_date: row.due_date,
      days_until: daysUntil,
      is_overdue: daysUntil < 0,
    });
  }

  const courses = stmt.courses.all().map((course) => {
    const { total = 0, completed = 0 } = progressByCourse.get(course.id) ?? {};
    return {
      id: course.id,
      name: course.name,
      progress_percent: percentOf(completed, total),
      total_sub_lessons: total,
      completed_sub_lessons: completed,
      remaining_sub_lessons: total - completed,
      hours_this_week: round2(hoursByCourse.get(course.id) ?? 0),
      deadlines: deadlinesByCourse.get(course.id) ?? [],
    };
  });

  const week = stmt.weekTotal.get({ from: weekFrom, to: today });

  return {
    generated_on: today,
    week: { from: weekFrom, to: today, days: WEEK_DAYS },
    deadline_window: { from: today, to: deadlineUntil, days: DEADLINE_WINDOW_DAYS },
    totals: {
      hours_this_week: round2(week.total_hours),
      session_count: week.session_count,
      course_count: courses.length,
    },
    needs_attention: pickNeedsAttention(courses),
    courses,
  };
}

module.exports = { buildWeeklyReport, daysBetween };
