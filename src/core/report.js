'use strict';
/**
 * report.js — machine-readable JSON and human-readable text/CSV logs.
 *
 * Reports describe project files and paths only. Audio file contents are never
 * read by this application, so they can never appear in a log.
 */

const fsp = require('fs').promises;
const path = require('path');

const APP_VERSION = require('../../package.json').version;

/**
 * @param {{sourcePath: string, outputPath: string, settings: object, records: Array, summary: object}} input
 */
function buildReport(input) {
  return {
    application: 'LMMS Path Relinker',
    version: APP_VERSION,
    timestamp: new Date().toISOString(),
    sourcePath: input.sourcePath,
    outputPath: input.outputPath,
    settings: {
      oldPath: input.settings.oldPath,
      newPath: input.settings.newPath,
      matchSeparatorVariants: input.settings.matchSeparatorVariants !== false,
    },
    summary: input.summary,
    files: input.records.map((r) => ({
      filename: r.filename,
      format: r.format,
      oldPath: r.oldPath,
      newPath: r.newPath,
      occurrences: r.occurrences,
      decompression: r.decompression,
      recompression: r.recompression,
      roundTrip: r.roundTrip,
      result: r.result,
      outputPath: r.outputPath,
      sha256Xml: r.sha256Xml,
      message: r.message,
    })),
  };
}

function toCsv(report) {
  const header = [
    'filename',
    'format',
    'occurrences',
    'old_path',
    'new_path',
    'decompression',
    'recompression',
    'round_trip',
    'result',
    'message',
  ];

  const escape = (value) => {
    const s = value === undefined || value === null ? '' : String(value);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  const lines = [header.join(',')];
  for (const f of report.files) {
    lines.push(
      [
        f.filename,
        f.format,
        f.occurrences,
        f.oldPath,
        f.newPath,
        f.decompression,
        f.recompression,
        f.roundTrip,
        f.result,
        f.message,
      ]
        .map(escape)
        .join(',')
    );
  }
  return lines.join('\n') + '\n';
}

function toText(report) {
  const s = report.summary;
  const lines = [
    'LMMS Path Relinker — repair report',
    `Version:   ${report.version}`,
    `Timestamp: ${report.timestamp}`,
    `Source:    ${report.sourcePath}`,
    `Output:    ${report.outputPath}`,
    '',
    `Old path:  ${report.settings.oldPath}`,
    `New path:  ${report.settings.newPath}`,
    `Separator-variant matching: ${report.settings.matchSeparatorVariants ? 'on' : 'off'}`,
    '',
    '--- Summary ---',
    `Projects processed:   ${s.projectsProcessed ?? '-'}`,
    `Projects modified:    ${s.projectsModified ?? '-'}`,
    `Path replacements:    ${s.replacements ?? '-'}`,
    `Projects skipped:     ${s.projectsSkipped ?? '-'}`,
    `Validation failures:  ${s.validationFailures ?? '-'}`,
    '',
    '--- Files ---',
  ];

  for (const f of report.files) {
    const detail = f.message ? `  (${f.message})` : '';
    lines.push(
      `[${f.result}] ${f.filename} (${f.format}) — ${f.occurrences} occurrence(s)${detail}`
    );
  }

  return lines.join('\n') + '\n';
}

/**
 * Write all three report formats next to the output.
 * @returns {Promise<{json: string, csv: string, txt: string}>}
 */
async function writeReports(report, destinationDir) {
  await fsp.mkdir(destinationDir, { recursive: true });
  const stamp = report.timestamp.replace(/[:.]/g, '-');
  const base = `relink-report-${stamp}`;

  const jsonPath = path.join(destinationDir, `${base}.json`);
  const csvPath = path.join(destinationDir, `${base}.csv`);
  const txtPath = path.join(destinationDir, `${base}.txt`);

  await fsp.writeFile(jsonPath, JSON.stringify(report, null, 2), 'utf8');
  await fsp.writeFile(csvPath, toCsv(report), 'utf8');
  await fsp.writeFile(txtPath, toText(report), 'utf8');

  return { json: jsonPath, csv: csvPath, txt: txtPath };
}

module.exports = { buildReport, toCsv, toText, writeReports, APP_VERSION };
