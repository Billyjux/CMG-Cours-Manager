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

export function toast(message, { error = false } = {}) {
  const host = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = `toast${error ? ' is-error' : ''}`;
  el.textContent = message;
  host.appendChild(el);
  setTimeout(() => el.remove(), error ? 5000 : 2600);
}

/** Prompt-style modal built on <dialog>; resolves with the field values or null. */
export function openFormDialog({ title, fields, submitLabel = 'Save' }) {
  return new Promise((resolve) => {
    const dialog = document.createElement('dialog');
    dialog.innerHTML = `
      <form method="dialog">
        <h2>${escapeHtml(title)}</h2>
        ${fields
          .map(
            (f) => `
          <div class="field">
            <label for="dlg-${f.name}">${escapeHtml(f.label)}</label>
            ${
              f.type === 'textarea'
                ? `<textarea id="dlg-${f.name}" name="${f.name}" rows="4"
                     placeholder="${escapeHtml(f.placeholder || '')}">${escapeHtml(f.value || '')}</textarea>`
                : `<input type="text" id="dlg-${f.name}" name="${f.name}"
                     value="${escapeHtml(f.value || '')}"
                     placeholder="${escapeHtml(f.placeholder || '')}">`
            }
          </div>`,
          )
          .join('')}
        <div class="dialog-actions">
          <button type="button" class="btn" data-cancel>Cancel</button>
          <button type="submit" class="btn btn-primary">${escapeHtml(submitLabel)}</button>
        </div>
      </form>`;

    const form = dialog.querySelector('form');
    let result = null;

    form.addEventListener('submit', () => {
      result = Object.fromEntries(new FormData(form).entries());
    });
    // Enter in a single-line field submits; textareas keep their newlines.
    form.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && event.target.tagName === 'INPUT') {
        event.preventDefault();
        form.requestSubmit();
      }
    });

    dialog.querySelector('[data-cancel]').addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => {
      dialog.remove();
      resolve(result);
    });

    document.body.appendChild(dialog);
    dialog.showModal();
    dialog.querySelector('input, textarea')?.focus();
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
