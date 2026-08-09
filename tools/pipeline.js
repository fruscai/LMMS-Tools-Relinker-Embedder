'use strict';
/**
 * pipeline.js — relink AND bundle in one pass.
 *
 *   node tools/pipeline.js <source> --old <path> --new <path> [options]
 *
 * Source may be a folder, a .zip, or a single project.
 *
 * Runs: relink -> verify -> bundle -> dedupe -> linux-normalise -> validate,
 * and writes ONE output folder named for the stages applied:
 *
 *   <source>_RELINKED_BUNDLED
 *
 * Options:
 *   --strip-empty     drop empty src="" slots so LMMS will bundle those projects
 *   --keep-relinked   also keep the intermediate <source>_RELINKED tree
 *   --no-dedupe       keep LMMS's raw per-reference resource copies
 *   --out <dir>       override the output location
 *   --lmms <path>     non-standard LMMS binary
 *
 * The source is only ever read.
 */

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');

const engine = require('../src/core/engine');
const bundle = require('../src/core/bundle');
const { extractZip } = require('../src/core/zip');
const { outputPathFor } = require('../src/core/naming');
const { buildReport, writeReports } = require('../src/core/report');

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const value = (n) => { const i = argv.indexOf(n); return i === -1 ? null : argv[i + 1]; };
const positional = argv.filter((a, i) =>
  !a.startsWith('--') && !['--old', '--new', '--out', '--lmms'].includes(argv[i - 1]));

const source = positional[0];
const oldPath = value('--old');
const newPath = value('--new');

if (!source || !oldPath || !newPath) {
  console.error('usage: node tools/pipeline.js <source> --old <path> --new <path> [--strip-empty] [--keep-relinked] [--no-dedupe] [--out <dir>] [--lmms <path>]');
  process.exit(2);
}

const DIRS = {
  userSamples: process.env.LMMS_USER_SAMPLES || path.join(os.homedir(), 'Documents/lmms/samples'),
  factory: process.env.LMMS_FACTORY_SAMPLES || '/Applications/LMMS.app/Contents/share/lmms/samples',
  gig: process.env.LMMS_GIG_DIR || path.join(os.homedir(), 'Documents/lmms/samples/gig'),
  soundfont: process.env.LMMS_SF2_DIR || path.join(os.homedir(), 'Documents/lmms/samples/soundfonts'),
};

const mb = (n) => `${(n / 1048576).toFixed(2)} MB`;
const temps = [];
const mkTemp = async (label) => {
  const d = await fsp.mkdtemp(path.join(os.tmpdir(), `pipeline-${label}-`));
  temps.push(d);
  return d;
};

(async () => {
  const lmms = await bundle.detectLmms(value('--lmms'));
  console.log(`LMMS: ${lmms.path || '(not found)'}  ${lmms.version || ''}`);
  if (!lmms.ok) { console.error(`REFUSING: ${lmms.reason}`); process.exit(1); }

  // ---- resolve the source into a directory we can walk ----
  const stat = await fsp.lstat(source);
  const isZip = stat.isFile() && path.extname(source).toLowerCase() === '.zip';
  let inputTree;

  if (isZip) {
    inputTree = await mkTemp('extract');
    process.stdout.write('extracting archive… ');
    const ex = await extractZip(source, inputTree);
    console.log(`${ex.entries} entries, ${ex.refused.length} refused`);
  } else if (stat.isDirectory()) {
    inputTree = path.resolve(source);
  } else {
    // Single project: work in a one-file directory.
    inputTree = await mkTemp('single');
    await fsp.copyFile(source, path.join(inputTree, path.basename(source)));
  }

  const settings = { oldPath, newPath, matchSeparatorVariants: true };

  // ---- STAGE 1: relink ----
  console.log('\n=== relink ===');
  const scan = await engine.scan(inputTree, settings);
  console.log(
    `  ${scan.summary.projectsFound} project(s), ` +
    `${scan.summary.projectsWithMatches} contain the path, ` +
    `${scan.summary.totalOccurrences} reference(s)`
  );

  const keepRelinked = flag('--keep-relinked');
  const relinkedTree = keepRelinked
    ? outputPathFor(source, { relink: true }, { kind: isZip ? 'folder' : 'folder' })
    : await mkTemp('relinked');

  await fsp.mkdir(relinkedTree, { recursive: true });
  await engine.mirrorTree(inputTree, relinkedTree);
  const relink = await engine.repair(inputTree, relinkedTree, settings);
  console.log(
    `  modified ${relink.summary.projectsModified}, ` +
    `${relink.summary.replacements} replacement(s), ` +
    `${relink.summary.validationFailures} failure(s)`
  );
  if (keepRelinked) console.log(`  kept: ${relinkedTree}`);

  // ---- STAGE 2+: bundle from the relinked tree ----
  const outputRoot = value('--out')
    || outputPathFor(source, { relink: true, bundle: true }, { kind: 'folder' });

  console.log('\n=== bundle ===');
  console.log(`  output: ${outputRoot}`);

  const projects = [];
  (async function walk(dir) {
    for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) await walk(full);
      else if (/\.(mmpz|mmp)$/i.test(e.name) && !/\.bak$/i.test(e.name)) projects.push(full);
    }
  });
  const collect = async (dir) => {
    for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) await collect(full);
      else if (/\.(mmpz|mmp)$/i.test(e.name) && !/\.mmpz\.bak$/i.test(e.name) && !/\.bak$/i.test(e.name)) {
        projects.push(full);
      }
    }
  };
  await collect(relinkedTree);
  projects.sort();

  const records = [];
  const totals = { processed: 0, bundled: 0, blocked: 0, failed: 0, stripped: 0,
                   bytesBefore: 0, bytesAfter: 0 };

  for (const project of projects) {
    totals.processed += 1;
    const rel = path.relative(relinkedTree, project);
    const record = { project: rel, status: 'PENDING' };

    let sourceProject = project;
    let check = await bundle.verifyProject(project, DIRS);

    if (flag('--strip-empty') && check.emptyReferences > 0 && !check.alreadyBundled) {
      const stripped = path.join(await mkTemp('strip'), path.basename(project));
      try {
        const r = await bundle.stripEmptySampleSlots(project, stripped);
        if (r.changed) {
          sourceProject = stripped;
          record.strippedEmptySlots = r.stripped;
          totals.stripped += r.stripped;
          check = await bundle.verifyProject(sourceProject, DIRS);
        }
      } catch (err) { record.stripError = err.message; }
    }

    record.references = check.total;
    record.resolved = check.resolvedCount;
    record.emptyReferences = check.emptyReferences;

    if (check.alreadyBundled) {
      record.status = 'BLOCKED — already bundled';
      totals.blocked += 1; records.push(record);
      console.log(`  [BLOCKED] ${rel} — already bundled`);
      continue;
    }
    if (!check.ok) {
      record.status = `BLOCKED — ${check.blockedReason}`;
      totals.blocked += 1; records.push(record);
      console.log(`  [BLOCKED] ${rel} — ${check.blockedReason}`);
      continue;
    }

    const destination = path.join(
      outputRoot,
      path.dirname(rel) === '.' ? '' : path.dirname(rel),
      path.basename(project).replace(/\.(mmpz|mmp)$/i, '')
    );

    try {
      await bundle.makeBundle(lmms.path, sourceProject, destination, { overwrite: true });
      if (!flag('--no-dedupe')) {
        const dd = await bundle.dedupeBundle(destination);
        record.dedupe = dd;
        totals.bytesBefore += dd.bytesBefore;
        totals.bytesAfter += dd.bytesAfter;
      }
      await bundle.normalizeForLinux(destination);
      const audit = await bundle.auditLinuxPortability(destination);
      const v = await bundle.validateBundle(destination);
      record.linuxAudit = audit.ok;
      record.validation = v.ok;

      if (v.ok && audit.ok) {
        record.status = 'BUNDLED';
        totals.bundled += 1;
        const d = record.dedupe;
        console.log(`  [BUNDLED] ${rel}` +
          (d && d.changed ? ` — ${d.filesBefore}->${d.filesAfter} files, ${mb(d.bytesBefore)}->${mb(d.bytesAfter)}` : ''));
      } else {
        record.status = 'VALIDATION FAILED';
        totals.failed += 1;
        console.log(`  [FAILED] ${rel}`);
      }
    } catch (err) {
      record.status = 'BUNDLE FAILED';
      record.message = err.message;
      totals.failed += 1;
      console.log(`  [FAILED] ${rel} — ${err.message}`);
    }

    records.push(record);
  }

  console.log('\n=== totals ===');
  console.log(`  projects:   ${totals.processed}`);
  console.log(`  bundled:    ${totals.bundled}`);
  console.log(`  blocked:    ${totals.blocked}`);
  console.log(`  failed:     ${totals.failed}`);
  if (totals.stripped) console.log(`  empty slots stripped: ${totals.stripped}`);
  if (totals.bytesBefore) {
    console.log(`  size:       ${mb(totals.bytesBefore)} -> ${mb(totals.bytesAfter)} (saved ${mb(totals.bytesBefore - totals.bytesAfter)})`);
  }
  console.log(`\noutput: ${outputRoot}`);

  const report = buildReport({
    sourcePath: path.resolve(source),
    outputPath: outputRoot,
    settings,
    records: records.map((r) => ({
      filename: r.project, format: 'bundle', oldPath, newPath,
      occurrences: r.references, decompression: 'ok', recompression: 'ok',
      roundTrip: r.validation ? 'ok' : 'n/a', result: r.status, message: r.message,
    })),
    summary: {
      projectsProcessed: totals.processed,
      projectsModified: totals.bundled,
      replacements: relink.summary.replacements,
      projectsSkipped: totals.blocked,
      validationFailures: totals.failed,
      outputLocation: outputRoot,
    },
  });
  const paths = await writeReports(report, outputRoot);
  console.log(`report: ${paths.json}`);

  for (const t of temps) await fsp.rm(t, { recursive: true, force: true }).catch(() => {});
  process.exit(totals.failed > 0 ? 1 : 0);
})().catch(async (err) => {
  console.error('pipeline failed:', err.message);
  for (const t of temps) await fsp.rm(t, { recursive: true, force: true }).catch(() => {});
  process.exit(1);
});
