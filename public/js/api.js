// Thin wrapper over the Express API. Every call returns parsed JSON (or null
// for 204) and throws ApiError with the server's message on failure.

const BASE = '/api';

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function request(method, path, body) {
  const options = { method, headers: {} };
  if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }

  let res;
  try {
    res = await fetch(BASE + path, options);
  } catch {
    throw new ApiError('Cannot reach the server. Is it running?', 0);
  }

  if (res.status === 204) return null;

  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      throw new ApiError('Server returned a malformed response', res.status);
    }
  }

  if (!res.ok) {
    throw new ApiError((data && data.error) || `Request failed (${res.status})`, res.status);
  }
  return data;
}

export const api = {
  // courses
  listCourses: () => request('GET', '/courses'),
  getCourse: (id) => request('GET', `/courses/${id}`),
  createCourse: (payload) => request('POST', '/courses', payload),
  updateCourse: (id, payload) => request('PATCH', `/courses/${id}`, payload),
  deleteCourse: (id) => request('DELETE', `/courses/${id}`),
  getProgress: (id) => request('GET', `/courses/${id}/progress`),

  // chapters
  listChapters: (courseId) => request('GET', `/courses/${courseId}/chapters`),
  createChapter: (courseId, payload) => request('POST', `/courses/${courseId}/chapters`, payload),
  updateChapter: (courseId, chapterId, payload) =>
    request('PATCH', `/courses/${courseId}/chapters/${chapterId}`, payload),
  deleteChapter: (courseId, chapterId) =>
    request('DELETE', `/courses/${courseId}/chapters/${chapterId}`),

  // sub-lessons
  listSubLessons: (courseId, chapterId) =>
    request('GET', `/courses/${courseId}/chapters/${chapterId}/sub-lessons`),
  createSubLesson: (courseId, chapterId, payload) =>
    request('POST', `/courses/${courseId}/chapters/${chapterId}/sub-lessons`, payload),
  updateSubLesson: (courseId, chapterId, id, payload) =>
    request('PATCH', `/courses/${courseId}/chapters/${chapterId}/sub-lessons/${id}`, payload),
  deleteSubLesson: (courseId, chapterId, id) =>
    request('DELETE', `/courses/${courseId}/chapters/${chapterId}/sub-lessons/${id}`),

  // Always sends an explicit boolean rather than relying on the server's
  // empty-body flip, so a double click or a retry lands on the same state.
  setSubLessonComplete: (courseId, chapterId, id, isComplete) =>
    request('PATCH', `/courses/${courseId}/chapters/${chapterId}/sub-lessons/${id}/complete`, {
      is_complete: isComplete,
    }),

  // study sessions
  listStudySessions: (courseId) => request('GET', `/courses/${courseId}/study-sessions`),
  createStudySession: (courseId, payload) =>
    request('POST', `/courses/${courseId}/study-sessions`, payload),
  updateStudySession: (courseId, sessionId, payload) =>
    request('PATCH', `/courses/${courseId}/study-sessions/${sessionId}`, payload),
  deleteStudySession: (courseId, sessionId) =>
    request('DELETE', `/courses/${courseId}/study-sessions/${sessionId}`),
  getStudyTime: (courseId) => request('GET', `/courses/${courseId}/study-time`),

  // deadlines
  listDeadlines: (courseId) => request('GET', `/courses/${courseId}/deadlines`),
  createDeadline: (courseId, payload) => request('POST', `/courses/${courseId}/deadlines`, payload),
  updateDeadline: (courseId, deadlineId, payload) =>
    request('PATCH', `/courses/${courseId}/deadlines/${deadlineId}`, payload),
  deleteDeadline: (courseId, deadlineId) =>
    request('DELETE', `/courses/${courseId}/deadlines/${deadlineId}`),

  // reminders (top level; course_id is optional on the server)
  listReminders: (courseId) =>
    request('GET', courseId === undefined ? '/reminders' : `/reminders?course_id=${courseId}`),
  createReminder: (payload) => request('POST', '/reminders', payload),
  updateReminder: (reminderId, payload) => request('PATCH', `/reminders/${reminderId}`, payload),
  deleteReminder: (reminderId) => request('DELETE', `/reminders/${reminderId}`),

  // read-only aggregation for the dashboard overview
  getDashboardSummary: () => request('GET', '/dashboard-summary'),
  getActivitySummary: (days = 365) => request('GET', `/activity-summary?days=${days}`),

  // "resume where I left off" bookmark (a single server-side row)
  getLastViewed: () => request('GET', '/last-viewed'),
  setLastViewed: (courseId, chapterId = null) =>
    request('POST', '/last-viewed', { course_id: courseId, chapter_id: chapterId }),

  // notes
  listNotes: (courseId) => request('GET', `/courses/${courseId}/notes`),
  createNote: (courseId, payload) => request('POST', `/courses/${courseId}/notes`, payload),
  updateNote: (courseId, noteId, payload) =>
    request('PATCH', `/courses/${courseId}/notes/${noteId}`, payload),
  deleteNote: (courseId, noteId) => request('DELETE', `/courses/${courseId}/notes/${noteId}`),
};
