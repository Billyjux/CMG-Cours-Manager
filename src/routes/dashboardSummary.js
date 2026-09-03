// Read-only aggregation for the dashboard. Exists purely so the overview does
// not have to fan out to courses + deadlines + reminders + study-sessions per
// course (3N + 2 requests). Touches no other route's shape.

const express = require('express');
const { db } = require('../db');
const { wrap, localDay } = require('../util/validate');

const router = express.Router();

const UPCOMING_LIMIT = 5;
const WINDOW_DAYS = 7;
const WEEK_DAYS = 7;

// Local, not UTC: the client judges urgency against its own today and both run
// on the same machine here.
const dayOffset = localDay;

const stmt = {
  // No lower bound: anything already overdue stays in the list however old.
  deadlines: db.prepare(`
    SELECT d.id, d.course_id, c.name AS course_name, d.title, d.due_date AS date
    FROM deadline d
    JOIN courses c ON c.id = d.course_id
    WHERE d.due_date <= @until
  `),
  // LEFT JOIN because a reminder may be general (course_id NULL), and only
  // undone ones are worth surfacing.
  reminders: db.prepare(`
    SELECT r.id, r.course_id, c.name AS course_name, r.text AS title, r.remind_date AS date
    FROM reminder r
    LEFT JOIN courses c ON c.id = r.course_id
    WHERE r.is_done = 0 AND r.remind_date <= @until
  `),
  studyWeek: db.prepare(`
    SELECT
      COALESCE(SUM(hours), 0) AS total_hours,
      COUNT(*)                AS session_count
    FROM study_session
    WHERE date BETWEEN @from AND @to
  `),
};

router.get('/', wrap((req, res) => {
  const today = dayOffset(0);
  const until = dayOffset(WINDOW_DAYS);
  const weekFrom = dayOffset(-(WEEK_DAYS - 1));

  const upcoming = [
    ...stmt.deadlines.all({ until }).map((row) => ({ type: 'deadline', ...row })),
    ...stmt.reminders.all({ until }).map((row) => ({ type: 'reminder', ...row })),
  ]
    // Soonest (and most overdue) first; type then id keep same-day ties stable.
    .sort((a, b) =>
      a.date.localeCompare(b.date)
      || a.type.localeCompare(b.type)
      || a.id - b.id)
    .slice(0, UPCOMING_LIMIT);

  const week = stmt.studyWeek.get({ from: weekFrom, to: today });

  res.json({
    today,
    window_days: WINDOW_DAYS,
    upcoming,
    study_time_this_week: {
      from: weekFrom,
      to: today,
      // Summing REALs drifts, same as the per-course study-time endpoint.
      total_hours: Math.round(week.total_hours * 100) / 100,
      session_count: week.session_count,
    },
  });
}));

module.exports = router;
