// The application shell: the course sidebar and the two layout toggles.
// It owns no domain data of its own — it lists courses from the existing
// /courses endpoint and highlights whichever one the router has open.

import { api } from './api.js';
import { escapeHtml, progressBar, setProgressBar } from './ui.js';

const SIDEBAR_KEY = 'cm:sidebar-hidden';
const FOCUS_KEY = 'cm:focus-mode';

let courses = [];
let activeCourseId = null;
// course id → progress_percent, or null where the lookup failed. Kept apart
// from `courses` because it is refreshed on its own, after the first paint.
let progress = new Map();

const shell = () => document.getElementById('shell');

/* ------------------------------------------------------------ layout state */

const readFlag = (key) => {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    // Private mode or blocked storage: fall back to the default layout.
    return false;
  }
};

const writeFlag = (key, value) => {
  try {
    localStorage.setItem(key, value ? '1' : '0');
  } catch {
    /* not worth surfacing */
  }
};

let sidebarHidden = readFlag(SIDEBAR_KEY);
let focusMode = readFlag(FOCUS_KEY);

/** Distraction-free implies a hidden sidebar; the explicit toggle is separate. */
function applyLayout() {
  const el = shell();
  el.classList.toggle('is-sidebar-hidden', sidebarHidden || focusMode);
  el.classList.toggle('is-focus', focusMode);
  document.getElementById('toggle-focus').setAttribute('aria-pressed', String(focusMode));
  document
    .getElementById('toggle-sidebar')
    .setAttribute('aria-expanded', String(!(sidebarHidden || focusMode)));
}

function toggleSidebar() {
  // Leaving focus mode via the sidebar button should reveal the sidebar
  // rather than appear to do nothing.
  if (focusMode) {
    focusMode = false;
    sidebarHidden = false;
  } else {
    sidebarHidden = !sidebarHidden;
  }
  writeFlag(SIDEBAR_KEY, sidebarHidden);
  writeFlag(FOCUS_KEY, focusMode);
  applyLayout();
}

function toggleFocus(force) {
  focusMode = force === undefined ? !focusMode : force;
  writeFlag(FOCUS_KEY, focusMode);
  applyLayout();
}

/* ---------------------------------------------------------------- sidebar */

function renderSidebar() {
  const nav = document.getElementById('sidebar-nav');
  const foot = document.getElementById('sidebar-foot');

  const courseItems = courses.length
    ? courses
      .map((course) => {
        const percent = progress.get(course.id);
        return `
          <a class="sidebar-item is-course${course.id === activeCourseId ? ' is-active' : ''}"
             href="#/courses/${course.id}" data-course="${course.id}"
             ${course.id === activeCourseId ? 'aria-current="page"' : ''}>
            <span class="sidebar-item-name">${escapeHtml(course.name)}</span>
            ${percent === undefined || percent === null ? '' : progressBar(percent, { compact: true })}
          </a>`;
      })
      .join('')
    : '<p class="sidebar-empty">No courses yet</p>';

  // Overview sits at the top, the way an "all items" entry does in a file
  // tree, so the list below it reads as one group.
  nav.innerHTML = `
    <a class="sidebar-item${activeCourseId === null ? ' is-active' : ''}" href="#/">Overview</a>
    <p class="sidebar-label">Courses</p>
    ${courseItems}`;

  foot.innerHTML = courses.length
    ? `<span class="sidebar-count">${courses.length} course${courses.length === 1 ? '' : 's'}</span>`
    : '';
}

/**
 * Completion for each course, one request apiece — there is no bulk progress
 * endpoint and this stage did not add one. A course whose lookup fails simply
 * gets no bar, which is better than a bar showing the wrong number.
 */
async function loadProgress() {
  const entries = await Promise.all(
    courses.map(async (course) => {
      try {
        const { progress_percent: percent } = await api.getProgress(course.id);
        return [course.id, percent];
      } catch {
        return [course.id, null];
      }
    }),
  );
  progress = new Map(entries);
}

/** Re-reads the course list, then their progress. */
export async function refreshSidebar() {
  try {
    courses = await api.listCourses();
  } catch {
    // A failed list must not take the shell down; keep whatever we had.
  }
  // Paint the names straight away; the bars follow a moment later rather than
  // holding the whole sidebar behind N requests.
  renderSidebar();
  await loadProgress();
  renderSidebar();
}

/**
 * The course the workspace currently has open, or null on the dashboard. The
 * pomodoro asks at the moment a session completes, so walking from the
 * dashboard into a course mid-session still logs the time to that course.
 */
export function getActiveCourse() {
  if (activeCourseId === null) return null;
  const course = courses.find((c) => c.id === activeCourseId);
  return { id: activeCourseId, name: course ? course.name : null };
}

/** Called by the router so the sidebar marks the course being viewed. */
export function setActiveCourse(courseId) {
  activeCourseId = courseId;
  renderSidebar();
}

/**
 * Whether a keystroke went into something the user is typing in. A bare letter
 * is only a shortcut when it is not a letter someone is writing.
 */
function isTyping(target) {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

/* ----------------------------------------------------------------- wiring */

export function initShell() {
  applyLayout();

  document.getElementById('toggle-sidebar').addEventListener('click', toggleSidebar);
  document.getElementById('toggle-focus').addEventListener('click', () => toggleFocus());

  document.addEventListener('keydown', (event) => {
    // A modal owns the keyboard while it is up. It stops its own Esc from
    // reaching here, so this is only a second line of defence for the rest.
    if (document.querySelector('dialog[open]')) return;

    if (event.key === 'Escape' && focusMode) {
      toggleFocus(false);
      return;
    }
    // Ctrl/Cmd+B is the usual shortcut for this in editors.
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'b') {
      event.preventDefault();
      toggleSidebar();
      return;
    }

    if (isTyping(event.target) || event.ctrlKey || event.metaKey || event.altKey) return;

    // N is whatever button on screen claims it, so the key and the hint
    // printed on that button can never drift apart — and on a view with no
    // such button, N is just the letter N.
    if (event.key.toLowerCase() === 'n') {
      const trigger = document.querySelector('[data-shortcut="n"]');
      if (!trigger) return;
      event.preventDefault();
      trigger.click();
    }
  });

  // Views fire this after creating, renaming or deleting a course, so the
  // sidebar stays in step without them reaching into it directly.
  document.addEventListener('courses-changed', () => { refreshSidebar(); });

  // A course view recomputing its progress (a sub-lesson ticked, a chapter
  // added) repoints the matching sidebar bar, so the two never disagree.
  document.addEventListener('progress-changed', (event) => {
    const { courseId, percent } = event.detail;
    const had = progress.get(courseId);
    progress.set(courseId, percent);

    const bar = document.querySelector(`.sidebar-item[data-course="${courseId}"] .pbar`);
    // No bar yet (progress had not loaded for this course): render one.
    if (bar && had !== undefined && had !== null) setProgressBar(bar, percent);
    else renderSidebar();
  });

  return refreshSidebar();
}
