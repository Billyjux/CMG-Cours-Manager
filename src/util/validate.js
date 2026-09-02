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

module.exports = {
  wrap,
  requireBody,
  readString,
  readOptionalText,
  readInteger,
  readBoolean,
  readId,
  now,
};
