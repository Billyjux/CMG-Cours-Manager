// Pomodoro focus timer: a small widget in the corner of the workbar.
//
// Standard cycle — a focus interval, a 5-minute break after each, a longer
// 15-minute one after every fourth. The focus length is chosen when the
// interval is started (a preset or a custom number of minutes) and is then
// fixed for that interval. Finishing a *work* interval logs a study
// session against whichever course is open; nothing else writes anything, so a
// pause, a reset or a break never produces a row.
//
// State lives in localStorage and the countdown is derived from an absolute
// end time rather than a decrementing counter, so a reload picks the session
// back up where it really is rather than where a tick loop last got to.

import { api } from './api.js';
import { toast, openModal } from './ui.js';
import { getActiveCourse } from './shell.js';

const STORAGE_KEY = 'cm:pomodoro';
const MINUTE = 60 * 1000;
const TICK_MS = 250;

// Break lengths are fixed; only the focus interval is chosen by the user.
const PHASES = {
  work: { label: 'Focus' },
  short: { label: 'Short break', minutes: 5 },
  long: { label: 'Long break', minutes: 15 },
};
const WORK_PER_LONG_BREAK = 4;

const PRESET_MINUTES = [15, 25, 45];
const DEFAULT_WORK_MINUTES = 25;
// The upper bound is not a taste judgement: a finished interval is logged as
// hours, and study_session.hours is CHECK (> 0 AND <= 24). 1440 minutes is that
// ceiling exactly, so nothing the picker accepts can be rejected by the API.
const MIN_WORK_MINUTES = 1;
const MAX_WORK_MINUTES = 24 * 60;

/** Whole minutes inside the allowed range, or the default for anything else. */
function workMinutesOf(value) {
  const minutes = Math.round(Number(value));
  return Number.isFinite(minutes) && minutes >= MIN_WORK_MINUTES && minutes <= MAX_WORK_MINUTES
    ? minutes
    : DEFAULT_WORK_MINUTES;
}

/** Minutes as hours, rounded the way the API rounds it: 25 -> 0.42, 45 -> 0.75. */
const hoursFor = (minutes) => Math.round((minutes / 60) * 100) / 100;

/**
 * The length of one interval. `workMinutes` is passed explicitly by load(),
 * which has to measure a stored interval before `state` has been rebuilt.
 */
const duration = (phase, workMinutes = state.workMinutes) =>
  (phase === 'work' ? workMinutes : PHASES[phase].minutes) * MINUTE;

/**
 * `endsAt` is the single source of truth while running and null while paused,
 * where `remaining` takes over. `done` counts completed work intervals and is
 * what decides when a long break is due. `workMinutes` is the chosen focus
 * length; it outlives a single interval, so the picker can offer it back as the
 * default next time, and it is persisted so a reload does not silently resume a
 * 45-minute session as a 25-minute one.
 */
let state = {
  phase: 'work',
  done: 0,
  endsAt: null,
  workMinutes: DEFAULT_WORK_MINUTES,
  remaining: DEFAULT_WORK_MINUTES * MINUTE,
};
let ticker = null;
let host = null;

/* -------------------------------------------------------------- persistence */

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Private mode or blocked storage. The timer still runs for this page.
  }
}

/** Restores a stored session, ignoring anything that does not look like one. */
function load() {
  let stored;
  try {
    stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
  } catch {
    stored = null;
  }
  if (!stored || !PHASES[stored.phase]) return;

  // Restored before anything measures an interval: a stored 45-minute session
  // has to be clamped against 45 minutes, not against the default.
  const workMinutes = workMinutesOf(stored.workMinutes);

  state = {
    phase: stored.phase,
    done: Number.isInteger(stored.done) && stored.done >= 0 ? stored.done : 0,
    endsAt: typeof stored.endsAt === 'number' ? stored.endsAt : null,
    workMinutes,
    remaining: typeof stored.remaining === 'number'
      ? Math.max(0, Math.min(stored.remaining, duration(stored.phase, workMinutes)))
      : duration(stored.phase, workMinutes),
  };
}

/* -------------------------------------------------------------------- clock */

const isRunning = () => state.endsAt !== null;
const remainingMs = () => (isRunning() ? Math.max(0, state.endsAt - Date.now()) : state.remaining);

function formatClock(ms) {
  const seconds = Math.ceil(ms / 1000);
  const pad = (value) => String(value).padStart(2, '0');
  return `${pad(Math.floor(seconds / 60))}:${pad(seconds % 60)}`;
}

/** The local calendar day of an instant — the day the session was actually worked. */
function localDayOf(epochMs) {
  const date = new Date(epochMs);
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/* ------------------------------------------------------------------ actions */

function start() {
  if (isRunning() || remainingMs() <= 0) return;
  state.endsAt = Date.now() + state.remaining;
  save();
  render();
}

function pause() {
  if (!isRunning()) return;
  // A work interval abandoned part-way logs nothing: the deal is a whole
  // pomodoro or none of it.
  state.remaining = remainingMs();
  state.endsAt = null;
  save();
  render();
}

/** Puts the current interval back to full length, stopped. The cycle count stays. */
function reset() {
  state.endsAt = null;
  state.remaining = duration(state.phase);
  save();
  render();
}

/* -------------------------------------------------------- duration picking */

/**
 * True while the focus length may still be chosen: a work interval that is
 * stopped and has not been counted down at all.
 *
 * Once the clock has moved the length is fixed for that interval — a paused
 * session resumes at the length it started with. Changing it half way would
 * mean logging an hour count the session never actually ran for, so the way to
 * a different length is Reset (or letting the interval finish) and starting
 * again. Breaks are never chosen: only the focus interval is configurable.
 */
const canChooseDuration = () =>
  state.phase === 'work' && !isRunning() && state.remaining >= duration('work');

/** Applies a chosen length, resizing the pending interval to match. */
function setWorkMinutes(minutes) {
  state.workMinutes = workMinutesOf(minutes);
  if (state.phase === 'work' && !isRunning()) state.remaining = duration('work');
  save();
  render();
}

/**
 * The focus-length picker. Resolves the chosen minutes, or null if dismissed.
 *
 * Built on the shared openModal so Esc, the settle-once guard and the teardown
 * behave exactly like every other dialog in the app; only the markup is local
 * to this widget. A preset is the quick path — one click both picks and starts —
 * while the custom field needs its own submit, because a number being typed is
 * not a decision until the user says it is.
 */
function openDurationDialog(currentMinutes) {
  const presets = PRESET_MINUTES.map((minutes) => `
          <button type="button" class="pomo-preset${minutes === currentMinutes ? ' is-current' : ''}"
                  data-minutes="${minutes}" aria-pressed="${minutes === currentMinutes}">
            <span class="pomo-preset-value">${minutes}</span>
            <span class="pomo-preset-unit">min</span>
          </button>`).join('');

  const html = `
      <div class="pomo-picker">
        <h2>Focus session length</h2>
        <p class="confirm-message">
          How long should this focus interval run? Breaks are unchanged, and the
          length is fixed once the clock starts — reset to pick a different one.
        </p>
        <div class="pomo-presets">${presets}</div>
        <!-- novalidate: min/max still shape the stepper and the mobile keypad, but
             the browser's own validation bubble is a native popup this app does
             not use. Rejection is handled below, in the dialog's own styling. -->
        <form class="pomo-custom" novalidate>
          <label for="pomo-minutes">Custom</label>
          <input id="pomo-minutes" class="pomo-minutes" name="minutes" type="number"
                 inputmode="numeric" min="${MIN_WORK_MINUTES}" max="${MAX_WORK_MINUTES}"
                 step="1" value="${currentMinutes}">
          <span class="pomo-custom-unit">min</span>
          <button type="submit" class="btn btn-primary">Start</button>
        </form>
        <p class="pomo-error" role="alert" hidden></p>
        <div class="dialog-actions">
          <button type="button" class="btn" data-cancel>Cancel <kbd class="kbd">Esc</kbd></button>
        </div>
      </div>`;

  return openModal({
    html,
    cancelValue: null,
    focus: '#pomo-minutes',
    wire(dialog, finish) {
      const input = dialog.querySelector('#pomo-minutes');
      const error = dialog.querySelector('.pomo-error');

      // openModal focuses the field; selecting it there means the current value
      // is overwritten by typing rather than appended to.
      input.addEventListener('focus', () => input.select(), { once: true });

      for (const button of dialog.querySelectorAll('[data-minutes]')) {
        button.addEventListener('click', () => finish(Number(button.dataset.minutes)));
      }

      dialog.querySelector('form').addEventListener('submit', (event) => {
        event.preventDefault();
        const minutes = Math.round(Number(input.value));
        // Rejected rather than clamped: silently turning 200 hours into 24 would
        // start a timer the user did not ask for.
        if (!input.value.trim() || !Number.isFinite(minutes)
            || minutes < MIN_WORK_MINUTES || minutes > MAX_WORK_MINUTES) {
          error.textContent =
            `Enter a whole number of minutes between ${MIN_WORK_MINUTES} and ${MAX_WORK_MINUTES}.`;
          error.hidden = false;
          input.focus();
          input.select();
          return;
        }
        finish(minutes);
      });

      dialog.querySelector('[data-cancel]').addEventListener('click', () => finish(null));
    },
  });
}

/**
 * What the Start button does. A focus interval that has not begun yet gets its
 * length chosen first; resuming a paused interval, and every break, just runs.
 */
async function requestStart() {
  if (isRunning()) return;
  if (!canChooseDuration()) {
    start();
    return;
  }

  const minutes = await openDurationDialog(state.workMinutes);
  if (minutes === null) return;

  setWorkMinutes(minutes);
  start();
}

/**
 * Logs a finished work interval against the open course.
 *
 * `date` comes from when the interval ended, not from now, so a session that
 * completed just before midnight — or while the app was closed — lands on the
 * day it was worked. `hours` is passed in rather than read from state for the
 * same reason: by the time this runs the widget has already moved on to the
 * break, and a length chosen for the *next* focus interval must not be able to
 * rewrite what the one just finished is logged as.
 */
async function logSession(finishedAt, hours) {
  const course = getActiveCourse();
  if (!course) {
    toast('Focus session done. Open a course first to log time to it.');
    return;
  }

  try {
    await api.createStudySession(course.id, {
      date: localDayOf(finishedAt),
      hours,
      note: 'Pomodoro',
      is_live_tracked: true,
    });
    toast(`Logged ${hours} h to ${course.name ?? 'this course'}`);
    // The course view listens for this and refetches its study list. The
    // dashboard's grid needs no such wiring: a session can only be logged with
    // a course open, and the overview refetches everything on its way back in.
    document.dispatchEvent(new CustomEvent('study-logged', {
      detail: { courseId: course.id, hours },
    }));
  } catch (err) {
    toast(`Could not log the session: ${err.message}`, { error: true });
  }
}

/** The phase that follows the one just finished. */
function nextPhase() {
  if (state.phase !== 'work') return 'work';
  return state.done % WORK_PER_LONG_BREAK === 0 ? 'long' : 'short';
}

/**
 * Called the moment the countdown reaches zero — from the tick loop, or on
 * load for an interval that ran out while the page was closed.
 *
 * The next interval is left *stopped*. Rolling straight into another work
 * interval would keep logging study time to a machine nobody is sitting at.
 */
function complete(finishedAt) {
  const wasWork = state.phase === 'work';
  // Read while the finished interval is still the current one.
  const workedHours = hoursFor(state.workMinutes);
  if (wasWork) state.done += 1;

  const following = nextPhase();
  state.phase = following;
  state.endsAt = null;
  state.remaining = duration(following);
  save();
  render();

  if (wasWork) {
    logSession(finishedAt, workedHours);
  } else {
    toast('Break over — back to it.');
  }
}

function tick() {
  if (!isRunning()) return;
  if (remainingMs() <= 0) {
    complete(state.endsAt);
    return;
  }
  paintClock();
}

/* ----------------------------------------------------------------- rendering */

/**
 * The only thing a tick changes is the digits, so a tick patches them rather
 * than rebuilding the widget four times a second — which would tear the
 * buttons out from under anyone who had tabbed to one.
 */
function paintClock() {
  const time = host?.querySelector('.pomo-time');
  if (time) time.textContent = formatClock(remainingMs());
}

function render() {
  if (!host) return;

  const phase = PHASES[state.phase];
  const running = isRunning();
  const ms = remainingMs();
  const isWork = state.phase === 'work';
  // Which pomodoro of the current set of four this is.
  const inSet = (state.done % WORK_PER_LONG_BREAK) + (isWork ? 1 : 0);
  const noCourse = isWork && getActiveCourse() === null;
  // The button says which it is, so choosing a length is never a surprise.
  const phaseNoun = isWork ? 'focus session' : phase.label.toLowerCase();
  const playLabel = running
    ? `Pause the ${phaseNoun}`
    : canChooseDuration()
      ? 'Start a focus session — choose a length'
      : `Resume the ${phaseNoun}`;

  host.className = `pomo is-${state.phase}${running ? ' is-running' : ''}`;
  host.innerHTML = `
    <button class="pomo-btn pomo-play" type="button" data-action="${running ? 'pause' : 'start'}"
            title="${playLabel}" aria-label="${playLabel}">
      <span class="pomo-icon" aria-hidden="true"></span>
    </button>
    <span class="pomo-readout">
      <span class="pomo-time">${formatClock(ms)}</span>
      <span class="pomo-phase">${phase.label}${
        isWork ? ` · ${Math.min(inSet, WORK_PER_LONG_BREAK)}/${WORK_PER_LONG_BREAK}` : ''
      }</span>
    </span>
    <button class="pomo-btn pomo-reset" type="button" data-action="reset"
            title="Reset this interval" aria-label="Reset this interval">↺</button>
    ${noCourse ? '<span class="pomo-hint">Open a course to log time</span>' : ''}`;
}

/* ------------------------------------------------------------------- wiring */

export function initPomodoro() {
  host = document.getElementById('pomodoro');
  if (!host) return;

  load();

  // An interval that ran out while the tab was closed still ran out. It is
  // settled now, dated to when it actually finished, rather than silently
  // rewound or credited to today.
  if (isRunning() && remainingMs() <= 0) {
    complete(state.endsAt);
  } else {
    render();
  }

  host.addEventListener('click', (event) => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action === 'start') requestStart();
    if (action === 'pause') pause();
    if (action === 'reset') reset();
  });

  // The hint and the logging target both depend on which course is open.
  window.addEventListener('hashchange', () => render());

  ticker = setInterval(tick, TICK_MS);

  // Testing handle. A full focus interval is not something to sit through to
  // check that a session gets logged, and there is no build step here to strip
  // a dev-only export, so it is a plain window property with a plain name.
  window.pomodoro = {
    presets: () => [...PRESET_MINUTES],
    /**
     * Sets the focus length without opening the picker. Refused while the clock
     * is running, exactly as the picker is — the rule is the behaviour, not the
     * dialog, so a test cannot reach a state a user could not.
     */
    setDuration(minutes) {
      if (!isRunning()) setWorkMinutes(minutes);
      return this.state();
    },
    state: () => ({ ...state, running: isRunning(), remainingMs: remainingMs() }),
    /** Fast-forwards the running interval to `seconds` from now. */
    skipTo(seconds = 0) {
      if (!isRunning()) start();
      state.endsAt = Date.now() + seconds * 1000;
      save();
      tick();
      return this.state();
    },
    /** The raw start — no picker. Use setDuration() first to choose a length. */
    start,
    pause,
    reset,
    /**
     * Clears the stored session entirely, back to a fresh first pomodoro at the
     * default length — a known baseline, so a test never inherits a duration a
     * previous one chose.
     */
    clear() {
      state = {
        phase: 'work',
        done: 0,
        endsAt: null,
        workMinutes: DEFAULT_WORK_MINUTES,
        remaining: DEFAULT_WORK_MINUTES * MINUTE,
      };
      save();
      render();
      return this.state();
    },
  };

  return () => clearInterval(ticker);
}
