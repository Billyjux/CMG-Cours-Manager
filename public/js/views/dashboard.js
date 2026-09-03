import { api } from '../api.js';
import {
  escapeHtml, progressBar, toast, openFormDialog, withBusy,
  deadlineStatus, formatDay, relativeDayLabel, openDurationDialog,
} from '../ui.js';
import { startLiveTimerFor } from './course.js';

const ACTIVITY_DAYS = 365;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * One row of the "Upcoming" list. Deadlines and reminders share a shape here;
 * urgency uses the same deadlineStatus() as the per-course deadline list, so
 * the colours mean the same thing in both places.
 */
function upcomingItemTemplate(item) {
  const { status, days } = deadlineStatus(item.date);
  const where = item.course_name ? escapeHtml(item.course_name) : 'General';
  // A general reminder has no course to open.
  const href = item.course_id ? `#/courses/${item.course_id}` : null;

  const body = `
    <span class="overview-item-title">${escapeHtml(item.title)}</span>
    <span class="overview-item-meta">
      <span class="overview-kind is-${item.type}">${item.type}</span>
      ${where} · ${escapeHtml(formatDay(item.date))}
      <span class="overview-when">${escapeHtml(relativeDayLabel(days))}</span>
    </span>`;

  return `
    <li class="overview-item is-${status}">
      <span class="overview-marker" aria-hidden="true"></span>
      ${href
        ? `<a class="overview-item-body" href="${href}">${body}</a>`
        : `<span class="overview-item-body">${body}</span>`}
    </li>`;
}

function upcomingSection(summary) {
  const items = summary ? summary.upcoming : [];

  return `
    <section class="overview-card">
      <h2 class="overview-title">Upcoming</h2>
      ${
        items.length
          ? `<ul class="overview-list">${items.map(upcomingItemTemplate).join('')}</ul>`
          // "nothing due" and "could not load" are different facts; never claim
          // the first when the request actually failed.
          : `<p class="overview-empty">${
              summary
                ? 'Nothing due in the next 7 days.'
                : 'Could not load the overview just now.'
            }</p>`
      }
    </section>`;
}

function studyWeekSection(summary, courses) {
  const week = summary ? summary.study_time_this_week : null;
  const hours = week ? week.total_hours : 0;
  const sessions = week ? week.session_count : 0;

  return `
    <section class="overview-card">
      <h2 class="overview-title">Study time this week</h2>
      ${
        sessions
          ? `<div class="study-week">
               <strong class="study-week-hours">${escapeHtml(hours)} h</strong>
               <span class="study-week-meta">
                 across ${sessions} session${sessions === 1 ? '' : 's'} · last 7 days
               </span>
             </div>`
          : '<p class="overview-empty">No study time logged in the last 7 days.</p>'
      }
      ${
        courses.length
          ? `<div class="study-week-picker">
               <select id="timer-course" aria-label="Course to study">
                 ${courses
                   .map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`)
                   .join('')}
               </select>
               <button class="btn btn-sm btn-timer-start" type="button" id="start-timer">
                 ▶ Start studying
               </button>
             </div>`
          : ''
      }
    </section>`;
}

/**
 * "Resume where I left off" card. Renders nothing when the API reports no
 * bookmark — first run, or the course has since been deleted.
 */
function continueCard(last) {
  if (!last) return '';

  const href = last.chapter_id
    ? `#/courses/${last.course_id}/chapters/${last.chapter_id}`
    : `#/courses/${last.course_id}`;

  return `
    <a class="continue-card" href="${href}">
      <span class="continue-icon" aria-hidden="true">▶</span>
      <span class="continue-body">
        <span class="continue-label">Continue where you left off</span>
        <span class="continue-target">
          ${escapeHtml(last.course_name)}${
            last.chapter_title
              ? ` <span class="continue-arrow">→</span> ${escapeHtml(last.chapter_title)}`
              : ''
          }
        </span>
      </span>
      <span class="continue-go" aria-hidden="true">›</span>
    </a>`;
}

/** One square's hover text: what happened that day, in plain words. */
function activityTitle(day) {
  const parts = [];
  if (day.sub_lessons_completed) {
    parts.push(`${day.sub_lessons_completed} sub-lesson${day.sub_lessons_completed === 1 ? '' : 's'}`);
  }
  if (day.hours) parts.push(`${day.hours} h studied`);
  return `${parts.length ? parts.join(' · ') : 'Nothing logged'} — ${formatDay(day.date)}`;
}

/**
 * A year of activity as a contribution grid: one square per day, one column per
 * week, running Sunday to Saturday down each column.
 *
 * The server hands back every day in the window, quiet ones included, so the
 * only arithmetic here is padding the first column out to a whole week — the
 * date walking, the grouping and the intensity all stay on one side of the
 * wire, where they can be tested.
 */
function activitySection(summary) {
  if (!summary || !summary.activity.length) {
    return `
      <section class="overview-card activity-card" data-activity>
        <h2 class="overview-title">Activity</h2>
        <p class="overview-empty">Could not load your activity just now.</p>
      </section>`;
  }

  const days = summary.activity;
  // Blank leading cells so every column is a real Sunday-to-Saturday week and
  // the weekday rows line up with their labels.
  const lead = new Date(`${days[0].date}T00:00:00`).getDay();
  const cells = [...Array(lead).fill(null), ...days];

  const weeks = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));

  // A month is labelled on the first column that lands in it, the way a
  // calendar names a month once rather than on every week.
  const monthLabels = [];
  let lastMonth = null;
  weeks.forEach((week, column) => {
    const day = week.find(Boolean);
    if (!day) return;
    const month = new Date(`${day.date}T00:00:00`).getMonth();
    if (month === lastMonth) return;
    lastMonth = month;
    // Skip a label with no room before the next one.
    if (column > weeks.length - 3) return;
    monthLabels.push(`<span class="activity-month" style="grid-column:${column + 1}">${MONTHS[month]}</span>`);
  });

  const squares = weeks
    .flat()
    .map((day) => (day
      ? `<span class="activity-cell" data-level="${day.level}" data-date="${day.date}"
               title="${escapeHtml(activityTitle(day))}"></span>`
      : '<span class="activity-cell is-pad"></span>'))
    .join('');

  const { totals } = summary;

  return `
    <section class="overview-card activity-card" data-activity>
      <div class="activity-head">
        <h2 class="overview-title">Activity</h2>
        <p class="activity-summary">
          ${totals.sub_lessons_completed} sub-lesson${totals.sub_lessons_completed === 1 ? '' : 's'}
          and ${totals.hours} h across ${totals.active_days} day${totals.active_days === 1 ? '' : 's'}
        </p>
      </div>

      <div class="activity-scroll">
        <div class="activity-plot" style="--weeks:${weeks.length}">
          <div class="activity-months">${monthLabels.join('')}</div>
          <div class="activity-days" aria-hidden="true">
            <span>Mon</span><span>Wed</span><span>Fri</span>
          </div>
          <div class="activity-grid" role="img"
               aria-label="Activity over the last ${summary.days} days: ${totals.active_days} active days">
            ${squares}
          </div>
        </div>
      </div>

      <div class="activity-legend">
        <span>Less</span>
        ${[0, 1, 2, 3, 4].map((l) => `<span class="activity-cell" data-level="${l}"></span>`).join('')}
        <span>More</span>
      </div>
    </section>`;
}

/**
 * Lightweight urgency pills. Counts only what needs attention — overdue and
 * due within a week — so a course with distant deadlines stays unmarked.
 */
function deadlineBadges(deadlines) {
  let overdue = 0;
  let upcoming = 0;
  for (const deadline of deadlines) {
    const { status } = deadlineStatus(deadline.due_date);
    if (status === 'overdue') overdue += 1;
    else if (status === 'upcoming') upcoming += 1;
  }

  const pills = [
    overdue ? `<span class="deadline-badge is-overdue">${overdue} overdue</span>` : '',
    upcoming ? `<span class="deadline-badge is-upcoming">${upcoming} due soon</span>` : '',
  ].filter(Boolean);

  // Emit nothing at all when there is nothing urgent, so no empty row of
  // padding is left behind on a quiet course card.
  return pills.length ? `<div class="course-card-badges">${pills.join('')}</div>` : '';
}

function courseCard(course, progress, deadlines) {
  const meta = progress.total_sub_lessons
    ? `${progress.completed_sub_lessons} of ${progress.total_sub_lessons} sub-lessons done`
    : 'No sub-lessons yet';

  // One progress indicator per card: the bar carries the percentage, so the
  // ring it replaced would only have said the same thing twice.
  return `
    <a class="course-card" href="#/courses/${course.id}">
      <div class="course-card-body">
        <div class="course-card-title">${escapeHtml(course.name)}</div>
        ${course.description ? `<div class="course-card-desc">${escapeHtml(course.description)}</div>` : ''}
        <div class="course-card-meta">${escapeHtml(meta)}</div>
      </div>
      ${progressBar(progress.progress_percent)}
      ${deadlineBadges(deadlines)}
    </a>`;
}

async function promptNewCourse(button, reload) {
  const values = await openFormDialog({
    title: 'New course',
    submitLabel: 'Create course',
    fields: [
      { name: 'name', label: 'Name', placeholder: 'e.g. Algebra II' },
      {
        name: 'description',
        label: 'Description (optional)',
        type: 'textarea',
        placeholder: 'What this course covers',
      },
    ],
  });
  if (!values) return;

  const name = values.name.trim();
  if (!name) {
    toast('A course needs a name', { error: true });
    return;
  }

  await withBusy(button, async () => {
    try {
      const course = await api.createCourse({
        name,
        description: values.description.trim() || undefined,
      });
      document.dispatchEvent(new CustomEvent('courses-changed'));
      toast(`Created "${course.name}"`);
      reload();
    } catch (err) {
      toast(err.message, { error: true });
    }
  });
}

export async function renderDashboard(root, actions) {
  root.innerHTML = '<div class="skeleton">Loading courses…</div>';
  actions.innerHTML = '';

  let courses;
  try {
    courses = await api.listCourses();
  } catch (err) {
    root.innerHTML = `<div class="error-box">${escapeHtml(err.message)}</div>`;
    return;
  }

  // Progress lives behind its own endpoint, so fan out once per course.
  const progressList = await Promise.all(
    courses.map((course) =>
      api.getProgress(course.id).catch(() => ({
        total_sub_lessons: 0,
        completed_sub_lessons: 0,
        progress_percent: 0,
      })),
    ),
  );

  // Same fan-out for deadlines; a failure just means no badge on that card.
  const deadlineLists = await Promise.all(
    courses.map((course) => api.listDeadlines(course.id).catch(() => [])),
  );

  // Both are nice-to-haves: if either fails, the dashboard still renders and
  // the affected section falls back to its empty state.
  const [lastViewed, summary, activity] = await Promise.all([
    api.getLastViewed().catch(() => null),
    api.getDashboardSummary().catch(() => null),
    api.getActivitySummary(ACTIVITY_DAYS).catch(() => null),
  ]);

  const reload = () => renderDashboard(root, actions);

  actions.innerHTML = '<button class="btn btn-primary" id="new-course" data-shortcut="n">'
    + '+ New course <kbd class="kbd">N</kbd></button>';
  document
    .getElementById('new-course')
    .addEventListener('click', (e) => promptNewCourse(e.currentTarget, reload));

  root.innerHTML = `
    <div class="page-head">
      <div>
        <h1>Your courses</h1>
        <p class="subtitle">${courses.length} course${courses.length === 1 ? '' : 's'} tracked</p>
      </div>
      <!-- A plain link, not a fetch-and-blob: the endpoint already sends
           Content-Disposition, so the browser names and saves the file itself,
           and the download survives this view being re-rendered underneath it. -->
      <a class="btn btn-sm btn-report" href="/api/reports/weekly" download
         title="Download a PDF summary of this week across all courses">
        <span class="icon-download" aria-hidden="true"></span> Weekly report
      </a>
    </div>
    ${continueCard(lastViewed)}
    <div class="overview">
      ${upcomingSection(summary)}
      ${studyWeekSection(summary, courses)}
    </div>
    ${activitySection(activity)}
    ${
      courses.length === 0
        ? `<div class="empty">
             <p>No courses yet. Add your first one to start tracking progress.</p>
             <button class="btn btn-primary" id="empty-new-course" data-shortcut="n">
               + New course <kbd class="kbd">N</kbd>
             </button>
           </div>`
        : `<div class="course-grid">
             ${courses.map((c, i) => courseCard(c, progressList[i], deadlineLists[i])).join('')}
           </div>`
    }`;

  document
    .getElementById('empty-new-course')
    ?.addEventListener('click', (e) => promptNewCourse(e.currentTarget, reload));

  document.getElementById('start-timer')?.addEventListener('click', async () => {
    const select = document.getElementById('timer-course');
    const courseId = Number(select.value);
    const courseName = select.options[select.selectedIndex].textContent.trim();

    // Asked here rather than after navigating, so the picker appears where the
    // button was pressed instead of on a view that changed underneath the user.
    const answer = await openDurationDialog({
      title: 'Study session length',
      message: `How long are you sitting down to study "${courseName}"? `
        + 'You can add more time when it runs out.',
      submitLabel: 'Start',
    });
    if (!answer || answer.action !== 'choose') return;

    // Shares the course view's single timer, so this refuses rather than
    // quietly replacing a session already being tracked elsewhere.
    const started = startLiveTimerFor(courseId, courseName, answer.minutes);
    if (!started.ok) {
      toast(`A timer is already running for "${started.runningFor}". Stop it there first.`, {
        error: true,
      });
      return;
    }
    window.location.hash = `#/courses/${courseId}`;
  });
}
