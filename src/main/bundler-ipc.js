'use strict';
/**
 * bundler-ipc.js — main-process work for the RelinkBundler.
 *
 * Two modes:
 *   bundle          the project already opens correctly in LMMS
 *   relink+bundle   LMMS reports missing samples, so fix the paths first
 *
 * Verification always runs before bundling. That gate is the entire point:
 * makebundle copies whatever sits at each path and silently produces a bundle
 * of missing resources when a path does not resolve.
 */

const { ipcMain, dialog, shell, BrowserWindow } = require('electron');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');

const engine = require('../core/engine');
const bundle = require('../core/bundle');
const { extractZip } = require('../core/zip');
const { outputPathFor } = require('../core/naming');
const { buildReport, writeReports } = require('../core/report');

const tempDirs = new Set();

async function makeTempDir(label) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), `relinkbundler-${label}-`));
  tempDirs.add(dir);
  return dir;
}

/** Platform-aware sample roots (macOS, Windows, Linux). */
const sampleDirs = () => bundle.defaultSampleDirs();

function send(channel, payload) {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send(channel, payload);
}

/** Resolve the dropped item into a directory we can walk. */
async function prepareSource(sourcePath) {
  const stat = await fsp.lstat(sourcePath);
  if (stat.isDirectory()) return { kind: 'folder', tree: sourcePath };

  if (path.extname(sourcePath).toLowerCase() === '.zip') {
    const tree = await makeTempDir('extract');
    const extraction = await extractZip(sourcePath, tree);
    return { kind: 'zip', tree, extraction };
  }

  const tree = await makeTempDir('single');
  await fsp.copyFile(sourcePath, path.join(tree, path.basename(sourcePath)));
  return { kind: 'file', tree };
}

/** Every project in a tree, excluding autosaves which carry stale paths. */
async function collectProjects(root) {
  const found = [];
  async function walk(dir, depth) {
    if (depth > 32) return;
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) await walk(full, depth + 1);
      else if (/\.(mmpz|mmp)$/i.test(e.name) && !/\.bak$/i.test(e.name)) found.push(full);
    }
  }
  await walk(path.resolve(root), 0);
  return found.sort();
}

function registerBundlerIpc() {
  ipcMain.handle('lmms:detect', async () => bundle.detectLmms(null));

  ipcMain.handle('dialog:open', async (_e, mode) => {
    const result = await dialog.showOpenDialog({
      properties: mode === 'folder' ? ['openDirectory'] : ['openFile'],
      filters: mode === 'zip'
        ? [{ name: 'ZIP archive', extensions: ['zip'] }]
        : mode === 'file'
          ? [{ name: 'LMMS project', extensions: ['mmp', 'mmpz'] }]
          : [],
    });
    return result.canceled || !result.filePaths.length ? null : result.filePaths[0];
  });

  ipcMain.handle('shell:reveal', async (_e, target) => {
    if (typeof target !== 'string' || !fs.existsSync(target)) return false;
    shell.showItemInFolder(target);
    return true;
  });

  /**
   * Dry run. Reports, per project, whether every sample resolves — which
   * decides whether bundling can succeed at all.
   */
  ipcMain.handle('bundler:check', async (_e, payload) => {
    const { sourcePath, mode, oldPath, newPath } = payload;
    if (!sourcePath) throw new Error('No source selected');
    if (mode === 'relink+bundle') {
      if (!oldPath) throw new Error('Enter the incorrect path');
      if (!newPath) throw new Error('Enter the replacement path');
    }

    const prepared = await prepareSource(sourcePath);
    const dirs = sampleDirs();

    // In relink mode, check against a relinked copy so the preview reflects
    // what bundling would actually see.
    let tree = prepared.tree;
    let relinkSummary = null;
    if (mode === 'relink+bundle') {
      const settings = { oldPath, newPath, matchSeparatorVariants: true };
      const relinked = await makeTempDir('relinked');
      await engine.mirrorTree(prepared.tree, relinked);
      const r = await engine.repair(prepared.tree, relinked, settings);
      relinkSummary = r.summary;
      tree = relinked;
    }

    const projects = await collectProjects(tree);
    const results = [];
    let ready = 0, blocked = 0, totalRefs = 0, resolvedRefs = 0;

    for (let i = 0; i < projects.length; i += 1) {
      const p = projects[i];
      const rel = path.relative(tree, p);
      try {
        const check = await bundle.verifyProject(p, dirs);
        totalRefs += check.total;
        resolvedRefs += check.resolvedCount;

        let status = 'READY';
        let detail = `${check.resolvedCount}/${check.total} samples resolve`;

        if (check.alreadyBundled) {
          status = 'ALREADY BUNDLED';
          detail = 'uses local: references — bundling again would produce an empty bundle';
        } else if (check.unresolved.length) {
          status = 'MISSING SAMPLES';
          detail = `${check.unresolved.length} path(s) do not resolve` +
                   (mode === 'bundle' ? ' — try Relink + Bundle' : '');
        } else if (check.emptyReferences > 0) {
          status = 'EMPTY SLOTS';
          detail = `${check.emptyReferences} instrument(s) with no sample — enable "Strip empty slots"`;
        }

        status === 'READY' ? ready++ : blocked++;
        results.push({
          file: rel, status, detail,
          references: check.total,
          unresolved: check.unresolved.slice(0, 5).map((u) => u.src),
        });
      } catch (err) {
        blocked++;
        results.push({ file: rel, status: 'ERROR', detail: err.message, references: 0, unresolved: [] });
      }
      if (i % 5 === 0) send('bundler:progress', { done: i + 1, total: projects.length });
    }

    return {
      kind: prepared.kind,
      mode,
      relinkSummary,
      summary: { projects: projects.length, ready, blocked, totalRefs, resolvedRefs },
      results,
    };
  });

  /** Full run: (optional relink) -> verify -> bundle -> dedupe -> normalise -> validate. */
  ipcMain.handle('bundler:run', async (_e, payload) => {
    const { sourcePath, mode, oldPath, newPath, stripEmpty, dedupe } = payload;

    const lmms = await bundle.detectLmms(null);
    if (!lmms.ok) throw new Error(lmms.reason || 'LMMS not available');

    const prepared = await prepareSource(sourcePath);
    const dirs = sampleDirs();

    let tree = prepared.tree;
    let relinkSummary = null;

    if (mode === 'relink+bundle') {
      const settings = { oldPath, newPath, matchSeparatorVariants: true };
      const relinked = await makeTempDir('relinked');
      await engine.mirrorTree(prepared.tree, relinked);
      const r = await engine.repair(prepared.tree, relinked, settings);
      relinkSummary = r.summary;
      tree = relinked;
    }

    const stages = mode === 'relink+bundle' ? { relink: true, bundle: true } : { bundle: true };
    const outputRoot = outputPathFor(sourcePath, stages, { kind: 'folder' });

    const projects = await collectProjects(tree);
    const records = [];
    const totals = { processed: 0, bundled: 0, blocked: 0, failed: 0, stripped: 0,
                     bytesBefore: 0, bytesAfter: 0 };

    for (let i = 0; i < projects.length; i += 1) {
      const project = projects[i];
      const rel = path.relative(tree, project);
      totals.processed += 1;
      const record = { filename: rel, format: 'bundle', oldPath, newPath, result: 'PENDING' };

      try {
        let sourceProject = project;
        let check = await bundle.verifyProject(project, dirs);

        if (stripEmpty && check.emptyReferences > 0 && !check.alreadyBundled) {
          const stripped = path.join(await makeTempDir('strip'), path.basename(project));
          const s = await bundle.stripEmptySampleSlots(project, stripped);
          if (s.changed) {
            sourceProject = stripped;
            totals.stripped += s.stripped;
            record.strippedEmptySlots = s.stripped;
            check = await bundle.verifyProject(sourceProject, dirs);
          }
        }

        record.occurrences = check.total;

        if (check.alreadyBundled || !check.ok) {
          record.result = check.alreadyBundled
            ? 'SKIPPED — already bundled'
            : `SKIPPED — ${check.blockedReason}`;
          totals.blocked += 1;
          records.push(record);
          continue;
        }

        const destination = path.join(
          outputRoot,
          path.dirname(rel) === '.' ? '' : path.dirname(rel),
          path.basename(project).replace(/\.(mmpz|mmp)$/i, '')
        );

        await bundle.makeBundle(lmms.path, sourceProject, destination, { overwrite: true });

        if (dedupe !== false) {
          const dd = await bundle.dedupeBundle(destination);
          totals.bytesBefore += dd.bytesBefore;
          totals.bytesAfter += dd.bytesAfter;
          record.dedupe = { before: dd.filesBefore, after: dd.filesAfter };
        }

        await bundle.normalizeForLinux(destination);
        const audit = await bundle.auditLinuxPortability(destination);
        const v = await bundle.validateBundle(destination);

        record.roundTrip = v.ok ? 'ok' : 'failed';
        record.linuxSafe = audit.ok;

        if (v.ok && audit.ok) {
          record.result = 'BUNDLED';
          record.outputPath = destination;
          totals.bundled += 1;
        } else {
          record.result = 'VALIDATION FAILED';
          record.message = [...v.checks.filter((c) => !c.ok).map((c) => c.name), ...audit.problems].join('; ');
          totals.failed += 1;
        }
      } catch (err) {
        record.result = 'FAILED';
        record.message = err.message;
        totals.failed += 1;
      }

      records.push(record);
      send('bundler:progress', { done: i + 1, total: projects.length });
    }

    const report = buildReport({
      sourcePath: path.resolve(sourcePath),
      outputPath: outputRoot,
      settings: { oldPath: oldPath || '(none — bundle only)', newPath: newPath || '(none)', matchSeparatorVariants: true },
      records,
      summary: {
        projectsProcessed: totals.processed,
        projectsModified: totals.bundled,
        replacements: relinkSummary ? relinkSummary.replacements : 0,
        projectsSkipped: totals.blocked,
        validationFailures: totals.failed,
        outputLocation: outputRoot,
      },
    });
    const reportPaths = await writeReports(report, outputRoot);

    return { totals, outputRoot, relinkSummary, reportPaths, mode };
  });
}

module.exports = { registerBundlerIpc };
