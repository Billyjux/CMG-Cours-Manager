// Small shared rendering helpers. No framework: templates are strings, and
// everything interpolated goes through escapeHtml.

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Escapes, then turns bare http(s) URLs into links — notes are often resources. */
export function escapeWithLinks(value) {
  return escapeHtml(value).replace(
    /https?:\/\/[^\s<]+/g,
    (url) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`,
  );
}

export function formatDate(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/**
 * Whole days from today to a YYYY-MM-DD day, negative for the past.
 *
 * Both sides are pinned to local midnight so the answer is a calendar-day
 * difference, not an elapsed-time one: a deadline "tomorrow" is 1 whether it is
 * now 09:00 or 23:30. Math.round absorbs the 23- and 25-hour days that DST
 * transitions produce.
 */
export function daysUntil(ymd) {
  const due = new Date(`${ymd}T00:00:00`);
  if (Number.isNaN(due.getTime())) return null;

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((due - today) / 86400000);
}

/**
 * Renders a YYYY-MM-DD day. Parsed at local midnight, not UTC, so the date
 * shown is the date stored.
 */
export function formatDay(ymd) {
  const date = new Date(`${ymd}T00:00:00`);
  if (Number.isNaN(date.getTime())) return ymd;
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

/** "3 days overdue" / "today" / "tomorrow" / "in 5 days". */
export function relativeDayLabel(days) {
  if (days === null) return '';
  if (days < 0) {
    const late = Math.abs(days);
    return `${late} day${late === 1 ? '' : 's'} overdue`;
  }
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  return `in ${days} days`;
}

/**
 * Urgency bucket for a deadline, shared by the course view and the dashboard
 * badges so both agree on what "soon" means.
 */
export function deadlineStatus(ymd, { withinDays = 7 } = {}) {
  const days = daysUntil(ymd);
  if (days === null) return { status: 'later', days: null };
  if (days < 0) return { status: 'overdue', days };
  if (days <= withinDays) return { status: 'upcoming', days };
  return { status: 'later', days };
}

/**
 * SVG completion ring. `percent` is used exactly as the API returned it —
 * already rounded to one decimal, so no further rounding here.
 */
export function progressRing(percent, { size = 56, stroke = 5 } = {}) {
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const clamped = Math.max(0, Math.min(100, Number(percent) || 0));
  const offset = circumference * (1 - clamped / 100);
  const center = size / 2;
  const fontSize = size >= 72 ? 17 : 13;

  return `
    <svg class="ring${clamped === 100 ? ' is-complete' : ''}" width="${size}" height="${size}"
         viewBox="0 0 ${size} ${size}" role="img"
         aria-label="${escapeHtml(percent)} percent complete">
      <circle class="ring-track" cx="${center}" cy="${center}" r="${radius}"
              fill="none" stroke-width="${stroke}"></circle>
      <circle class="ring-value" cx="${center}" cy="${center}" r="${radius}"
              fill="none" stroke-width="${stroke}" stroke-linecap="round"
              stroke-dasharray="${circumference.toFixed(2)}"
              stroke-dashoffset="${offset.toFixed(2)}"
              transform="rotate(-90 ${center} ${center})"></circle>
      <text class="ring-label" x="${center}" y="${center}" font-size="${fontSize}">${escapeHtml(percent)}<tspan class="ring-label-unit" font-size="${fontSize - 4}">%</tspan></text>
    </svg>`;
}

/**
 * Whether the user has asked for less movement. Every animation in this app is
 * decoration layered over a state change that has already been applied, so
 * honouring this only ever means skipping the movement, never the change.
 */
export function prefersReducedMotion() {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

/**
 * Completion as a percentage, rounded to one decimal — the same rounding the
 * server applies to `progress_percent`. A chapter bar computed here and a
 * course bar computed there therefore never disagree about how a number looks.
 */
export function completionPercent(done, total) {
  if (!total) return 0;
  return Math.round((done / total) * 1000) / 10;
}

/**
 * Thin completion bar with the exact percentage beside it. `percent` is
 * printed exactly as handed in — the API has already rounded it, and rounding
 * a second time is how two views start disagreeing.
 */
export function progressBar(percent, { compact = false } = {}) {
  const clamped = Math.max(0, Math.min(100, Number(percent) || 0));

  return `
    <div class="pbar${compact ? ' is-compact' : ''}${clamped === 100 ? ' is-complete' : ''}"
         role="img" aria-label="${escapeHtml(percent)} percent complete">
      <span class="pbar-track"><span class="pbar-fill" style="width:${clamped}%"></span></span>
      <span class="pbar-value">${escapeHtml(percent)}%</span>
    </div>`;
}

/**
 * Repoints an existing bar in place, the way renderProgress() patches the ring.
 * The new width is applied first and the animation is layered on top, so a
 * browser that drops it — or an automated one, where CSS width transitions
 * freeze at their start value — still shows the right number.
 */
export function setProgressBar(el, percent) {
  if (!el) return;

  const clamped = Math.max(0, Math.min(100, Number(percent) || 0));
  const fill = el.querySelector('.pbar-fill');
  const from = fill.style.width;

  fill.style.width = `${clamped}%`;
  el.querySelector('.pbar-value').textContent = `${percent}%`;
  el.classList.toggle('is-complete', clamped === 100);
  el.setAttribute('aria-label', `${percent} percent complete`);

  if (from && from !== `${clamped}%` && fill.animate && !prefersReducedMotion()) {
    fill.animate([{ width: from }, { width: `${clamped}%` }], {
      duration: 300,
      easing: 'cubic-bezier(.4, 0, .2, 1)',
    });
  }
}

export function toast(message, { error = false } = {}) {
  const host = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = `toast${error ? ' is-error' : ''}`;
  el.textContent = message;
  host.appendChild(el);
  setTimeout(() => el.remove(), error ? 5000 : 2600);
}

/**
 * Shared plumbing behind every modal in the app.
 *
 * Builds a <dialog>, shows it modally, and answers the caller exactly once.
 * `wire` attaches the handlers particular to one modal and calls `finish(value)`
 * with whatever that modal decides; `cancelValue` is the answer for every
 * dismissal the modal did not decide itself. Both openFormDialog and
 * openConfirmDialog run through here so the awkward parts below — none of which
 * are obvious, all of which cost a debugging session once — are written, and
 * can be fixed, in exactly one place.
 *
 * Exported so a view with its own one-off modal — the pomodoro's focus-length
 * picker — can reuse the plumbing without restating the awkward parts or
 * putting its widget-specific markup in this shared module.
 */
export function openModal({ html, cancelValue, wire, focus }) {
  return new Promise((resolve) => {
    const dialog = document.createElement('dialog');
    dialog.innerHTML = html;

    let settled = false;

    /**
     * Tears the dialog down and answers the caller exactly once.
     *
     * Every path calls this, rather than resolving only on "close": a <dialog>
     * closed by its own method="dialog" form does not emit a close event in
     * every embedded browser, and when it does not, the promise would never
     * settle and the caller would silently do nothing. Closing here rather than
     * at each call site also means the settled flag is set before anything can
     * re-enter, so the close event this fires can never overwrite the answer.
     */
    function finish(value) {
      if (settled) return;
      settled = true;
      dialog.close();
      dialog.remove();
      resolve(value);
    }

    wire(dialog, finish);

    // Esc. A <dialog> is supposed to handle this itself, firing cancel and then
    // close, but that pair does not arrive in every embedded browser (see
    // HANDOFF) — and an Esc that appears to do nothing is worse than no
    // shortcut at all. stopPropagation keeps it from also reaching the shell,
    // where Esc leaves distraction-free mode.
    dialog.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      finish(cancelValue);
    });
    dialog.addEventListener('close', () => finish(cancelValue));

    document.body.appendChild(dialog);
    dialog.showModal();
    if (focus) dialog.querySelector(focus)?.focus();
  });
}

/** Prompt-style modal built on <dialog>; resolves with the field values or null. */
export function openFormDialog({ title, fields, submitLabel = 'Save' }) {
  const html = `
      <form method="dialog">
        <h2>${escapeHtml(title)}</h2>
        ${fields
          .map(
            (f) => `
          <div class="field">
            <label for="dlg-${f.name}">${escapeHtml(f.label)}</label>
            ${
              f.type === 'textarea'
                ? `<textarea class="input-panel" id="dlg-${f.name}" name="${f.name}" rows="4"
                     placeholder="${escapeHtml(f.placeholder || '')}">${escapeHtml(f.value || '')}</textarea>`
                : `<input type="${f.type === 'date' ? 'date' : 'text'}"
                     id="dlg-${f.name}" name="${f.name}"
                     value="${escapeHtml(f.value || '')}"
                     placeholder="${escapeHtml(f.placeholder || '')}">`
            }
          </div>`,
          )
          .join('')}
        <div class="dialog-actions">
          <button type="button" class="btn" data-cancel>Cancel <kbd class="kbd">Esc</kbd></button>
          <button type="submit" class="btn btn-primary">${escapeHtml(submitLabel)}</button>
        </div>
      </form>`;

  // A dismissed dialog answers with null.
  return openModal({
    html,
    cancelValue: null,
    focus: 'input, textarea',
    wire(dialog, finish) {
      const form = dialog.querySelector('form');

      form.addEventListener('submit', () => {
        finish(Object.fromEntries(new FormData(form).entries()));
      });
      // Enter in a single-line field submits; textareas keep their newlines.
      form.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && event.target.tagName === 'INPUT') {
          event.preventDefault();
          form.requestSubmit();
        }
      });

      dialog.querySelector('[data-cancel]').addEventListener('click', () => finish(null));
    },
  });
}

/**
 * Confirmation modal for destructive actions; resolves true only on Confirm.
 *
 * This is the app's replacement for window.confirm(), which cannot be themed
 * and announces itself as "localhost:3000 says". Every delete goes through it,
 * so the answer is always an explicit boolean: Cancel, Esc, and any dismissal
 * the browser reports some other way all resolve false, never undefined — a
 * caller that guards with `if (!ok) return` can therefore never be talked into
 * deleting by a dialog that failed in an unexpected way.
 *
 * There is deliberately no <form> here. A form would give Enter an implicit
 * submission path to the destructive button; with plain buttons, Enter only
 * ever activates the one that already holds focus.
 */
export function openConfirmDialog({
  title,
  message,
  confirmLabel = 'Delete',
  cancelLabel = 'Cancel',
}) {
  const html = `
      <div class="confirm">
        <h2>${escapeHtml(title)}</h2>
        <p class="confirm-message">${escapeHtml(message)}</p>
        <div class="dialog-actions">
          <button type="button" class="btn" data-cancel>${escapeHtml(cancelLabel)} <kbd class="kbd">Esc</kbd></button>
          <button type="button" class="btn btn-danger-solid" data-confirm>${escapeHtml(confirmLabel)}</button>
        </div>
      </div>`;

  return openModal({
    html,
    cancelValue: false,
    // Cancel takes the focus, not Confirm. This dialog only ever stands in
    // front of a delete, so the button already under the user's finger must
    // not be the one that destroys something.
    focus: '[data-cancel]',
    wire(dialog, finish) {
      dialog.querySelector('[data-confirm]').addEventListener('click', () => finish(true));
      dialog.querySelector('[data-cancel]').addEventListener('click', () => finish(false));
    },
  });
}

/**
 * Duration picker: quick presets plus a custom number of minutes.
 *
 * Resolves `{ action: 'choose', minutes }` when a length is picked,
 * `{ action: 'secondary' }` when the optional second action is taken, or null
 * when dismissed. Dismissal is deliberately its own answer rather than being
 * folded into one of the buttons: a timer already holding elapsed time must be
 * able to be left alone, and the caller is the only thing that knows whether
 * "no answer" means "do nothing" or "throw the session away".
 *
 * A preset is the quick path — one click picks and commits — while the custom
 * field needs its own submit, because a number being typed is not a decision
 * until the user says it is.
 */
export function openDurationDialog({
  title,
  message,
  presets = [15, 25, 45],
  current = 25,
  highlightCurrent = true,
  minMinutes = 1,
  maxMinutes = 24 * 60,
  submitLabel = 'Start',
  secondaryLabel = null,
  cancelLabel = 'Cancel',
}) {
  const presetButtons = presets.map((minutes) => {
    const isCurrent = highlightCurrent && minutes === current;
    return `
          <button type="button" class="duration-preset${isCurrent ? ' is-current' : ''}"
                  data-minutes="${minutes}" aria-pressed="${isCurrent}">
            <span class="duration-preset-value">${minutes}</span>
            <span class="duration-preset-unit">min</span>
          </button>`;
  }).join('');

  const html = `
      <div class="duration-picker">
        <h2>${escapeHtml(title)}</h2>
        <p class="confirm-message">${escapeHtml(message)}</p>
        <div class="duration-presets">${presetButtons}</div>
        <!-- novalidate: min/max still shape the stepper and the mobile keypad,
             but the browser's own validation bubble is a native popup this app
             does not use. Rejection is handled below, in the dialog's styling. -->
        <form class="duration-custom" novalidate>
          <label for="duration-minutes">Custom</label>
          <input id="duration-minutes" class="duration-minutes" name="minutes" type="number"
                 inputmode="numeric" min="${minMinutes}" max="${maxMinutes}" step="1"
                 value="${current}">
          <span class="duration-custom-unit">min</span>
          <button type="submit" class="btn btn-primary">${escapeHtml(submitLabel)}</button>
        </form>
        <p class="duration-error" role="alert" hidden></p>
        <div class="dialog-actions">
          <button type="button" class="btn" data-cancel>${escapeHtml(cancelLabel)} <kbd class="kbd">Esc</kbd></button>
          ${secondaryLabel
            ? `<button type="button" class="btn btn-secondary-action" data-secondary>${escapeHtml(secondaryLabel)}</button>`
            : ''}
        </div>
      </div>`;

  return openModal({
    html,
    cancelValue: null,
    focus: '#duration-minutes',
    wire(dialog, finish) {
      const input = dialog.querySelector('#duration-minutes');
      const error = dialog.querySelector('.duration-error');

      // openModal focuses the field; selecting it there means the current value
      // is overwritten by typing rather than appended to.
      input.addEventListener('focus', () => input.select(), { once: true });

      for (const button of dialog.querySelectorAll('[data-minutes]')) {
        button.addEventListener('click', () => {
          finish({ action: 'choose', minutes: Number(button.dataset.minutes) });
        });
      }

      dialog.querySelector('form').addEventListener('submit', (event) => {
        event.preventDefault();
        const minutes = Math.round(Number(input.value));
        // Rejected rather than clamped: silently turning 200 hours into 24 would
        // start a timer the user did not ask for.
        if (!input.value.trim() || !Number.isFinite(minutes)
            || minutes < minMinutes || minutes > maxMinutes) {
          error.textContent =
            `Enter a whole number of minutes between ${minMinutes} and ${maxMinutes}.`;
          error.hidden = false;
          input.focus();
          input.select();
          return;
        }
        finish({ action: 'choose', minutes });
      });

      dialog.querySelector('[data-secondary]')
        ?.addEventListener('click', () => finish({ action: 'secondary' }));
      dialog.querySelector('[data-cancel]').addEventListener('click', () => finish(null));
    },
  });
}

/** Disables a button while an async action runs so double-submits cannot stack. */
export async function withBusy(button, fn) {
  if (!button) return fn();
  const previous = button.disabled;
  button.disabled = true;
  try {
    return await fn();
  } finally {
    button.disabled = previous;
  }
}
