'use strict';
/**
 * bundle-batch.js — run the bundle pipeline across a snapshot tree.
 *
 * Usage:
 *   node tools/bundle-batch.js <snapshotDir> <outputDir> [--dry-run] [--overwrite]
 *                              [--lmms <path>] [--no-dedupe]
 *
 * Per the spec, a project that fails verification is reported and skipped —
 * the batch never aborts, and an unverified project is never bundled.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const bundle = require('../src/core/bundle');

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const valueOf = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1];
};

const positional = args.filter((a, i) =>
  !a.startsWith('--') && args[i - 1] !== '--lmms');

const { outputPathFor } = require('../src/core/naming');

const [snapshotDir, explicitOutput] = positional;
const DRY_RUN = flag('--dry-run');
const OVERWRITE = flag('--overwrite');
const DEDUPE = !flag('--no-dedupe');
/** Opt-in: drop empty src="" attributes so LMMS will bundle the project. */
const STRIP_EMPTY = flag('--strip-empty');

if (!snapshotDir) {
  console.error('usage: node tools/bundle-batch.js <snapshotDir> [outputDir] [--dry-run] [--overwrite] [--no-dedupe] [--strip-empty] [--was-relinked] [--lmms <path>]');
  process.exit(2);
}

/**
 * Output naming reflects the stages applied. Pass --was-relinked when the input
 * tree came out of the relinker, so the folder reads "_RELINKED_BUNDLED".
 */
const STAGES = { relink: flag('--was-relinked'), bundle: true };
const outputRoot = explicitOutput || outputPathFor(snapshotDir, STAGES, { kind: 'folder' });

// Platform-aware, with LMMS_* environment overrides.
const DIRS = bundle.defaultSampleDirs();

const mb = (n) => `${(n / 1048576).toFixed(2)} MB`;

/** Projects to bundle. Autosaves carry the old paths, so they are excluded. */
function isBundleCandidate(name) {
  if (/\.mmpz\.bak$/i.test(name)) return false;
  if (/\.bak$/i.test(name)) return false;
  return /\.(mmpz|mmp)$/i.test(name);
}

/** Collect one project per snapshot folder, recursively. */
async function findProjects(root) {
  const found = [];
  async function walk(dir, depth) {
    if (depth > 32) return;
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) { await walk(full, depth + 1); continue; }
      if (e.isFile() && isBundleCandidate(e.name)) found.push(full);
    }
  }
  await walk(path.resolve(root), 0);
  return found.sort();
}

(async () => {
  const lmms = await bundle.detectLmms(valueOf('--lmms'));
  console.log(`LMMS: ${lmms.path || '(not found)'}`);
  console.log(`      ${lmms.version || ''}`);
  if (!lmms.ok) {
    console.error(`REFUSING: ${lmms.reason}`);
    process.exit(1);
  }

  const projects = await findProjects(snapshotDir);
  console.log(`\nFound ${projects.length} project file(s) under ${snapshotDir}`);
  if (DRY_RUN) console.log('DRY RUN — verification only, nothing will be bundled.\n');

  const log = {
    application: 'LMMS Path Relinker — bundle batch',
    timestamp: new Date().toISOString(),
    snapshotDir: path.resolve(snapshotDir),
    outputRoot: path.resolve(outputRoot),
    dedupe: DEDUPE,
    dryRun: DRY_RUN,
    projects: [],
  };

  const totals = {
    processed: 0, verified: 0, blocked: 0, bundled: 0, failed: 0,
    bytesBefore: 0, bytesAfter: 0,
  };

  for (const project of projects) {
    const rel = path.relative(path.resolve(snapshotDir), project);
    const label = rel || path.basename(project);
    totals.processed += 1;

    const record = { project: label, status: 'PENDING' };

    // STAGE 2 — verify. Never bundle an unverified project.
    let check;
    try {
      check = await bundle.verifyProject(project, DIRS);
    } catch (err) {
      record.status = 'READ FAILED';
      record.message = err.message;
      totals.failed += 1;
      log.projects.push(record);
      console.log(`[READ FAILED] ${label} — ${err.message}`);
      continue;
    }

    record.references = check.total;
    record.distinct = check.uniqueReferenced;
    record.resolved = check.resolvedCount;
    record.unresolved = check.unresolved;

    record.emptyReferences = check.emptyReferences;

    // STAGE 2b — optionally strip empty sample slots so LMMS will bundle.
    // Writes a stripped copy; the source project is never modified.
    let sourceProject = project;
    if (STRIP_EMPTY && check.emptyReferences > 0 && !check.alreadyBundled && !DRY_RUN) {
      try {
        const stripped = path.join(
          require('os').tmpdir(),
          `stripped-${Date.now()}-${path.basename(project)}`
        );
        const r = await bundle.stripEmptySampleSlots(project, stripped);
        if (r.changed) {
          sourceProject = stripped;
          record.strippedEmptySlots = r.stripped;
          console.log(`   stripped ${r.stripped} empty sample slot(s)`);
          check = await bundle.verifyProject(sourceProject, DIRS);
          record.resolved = check.resolvedCount;
          record.emptyReferences = check.emptyReferences;
        }
      } catch (err) {
        record.stripError = err.message;
      }
    }

    // Bundling an already-bundled project yields an empty bundle and exit 0.
    if (check.alreadyBundled) {
      record.status = 'BLOCKED — already bundled';
      record.message = check.rebundleWarning;
      totals.blocked += 1;
      log.projects.push(record);
      console.log(`[BLOCKED] ${label} — already bundled; bundle from the relinked source instead`);
      continue;
    }

    if (!check.ok) {
      record.status = `BLOCKED — ${check.blockedReason}`;
      totals.blocked += 1;
      log.projects.push(record);
      console.log(`[BLOCKED] ${label} — ${check.blockedReason}`);
      for (const u of check.unresolved.slice(0, 3)) console.log(`            ${u.src} (${u.reason})`);
      continue;
    }

    totals.verified += 1;
    if (DRY_RUN) {
      record.status = 'VERIFIED (dry run)';
      log.projects.push(record);
      console.log(`[VERIFIED] ${label} — ${check.total} refs, ${check.uniqueReferenced} distinct`);
      continue;
    }

    // STAGE 3 — bundle. Each snapshot bundles from its own resolved state, into
    // its own folder, so no interim ever shares another's resources.
    const bundleName = path.basename(project).replace(/\.(mmpz|mmp)$/i, '');
    const destination = path.join(
      path.resolve(outputRoot),
      path.dirname(rel) === '.' ? '' : path.dirname(rel),
      bundleName
    );

    try {
      // sourceProject is the stripped copy when --strip-empty applied, else the original.
      await bundle.makeBundle(lmms.path, sourceProject, destination, { overwrite: OVERWRITE });
    } catch (err) {
      record.status = 'BUNDLE FAILED';
      record.message = err.message;
      totals.failed += 1;
      log.projects.push(record);
      console.log(`[BUNDLE FAILED] ${label} — ${err.message}`);
      continue;
    }

    // STAGE 4 — dedupe within this bundle only.
    if (DEDUPE) {
      try {
        const dd = await bundle.dedupeBundle(destination);
        record.dedupe = dd;
        totals.bytesBefore += dd.bytesBefore;
        totals.bytesAfter += dd.bytesAfter;
      } catch (err) {
        record.dedupeError = err.message;
      }
    }

    // STAGE 4b — make the bundle safe on a case-sensitive filesystem.
    try {
      const norm = await bundle.normalizeForLinux(destination);
      record.linuxNormalize = {
        fixed: norm.fixes.length,
        unfixable: norm.unfixable.length,
        collisions: norm.collisions.length,
      };
      if (norm.fixes.length) {
        console.log(`   linux-normalise: corrected ${norm.fixes.length} reference(s)`);
      }
      if (norm.unfixable.length) {
        console.log(`   linux-normalise: ${norm.unfixable.length} could NOT be fixed`);
      }
    } catch (err) {
      record.linuxNormalizeError = err.message;
    }

    const audit = await bundle.auditLinuxPortability(destination);
    record.linuxAudit = { ok: audit.ok, problems: audit.problems };
    if (!audit.ok) console.log(`   linux-audit FAILED: ${audit.problems.slice(0, 3).join('; ')}`);

    // STAGE 5 — validate.
    const v = await bundle.validateBundle(destination);
    record.validation = { ok: v.ok, referenceCount: v.referenceCount,
                          distinctReferenced: v.distinctReferenced, resourceCount: v.resourceCount,
                          failed: v.checks.filter((c) => !c.ok).map((c) => c.name) };

    if (v.ok) {
      record.status = 'BUNDLED';
      record.outputPath = destination;
      totals.bundled += 1;
      const d = record.dedupe;
      console.log(
        `[BUNDLED] ${label}` +
        (d && d.changed ? ` — ${d.filesBefore}->${d.filesAfter} files, ${mb(d.bytesBefore)}->${mb(d.bytesAfter)}` : '')
      );
    } else {
      record.status = 'VALIDATION FAILED';
      totals.failed += 1;
      console.log(`[VALIDATION FAILED] ${label} — ${record.validation.failed.join(', ')}`);
    }

    log.projects.push(record);
  }

  log.totals = totals;

  console.log('\n=== totals ===');
  console.log(`  processed:        ${totals.processed}`);
  console.log(`  verified:         ${totals.verified}`);
  console.log(`  blocked:          ${totals.blocked}`);
  console.log(`  bundled:          ${totals.bundled}`);
  console.log(`  failed:           ${totals.failed}`);
  if (DEDUPE && totals.bytesBefore) {
    console.log(`  bundle size:      ${mb(totals.bytesBefore)} -> ${mb(totals.bytesAfter)}` +
                ` (saved ${mb(totals.bytesBefore - totals.bytesAfter)})`);
  }

  await fsp.mkdir(path.resolve(outputRoot), { recursive: true });
  const logPath = path.join(path.resolve(outputRoot),
    `bundle-log-${log.timestamp.replace(/[:.]/g, '-')}.json`);
  await fsp.writeFile(logPath, JSON.stringify(log, null, 2), 'utf8');
  console.log(`\nlog: ${logPath}`);

  process.exit(totals.failed > 0 ? 1 : 0);
})().catch((err) => {
  console.error('batch failed:', err.message);
  process.exit(1);
});
