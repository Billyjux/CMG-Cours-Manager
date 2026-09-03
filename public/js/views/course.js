import { api } from '../api.js';
import {
  escapeHtml,
  escapeWithLinks,
  formatDate,
  progressRing,
  progressBar,
  setProgressBar,
  completionPercent,
  prefersReducedMotion,
  toast,
  openFormDialog,
  openConfirmDialog,
  openDurationDialog,
  withBusy,
  deadlineStatus,
} from '../ui.js';

// View state for the course currently on screen. Rebuilt on every navigation.
let state = null;

/**
 * The running live timer, or null. Deliberately module-level rather than part
 * of `state`, which is thrown away on every navigation: this way the clock
 * keeps running while you look at another course and is still going when you
 * come back.
 *
 * Shape:
 *   targetMs          the length asked for, grown by "add more time"
 *   accumulatedMs     time banked from segments that have already ended
 *   segmentStartedAt  when the current running segment began, or null if frozen
 *
 * A plain `startedAt` is not enough any more. The timer freezes when it runs
 * out and waits for an answer, and the minutes spent deciding are not minutes
 * spent studying — someone who walks away from a finished timer must not come
 * back to an hour of logged work. Banking each segment keeps the total honest
 * while still deriving the live part from an absolute instant, so nothing
 * drifts while the display is off-screen.
 *
 * KNOWN LIMITATION: this lives in memory only. A full page reload (F5, closing
 * the tab, restarting the server) loses a running timer and its elapsed time —
 * there is no server-side "active session" row and none is planned here. Stop
 * the timer before reloading. Sessions already logged are of course persisted.
 */
let liveTimer = null;
let tickHandle = null;
/**
 * Expiry watchdog. Separate from the display tick on purpose: the tick only
 * lives as long as the course view is mounted, but a timer started here and
 * left running while the user reads the dashboard still has to notice when it
 * runs out. This one lives exactly as long as the timer does.
 */
let expiryHandle = null;
let expiryPromptOpen = false;
/** The last length picked, offered back as the default next time. */
let lastTimerMinutes = 25;

/* ---------------------------------------------------------------- loading */

async function loadState(courseId) {
  const [
    course, chapters, notes, progress, studySessions, studyTime, deadlines, reminders,
  ] = await Promise.all([
    api.getCourse(courseId),
    api.listChapters(courseId),
    api.listNotes(courseId),
    api.getProgress(courseId),
    api.listStudySessions(courseId),
    api.getStudyTime(courseId),
    api.listDeadlines(courseId),
    api.listReminders(courseId),
  ]);

  const withLessons = await Promise.all(
    chapters.map(async (chapter) => ({
      ...chapter,
      subLessons: await api.listSubLessons(courseId, chapter.id),
    })),
  );

  return {
    courseId: Number(courseId),
    course,
    chapters: withLessons,
    notes,
    progress,
    studySessions,
    studyTime,
    deadlines,
    reminders,
    // Chapters start expanded so sub-lessons are visible without a click.
    open: new Set(withLessons.map((c) => c.id)),
    editingNoteId: null,
  };
}

/** Today in the user's own timezone. toISOString() would use UTC and can be
 *  a day off either side of midnight. */
function todayLocal() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Renders a YYYY-MM-DD day. Parsed at local midnight, not UTC, so the date
 *  shown is the date stored. */
function formatDay(ymd) {
  const date = new Date(`${ymd}T00:00:00`);
  if (Number.isNaN(date.getTime())) return ymd;
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

/** "2 h" / "1.5 h" — trailing zeros trimmed by Number's own formatting. */
const formatHours = (hours) => `${Number(hours)} h`;

const findChapter = (id) => state.chapters.find((c) => c.id === Number(id));

/**
 * Moves the "resume where I left off" bookmark. Fire-and-forget: a failed
 * write is not worth interrupting the user over, and the next navigation
 * will try again.
 */
function recordLastViewed(chapterId = null) {
  api.setLastViewed(state.courseId, chapterId).catch(() => {});
}

const CHAPTER_ANIM_MS = 190;

/**
 * Opens or closes one chapter, with the body sliding to its new height.
 *
 * The movement is decoration on top of a state change that is applied first:
 * `.is-open` is what actually shows the body, and every exit path — finished,
 * cancelled, no Web Animations, reduced motion — leaves the section in the
 * state that was asked for. A CSS transition would be the shorter way to write
 * this, but transitions freeze at their start value in the automated browser
 * pane (see HANDOFF §1), which would leave chapters stuck shut there.
 */
function setChapterOpen(section, open) {
  const body = section.querySelector('.chapter-body');
  section.querySelector('.chapter-head')?.setAttribute('aria-expanded', String(open));

  // Height on screen right now, including a slide still in flight; cancelling
  // afterwards drops that animation so the target below measures true.
  const from = section.classList.contains('is-open')
    ? body.getBoundingClientRect().height
    : 0;
  body.getAnimations?.().forEach((animation) => animation.cancel());

  section.classList.add('is-open'); // displayed, so the target is measurable
  const to = open ? body.scrollHeight : 0;

  // A click during a slide supersedes it; the older callbacks bow out here.
  const turn = String(Number(section.dataset.slide || 0) + 1);
  section.dataset.slide = turn;

  const settle = () => {
    if (section.dataset.slide !== turn) return;
    section.classList.toggle('is-open', open);
    body.style.removeProperty('overflow');
    body.getAnimations?.().forEach((animation) => {
      animation.onfinish = null;
      animation.oncancel = null;
      animation.cancel();
    });
  };

  if (from === to || !body.animate || prefersReducedMotion()) {
    settle();
    return;
  }

  body.style.overflow = 'hidden';
  const animation = body.animate(
    [{ height: `${from}px` }, { height: `${to}px` }],
    { duration: CHAPTER_ANIM_MS, easing: 'cubic-bezier(.4, 0, .2, 1)' },
  );
  animation.onfinish = settle;
  animation.oncancel = settle;
  // Backstop. Animations are driven by frames, and frames stop in a hidden or
  // backgrounded tab — collapse a chapter, switch tabs, and `onfinish` may not
  // arrive for minutes. Timers keep firing, so the state lands on time whether
  // or not the movement ever played. settle() is idempotent.
  setTimeout(settle, CHAPTER_ANIM_MS + 80);
}

/** Expands a chapter, scrolls it into view and flashes it once. */
function focusChapter(chapterId) {
  const section = document.querySelector(`.chapter[data-chapter="${chapterId}"]`);
  if (!section) return;

  setChapterOpen(section, true);
  state.open.add(Number(chapterId));

  // Deliberately an instant scroll, not a smooth one: smooth scrolling is
  // silently a no-op in some embedded/automated browsers, which would leave
  // the resumed chapter off-screen. Landing directly on it is also the
  // better behaviour on a fresh page load. The flash marks where you landed.
  section.scrollIntoView({ block: 'center' });
  section.classList.add('is-focused');
  setTimeout(() => section.classList.remove('is-focused'), 1800);
}

/* -------------------------------------------------------------- templates */

function chapterTemplate(chapter) {
  const total = chapter.subLessons.length;
  const done = chapter.subLessons.filter((l) => l.is_complete).length;
  const isOpen = state.open.has(chapter.id);
  const allDone = total > 0 && done === total;

  return `
    <section class="chapter${isOpen ? ' is-open' : ''}" data-chapter="${chapter.id}">
      <div class="chapter-head-row">
        <button class="chapter-head" data-action="toggle-chapter"
                aria-expanded="${isOpen}">
          <span class="chapter-caret" aria-hidden="true">▶</span>
          <span class="chapter-title">${escapeHtml(chapter.title)}</span>
          <span class="chapter-count${allDone ? ' is-done' : ''}" data-count>${done}/${total}</span>
        </button>
        <span class="chapter-actions">
          <button class="btn btn-sm btn-ghost" data-action="rename-chapter" title="Rename chapter">Rename</button>
          <button class="btn btn-sm btn-ghost btn-danger" data-action="delete-chapter" title="Delete chapter">Delete</button>
        </span>
      </div>

      <!-- The padding lives on the inner wrapper so the outer box can be
           animated between 0 and its natural height without fighting it. -->
      <div class="chapter-body">
        <div class="chapter-body-inner">
          ${
            total === 0
              ? '<p class="muted" style="margin:10px 0">No sub-lessons in this chapter yet.</p>'
              : `<div class="chapter-progress">
                   ${progressBar(completionPercent(done, total), { compact: true })}
                 </div>
                 <ul class="lesson-list">
                   ${chapter.subLessons.map((l) => lessonTemplate(chapter, l)).join('')}
                 </ul>`
          }
          <form class="inline-form" data-action="add-sub-lesson">
            <input type="text" name="title" placeholder="Add a sub-lesson…" autocomplete="off">
            <button class="btn btn-sm" type="submit">Add</button>
          </form>
        </div>
      </div>
    </section>`;
}

/** Hover hint on the status icon; kept in step by toggleLesson(). */
const lessonCheckTitle = (isComplete) =>
  (isComplete ? 'Mark as not complete' : 'Mark as complete');

function lessonTemplate(chapter, lesson) {
  const id = `lesson-${lesson.id}`;
  return `
    <li class="lesson${lesson.is_complete ? ' is-complete' : ''}" data-lesson="${lesson.id}">
      <input class="lesson-check" type="checkbox" id="${id}"
             data-action="toggle-lesson"
             data-chapter="${chapter.id}"
             title="${lessonCheckTitle(lesson.is_complete)}"
             ${lesson.is_complete ? 'checked' : ''}>
      <label class="lesson-title" for="${id}">${escapeHtml(lesson.title)}</label>
      <button class="btn btn-sm btn-ghost" data-action="rename-lesson">Rename</button>
      <button class="btn btn-sm btn-ghost btn-danger" data-action="delete-lesson">Delete</button>
    </li>`;
}

function noteTemplate(note) {
  if (state.editingNoteId === note.id) {
    return `
      <article class="note note-editor" data-note="${note.id}">
        <textarea class="input-panel" rows="4" data-note-input>${escapeHtml(note.content)}</textarea>
        <div class="note-editor-actions">
          <button class="btn btn-sm btn-primary" data-action="save-note">Save</button>
          <button class="btn btn-sm" data-action="cancel-note">Cancel</button>
        </div>
      </article>`;
  }

  const edited = note.updated_at !== note.created_at;
  return `
    <article class="note" data-note="${note.id}">
      <div class="note-content">${escapeWithLinks(note.content)}</div>
      <div class="note-foot">
        <span class="note-meta">
          ${escapeHtml(formatDate(note.created_at))}${edited ? ` · edited ${escapeHtml(formatDate(note.updated_at))}` : ''}
        </span>
        <span class="note-actions">
          <button class="btn btn-sm btn-ghost" data-action="edit-note">Edit</button>
          <button class="btn btn-sm btn-ghost btn-danger" data-action="delete-note">Delete</button>
        </span>
      </div>
    </article>`;
}

/** "3 days overdue" / "today" / "tomorrow" / "in 5 days" / "in 21 days". */
function deadlineWhen(days) {
  if (days === null) return '';
  if (days < 0) {
    const late = Math.abs(days);
    return `${late} day${late === 1 ? '' : 's'} overdue`;
  }
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  return `in ${days} days`;
}

function deadlineTemplate(deadline) {
  const { status, days } = deadlineStatus(deadline.due_date);

  return `
    <li class="deadline is-${status}" data-deadline="${deadline.id}">
      <span class="deadline-marker" aria-hidden="true"></span>
      <span class="deadline-body">
        <span class="deadline-title">${escapeHtml(deadline.title)}</span>
        <span class="deadline-meta">
          ${escapeHtml(formatDay(deadline.due_date))}
          <span class="deadline-when">${escapeHtml(deadlineWhen(days))}</span>
        </span>
      </span>
      <span class="deadline-actions">
        <button class="btn btn-sm btn-ghost" type="button"
                data-action="edit-deadline">Edit</button>
        <button class="btn btn-sm btn-ghost btn-danger" type="button"
                data-action="delete-deadline">Delete</button>
      </span>
    </li>`;
}

function studySessionTemplate(session) {
  return `
    <li class="study-session" data-session="${session.id}">
      <span class="study-hours">${escapeHtml(formatHours(session.hours))}</span>
      <span class="study-body">
        <span class="study-date">${escapeHtml(formatDay(session.date))}</span>
        ${session.note ? `<span class="study-note">${escapeHtml(session.note)}</span>` : ''}
      </span>
      <button class="btn btn-sm btn-ghost btn-danger" type="button"
              data-action="delete-study-session">Delete</button>
    </li>`;
}

function studyTotalTemplate(studyTime) {
  const { total_hours: total, session_count: count } = studyTime;
  if (!count) return '<span class="muted">No study time logged yet</span>';

  return `
    <strong>${escapeHtml(total)} hour${total === 1 ? '' : 's'} logged</strong>
    <span class="muted">across ${count} session${count === 1 ? '' : 's'}</span>`;
}

function progressTextTemplate(progress) {
  const { total_sub_lessons: total, completed_sub_lessons: done } = progress;
  const chapters = state.chapters.length;
  return `
    <div class="progress-summary-text">
      <strong>${escapeHtml(progress.progress_percent)}% complete</strong>
      ${
        total === 0
          ? 'Add sub-lessons to start tracking progress'
          : `${done} of ${total} sub-lessons across ${chapters} chapter${chapters === 1 ? '' : 's'}`
      }
    </div>`;
}

function progressSummaryTemplate(progress) {
  return progressRing(progress.progress_percent, { size: 76, stroke: 6 })
    + progressTextTemplate(progress);
}

/* ------------------------------------------------------- partial renderers */

const renderChapters = () => {
  const host = document.getElementById('chapters');
  host.innerHTML = state.chapters.length
    ? state.chapters.map(chapterTemplate).join('')
    : '<div class="empty"><p>No chapters yet. Add one below to get started.</p></div>';
};

const renderNotes = () => {
  const host = document.getElementById('notes-list');
  host.innerHTML = state.notes.length
    ? state.notes.map(noteTemplate).join('')
    : '<p class="muted">No notes yet. Paste a resource link or jot something down above.</p>';
};

function reminderTemplate(reminder) {
  const id = `reminder-${reminder.id}`;
  return `
    <li class="reminder${reminder.is_done ? ' is-done' : ''}" data-reminder="${reminder.id}">
      <input class="reminder-check" type="checkbox" id="${id}"
             data-action="toggle-reminder" ${reminder.is_done ? 'checked' : ''}>
      <label class="reminder-body" for="${id}">
        <span class="reminder-text">${escapeHtml(reminder.text)}</span>
        <span class="reminder-date">${escapeHtml(formatDay(reminder.remind_date))}</span>
      </label>
      <button class="btn btn-sm btn-ghost btn-danger" type="button"
              data-action="delete-reminder">Delete</button>
    </li>`;
}

const renderReminders = () => {
  const host = document.getElementById('reminder-list');
  host.innerHTML = state.reminders.length
    ? state.reminders.map(reminderTemplate).join('')
    : '<li class="muted reminder-empty">No reminders for this course yet.</li>';
};

/** Re-reads from the API after a write; the server owns the date ordering. */
async function refreshReminders() {
  state.reminders = await api.listReminders(state.courseId);
  renderReminders();
}

const renderDeadlines = () => {
  const host = document.getElementById('deadline-list');
  host.innerHTML = state.deadlines.length
    ? state.deadlines.map(deadlineTemplate).join('')
    : '<li class="muted deadline-empty">No deadlines yet.</li>';
};

/** Re-reads the list from the API after a write; the server owns the ordering. */
async function refreshDeadlines() {
  state.deadlines = await api.listDeadlines(state.courseId);
  renderDeadlines();
}

/* ------------------------------------------------------------ live timer */

const timerRunsHere = () => Boolean(liveTimer) && liveTimer.courseId === state.courseId;
/** Ran out and waiting for an answer: holding time, but not counting any. */
const timerFrozen = () => Boolean(liveTimer) && liveTimer.segmentStartedAt === null;

/** Total time actually studied — banked segments plus the one now running. */
function elapsedMs() {
  if (!liveTimer) return 0;
  const live = liveTimer.segmentStartedAt === null ? 0 : Date.now() - liveTimer.segmentStartedAt;
  return liveTimer.accumulatedMs + live;
}

const remainingMs = () => (liveTimer ? Math.max(0, liveTimer.targetMs - elapsedMs()) : 0);

/** Milliseconds as HH:MM:SS. */
function formatElapsed(ms) {
  const seconds = Math.floor(ms / 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(Math.floor(seconds / 3600))}:${pad(Math.floor(seconds / 60) % 60)}:${pad(seconds % 60)}`;
}

function stopTicking() {
  if (tickHandle) clearInterval(tickHandle);
  tickHandle = null;
}

function tick() {
  const display = document.getElementById('timer-display');
  // The view has changed under us. Drop the interval; the timer itself keeps
  // running, because the elapsed time is computed from absolute instants.
  if (!display) {
    stopTicking();
    return;
  }
  display.textContent = formatElapsed(remainingMs());
  const studied = document.getElementById('timer-studied');
  if (studied) studied.textContent = formatElapsed(elapsedMs());
}

/* --------------------------------------------------- running / freezing */

function freezeTimer() {
  if (!liveTimer || liveTimer.segmentStartedAt === null) return;
  liveTimer.accumulatedMs = elapsedMs();
  liveTimer.segmentStartedAt = null;
}

function resumeTimer() {
  if (!liveTimer || liveTimer.segmentStartedAt !== null) return;
  liveTimer.segmentStartedAt = Date.now();
}

function startWatchdog() {
  if (expiryHandle) return;
  expiryHandle = setInterval(checkExpiry, 500);
}

function stopWatchdog() {
  if (expiryHandle) clearInterval(expiryHandle);
  expiryHandle = null;
}

/** Begins a timer. Shared by the course view and the dashboard's quick-picker. */
function beginTimer(courseId, courseName, minutes) {
  lastTimerMinutes = minutes;
  liveTimer = {
    courseId,
    courseName,
    targetMs: minutes * 60000,
    accumulatedMs: 0,
    segmentStartedAt: Date.now(),
  };
  startWatchdog();
}

/**
 * Adds another stretch to a timer that has run out and picks it back up. The
 * banked total is untouched, so the session continues rather than restarting.
 */
function addTimerTime(minutes) {
  if (!liveTimer) return;
  lastTimerMinutes = minutes;
  liveTimer.targetMs += minutes * 60000;
  resumeTimer();
  renderTimer();
}

/**
 * Runs every half second for as long as a timer exists. The moment the target
 * is reached the clock is frozen — deliberately *before* anything is logged and
 * before anyone is asked anything, so the answer costs no study time whichever
 * way it goes, and a prompt left unanswered cannot inflate the session.
 */
async function checkExpiry() {
  if (!liveTimer || timerFrozen() || expiryPromptOpen) return;
  if (remainingMs() > 0) return;

  freezeTimer();
  stopTicking();
  renderTimer();
  await promptExpired();
}

/**
 * The "time is up" prompt. Offers another stretch or an end to the session.
 *
 * Dismissing it (Esc, or Not now) decides nothing: the timer stays frozen and
 * the course view offers the same two choices inline. Nothing is logged and
 * nothing is discarded without being asked for — the session is the user's
 * time, and this dialog is not entitled to spend it either way.
 */
async function promptExpired() {
  if (expiryPromptOpen || !liveTimer) return;
  expiryPromptOpen = true;

  const courseName = liveTimer.courseName ?? 'this course';
  try {
    const answer = await openDurationDialog({
      title: 'Time is up',
      message: `${formatElapsed(elapsedMs())} studied on "${courseName}". `
        + 'Add more time to keep going, or stop and log the session.',
      current: lastTimerMinutes,
      highlightCurrent: false,
      submitLabel: 'Add',
      secondaryLabel: 'Stop and log',
      cancelLabel: 'Not now',
    });

    // Stopped from somewhere else while the dialog was open.
    if (!liveTimer) return;

    if (!answer) {
      renderTimer();
      return;
    }
    if (answer.action === 'secondary') {
      await stopTimer();
      return;
    }
    addTimerTime(answer.minutes);
  } finally {
    expiryPromptOpen = false;
  }
}

/* -------------------------------------------------------------- rendering */

const renderTimer = () => {
  const host = document.getElementById('study-timer');
  if (!host) return;

  const running = timerRunsHere();
  const expired = running && timerFrozen();

  host.innerHTML = `
    ${expired
      ? `<button class="btn btn-sm btn-timer-start" type="button" data-action="add-time">
           + Add time
         </button>
         <button class="btn btn-sm btn-timer-stop" type="button" data-action="toggle-timer">
           ■ Stop and log
         </button>`
      : `<button class="btn btn-sm ${running ? 'btn-timer-stop' : 'btn-timer-start'}"
                 type="button" data-action="toggle-timer">
           ${running ? '■ Stop' : '▶ Start studying'}
         </button>`}
    <span class="study-timer-display${running && !expired ? ' is-running' : ''}${expired ? ' is-expired' : ''}"
          id="timer-display">
      ${running ? formatElapsed(remainingMs()) : '00:00:00'}
    </span>
    ${running
      ? `<span class="study-timer-hint">
           ${expired ? 'Time is up —' : 'Recording —'}
           <span id="timer-studied">${formatElapsed(elapsedMs())}</span> studied
         </span>`
      : ''}`;

  stopTicking();
  if (running && !expired) tickHandle = setInterval(tick, 1000);
};

/* ---------------------------------------------------------------- actions */

async function stopTimer() {
  if (!liveTimer) return;
  // Read from the timer, not from `state`: the prompt can be answered from the
  // dashboard, where the course view's state is another course's or absent.
  const { courseId } = liveTimer;
  // The API rejects hours <= 0, so a session shorter than ~18 seconds would be
  // refused outright. Floor it at the smallest value 2dp can express instead of
  // throwing the time away.
  const hours = Math.max(0.01, Math.round((elapsedMs() / 3600000) * 100) / 100);
  const button = document.querySelector('[data-action="toggle-timer"]');

  await withBusy(button, async () => {
    try {
      await api.createStudySession(courseId, {
        // Dated when the timer stops, so a session spanning midnight lands on
        // the day it finished.
        date: todayLocal(),
        hours,
        is_live_tracked: true,
      });

      liveTimer = null;
      stopWatchdog();
      stopTicking();
      renderTimer();
      // The course view's own listener refreshes the list when it happens to be
      // showing this course, so stopping from the dashboard works the same way.
      document.dispatchEvent(new CustomEvent('study-logged', {
        detail: { courseId, hours },
      }));
      toast(`Logged ${hours} h`);
    } catch (err) {
      // Leave the timer as it was so the elapsed time survives a failed save
      // and Stop can simply be pressed again.
      toast(err.message, { error: true });
    }
  });
}

async function toggleTimer() {
  if (timerRunsHere()) {
    stopTimer();
    return;
  }
  if (liveTimer) {
    toast(`A timer is already running for "${liveTimer.courseName}". Stop it there first.`, {
      error: true,
    });
    return;
  }

  const answer = await openDurationDialog({
    title: 'Study session length',
    message: `How long are you sitting down to study "${state.course.name}"? `
      + 'You can add more time when it runs out.',
    current: lastTimerMinutes,
    submitLabel: 'Start',
  });
  if (!answer || answer.action !== 'choose') return;

  beginTimer(state.courseId, state.course.name, answer.minutes);
  renderTimer();
}

/** The "+ Add time" button on an expired timer — the same prompt, reopened. */
async function addMoreTime() {
  if (!liveTimer || !timerFrozen()) return;
  await promptExpired();
}

const renderStudy = () => {
  document.getElementById('study-total').innerHTML = studyTotalTemplate(state.studyTime);

  const list = document.getElementById('study-list');
  list.innerHTML = state.studySessions.length
    ? state.studySessions.map(studySessionTemplate).join('')
    : '';
};

/**
 * Re-reads both the list and the total from the API after a write, rather than
 * adjusting them locally: the server owns the sort order and the rounded sum.
 */
async function refreshStudy() {
  const [sessions, studyTime] = await Promise.all([
    api.listStudySessions(state.courseId),
    api.getStudyTime(state.courseId),
  ]);
  state.studySessions = sessions;
  state.studyTime = studyTime;
  renderStudy();
}

/**
 * Registered once at module load. A pomodoro logging time to the course that
 * happens to be on screen should appear in its list straight away, rather than
 * lurking until the next navigation. Guarded on both the course id and the
 * list being mounted, so it is inert everywhere else.
 */
document.addEventListener('study-logged', (event) => {
  if (!state || state.courseId !== event.detail.courseId) return;
  if (!document.getElementById('study-list')) return;
  refreshStudy().catch(() => {});
});

/**
 * Patches the existing ring in place (rather than re-rendering it) so the
 * stroke transition animates when a checkbox changes the percentage.
 */
function renderProgress() {
  const host = document.getElementById('progress-summary');
  const ring = host.querySelector('.ring');
  const value = host.querySelector('.ring-value');

  if (ring && value) {
    const radius = Number(value.getAttribute('r'));
    const circumference = 2 * Math.PI * radius;
    const pct = Math.max(0, Math.min(100, Number(state.progress.progress_percent) || 0));
    value.setAttribute('stroke-dashoffset', (circumference * (1 - pct / 100)).toFixed(2));
    ring.classList.toggle('is-complete', pct === 100);
    ring.setAttribute('aria-label', `${state.progress.progress_percent} percent complete`);
    // Keep the <tspan>%</tspan> and swap only the number in front of it.
    host.querySelector('.ring-label').firstChild.nodeValue = String(
      state.progress.progress_percent,
    );
    host.querySelector('.progress-summary-text').outerHTML = progressTextTemplate(state.progress);
  } else {
    host.innerHTML = progressSummaryTemplate(state.progress);
  }

  // The sidebar shows the same number. Announced rather than written directly,
  // the way course create/rename/delete already reaches the shell.
  document.dispatchEvent(new CustomEvent('progress-changed', {
    detail: { courseId: state.courseId, percent: state.progress.progress_percent },
  }));
}

async function refreshProgress() {
  try {
    state.progress = await api.getProgress(state.courseId);
    renderProgress();
  } catch (err) {
    toast(err.message, { error: true });
  }
}

/**
 * Repoints one chapter's own count and bar after a lesson toggles, rather than
 * re-rendering the outline — a re-render would throw away the open/closed
 * heights mid-slide and drop the row the user just clicked.
 */
function updateChapterProgress(chapterId) {
  const chapter = findChapter(chapterId);
  // `.chapter` qualifies the selector: sub-lesson checkboxes carry a
  // data-chapter of their own.
  const section = document.querySelector(`.chapter[data-chapter="${chapter.id}"]`);
  if (!section) return;

  const total = chapter.subLessons.length;
  const done = chapter.subLessons.filter((l) => l.is_complete).length;

  const count = section.querySelector('[data-count]');
  if (count) {
    count.textContent = `${done}/${total}`;
    count.classList.toggle('is-done', total > 0 && done === total);
  }

  setProgressBar(
    section.querySelector('.chapter-progress .pbar'),
    completionPercent(done, total),
  );
}

/* ---------------------------------------------------------------- actions */

async function toggleLesson(checkbox) {
  const desired = checkbox.checked; // the browser already flipped it optimistically
  const chapterId = Number(checkbox.dataset.chapter);
  const row = checkbox.closest('.lesson');
  const lessonId = Number(row.dataset.lesson);

  row.classList.add('is-busy');
  checkbox.disabled = true;
  try {
    // Explicit boolean, not an empty-body flip: retries land on the same state.
    const updated = await api.setSubLessonComplete(
      state.courseId,
      chapterId,
      lessonId,
      desired,
    );

    const chapter = findChapter(chapterId);
    const index = chapter.subLessons.findIndex((l) => l.id === lessonId);
    chapter.subLessons[index] = updated;

    checkbox.checked = updated.is_complete;
    checkbox.title = lessonCheckTitle(updated.is_complete);
    row.classList.toggle('is-complete', updated.is_complete);
    updateChapterProgress(chapterId);
    await refreshProgress();
  } catch (err) {
    checkbox.checked = !desired; // roll back the optimistic flip
    toast(err.message, { error: true });
  } finally {
    row.classList.remove('is-busy');
    checkbox.disabled = false;
  }
}

async function addChapter(form) {
  const input = form.querySelector('input[name="title"]');
  const title = input.value.trim();
  if (!title) return;

  await withBusy(form.querySelector('button'), async () => {
    try {
      const chapter = await api.createChapter(state.courseId, { title });
      state.chapters.push({ ...chapter, subLessons: [] });
      state.open.add(chapter.id);
      input.value = '';
      renderChapters();
      renderProgress();
    } catch (err) {
      toast(err.message, { error: true });
    }
  });
}

async function addSubLesson(form, chapterId) {
  const input = form.querySelector('input[name="title"]');
  const title = input.value.trim();
  if (!title) return;

  await withBusy(form.querySelector('button'), async () => {
    try {
      const lesson = await api.createSubLesson(state.courseId, chapterId, { title });
      findChapter(chapterId).subLessons.push(lesson);
      renderChapters();
      // The new row replaced the form, so put the cursor back for fast entry.
      document
        .querySelector(`[data-chapter="${chapterId}"] input[name="title"]`)
        ?.focus();
      await refreshProgress();
    } catch (err) {
      toast(err.message, { error: true });
    }
  });
}

/* ------------------------------------------------------------- reminders */

async function addReminder(form) {
  const text = form.elements.text.value.trim();
  const remindDate = form.elements.remind_date.value;

  if (!text) {
    toast('Write what to be reminded about', { error: true });
    return;
  }
  if (!remindDate) {
    toast('Pick a date for the reminder', { error: true });
    return;
  }

  await withBusy(form.querySelector('button[type="submit"]'), async () => {
    try {
      await api.createReminder({
        course_id: state.courseId,
        text,
        remind_date: remindDate,
      });
      form.elements.text.value = '';
      await refreshReminders();
      form.elements.text.focus();
    } catch (err) {
      toast(err.message, { error: true });
    }
  });
}

/**
 * Marking done keeps the row — it is dimmed and struck through, never removed.
 * Sends an explicit boolean rather than a flip so repeat clicks converge, and
 * updates the row in place so the list does not jump under the cursor.
 */
async function toggleReminder(checkbox) {
  const row = checkbox.closest('[data-reminder]');
  const reminderId = Number(row.dataset.reminder);
  const desired = checkbox.checked;

  row.classList.add('is-busy');
  checkbox.disabled = true;
  try {
    const updated = await api.updateReminder(reminderId, { is_done: desired });

    const index = state.reminders.findIndex((r) => r.id === reminderId);
    state.reminders[index] = updated;
    checkbox.checked = updated.is_done;
    row.classList.toggle('is-done', updated.is_done);
  } catch (err) {
    checkbox.checked = !desired; // roll back the optimistic flip
    toast(err.message, { error: true });
  } finally {
    row.classList.remove('is-busy');
    checkbox.disabled = false;
  }
}

async function deleteReminder(reminderId) {
  const reminder = state.reminders.find((r) => r.id === reminderId);
  const ok = await openConfirmDialog({
    title: 'Delete reminder',
    message: `Delete the reminder "${reminder.text}"?`,
  });
  if (!ok) return;

  try {
    await api.deleteReminder(reminderId);
    await refreshReminders();
  } catch (err) {
    toast(err.message, { error: true });
  }
}

/* ------------------------------------------------------------- deadlines */

async function addDeadline(form) {
  const title = form.elements.title.value.trim();
  const dueDate = form.elements.due_date.value;

  if (!title) {
    toast('Give the deadline a title', { error: true });
    return;
  }
  if (!dueDate) {
    toast('Pick a due date', { error: true });
    return;
  }

  await withBusy(form.querySelector('button[type="submit"]'), async () => {
    try {
      await api.createDeadline(state.courseId, { title, due_date: dueDate });
      form.elements.title.value = '';
      await refreshDeadlines();
      form.elements.title.focus();
    } catch (err) {
      toast(err.message, { error: true });
    }
  });
}

async function editDeadline(deadlineId) {
  const deadline = state.deadlines.find((d) => d.id === deadlineId);
  const values = await openFormDialog({
    title: 'Edit deadline',
    fields: [
      { name: 'title', label: 'Title', value: deadline.title },
      { name: 'due_date', label: 'Due date', type: 'date', value: deadline.due_date },
    ],
  });
  if (!values) return;

  const title = values.title.trim();
  if (!title || !values.due_date) {
    toast('A deadline needs a title and a due date', { error: true });
    return;
  }

  try {
    await api.updateDeadline(state.courseId, deadlineId, {
      title,
      due_date: values.due_date,
    });
    await refreshDeadlines();
  } catch (err) {
    toast(err.message, { error: true });
  }
}

async function deleteDeadline(deadlineId) {
  const deadline = state.deadlines.find((d) => d.id === deadlineId);
  const ok = await openConfirmDialog({
    title: 'Delete deadline',
    message: `Delete the deadline "${deadline.title}"?`,
  });
  if (!ok) return;

  try {
    await api.deleteDeadline(state.courseId, deadlineId);
    await refreshDeadlines();
  } catch (err) {
    toast(err.message, { error: true });
  }
}

/* ----------------------------------------------------------- study time */

async function addStudySession(form) {
  const date = form.elements.date.value;
  const rawHours = form.elements.hours.value.trim();
  const note = form.elements.note.value.trim();

  if (!date) {
    toast('Pick a date for the session', { error: true });
    return;
  }
  const hours = Number(rawHours);
  if (!rawHours || !Number.isFinite(hours) || hours <= 0) {
    toast('Enter the hours as a number, e.g. 1.5', { error: true });
    return;
  }
  if (hours > 24) {
    toast('A single session cannot exceed 24 hours', { error: true });
    return;
  }

  await withBusy(form.querySelector('button[type="submit"]'), async () => {
    try {
      await api.createStudySession(state.courseId, {
        date,
        hours,
        note: note || undefined,
      });
      // The date stays put so logging several days in a row is quick.
      form.elements.hours.value = '';
      form.elements.note.value = '';
      await refreshStudy();
      form.elements.hours.focus();
    } catch (err) {
      toast(err.message, { error: true });
    }
  });
}

async function deleteStudySession(sessionId) {
  const session = state.studySessions.find((s) => s.id === sessionId);
  const ok = await openConfirmDialog({
    title: 'Delete study session',
    message: `Delete the ${formatHours(session.hours)} session on ${formatDay(session.date)}?`,
  });
  if (!ok) return;

  try {
    await api.deleteStudySession(state.courseId, sessionId);
    await refreshStudy();
  } catch (err) {
    toast(err.message, { error: true });
  }
}

async function renameChapter(chapterId) {
  const chapter = findChapter(chapterId);
  const values = await openFormDialog({
    title: 'Rename chapter',
    fields: [{ name: 'title', label: 'Title', value: chapter.title }],
  });
  if (!values || !values.title.trim()) return;

  try {
    const updated = await api.updateChapter(state.courseId, chapterId, {
      title: values.title.trim(),
    });
    Object.assign(chapter, updated);
    renderChapters();
  } catch (err) {
    toast(err.message, { error: true });
  }
}

async function deleteChapter(chapterId) {
  const chapter = findChapter(chapterId);
  const count = chapter.subLessons.length;
  const warning = count
    ? `Delete "${chapter.title}" and its ${count} sub-lesson${count === 1 ? '' : 's'}?`
    : `Delete "${chapter.title}"?`;
  const ok = await openConfirmDialog({ title: 'Delete chapter', message: warning });
  if (!ok) return;

  try {
    await api.deleteChapter(state.courseId, chapterId);
    state.chapters = state.chapters.filter((c) => c.id !== Number(chapterId));
    renderChapters();
    await refreshProgress();
  } catch (err) {
    toast(err.message, { error: true });
  }
}

async function renameLesson(chapterId, lessonId) {
  const chapter = findChapter(chapterId);
  const lesson = chapter.subLessons.find((l) => l.id === lessonId);
  const values = await openFormDialog({
    title: 'Rename sub-lesson',
    fields: [{ name: 'title', label: 'Title', value: lesson.title }],
  });
  if (!values || !values.title.trim()) return;

  try {
    const updated = await api.updateSubLesson(state.courseId, chapterId, lessonId, {
      title: values.title.trim(),
    });
    Object.assign(lesson, updated);
    renderChapters();
  } catch (err) {
    toast(err.message, { error: true });
  }
}

async function deleteLesson(chapterId, lessonId) {
  const chapter = findChapter(chapterId);
  const lesson = chapter.subLessons.find((l) => l.id === lessonId);
  const ok = await openConfirmDialog({
    title: 'Delete sub-lesson',
    message: `Delete "${lesson.title}"?`,
  });
  if (!ok) return;

  try {
    await api.deleteSubLesson(state.courseId, chapterId, lessonId);
    chapter.subLessons = chapter.subLessons.filter((l) => l.id !== lessonId);
    renderChapters();
    await refreshProgress();
  } catch (err) {
    toast(err.message, { error: true });
  }
}

async function addNote(button) {
  const textarea = document.getElementById('new-note');
  const content = textarea.value.trim();
  if (!content) {
    toast('Write something first', { error: true });
    return;
  }

  await withBusy(button, async () => {
    try {
      const note = await api.createNote(state.courseId, { content });
      state.notes.unshift(note); // API lists newest first
      textarea.value = '';
      renderNotes();
    } catch (err) {
      toast(err.message, { error: true });
    }
  });
}

async function saveNote(noteId, content) {
  if (!content.trim()) {
    toast('A note cannot be empty', { error: true });
    return;
  }
  try {
    const updated = await api.updateNote(state.courseId, noteId, { content: content.trim() });
    const index = state.notes.findIndex((n) => n.id === noteId);
    state.notes[index] = updated;
    state.editingNoteId = null;
    renderNotes();
    toast('Note saved');
  } catch (err) {
    toast(err.message, { error: true });
  }
}

async function deleteNote(noteId) {
  const ok = await openConfirmDialog({
    title: 'Delete note',
    message: 'Delete this note?',
  });
  if (!ok) return;
  try {
    await api.deleteNote(state.courseId, noteId);
    state.notes = state.notes.filter((n) => n.id !== noteId);
    renderNotes();
  } catch (err) {
    toast(err.message, { error: true });
  }
}

async function editCourse(reload) {
  const values = await openFormDialog({
    title: 'Edit course',
    fields: [
      { name: 'name', label: 'Name', value: state.course.name },
      {
        name: 'description',
        label: 'Description',
        type: 'textarea',
        value: state.course.description || '',
      },
    ],
  });
  if (!values || !values.name.trim()) return;

  try {
    await api.updateCourse(state.courseId, {
      name: values.name.trim(),
      description: values.description.trim() || null,
    });
    document.dispatchEvent(new CustomEvent('courses-changed'));
    reload();
  } catch (err) {
    toast(err.message, { error: true });
  }
}

async function deleteCourse() {
  const ok = await openConfirmDialog({
    title: 'Delete course',
    message: `Delete "${state.course.name}" and everything in it?`,
  });
  if (!ok) return;
  try {
    await api.deleteCourse(state.courseId);
    document.dispatchEvent(new CustomEvent('courses-changed'));
    toast('Course deleted');
    window.location.hash = '#/';
  } catch (err) {
    toast(err.message, { error: true });
  }
}

/* ----------------------------------------------------------------- wiring */

function attachHandlers(view, reload) {
  view.addEventListener('change', (event) => {
    if (event.target.dataset.action === 'toggle-lesson') toggleLesson(event.target);
    if (event.target.dataset.action === 'toggle-reminder') toggleReminder(event.target);
  });

  view.addEventListener('submit', (event) => {
    const form = event.target;
    event.preventDefault();
    if (form.dataset.action === 'add-chapter') addChapter(form);
    if (form.dataset.action === 'add-sub-lesson') {
      addSubLesson(form, Number(form.closest('[data-chapter]').dataset.chapter));
    }
    if (form.dataset.action === 'add-study-session') addStudySession(form);
    if (form.dataset.action === 'add-deadline') addDeadline(form);
    if (form.dataset.action === 'add-reminder') addReminder(form);
  });

  view.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    const el = event.target;

    // Enter submits the quick-add inputs without reaching for the button.
    if (el.tagName === 'INPUT' && ['text', 'number', 'date'].includes(el.type)) {
      const form = el.closest('form[data-action]');
      if (form) {
        event.preventDefault();
        form.requestSubmit();
      }
      return;
    }

    // Newlines are meaningful in notes, so require a modifier there.
    if (el.tagName === 'TEXTAREA' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      if (el.id === 'new-note') {
        addNote(view.querySelector('[data-action="add-note"]'));
      } else if (el.matches('[data-note-input]')) {
        saveNote(Number(el.closest('[data-note]').dataset.note), el.value);
      }
    }
  });

  view.addEventListener('click', (event) => {
    const trigger = event.target.closest('[data-action]');
    if (!trigger || !view.contains(trigger)) return;

    const chapterEl = trigger.closest('[data-chapter]');
    const chapterId = chapterEl ? Number(chapterEl.dataset.chapter) : null;
    const lessonEl = trigger.closest('[data-lesson]');
    const lessonId = lessonEl ? Number(lessonEl.dataset.lesson) : null;
    const noteEl = trigger.closest('[data-note]');
    const noteId = noteEl ? Number(noteEl.dataset.note) : null;
    const sessionEl = trigger.closest('[data-session]');
    const sessionId = sessionEl ? Number(sessionEl.dataset.session) : null;
    const deadlineEl = trigger.closest('[data-deadline]');
    const deadlineId = deadlineEl ? Number(deadlineEl.dataset.deadline) : null;
    const reminderEl = trigger.closest('[data-reminder]');
    const reminderId = reminderEl ? Number(reminderEl.dataset.reminder) : null;

    switch (trigger.dataset.action) {
      case 'toggle-chapter': {
        const section = trigger.closest('.chapter');
        const nowOpen = !section.classList.contains('is-open');
        setChapterOpen(section, nowOpen);
        if (nowOpen) {
          state.open.add(chapterId);
          // Expanding is a navigation event, so it moves the bookmark.
          // Collapsing is not, and checkbox toggles never touch it.
          recordLastViewed(chapterId);
        } else {
          state.open.delete(chapterId);
        }
        break;
      }
      case 'rename-chapter': renameChapter(chapterId); break;
      case 'delete-chapter': deleteChapter(chapterId); break;
      case 'rename-lesson': renameLesson(chapterId, lessonId); break;
      case 'delete-lesson': deleteLesson(chapterId, lessonId); break;
      case 'add-note': addNote(trigger); break;
      case 'edit-note':
        state.editingNoteId = noteId;
        renderNotes();
        noteEl.parentElement.querySelector('[data-note-input]')?.focus();
        break;
      case 'cancel-note':
        state.editingNoteId = null;
        renderNotes();
        break;
      case 'save-note':
        saveNote(noteId, noteEl.querySelector('[data-note-input]').value);
        break;
      case 'delete-note': deleteNote(noteId); break;
      case 'toggle-timer': toggleTimer(); break;
      case 'add-time': addMoreTime(); break;
      case 'delete-study-session': deleteStudySession(sessionId); break;
      case 'edit-deadline': editDeadline(deadlineId); break;
      case 'delete-deadline': deleteDeadline(deadlineId); break;
      case 'delete-reminder': deleteReminder(reminderId); break;
      case 'edit-course': editCourse(reload); break;
      case 'delete-course': deleteCourse(); break;
      default: break;
    }
  });
}

/**
 * Starts the live timer for a course from outside this view (the dashboard's
 * quick-picker). Shares the same module-level `liveTimer`, so arriving on the
 * course page shows an already-running clock rather than a second one.
 *
 * Returns { ok: false, runningFor } when a different course is being timed, so
 * the caller can say so instead of silently discarding that session.
 *
 * The length is chosen by the caller (the dashboard asks before navigating), so
 * the picker appears where the button was pressed rather than after the view
 * has already changed underneath the user.
 */
export function startLiveTimerFor(courseId, courseName, minutes) {
  if (liveTimer && liveTimer.courseId !== courseId) {
    return { ok: false, runningFor: liveTimer.courseName };
  }
  if (!liveTimer) {
    beginTimer(courseId, courseName, minutes);
  }
  return { ok: true };
}

/**
 * Testing handle, the same bargain the pomodoro's `window.pomodoro` strikes:
 * sitting through a 25-minute interval to check that the right number gets
 * logged is not a test anyone runs twice, and there is no build step here to
 * strip a dev-only export. Registered at module load so it exists whichever
 * view is showing.
 */
window.studyTimer = {
  state: () => (liveTimer
    ? {
      ...liveTimer,
      frozen: timerFrozen(),
      elapsedMs: elapsedMs(),
      remainingMs: remainingMs(),
      promptOpen: expiryPromptOpen,
    }
    : null),
  /**
   * Fast-forwards the running segment so `seconds` remain. Shifts the segment's
   * start rather than faking the elapsed total, so everything downstream —
   * banking, the watchdog, the logged hours — runs exactly as it would have.
   */
  skipTo(seconds = 0) {
    if (!liveTimer || timerFrozen()) return this.state();
    liveTimer.segmentStartedAt -= remainingMs() - seconds * 1000;
    return this.state();
  },
  addTime: (minutes) => addTimerTime(minutes),
  stop: () => stopTimer(),
};

/* ------------------------------------------------------------------ entry */

export async function renderCourse(root, actions, courseId, focusChapterId = null) {
  root.innerHTML = '<div class="skeleton">Loading course…</div>';
  actions.innerHTML = '<a class="btn btn-sm" href="#/">← All courses</a>';

  try {
    state = await loadState(courseId);
  } catch (err) {
    root.innerHTML = `
      <div class="error-box">${escapeHtml(err.message)}</div>
      <p style="margin-top:16px"><a href="#/">← Back to all courses</a></p>`;
    return;
  }

  const reload = () => renderCourse(root, actions, courseId, focusChapterId);
  const { course } = state;

  root.innerHTML = `
    <div class="course-view">
      <div class="page-head">
        <div>
          <h1>${escapeHtml(course.name)}</h1>
          <p class="subtitle">${course.description ? escapeHtml(course.description) : 'No description'}</p>
        </div>
        <div style="display:flex;gap:6px">
          <button class="btn btn-sm" data-action="edit-course">Edit</button>
          <button class="btn btn-sm btn-danger" data-action="delete-course">Delete</button>
        </div>
      </div>

      <div class="progress-summary" id="progress-summary"></div>

      <div class="course-layout">
        <div class="course-col course-col-main">
          <div class="section">
            <div class="section-head"><h2>Chapters</h2></div>
            <div id="chapters"></div>
            <form class="inline-form" data-action="add-chapter" style="margin-top:14px">
              <input type="text" name="title" placeholder="Add a chapter…" autocomplete="off">
              <button class="btn" type="submit">Add chapter</button>
            </form>
          </div>
        </div>

        <div class="course-col course-col-side">
          <div class="section">
            <div class="section-head"><h2>Deadlines</h2></div>
            <form class="deadline-form" data-action="add-deadline">
              <div class="deadline-field deadline-field-title">
                <label for="deadline-title">Title</label>
                <input type="text" id="deadline-title" name="title"
                       placeholder="e.g. Rapport de TP" autocomplete="off">
              </div>
              <div class="deadline-field">
                <label for="deadline-date">Due date</label>
                <input type="date" id="deadline-date" name="due_date"
                       value="${todayLocal()}" autocomplete="off">
              </div>
              <button class="btn btn-primary btn-sm" type="submit">Add deadline</button>
            </form>
            <ul class="deadline-list" id="deadline-list"></ul>
          </div>

          <div class="section">
            <div class="section-head"><h2>Reminders</h2></div>
            <form class="reminder-form" data-action="add-reminder">
              <div class="reminder-field reminder-field-text">
                <label for="reminder-text">Reminder</label>
                <input class="input-panel" type="text" id="reminder-text" name="text"
                       placeholder="e.g. Revoir les exercices du TD3" autocomplete="off">
              </div>
              <div class="reminder-field">
                <label for="reminder-date">Date</label>
                <input type="date" id="reminder-date" name="remind_date"
                       value="${todayLocal()}" autocomplete="off">
              </div>
              <button class="btn btn-primary btn-sm" type="submit">Add reminder</button>
            </form>
            <ul class="reminder-list" id="reminder-list"></ul>
          </div>

          <div class="section">
            <div class="section-head">
              <h2>Study time</h2>
              <div class="study-total" id="study-total"></div>
            </div>
            <div class="study-timer" id="study-timer"></div>
            <form class="study-form" data-action="add-study-session">
              <div class="study-field">
                <label for="study-date">Date</label>
                <input type="date" id="study-date" name="date"
                       value="${todayLocal()}" autocomplete="off">
              </div>
              <div class="study-field study-field-hours">
                <label for="study-hours">Hours</label>
                <input type="number" id="study-hours" name="hours"
                       step="any" min="0.1" max="24" placeholder="1.5" autocomplete="off">
              </div>
              <div class="study-field study-field-note">
                <label for="study-note">Note (optional)</label>
                <input type="text" id="study-note" name="note"
                       placeholder="What did you work on?" autocomplete="off">
              </div>
              <button class="btn btn-primary btn-sm" type="submit">Log session</button>
            </form>
            <ul class="study-list" id="study-list"></ul>
          </div>
        </div>
      </div>

      <div class="section">
        <div class="section-head"><h2>Notes &amp; resources</h2></div>
        <div style="margin-bottom:16px">
          <textarea class="input-panel" id="new-note" rows="3"
            placeholder="Paste a link or write a note…"></textarea>
          <div style="margin-top:8px">
            <button class="btn btn-primary btn-sm" data-action="add-note">Add note</button>
          </div>
        </div>
        <div id="notes-list"></div>
      </div>
    </div>`;

  document.getElementById('progress-summary').innerHTML = progressSummaryTemplate(state.progress);
  renderChapters();
  renderDeadlines();
  renderReminders();
  renderStudy();
  renderTimer();
  renderNotes();
  attachHandlers(root.querySelector('.course-view'), reload);

  // Opening a course detail view is itself a navigation event: bookmark it,
  // keeping the chapter we were sent to (if any).
  const focused = focusChapterId && findChapter(focusChapterId) ? focusChapterId : null;
  if (focused) focusChapter(focused);
  recordLastViewed(focused);
}
