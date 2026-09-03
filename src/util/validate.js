const { badRequest } = require('../middleware/errors');

/** Wraps a sync route handler so thrown errors reach the Express error handler. */
const wrap = (fn) => (req, res, next) => {
  try {
    fn(req, res, next);
  } catch (err) {
    next(err);
  }
};

function requireBody(req) {
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
    throw badRequest('Request body must be a JSON object');
  }
  return req.body;
}

/** Non-empty trimmed string. `required` distinguishes POST from PATCH. */
function readString(body, field, { required, maxLength = 500 } = {}) {
  const raw = body[field];
  if (raw === undefined) {
    if (required) throw badRequest(`"${field}" is required`);
    return undefined;
  }
  if (typeof raw !== 'string') throw badRequest(`"${field}" must be a string`);
  const value = raw.trim();
  if (!value) throw badRequest(`"${field}" must not be empty`);
  if (value.length > maxLength) {
    throw badRequest(`"${field}" must be at most ${maxLength} characters`);
  }
  return value;
}

/** String that may be explicitly cleared by sending null. */
function readOptionalText(body, field, { maxLength = 20000 } = {}) {
  const raw = body[field];
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (typeof raw !== 'string') throw badRequest(`"${field}" must be a string or null`);
  if (raw.length > maxLength) {
    throw badRequest(`"${field}" must be at most ${maxLength} characters`);
  }
  return raw;
}

function readInteger(body, field) {
  const raw = body[field];
  if (raw === undefined) return undefined;
  if (!Number.isInteger(raw)) throw badRequest(`"${field}" must be an integer`);
  return raw;
}

/** A finite decimal within (min, max]. Rounded to `decimals` so 1.5 stays 1.5. */
function readNumber(body, field, { required, min = 0, max, decimals = 2 } = {}) {
  const raw = body[field];
  if (raw === undefined || raw === null) {
    if (required) throw badRequest(`"${field}" is required`);
    return undefined;
  }
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    throw badRequest(`"${field}" must be a number`);
  }
  if (raw <= min) throw badRequest(`"${field}" must be greater than ${min}`);
  if (max !== undefined && raw > max) throw badRequest(`"${field}" must be at most ${max}`);

  const factor = 10 ** decimals;
  return Math.round(raw * factor) / factor;
}

/**
 * A calendar day as YYYY-MM-DD. Round-tripping through Date catches values that
 * match the shape but are not real days, such as 2026-02-31.
 */
function readDate(body, field, { required } = {}) {
  const raw = body[field];
  if (raw === undefined || raw === null) {
    if (required) throw badRequest(`"${field}" is required`);
    return undefined;
  }
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw badRequest(`"${field}" must be a date in YYYY-MM-DD format`);
  }
  const parsed = new Date(`${raw}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== raw) {
    throw badRequest(`"${field}" is not a real calendar date`);
  }
  return raw;
}

function readBoolean(body, field) {
  const raw = body[field];
  if (raw === undefined) return undefined;
  if (typeof raw !== 'boolean') throw badRequest(`"${field}" must be a boolean`);
  return raw;
}

/** Route params arrive as strings; reject anything that is not a positive int id. */
function readId(value, name) {
  if (!/^\d+$/.test(String(value))) throw badRequest(`"${name}" must be a positive integer`);
  const id = Number(value);
  if (id < 1) throw badRequest(`"${name}" must be a positive integer`);
  return id;
}

const now = () => new Date().toISOString();

/**
 * A calendar day as YYYY-MM-DD in the machine's own timezone, optionally
 * shifted by whole days. Local rather than UTC on purpose: every date this app
 * stores is a day the user lived through, and toISOString() names the wrong one
 * for anybody west of Greenwich from mid-afternoon onwards.
 */
function localDay(offsetDays = 0) {
  const date = new Date();
  if (offsetDays) date.setDate(date.getDate() + offsetDays);
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

module.exports = {
  wrap,
  requireBody,
  readString,
  readOptionalText,
  readInteger,
  readNumber,
  readDate,
  readBoolean,
  readId,
  now,
  localDay,
};
