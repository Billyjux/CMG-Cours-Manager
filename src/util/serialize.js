// SQLite has no boolean type; is_complete round-trips as 0/1 but the API
// should speak JSON booleans.
const toSubLesson = (row) => (row ? { ...row, is_complete: row.is_complete === 1 } : row);

module.exports = { toSubLesson };
