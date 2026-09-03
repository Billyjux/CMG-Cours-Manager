# Course Manager

A single-user study tracker: courses break down into chapters, chapters into
sub-lessons, and everything you tick off rolls up into a completion percentage.
Around that core it keeps deadlines, reminders, free-text notes, and a log of
the hours you actually studied.

Express 5 + SQLite on the back, vanilla ES-module JavaScript on the front.
No ORM, no build step, no bundler, no accounts, and nothing leaves the machine
it runs on.

## What it does

- **Outline** — courses > chapters > sub-lessons, in a collapsible accordion.
  Ticking a sub-lesson updates the chapter count, the chapter bar, the course
  ring and the sidebar bar at once.
- **Deadlines and reminders** — per course, colour-coded by urgency. Overdue
  items stay on the list instead of disappearing.
- **Study log** — record hours by hand, or run a countdown timer that asks
  whether to add time or stop when it reaches zero rather than logging an
  empty room.
- **Pomodoro** — a focus timer in the top bar with a configurable interval;
  each completed interval writes a study session against whichever course is
  open.
- **Dashboard** — what is due, hours this week, a year-long activity grid built
  from lessons finished and hours studied, and a card per course.
- **Weekly report** — a downloadable PDF covering every course: progress, hours
  this week, upcoming deadlines, and which course needs the most attention.
- **Notes** — free text per course; pasted URLs become links.
- **Resume** — the app remembers the last course and chapter you opened and
  offers it on the dashboard.

## Requirements

Node.js **22 or newer** (`better-sqlite3` requires it; developed on 24). No
database server to install — SQLite is embedded.

## Quick start

```bash
git clone https://github.com/Billyjux/CMG-Cours-Manager.git
cd CMG-Cours-Manager
npm install
npm start
```

Then open <http://localhost:3000>. The UI is at `/`; the JSON API lives under
`/api`.

```bash
npm run dev        # same, with --watch reload
npm test           # 208 integration tests, no server needed
```

The SQLite file is created for you at `data/courses.db` on first run. It is
gitignored — your data never becomes part of the repository.

## Configuration

Two environment variables, both optional:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `DB_FILE` | `data/courses.db` | Where the SQLite file lives |

`.env.example` documents both. Note that **the app does not read a `.env` file
itself** — there is no dotenv dependency. Set them as real environment
variables:

```bash
PORT=4000 DB_FILE=/tmp/scratch.db npm start
```

There are no API keys, no third-party services and no telemetry. The three
runtime dependencies are `express`, `better-sqlite3` and `pdfkit`.

## Optional: Windows Start-menu launcher

*Windows only, and entirely optional — the app runs the same without it.*

`scripts/` contains a small PowerShell launcher so the app can be opened with
three keystrokes: press <kbd>Windows</kbd>, type `CMG`, press <kbd>Enter</kbd>.

```bash
powershell -ExecutionPolicy Bypass -File scripts\install-cmg-shortcut.ps1
```

That writes one shortcut into your own Start menu (no administrator rights, no
hardcoded paths — it resolves the project folder from its own location). Pass
`-Remove` to take it back out, and re-run it if you move the project.

The shortcut runs `scripts/cmg.ps1`, which checks `/health` first and reuses a
server that is already running rather than starting a second one, so two
processes never share the database. If nothing is listening it starts the
server hidden, waits for it to answer, then opens the browser. It never stops a
server it did not start. `CMG_PORT` overrides the port.

## License

MIT — see [LICENSE](LICENSE).

---

The rest of this file documents the internals: layout, endpoints, and how each
feature is computed.

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
    shell.js           sidebar, course list, sidebar/distraction-free toggles
    api.js             fetch wrapper, one method per endpoint
    pomodoro.js        focus timer widget in the workbar
    ui.js              escaping, progress ring and bars, toasts, modal dialog
    views/dashboard.js course list with a completion bar per course
    views/course.js    chapters, sub-lessons, notes, progress
```

## Frontend

Plain HTML/CSS/ES-modules — no framework, no bundler. Open the server root and
the SPA loads; every piece of state on screen comes from the API.

### Shell

The app is a two-pane workspace: a **sidebar** listing every course, and a
**workspace** that renders the overview (`#/`) or a course (`#/courses/:id`).
`js/shell.js` owns the sidebar and the layout toggles and nothing else — it
reads the course list from the existing `/courses` endpoint and highlights
whichever course the router has open.

Keyboard: **N** opens the new-course dialog, **Esc** closes an open dialog (and
otherwise leaves distraction-free mode), and `Ctrl`/`Cmd`+`B` toggles the
sidebar. N and Esc are printed on the buttons that own them. N is claimed by
whichever button on screen carries `data-shortcut="n"`, so the key and the hint
can never drift apart — and on a view with no such button, N is just the letter
N. There is no search shortcut because there is no search.

- The **☰** button (or `Ctrl`/`Cmd`+`B`) collapses the sidebar to zero width.
- The **⛶** button is distraction-free mode: sidebar hidden, workspace full
  width, `Esc` to leave. View actions stay reachable, so nothing becomes
  unreachable in that mode.
- Both states are remembered in `localStorage`; a blocked store just falls back
  to the default layout.
- Views announce course create/rename/delete with a `courses-changed` DOM event
  so the sidebar stays in step without them reaching into it.

The workspace pane is the scroll container, not the document — resetting scroll
on navigation means scrolling that element.

### Theme

Deep neutral slate surfaces, three-step grey text hierarchy, and exactly one
vibrant accent (**indigo `#6366f1`**). The accent is reserved for active and
selected states, primary buttons, and progress indicators — the sidebar's
active row, `.btn-primary`, the completion ring and bars, completed
sub-lessons and focus rings. Nothing else uses it, down to the product mark,
which is neutral.

Red and amber are **status** colours for deadline urgency, not accents, and are
the only other chromatic values in the palette.

Course detail shows the outline as an accordion: each chapter expands to its
own completion bar and its sub-lessons, and slides shut again. A sub-lesson
carries a status icon rather than a plain tick box — a play mark while it is
outstanding, a check once it is done — and clicking that icon is what completes
it. Thin completion bars also sit on every course card, in the sidebar and on
the dashboard, each labelled with the exact percentage.

A **pomodoro timer** sits in the corner of the workbar: 25 minutes of focus, a
5-minute break after each, a 15-minute one after every fourth. Finishing a whole
focus interval logs a 0.42 h study session against whichever course is open —
pausing, resetting or a break never logs anything, and with no course open it
says so instead. The countdown is stored as an end time rather than a counter,
so a reload picks the interval back up where it really is. The next interval is
always left stopped: rolling straight into another focus block would keep
logging time to a machine nobody is sitting at.

The dashboard carries a **contribution grid** — a year of squares, one per day,
shaded in five steps of the accent by how much was done that day. Both signals
it draws on are things the app already records: sub-lessons ticked off, and
hours studied.

Below the outline are deadlines, reminders, study time and notes. Quick-add
inputs sit inline under each list; creating and editing a course uses a
`<dialog>` modal. Bare `http(s)` URLs in notes render as links, styled
neutrally. The three places you write your own prose — a note, a course
description, a reminder — are styled as bordered panels rather than form
fields: a dashed edge that goes solid and lights up once you are typing in it.
That is presentation only; the app has no file attachments and these are not
drop targets.

Behaviour worth knowing:

- Clicking a sub-lesson's status icon sends `PATCH .../sub-lessons/:id/complete`
  with an explicit `{"is_complete": true|false}` body — never the server's
  empty-body flip — so a double click or a retry converges on the state the icon
  shows. The icon flips optimistically and rolls back if the request fails.
- After each toggle the app refetches `/progress` rather than recomputing
  locally, so the ring and the course bars always show the server's number. Only
  the per-chapter bar is computed in the browser, from sub-lessons already
  loaded, and it rounds to one decimal exactly as the server does.
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
| GET | `/activity-summary?days=365` | per-day activity for the contribution grid |
| GET / POST | `/courses/:courseId/chapters` | `{ title, order_index? }` |
| GET / PUT / PATCH / DELETE | `/courses/:courseId/chapters/:chapterId` | |
| GET / POST | `/courses/:courseId/chapters/:chapterId/sub-lessons` | `{ title, is_complete?, order_index? }` |
| GET / PUT / PATCH / DELETE | `.../sub-lessons/:subLessonId` | |
| PATCH | `.../sub-lessons/:subLessonId/complete` | **toggle** — flips with no body, or send `{ "is_complete": true }` |
| GET / POST | `/courses/:courseId/notes` | `{ content }` |
| GET / PUT / PATCH / DELETE | `/courses/:courseId/notes/:noteId` | `updated_at` refreshed on write |
| GET/POST | `/courses/:courseId/study-sessions` | `{ date, hours, note?, is_live_tracked? }` |
| GET/PATCH/DELETE | `/courses/:courseId/study-sessions/:sessionId` | |
| GET | `/courses/:courseId/study-time` | total hours logged for the course |
| GET/POST | `/courses/:courseId/deadlines` | `{ title, due_date }` |
| GET/PATCH/DELETE | `/courses/:courseId/deadlines/:deadlineId` | |
| GET | `/reminders` | all reminders; `?course_id=` narrows to one course |
| POST | `/reminders` | `{ text, remind_date, course_id?, is_done? }` — `course_id` omitted means a general reminder |
| GET/PATCH/DELETE | `/reminders/:reminderId` | PATCH with `{ is_done }` is the done toggle |
| GET | `/last-viewed` | the resume bookmark, or `null` |
| POST | `/last-viewed` | `{ course_id, chapter_id? }` — upserts the single row |
| GET | `/dashboard-summary` | read-only aggregation for the overview |
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

## Study time

Two ways to log time against a course, both writing the same `study_session`
row:

1. **The manual form** — pick a date, type decimal hours (`1.5`), optional note.
2. **The live timer** — "Start studying" runs an HH:MM:SS clock; "Stop" converts
   the elapsed time to decimal hours, rounds to 2dp, and POSTs the session in
   one call. Sessions logged this way carry `is_live_tracked: true`; manual ones
   are `false`. Nothing else about them differs, and the running total treats
   them identically.

There is no server-side "active session": the clock is client-side and the API
is touched exactly once, on Stop.

**Known limitation — a running timer does not survive a page reload.** It lives
in memory for the life of the page. Navigating between courses is fine (the
clock keeps running and is still going when you return, and starting a second
timer elsewhere is refused rather than silently discarding the first), but F5,
closing the tab, or restarting the server loses a timer that has not been
stopped, along with its elapsed time. Stop before reloading. This is deliberate
and not worked around: persisting it would need an active-session row server
side. Sessions already logged are of course in the database.

Two rounding notes: the API rejects `hours <= 0`, so a session shorter than
about 18 seconds is floored at `0.01` rather than refused, and the `study-time`
total is rounded to 2dp because summing REALs drifts (`0.1 + 0.2`).

## Dashboard overview

The dashboard is an overview hub: the "Continue where you left off" card, an
**Upcoming** list and a **Study time this week** panel, above the course grid.

`GET /api/dashboard-summary` exists only to feed it. Gathering the same data
client-side meant courses + progress + deadlines + reminders + study sessions,
which is 3N + 2 requests for N courses; this is one. It is read-only, adds no
table, and changes no other endpoint's shape.

- **Upcoming** merges deadlines and *undone* reminders that fall on or before
  today + 7 days, sorted soonest first, capped at 5. There is no lower bound, so
  anything overdue stays visible however old it is. General reminders (no
  course) appear labelled "General" and are not clickable.
- Urgency colouring reuses the same `deadlineStatus()` helper as the per-course
  deadline list, so red and amber mean the same thing everywhere.
- **Study time this week** sums `study_session.hours` over a rolling 7-day
  window ending today (`from`/`to` are in the response). Sessions dated in the
  future or older than the window are excluded, so this figure will differ from
  a course's all-time total.
- The quick-picker starts the *same* live timer the course view owns, then
  navigates to that course. If another course is already being timed it refuses
  and says which, rather than replacing it.

Each section keeps its heading and shows a light empty state when it has
nothing — including when the summary request itself fails.

## Reminders

Reminders live at the top level rather than under a course, because `course_id`
is nullable: a reminder is either tied to a course or general. Tied ones cascade
away with their course; general ones are untouched by any course deletion.

Marking one done is a `PATCH` with an explicit `{ "is_done": true|false }`, not a
flip, so repeated clicks converge. A done reminder is dimmed and struck through
in place — it is never removed from the list, only `DELETE` does that.

The course detail view lists that course's reminders (`?course_id=`), so general
reminders do not appear there. There is no UI for creating general ones yet; the
API accepts them.

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
  ("Linear Algebra → Chapter 3"), or nothing at all when `GET` returns
  `null`. Clicking it opens the course with that chapter expanded and scrolled
  into view.
- A cold load at `/` shows the **dashboard**, not the bookmark. Opening the
  app is not the same thing as asking to go back to where you were, so
  resuming is a click on the Continue card rather than a redirect that fires
  before the overview can be read. A link straight to `#/courses/:id` still
  opens that course.
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
