import { renderDashboard } from './views/dashboard.js';
import { renderCourse } from './views/course.js';
import { initShell, setActiveCourse } from './shell.js';
import { initPomodoro } from './pomodoro.js';

const root = document.getElementById('app');
const actions = document.getElementById('topbar-actions');

/**
 * Hash router.
 *   #/                        dashboard
 *   #/courses/:id             course detail
 *   #/courses/:id/chapters/:n course detail, that chapter expanded and scrolled to
 */
function route() {
  const hash = window.location.hash.replace(/^#/, '') || '/';
  const match = hash.match(/^\/courses\/(\d+)(?:\/chapters\/(\d+))?$/);

  // The workspace pane scrolls, not the document, so resetting the scroll
  // position on navigation means scrolling that element.
  root.scrollTop = 0;
  if (match) {
    const courseId = Number(match[1]);
    setActiveCourse(courseId);
    renderCourse(root, actions, courseId, match[2] ? Number(match[2]) : null);
  } else {
    setActiveCourse(null);
    renderDashboard(root, actions);
  }
}

/*
 * Cold start lands on the dashboard, deliberately. The bookmark is still
 * recorded and still offered — as the Continue card at the top of the
 * overview — but opening the app is not the same thing as asking to go back
 * to where you were, and a redirect that fires before the overview can be
 * read takes that choice away. Resuming is one click; nothing resumes on its
 * own. A link straight to #/courses/:id still opens that course, so this only
 * governs the empty-hash case.
 */

window.addEventListener('hashchange', route);
// The shell renders around the views, so it comes up first.
initShell();
// After the shell: the widget asks it which course is open.
initPomodoro();
route();
