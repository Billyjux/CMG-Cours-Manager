const path = require('path');
const express = require('express');
const { notFoundHandler, errorHandler } = require('./middleware/errors');
const coursesRouter = require('./routes/courses');
const lastViewedRouter = require('./routes/lastViewed');

const app = express();

app.use(express.json({ limit: '1mb' }));

// Serves the vanilla-JS frontend from public/ on the same origin as the API,
// so the browser needs no CORS handling. "no-cache" means "revalidate before
// reusing", not "do not store": edits to the JS show up on a plain refresh
// instead of being masked by Chrome's ES-module cache.
app.use(
  express.static(path.join(__dirname, '..', 'public'), {
    setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
  }),
);

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.use('/api/courses', coursesRouter);
app.use('/api/last-viewed', lastViewedRouter);

app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
