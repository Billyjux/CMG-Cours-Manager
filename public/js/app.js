import { api } from './api.js';
import { renderDashboard } from './views/dashboard.js';
import { renderCourse } from './views/course.js';

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

  window.scrollTo(0, 0);
  if (match) {
    renderCourse(root, actions, Number(match[1]), match[2] ? Number(match[2]) : null);
  } else {
    renderDashboard(root, actions);
  }
}

/**
 * Cold start. If the app is opening at the dashboard and a bookmark exists,
 * jump straight back into it. This lives outside route() on purpose: it runs
 * once per page load, so navigating back to "/" later shows the real
 * dashboard instead of bouncing the user into a course again.
 */
async function start() {
  const atDashboard = !window.location.hash || window.location.hash === '#/';

  if (atDashboard) {
    let last = null;
    try {
      last = await api.getLastViewed();
    } catch {
      // A failed bookmark lookup must never block the app; fall through to
      // the normal dashboard.
    }

    if (last) {
      const target = last.chapter_id
        ? `#/courses/${last.course_id}/chapters/${last.chapter_id}`
        : `#/courses/${last.course_id}`;
      // replaceState updates the URL without firing hashchange (so the router
      // runs exactly once) and without leaving a dashboard entry to bounce
      // back to.
      window.history.replaceState(null, '', target);
    }
  }

  route();
}

window.addEventListener('hashchange', route);
start();
