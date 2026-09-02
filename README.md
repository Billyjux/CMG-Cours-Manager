# Course Manager

Express + SQLite REST backend for tracking academic courses, their chapters,
sub-lessons and notes, with a per-course completion percentage — plus a
vanilla-JS single-page frontend served from the same origin.

No ORM, no build step, no auth — single-user personal tool.

## Run

```bash
npm install
npm start          # http://localhost:3000
npm run dev        # same, with --watch reload
```

Then open <http://localhost:3000> for the UI; the API lives under `/api`.

The SQLite file is created automatically at `data/courses.db`. Override with
`PORT` and `DB_FILE` env vars.

## Layout

```
src/
  server.js            HTTP listener
  app.js               Express app: JSON parsing, route mounting, error handling
  db/
    index.js           Connection, pragmas, schema applied at require-time
    schema.sql         Tables, FKs with ON DELETE CASCADE, indexes
    lookups.js         loadCourse / loadChapter / loadSubLesson / loadNote (404s)
  routes/
    courses.js         /api/courses  (+ mounts chapters and notes)
    chapters.js        nested under a course (+ mounts sub-lessons)
    subLessons.js      nested under a chapter, incl. the complete toggle
    notes.js           nested under a course
    lastViewed.js      the single-row "resume where I left off" bookmark
  middleware/errors.js HttpError + JSON error handler
  util/                request validation, boolean serialization

public/                served statically by the Express app
  index.html           app shell (topbar + #app mount point)
  css/styles.css       dark theme, no framework
  js/
    app.js             hash router: #/ and #/courses/:id
    api.js             fetch wrapper, one method per endpoint
    ui.js              escaping, progress ring, toasts, modal dialog
    views/dashboard.js course list with a progress ring per course
    views/course.js    chapters, sub-lessons, notes, progress
```

## Frontend

Plain HTML/CSS/ES-modules — no framework, no bundler. Open the server root and
the SPA loads; every piece of state on screen comes from the API.

**Dashboard** (`#/`) lists courses, each with an SVG completion ring fed by
`GET /courses/:id/progress`. **Course detail** (`#/courses/:id`) shows chapters
as collapsible sections with checkboxes for their sub-lessons, plus a notes
section. Quick-add inputs sit inline under each list; creating and editing a
course uses a `<dialog>` modal. Bare `http(s)` URLs in notes render as links.

Behaviour worth knowing:

- Ticking a checkbox sends `PATCH .../sub-lessons/:id/complete` with an explicit
  `{"is_complete": true|false}` body — never the server's empty-body flip — so a
  double click or a retry converges on the state the box shows. The checkbox
  flips optimistically and rolls back if the request fails.
- After each toggle the app refetches `/progress` rather than recomputing
  locally, so the ring always shows the server's number.
- The percentage is printed exactly as the API returns it (one decimal, e.g.
  `33.3%`); the frontend never rounds it again.
- Static files are served with `Cache-Control: no-cache`, meaning "revalidate
  before reusing". Without it Chrome's ES-module cache will happily keep running
  your previous `js/` edit after a refresh.

## Endpoints

All routes are under `/api`.

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/courses` | newest first |
| POST | `/courses` | `{ name, description? }` |
| GET | `/courses/:courseId` | |
| PUT / PATCH | `/courses/:courseId` | PUT replaces, PATCH merges |
| DELETE | `/courses/:courseId` | cascades to chapters, sub-lessons, notes |
| GET | `/courses/:courseId/progress` | completion % |
| GET / POST | `/courses/:courseId/chapters` | `{ title, order_index? }` |
| GET / PUT / PATCH / DELETE | `/courses/:courseId/chapters/:chapterId` | |
| GET / POST | `/courses/:courseId/chapters/:chapterId/sub-lessons` | `{ title, is_complete?, order_index? }` |
| GET / PUT / PATCH / DELETE | `.../sub-lessons/:subLessonId` | |
| PATCH | `.../sub-lessons/:subLessonId/complete` | **toggle** — flips with no body, or send `{ "is_complete": true }` |
| GET / POST | `/courses/:courseId/notes` | `{ content }` |
| GET / PUT / PATCH / DELETE | `/courses/:courseId/notes/:noteId` | `updated_at` refreshed on write |
| GET | `/last-viewed` | the resume bookmark, or `null` |
| POST | `/last-viewed` | `{ course_id, chapter_id? }` — upserts the single row |
| GET | `/health` | outside `/api` |

Notes on behaviour:

- `order_index` is optional on create; omitting it appends to the end of the
  parent (max + 1).
- `is_complete` is stored as SQLite `0`/`1` but is a real JSON boolean in
  requests and responses.
- A nested id that exists but belongs to a different parent returns 404, so
  `/courses/1/chapters/9/...` cannot reach chapter 9 of another course.
- Errors are JSON: `{ "error": "..." }`, 400 for validation, 404 for missing.

## Progress

`GET /api/courses/:courseId/progress` counts sub-lessons across every chapter of
the course:

```json
{
  "course_id": 1,
  "total_sub_lessons": 4,
  "completed_sub_lessons": 2,
  "progress_percent": 50
}
```

Rounded to one decimal. A course with no sub-lessons reports `0`.

## Resume where I left off

A single row (`last_viewed`, pinned to `id = 1` by a CHECK constraint) records
the last course and chapter opened. `POST /api/last-viewed` upserts it; there is
never a second row.

Staleness is handled by the schema rather than by cleanup code: `course_id`
cascades on delete, so removing a course drops the bookmark and `GET` returns
`null`; `chapter_id` is `ON DELETE SET NULL`, so removing a chapter leaves the
course-level bookmark intact. `GET` inner-joins `courses` and left-joins
`chapters`, and blanks a `chapter_id` whose title will not resolve — a stale id
can never reach the client, and a missing bookmark is `200` with a `null` body,
never an error.

In the UI:

- The dashboard shows a **Continue** card above the grid
  ("Automatisme Industriel → Chapitre 3"), or nothing at all when `GET` returns
  `null`. Clicking it opens the course with that chapter expanded and scrolled
  into view.
- On a cold load at `/`, the app jumps straight to the bookmark instead of
  showing the dashboard. This happens **once per page load**, in `start()`
  rather than in the router, so clicking "All courses" afterwards stays on the
  dashboard. It uses `history.replaceState`, so the router runs once and the
  back button has no dashboard entry to bounce off.
- Writes happen on navigation only: opening a course, and expanding a chapter.
  Collapsing a chapter and ticking sub-lesson checkboxes deliberately do not
  write.
- Because chapters render expanded by default, the chapter half of the bookmark
  is set when you expand one (or arrive via a Continue link); otherwise the
  bookmark stays at course level and the card resumes the course.

The resume scroll is intentionally instant rather than smooth — smooth
scrolling is silently a no-op in some embedded browsers, which would leave the
chapter off-screen.

## Walkthrough (curl)

```bash
curl -s -X POST localhost:3000/api/courses \
  -H 'Content-Type: application/json' \
  -d '{"name":"Algebra II","description":"Linear algebra + proofs"}'

curl -s -X POST localhost:3000/api/courses/1/chapters \
  -H 'Content-Type: application/json' -d '{"title":"Vector Spaces"}'

curl -s -X POST localhost:3000/api/courses/1/chapters/1/sub-lessons \
  -H 'Content-Type: application/json' -d '{"title":"Basis and dimension"}'

curl -s -X PATCH localhost:3000/api/courses/1/chapters/1/sub-lessons/1/complete

curl -s -X POST localhost:3000/api/courses/1/notes \
  -H 'Content-Type: application/json' -d '{"content":"https://ocw.mit.edu/18-06"}'

curl -s localhost:3000/api/courses/1/progress
```

On Windows PowerShell, use `curl.exe` (not the `curl` alias) and single-quote
the JSON bodies as above.
