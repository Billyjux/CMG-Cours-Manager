// Test harness. Points DB_FILE at a throwaway file in the OS temp directory
// *before* anything requires src/db, because that module resolves DB_FILE and
// applies the schema at require-time. This is the only thing standing between
// the suite and the real data/courses.db, so it also asserts the redirect
// worked rather than trusting it.

const fs = require('fs');
const os = require('os');
const path = require('path');

const DB_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'cours-manager-test-')),
  'test.db',
);
process.env.DB_FILE = DB_PATH;

const { db, DB_FILE } = require('../../src/db');

if (path.resolve(DB_FILE) !== path.resolve(DB_PATH)) {
  throw new Error(`Refusing to run: tests are pointed at ${DB_FILE}`);
}

const app = require('../../src/app');

/** Truncates every table so each test starts from an empty database. */
function reset() {
  db.exec(`
    DELETE FROM last_viewed;
    DELETE FROM notes;
    DELETE FROM sub_lessons;
    DELETE FROM chapters;
    DELETE FROM courses;
    DELETE FROM sqlite_sequence;
  `);
}

/**
 * Boots the app on an ephemeral port and returns a request helper.
 * Real HTTP, so express.json(), the static mount, the 404 fallthrough and the
 * error handler are all exercised the way the browser hits them.
 */
async function start() {
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  /**
   * `body` is JSON-encoded when given. Pass `{ raw }` to send a string
   * verbatim (for malformed-JSON cases) and `{ json: false }` to omit the
   * Content-Type header entirely.
   */
  async function request(method, path, body, opts = {}) {
    const init = { method, headers: {} };
    if (opts.raw !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = opts.raw;
    } else if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }

    const res = await fetch(base + path, init);
    const text = await res.text();
    let parsed = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { __unparsed: text };
      }
    }
    return { status: res.status, body: parsed, headers: res.headers };
  }

  const close = () => new Promise((resolve) => server.close(resolve));

  return { request, close, base };
}

/** Removes the temp database and its WAL sidecars. */
function cleanup() {
  db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    fs.rmSync(DB_PATH + suffix, { force: true });
  }
  fs.rmSync(path.dirname(DB_PATH), { recursive: true, force: true });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

module.exports = { start, reset, cleanup, sleep, db, DB_PATH };
