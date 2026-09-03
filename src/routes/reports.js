// Downloadable reports. Read-only, and the only route in the app that answers
// with something other than JSON.

const express = require('express');
const { wrap } = require('../util/validate');
const { buildWeeklyReport } = require('../reports/weeklyReport');
const { renderWeeklyReportPdf } = require('../reports/weeklyReportPdf');

const router = express.Router();

router.get('/weekly', wrap((req, res) => {
  // Built before a single byte is written. Once the PDF starts streaming the
  // status line is already sent, and a failure would arrive as a corrupt file
  // rather than as the JSON error the rest of the API promises; doing the work
  // that can throw up front keeps that promise.
  const report = buildWeeklyReport();

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="weekly-study-report-${report.generated_on}.pdf"`,
  );
  // A report is a snapshot of a moving total; a cached copy is a wrong one.
  res.setHeader('Cache-Control', 'no-store');

  renderWeeklyReportPdf(report, res);
}));

module.exports = router;
