class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    if (details) this.details = details;
  }
}

const badRequest = (msg, details) => new HttpError(400, msg, details);
const notFound = (msg) => new HttpError(404, msg);

function notFoundHandler(req, res) {
  res.status(404).json({ error: `No route for ${req.method} ${req.originalUrl}` });
}

// eslint-disable-next-line no-unused-vars -- Express needs the 4-arg signature
function errorHandler(err, req, res, next) {
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({ error: 'Request body is not valid JSON' });
  }

  const status = err.status || 500;
  if (status >= 500) console.error(err);

  const body = { error: status >= 500 ? 'Internal server error' : err.message };
  if (err.details) body.details = err.details;
  res.status(status).json(body);
}

module.exports = { HttpError, badRequest, notFound, notFoundHandler, errorHandler };
