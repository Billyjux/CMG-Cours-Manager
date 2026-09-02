// App-level behaviour: the pieces every route inherits from app.js and the
// error middleware, rather than any one resource.

const { test, before, after, beforeEach, describe } = require('node:test');
const assert = require('node:assert/strict');
const { start, reset, cleanup } = require('./helpers/harness');
const { makeCourse } = require('./helpers/fixtures');

let request;
let close;

before(async () => { ({ request, close } = await start()); });
after(async () => { await close(); cleanup(); });
beforeEach(reset);

describe('health and routing', () => {
  test('GET /health answers outside the /api prefix', async () => {
    const res = await request('GET', '/health');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { status: 'ok' });
  });

  test('an unknown route is a JSON 404, not an HTML stack page', async () => {
    const res = await request('GET', '/api/nope');
    assert.equal(res.status, 404);
    assert.match(res.headers.get('content-type'), /application\/json/);
    assert.match(res.body.error, /No route for GET \/api\/nope/);
  });

  test('an unsupported method on a real path is a 404 too', async () => {
    const course = await makeCourse(request);
    const res = await request('POST', `/api/courses/${course.id}/progress`, {});
    assert.equal(res.status, 404);
  });
});

describe('static frontend', () => {
  test('serves index.html at the root', async () => {
    const res = await request('GET', '/');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
  });

  test('sends Cache-Control: no-cache so module edits survive a refresh', async () => {
    const res = await request('GET', '/js/app.js');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-cache');
  });
});

describe('request body handling', () => {
  test('malformed JSON is a 400 with a readable message', async () => {
    const res = await request('POST', '/api/courses', undefined, { raw: '{"name": ' });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'Request body is not valid JSON');
  });

  test('a JSON array body is rejected as not an object', async () => {
    const res = await request('POST', '/api/courses', ['not', 'an', 'object']);
    assert.equal(res.status, 400);
    assert.match(res.body.error, /Request body must be a JSON object/);
  });

  test('a bare JSON primitive is rejected at parse time', async () => {
    // express.json() is strict by default, so a top-level string never
    // reaches requireBody — it fails as malformed JSON instead. Different
    // message, same 400.
    const res = await request('POST', '/api/courses', 'just a string');
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'Request body is not valid JSON');
  });

  test('errors always come back shaped as { error }', async () => {
    const res = await request('GET', '/api/courses/9999');
    assert.equal(res.status, 404);
    assert.deepEqual(Object.keys(res.body), ['error']);
    assert.equal(typeof res.body.error, 'string');
  });
});

describe('id validation is uniform across nested paths', () => {
  test('rejects a negative, zero, float or non-numeric id', async () => {
    for (const bad of ['0', '-1', '1.5', 'abc', '%20']) {
      const res = await request('GET', `/api/courses/${bad}`);
      assert.equal(res.status, 400, `expected 400 for id "${bad}", got ${res.status}`);
    }
  });

  test('names the offending segment on a nested path', async () => {
    const course = await makeCourse(request);
    const res = await request('GET', `/api/courses/${course.id}/chapters/abc`);
    assert.equal(res.status, 400);
    assert.match(res.body.error, /"chapterId" must be a positive integer/);
  });
});
