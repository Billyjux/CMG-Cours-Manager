import { api } from '../api.js';
import { escapeHtml, progressRing, toast, openFormDialog, withBusy } from '../ui.js';

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

function courseCard(course, progress) {
  const meta = progress.total_sub_lessons
    ? `${progress.completed_sub_lessons} of ${progress.total_sub_lessons} sub-lessons done`
    : 'No sub-lessons yet';

  return `
    <a class="course-card" href="#/courses/${course.id}">
      ${progressRing(progress.progress_percent)}
      <div class="course-card-body">
        <div class="course-card-title">${escapeHtml(course.name)}</div>
        ${course.description ? `<div class="course-card-desc">${escapeHtml(course.description)}</div>` : ''}
        <div class="course-card-meta">${escapeHtml(meta)}</div>
      </div>
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

  // The bookmark is a nice-to-have: if it fails, the dashboard still renders.
  const lastViewed = await api.getLastViewed().catch(() => null);

  const reload = () => renderDashboard(root, actions);

  actions.innerHTML = '<button class="btn btn-primary" id="new-course">+ New course</button>';
  document
    .getElementById('new-course')
    .addEventListener('click', (e) => promptNewCourse(e.currentTarget, reload));

  root.innerHTML = `
    <div class="page-head">
      <div>
        <h1>Your courses</h1>
        <p class="subtitle">${courses.length} course${courses.length === 1 ? '' : 's'} tracked</p>
      </div>
    </div>
    ${continueCard(lastViewed)}
    ${
      courses.length === 0
        ? `<div class="empty">
             <p>No courses yet. Add your first one to start tracking progress.</p>
             <button class="btn btn-primary" id="empty-new-course">+ New course</button>
           </div>`
        : `<div class="course-grid">
             ${courses.map((c, i) => courseCard(c, progressList[i])).join('')}
           </div>`
    }`;

  document
    .getElementById('empty-new-course')
    ?.addEventListener('click', (e) => promptNewCourse(e.currentTarget, reload));
}
