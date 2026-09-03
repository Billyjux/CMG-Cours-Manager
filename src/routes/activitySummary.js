// Read-only day-by-day activity for the contribution grid. It combines two
// things the app already records — sub-lessons ticked off, and hours studied —
// into one 0-4 intensity per calendar day. It writes nothing and owns no table
// of its own; the only reason `sub_lessons.completed_on` exists is that a
// completion had nowhere to record *when* it happened.

const express = require('express');
const { db } = require('../db');
const { badRequest } = require('../middleware/errors');
const { wrap, localDay } = require('../util/validate');

const router = express.Router();

const DEFAULT_DAYS = 365;
// Two years. A grid longer than this is unreadable long before it is slow.
const MAX_DAYS = 732;

/**
 * How much of each signal buys one more shade. Both scales run 0-4 and are
 * summed, capped at 4, so a day of nothing but reading and a day of nothing but
 * ticking boxes can each light up on their own, and a day of both lights up
 * harder. The first hour step is deliberately tiny: any studying at all should
 * colour the square, and the shortest thing the app can log is a 25-minute
 * pomodoro at 0.42 h.
 */
const LESSON_STEPS = [1, 2, 3, 5];
const HOUR_STEPS = [0.01, 1, 2.5, 4];
const MAX_LEVEL = 4;

/** How many of the ascending `steps` a value has reached: 0 through steps.length. */
const stepsReached = (value, steps) =>
  steps.reduce((count, step) => (value >= step ? count + 1 : count), 0);

/** Sums of REAL drift (0.1 + 0.2), the same as the study-time endpoint. */
const round2 = (value) => Math.round(value * 100) / 100;

const stmt = {
  // NULL completed_on is every lesson still outstanding, plus any ticked off
  // before the column existed. Neither has a day to draw on.
  lessons: db.prepare(`
    SELECT completed_on AS date, COUNT(*) AS count
    FROM sub_lessons
    WHERE completed_on IS NOT NULL AND completed_on BETWEEN @from AND @to
    GROUP BY completed_on
  `),
  hours: db.prepare(`
    SELECT date, SUM(hours) AS hours
    FROM study_session
    WHERE date BETWEEN @from AND @to
    GROUP BY date
  `),
};

/** `days` arrives as a query string, so it gets its own reader. */
function readDays(raw) {
  if (raw === undefined) return DEFAULT_DAYS;
  if (Array.isArray(raw) || !/^\d+$/.test(String(raw))) {
    throw badRequest('"days" must be a positive integer');
  }
  const days = Number(raw);
  if (days < 1 || days > MAX_DAYS) {
    throw badRequest(`"days" must be between 1 and ${MAX_DAYS}`);
  }
  return days;
}

router.get('/', wrap((req, res) => {
  const days = readDays(req.query.days);
  const to = localDay();
  const from = localDay(-(days - 1));

  const lessonsByDay = new Map(stmt.lessons.all({ from, to }).map((row) => [row.date, row.count]));
  const hoursByDay = new Map(stmt.hours.all({ from, to }).map((row) => [row.date, row.hours]));

  const activity = [];
  let totalLessons = 0;
  let totalHours = 0;

  // Every day in the window, active or not, so the client can lay the grid out
  // without repeating this date arithmetic — and get the same answer if it did.
  // Each day is derived through localDay(), which walks calendar days rather
  // than adding 86400000 ms, so the 23- and 25-hour days a DST change makes do
  // not shift the run by one.
  for (let offset = 0; offset < days; offset += 1) {
    const date = localDay(offset - (days - 1));
    const completed = lessonsByDay.get(date) ?? 0;
    const hours = round2(hoursByDay.get(date) ?? 0);

    totalLessons += completed;
    totalHours += hours;

    activity.push({
      date,
      sub_lessons_completed: completed,
      hours,
      level: Math.min(
        MAX_LEVEL,
        stepsReached(completed, LESSON_STEPS) + stepsReached(hours, HOUR_STEPS),
      ),
    });
  }

  res.json({
    from,
    to,
    days,
    totals: {
      sub_lessons_completed: totalLessons,
      hours: round2(totalHours),
      active_days: activity.reduce((count, day) => count + (day.level > 0 ? 1 : 0), 0),
    },
    activity,
  });
}));

module.exports = router;
