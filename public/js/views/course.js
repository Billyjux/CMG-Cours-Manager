import { api } from '../api.js';
import {
  escapeHtml,
  escapeWithLinks,
  formatDate,
  progressRing,
  toast,
  openFormDialog,
  withBusy,
} from '../ui.js';

// View state for the course currently on screen. Rebuilt on every navigation.
let state = null;

/* ---------------------------------------------------------------- loading */

async function loadState(courseId) {
  const [course, chapters, notes, progress] = await Promise.all([
    api.getCourse(courseId),
    api.listChapters(courseId),
    api.listNotes(courseId),
    api.getProgress(courseId),
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
    // Chapters start expanded so sub-lessons are visible without a click.
    open: new Set(withLessons.map((c) => c.id)),
    editingNoteId: null,
  };
}

const findChapter = (id) => state.chapters.find((c) => c.id === Number(id));

/**
 * Moves the "resume where I left off" bookmark. Fire-and-forget: a failed
 * write is not worth interrupting the user over, and the next navigation
 * will try again.
 */
function recordLastViewed(chapterId = null) {
  api.setLastViewed(state.courseId, chapterId).catch(() => {});
}

/** Expands a chapter, scrolls it into view and flashes it once. */
function focusChapter(chapterId) {
  const section = document.querySelector(`.chapter[data-chapter="${chapterId}"]`);
  if (!section) return;

  section.classList.add('is-open');
  section.querySelector('.chapter-head')?.setAttribute('aria-expanded', 'true');
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
      <div class="chapter-head-row" style="display:flex;align-items:center">
        <button class="chapter-head" data-action="toggle-chapter"
                aria-expanded="${isOpen}">
          <span class="chapter-caret">▶</span>
          <span class="chapter-title">${escapeHtml(chapter.title)}</span>
          <span class="chapter-count${allDone ? ' is-done' : ''}" data-count>${done}/${total}</span>
        </button>
        <span class="chapter-actions" style="padding-right:10px">
          <button class="btn btn-sm btn-ghost" data-action="rename-chapter" title="Rename chapter">Rename</button>
          <button class="btn btn-sm btn-ghost btn-danger" data-action="delete-chapter" title="Delete chapter">Delete</button>
        </span>
      </div>

      <div class="chapter-body">
        ${
          total === 0
            ? '<p class="muted" style="margin:10px 0">No sub-lessons in this chapter yet.</p>'
            : `<ul class="lesson-list">
                 ${chapter.subLessons.map((l) => lessonTemplate(chapter, l)).join('')}
               </ul>`
        }
        <form class="inline-form" data-action="add-sub-lesson">
          <input type="text" name="title" placeholder="Add a sub-lesson…" autocomplete="off">
          <button class="btn btn-sm" type="submit">Add</button>
        </form>
      </div>
    </section>`;
}

function lessonTemplate(chapter, lesson) {
  const id = `lesson-${lesson.id}`;
  return `
    <li class="lesson${lesson.is_complete ? ' is-complete' : ''}" data-lesson="${lesson.id}">
      <input class="lesson-check" type="checkbox" id="${id}"
             data-action="toggle-lesson"
             data-chapter="${chapter.id}"
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
        <textarea rows="4" data-note-input>${escapeHtml(note.content)}</textarea>
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
}

async function refreshProgress() {
  try {
    state.progress = await api.getProgress(state.courseId);
    renderProgress();
  } catch (err) {
    toast(err.message, { error: true });
  }
}

function updateChapterCount(chapterId) {
  const chapter = findChapter(chapterId);
  const el = document.querySelector(`[data-chapter="${chapter.id}"] [data-count]`);
  if (!el) return;
  const done = chapter.subLessons.filter((l) => l.is_complete).length;
  el.textContent = `${done}/${chapter.subLessons.length}`;
  el.classList.toggle('is-done', chapter.subLessons.length > 0 && done === chapter.subLessons.length);
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
    row.classList.toggle('is-complete', updated.is_complete);
    updateChapterCount(chapterId);
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
  if (!window.confirm(warning)) return;

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
  if (!window.confirm(`Delete "${lesson.title}"?`)) return;

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
  if (!window.confirm('Delete this note?')) return;
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
    reload();
  } catch (err) {
    toast(err.message, { error: true });
  }
}

async function deleteCourse() {
  if (!window.confirm(`Delete "${state.course.name}" and everything in it?`)) return;
  try {
    await api.deleteCourse(state.courseId);
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
  });

  view.addEventListener('submit', (event) => {
    const form = event.target;
    event.preventDefault();
    if (form.dataset.action === 'add-chapter') addChapter(form);
    if (form.dataset.action === 'add-sub-lesson') {
      addSubLesson(form, Number(form.closest('[data-chapter]').dataset.chapter));
    }
  });

  view.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    const el = event.target;

    // Enter submits the quick-add inputs without reaching for the button.
    if (el.tagName === 'INPUT' && el.type === 'text') {
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

    switch (trigger.dataset.action) {
      case 'toggle-chapter': {
        const section = trigger.closest('.chapter');
        const nowOpen = !section.classList.contains('is-open');
        section.classList.toggle('is-open', nowOpen);
        trigger.setAttribute('aria-expanded', String(nowOpen));
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
      case 'edit-course': editCourse(reload); break;
      case 'delete-course': deleteCourse(); break;
      default: break;
    }
  });
}

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

      <div class="section">
        <div class="section-head"><h2>Chapters</h2></div>
        <div id="chapters"></div>
        <form class="inline-form" data-action="add-chapter" style="margin-top:14px">
          <input type="text" name="title" placeholder="Add a chapter…" autocomplete="off">
          <button class="btn" type="submit">Add chapter</button>
        </form>
      </div>

      <div class="section">
        <div class="section-head"><h2>Notes &amp; resources</h2></div>
        <div style="margin-bottom:16px">
          <textarea id="new-note" rows="3"
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
  renderNotes();
  attachHandlers(root.querySelector('.course-view'), reload);

  // Opening a course detail view is itself a navigation event: bookmark it,
  // keeping the chapter we were sent to (if any).
  const focused = focusChapterId && findChapter(focusChapterId) ? focusChapterId : null;
  if (focused) focusChapter(focused);
  recordLastViewed(focused);
}
