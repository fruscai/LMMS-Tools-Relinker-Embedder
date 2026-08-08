'use strict';
/**
 * scan-cli.js — read-only scan of a folder, ZIP or single project.
 *
 * Usage:
 *   node tools/scan-cli.js <source> <oldPath> [newPath]
 *
 * Never writes to the source. Useful for checking a bundle before running the
 * GUI, and for scripting large jobs.
 */

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');

const engine = require('../src/core/engine');
const { extractZip } = require('../src/core/zip');

const [, , source, oldPath, newPath = '<not set>'] = process.argv;

if (!source || !oldPath) {
  console.error('usage: node tools/scan-cli.js <source> <oldPath> [newPath]');
  process.exit(2);
}

(async () => {
  const stat = await fsp.lstat(source);
  let root = source;
  let temp = null;

  if (stat.isFile() && path.extname(source).toLowerCase() === '.zip') {
    temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'relinker-scan-'));
    process.stdout.write('extracting archive… ');
    const extraction = await extractZip(source, temp);
    console.log(`${extraction.entries} entries, ${extraction.refused.length} refused`);
    if (extraction.refused.length) {
      console.log('refused entries:', extraction.refused.slice(0, 10));
    }
    root = temp;
  }

  const { results, summary } = await engine.scan(root, {
    oldPath,
    newPath,
    matchSeparatorVariants: true,
  });

  console.log('');
  console.log(`folders scanned:            ${summary.foldersScanned}`);
  console.log(`.mmp files found:           ${summary.mmpFound}`);
  console.log(`.mmpz files found:          ${summary.mmpzFound}`);
  console.log(`projects containing path:   ${summary.projectsWithMatches}`);
  console.log(`path occurrences found:     ${summary.totalOccurrences}`);
  console.log(`projects needing no change: ${summary.projectsWithoutMatches}`);

  const variantTotals = {};
  const problems = [];
  for (const r of results) {
    for (const [label, n] of Object.entries(r.byVariant || {})) {
      variantTotals[label] = (variantTotals[label] || 0) + n;
    }
    if (!['WILL MODIFY', 'NO MATCH'].includes(r.status)) problems.push(r);
  }
  console.log(`matched by:                 ${JSON.stringify(variantTotals)}`);

  const affected = results.filter((r) => r.status === 'WILL MODIFY');
  console.log('\naffected projects (first 15):');
  for (const r of affected.slice(0, 15)) {
    console.log(`  [${r.occurrences.toString().padStart(3)}] ${r.file}`);
  }
  if (affected.length > 15) console.log(`  … and ${affected.length - 15} more`);

  if (problems.length) {
    console.log('\nproblem files:');
    for (const p of problems.slice(0, 20)) {
      console.log(`  [${p.status}] ${p.file} — ${p.message || ''}`);
    }
  }

  if (temp) await fsp.rm(temp, { recursive: true, force: true });
})().catch((err) => {
  console.error('scan failed:', err.message);
  process.exit(1);
});
