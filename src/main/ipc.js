'use strict';
/**
 * ipc.js — bridges the renderer to the core modules.
 *
 * All filesystem work happens here in the main process. The renderer only ever
 * sends paths and settings, and receives plain data back.
 */

const { ipcMain, dialog, shell, BrowserWindow } = require('electron');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');

const engine = require('../core/engine');
const { extractZip, createZip } = require('../core/zip');
const { buildReport, writeReports } = require('../core/report');
const { outputPathFor } = require('../core/naming');

/** Temp directories created this session, removed on exit. */
const tempDirs = new Set();

async function makeTempDir(label) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), `lmms-relinker-${label}-`));
  tempDirs.add(dir);
  return dir;
}

async function cleanupTempDirs() {
  for (const dir of tempDirs) {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  tempDirs.clear();
}

function isZip(sourcePath) {
  return path.extname(sourcePath).toLowerCase() === '.zip';
}

/**
 * Resolve whatever the user gave us into a directory (or single file) we can
 * scan. ZIPs are extracted into an isolated working directory.
 */
async function prepareSource(sourcePath) {
  const stat = await fsp.lstat(sourcePath);

  if (stat.isDirectory()) {
    return { kind: 'folder', workingRoot: sourcePath };
  }

  if (isZip(sourcePath)) {
    const workingRoot = await makeTempDir('extract');
    const result = await extractZip(sourcePath, workingRoot);
    return { kind: 'zip', workingRoot, extraction: result };
  }

  return { kind: 'file', workingRoot: sourcePath };
}

/**
 * Pick a non-colliding output location next to the source, named for the
 * stages applied. The GUI only relinks, so that is "_RELINKED"; the shared
 * helper produces "_BUNDLED" and "_RELINKED_BUNDLED" for the CLI pipeline.
 */
async function chooseOutputPath(sourcePath, kind, stages = { relink: true }) {
  return outputPathFor(sourcePath, stages, { kind });
}

function sendProgress(payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('job:progress', payload);
  }
}

function registerIpc() {
  ipcMain.handle('dialog:openSource', async (_event, mode) => {
    const properties =
      mode === 'folder' ? ['openDirectory'] : ['openFile'];

    const filters =
      mode === 'zip'
        ? [{ name: 'ZIP archive', extensions: ['zip'] }]
        : mode === 'file'
          ? [{ name: 'LMMS project', extensions: ['mmp', 'mmpz'] }]
          : [];

    const result = await dialog.showOpenDialog({ properties, filters });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  ipcMain.handle('shell:reveal', async (_event, target) => {
    if (typeof target !== 'string' || !fs.existsSync(target)) return false;
    shell.showItemInFolder(target);
    return true;
  });

  ipcMain.handle('job:scan', async (_event, payload) => {
    const { sourcePath, oldPath, newPath, matchSeparatorVariants } = payload;

    if (!sourcePath) throw new Error('No source selected');
    if (!oldPath) throw new Error('Enter the incorrect path to search for');
    // An empty replacement would preview stripping the root off every path,
    // which is never what the user means. Require it explicitly.
    if (!newPath) throw new Error('Enter the replacement path before scanning');

    const prepared = await prepareSource(sourcePath);

    const { results, summary } = await engine.scan(
      prepared.workingRoot,
      { oldPath, newPath, matchSeparatorVariants },
      { onProgress: sendProgress }
    );

    return {
      kind: prepared.kind,
      sourcePath,
      summary,
      results,
      extraction: prepared.extraction || null,
    };
  });

  ipcMain.handle('job:repair', async (_event, payload) => {
    const { sourcePath, oldPath, newPath, matchSeparatorVariants } = payload;

    if (!sourcePath) throw new Error('No source selected');
    if (!oldPath) throw new Error('Enter the incorrect path to search for');
    if (!newPath) throw new Error('Enter the replacement path before repairing');

    const prepared = await prepareSource(sourcePath);
    const settings = { oldPath, newPath, matchSeparatorVariants };

    const finalOutput = await chooseOutputPath(sourcePath, prepared.kind);

    // For folders and archives we mirror the whole tree first so unrelated
    // files (samples, artwork, readme files) are preserved in the output, then
    // repair writes the fixed projects over their copies. The source tree is
    // only ever read.
    let repairRoot;
    if (prepared.kind === 'file') {
      repairRoot = path.dirname(finalOutput);
      await fsp.mkdir(repairRoot, { recursive: true });
    } else if (prepared.kind === 'zip') {
      repairRoot = await makeTempDir('rebuild');
      await engine.mirrorTree(prepared.workingRoot, repairRoot);
    } else {
      repairRoot = finalOutput;
      await engine.mirrorTree(prepared.workingRoot, repairRoot);
    }

    const { records, summary } = await engine.repair(
      prepared.workingRoot,
      repairRoot,
      settings,
      { onProgress: sendProgress }
    );

    // Rebuild the archive with the same hierarchy.
    if (prepared.kind === 'zip') {
      await createZip(repairRoot, finalOutput);
    }

    summary.outputLocation = finalOutput;

    const report = buildReport({
      sourcePath,
      outputPath: finalOutput,
      settings,
      records,
      summary,
    });

    // Logs live beside the output, never inside a rebuilt archive.
    const reportDir =
      prepared.kind === 'folder' ? finalOutput : path.dirname(finalOutput);
    const reportPaths = await writeReports(report, reportDir);

    return { summary, records, reportPaths, outputPath: finalOutput };
  });
}

module.exports = { registerIpc, cleanupTempDirs, chooseOutputPath, prepareSource };
