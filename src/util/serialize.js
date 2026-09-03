// SQLite has no boolean type; these columns round-trip as 0/1 but the API
// should speak JSON booleans.
const toSubLesson = (row) => (row ? { ...row, is_complete: row.is_complete === 1 } : row);

// is_live_tracked is nullable — rows written before the live timer existed have
// NULL, which means the same thing as 0 here.
const toStudySession = (row) => (row ? { ...row, is_live_tracked: row.is_live_tracked === 1 } : row);

const toReminder = (row) => (row ? { ...row, is_done: row.is_done === 1 } : row);

module.exports = { toSubLesson, toStudySession, toReminder };
