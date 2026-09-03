// Renders a weekly report (see weeklyReport.js) as a PDF.
//
// This module does no arithmetic. Every number it prints arrives already
// computed and rounded, so there is exactly one place a figure can be wrong and
// it is the one covered by tests.
//
// Only the 14 standard PDF fonts are used, so nothing is embedded and the file
// stays small. That fixes the text to WinAnsi (Latin-1), which covers the
// accented Latin a course name is likely to carry; a name in a non-Latin script
// would need a real font embedded and is not handled here.

const PDFDocument = require('pdfkit');

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const INK = '#1a1a1a';
const MUTED = '#6b7280';
const RULE = '#d8dae0';
const ACCENT = '#4f46e5';

/** "2026-09-03" -> "3 September 2026". Spelled out rather than locale-formatted
 *  so the output does not shift with the server's locale (and with it, tests). */
function formatDay(ymd) {
  const [year, month, day] = ymd.split('-').map(Number);
  return `${day} ${MONTHS[month - 1]} ${year}`;
}

/** "in 3 days" / "today" / "2 days overdue" — the same phrasing the app uses. */
function relativeDay(days) {
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days > 1) return `in ${days} days`;
  if (days === -1) return '1 day overdue';
  return `${Math.abs(days)} days overdue`;
}

const hours = (value) => `${value} h`;

/**
 * Makes a string safe for the standard PDF fonts.
 *
 * The 14 built-in fonts are WinAnsi (Latin-1) and pdfkit discards anything
 * outside that range *without raising* — a course named in Greek or Japanese
 * would come out as a blank line, leaving a report that looks fine and says
 * nothing. A visible marker is the lesser evil; embedding a Unicode font is the
 * real fix if that day comes.
 */
const safe = (value) => String(value).replace(/[^\x00-\xFF]/g, '?');

function drawRule(doc, y, { color = RULE, width = 0.5 } = {}) {
  doc.save()
    .moveTo(doc.page.margins.left, y)
    .lineTo(doc.page.width - doc.page.margins.right, y)
    .lineWidth(width)
    .strokeColor(color)
    .stroke()
    .restore();
}

/** One label/value line of a course's table. */
function drawStatRow(doc, label, value, { valueColor = INK } = {}) {
  const left = doc.page.margins.left;
  const contentWidth = doc.page.width - left - doc.page.margins.right;
  const labelWidth = 190;
  const y = doc.y;

  doc.font('Helvetica').fontSize(10).fillColor(MUTED)
    .text(label, left + 10, y, { width: labelWidth });
  doc.font('Helvetica-Bold').fontSize(10).fillColor(valueColor)
    .text(value, left + 10 + labelWidth, y, { width: contentWidth - labelWidth - 20 });

  // Both columns were drawn at the same y; carry on below the taller of them.
  doc.y = y + 15;
}

function drawHeader(doc, report) {
  const left = doc.page.margins.left;

  doc.font('Helvetica-Bold').fontSize(20).fillColor(INK)
    .text('Weekly Study Report', left, doc.y);
  doc.moveDown(0.25);
  doc.font('Helvetica').fontSize(10).fillColor(MUTED)
    .text(
      `Generated ${formatDay(report.generated_on)}  ·  `
      + `covering ${formatDay(report.week.from)} to ${formatDay(report.week.to)}`,
      left,
      doc.y,
    );

  doc.moveDown(0.6);
  drawRule(doc, doc.y, { color: ACCENT, width: 1.5 });
  doc.y += 16;
}

function drawSummary(doc, report) {
  const left = doc.page.margins.left;

  doc.font('Helvetica-Bold').fontSize(11).fillColor(INK).text('Summary', left, doc.y);
  doc.y += 6;

  drawStatRow(doc, 'Total studied this week', hours(report.totals.hours_this_week));
  drawStatRow(
    doc,
    'Study sessions logged',
    String(report.totals.session_count),
  );
  drawStatRow(
    doc,
    'Needs the most attention',
    report.needs_attention
      ? `${safe(report.needs_attention.name)}  (${report.needs_attention.progress_percent}% complete, `
        + `${report.needs_attention.remaining_sub_lessons} left)`
      // Not a failure: it just means nothing has sub-lessons to be behind on.
      : 'Nothing to flag yet',
  );

  doc.y += 6;
  drawRule(doc, doc.y);
  doc.y += 16;
}

/** Roughly how tall a course block will be, so it is not split across a page. */
function estimateCourseHeight(course) {
  const deadlineLines = course.deadlines.length || 1;
  return 22 + (3 * 15) + 18 + (deadlineLines * 14) + 18;
}

function drawCourse(doc, course, report) {
  const left = doc.page.margins.left;
  const bottom = doc.page.height - doc.page.margins.bottom;

  // Keep a course whole. A block split mid-table is the one thing that makes a
  // short report look broken.
  if (doc.y + estimateCourseHeight(course) > bottom) doc.addPage();

  doc.font('Helvetica-Bold').fontSize(13).fillColor(INK).text(safe(course.name), left, doc.y);
  doc.y += 4;
  drawRule(doc, doc.y);
  doc.y += 8;

  drawStatRow(
    doc,
    'Completion',
    `${course.progress_percent}%   `
    + `(${course.completed_sub_lessons} of ${course.total_sub_lessons} sub-lessons done)`,
  );
  drawStatRow(doc, 'Sub-lessons remaining', String(course.remaining_sub_lessons));
  drawStatRow(doc, 'Studied this week', hours(course.hours_this_week));

  doc.y += 4;
  doc.font('Helvetica').fontSize(9.5).fillColor(MUTED)
    .text(`Deadlines in the next ${report.deadline_window.days} days`, left + 10, doc.y);
  doc.y += 13;

  if (!course.deadlines.length) {
    doc.font('Helvetica').fontSize(10).fillColor(MUTED)
      .text('None', left + 20, doc.y);
    doc.y += 14;
  } else {
    for (const deadline of course.deadlines) {
      const when = `${formatDay(deadline.due_date)}  -  ${relativeDay(deadline.days_until)}`;
      // Drawn rather than typed: U+2022 is outside Latin-1, so the standard
      // fonts drop it and leave a stray indent where the bullet should be.
      doc.save().circle(left + 23, doc.y + 5, 1.6).fillColor(MUTED).fill().restore();
      doc.font('Helvetica').fontSize(10).fillColor(INK)
        .text(safe(deadline.title), left + 30, doc.y, { width: 230, ellipsis: true });
      doc.font('Helvetica').fontSize(10)
        .fillColor(deadline.is_overdue ? '#b91c1c' : MUTED)
        .text(when, left + 270, doc.y, { width: 205 });
      doc.y += 14;
    }
  }

  doc.y += 14;
}

/**
 * Writes the report into `stream` (the response). Returns the document, already
 * ended — the caller does not need to close anything.
 */
function renderWeeklyReportPdf(report, stream) {
  const doc = new PDFDocument({
    size: 'A4',
    margin: 50,
    info: {
      Title: `Weekly Study Report ${report.generated_on}`,
      Author: 'Course Manager',
      Subject: `Study progress for ${report.week.from} to ${report.week.to}`,
    },
  });

  doc.pipe(stream);

  drawHeader(doc, report);
  drawSummary(doc, report);

  if (!report.courses.length) {
    doc.font('Helvetica').fontSize(11).fillColor(MUTED)
      .text('No courses yet. Add one to start tracking progress.', doc.page.margins.left, doc.y);
  } else {
    for (const course of report.courses) drawCourse(doc, course, report);
  }

  doc.end();
  return doc;
}

module.exports = { renderWeeklyReportPdf, formatDay, relativeDay };
