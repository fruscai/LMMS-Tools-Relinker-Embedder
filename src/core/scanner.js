'use strict';
/**
 * scanner.js — recursively enumerate LMMS project files.
 *
 * Treats the tree as untrusted: symlinks are never followed, and traversal is
 * depth-limited so a pathological tree cannot hang the app.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const PROJECT_EXTENSIONS = new Set(['.mmp', '.mmpz']);

const DEFAULT_LIMITS = {
  maxDepth: 64,
  maxFiles: 200000,
  maxFileSize: 256 * 1024 * 1024, // per-project ceiling
};

/**
 * @param {string} filePath
 * @returns {'mmp'|'mmpz'|null}
 */
function classify(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (!PROJECT_EXTENSIONS.has(ext)) return null;
  return ext === '.mmpz' ? 'mmpz' : 'mmp';
}

/**
 * Recursively collect .mmp/.mmpz files beneath `root`.
 *
 * @param {string} root directory or single file
 * @param {object} [limits]
 * @returns {Promise<{projects: Array<{absolutePath: string, relativePath: string, format: string, size: number}>, stats: object}>}
 */
async function scanTree(root, limits = {}) {
  const cfg = { ...DEFAULT_LIMITS, ...limits };

  const stats = {
    foldersScanned: 0,
    filesSeen: 0,
    mmpCount: 0,
    mmpzCount: 0,
    skippedSymlinks: 0,
    skippedTooLarge: 0,
  };
  const projects = [];

  const rootStat = await fsp.lstat(root);

  if (rootStat.isFile()) {
    const format = classify(root);
    if (format) {
      projects.push({
        absolutePath: path.resolve(root),
        relativePath: path.basename(root),
        format,
        size: rootStat.size,
      });
      stats.filesSeen = 1;
      if (format === 'mmpz') stats.mmpzCount++;
      else stats.mmpCount++;
    }
    return { projects, stats };
  }

  const baseDir = path.resolve(root);

  async function walk(dir, depth) {
    if (depth > cfg.maxDepth) return;
    stats.foldersScanned += 1;

    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable directory: skip rather than abort the whole scan
    }

    for (const entry of entries) {
      if (projects.length >= cfg.maxFiles) return;

      const full = path.join(dir, entry.name);

      // Never follow symlinks: they can point outside the selected tree.
      if (entry.isSymbolicLink()) {
        stats.skippedSymlinks += 1;
        continue;
      }

      if (entry.isDirectory()) {
        await walk(full, depth + 1);
        continue;
      }

      if (!entry.isFile()) continue;
      stats.filesSeen += 1;

      const format = classify(entry.name);
      if (!format) continue;

      let size = 0;
      try {
        size = (await fsp.stat(full)).size;
      } catch {
        continue;
      }

      if (size > cfg.maxFileSize) {
        stats.skippedTooLarge += 1;
        continue;
      }

      projects.push({
        absolutePath: full,
        relativePath: path.relative(baseDir, full),
        format,
        size,
      });
      if (format === 'mmpz') stats.mmpzCount += 1;
      else stats.mmpCount += 1;
    }
  }

  await walk(baseDir, 0);

  return { projects, stats };
}

module.exports = { scanTree, classify, PROJECT_EXTENSIONS, DEFAULT_LIMITS };
