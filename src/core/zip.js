'use strict';
/**
 * zip.js — safe extraction and rebuilding of ZIP archives.
 *
 * ZIP contents are untrusted. Entry names in an archive are attacker-controlled
 * strings, so every destination path is resolved and then checked to be inside
 * the extraction directory before a single byte is written (ZIP-slip). We also
 * bound entry count and total uncompressed size so a zip bomb cannot fill the
 * disk, and we never recreate symlinks.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const yauzl = require('yauzl');
const yazl = require('yazl');

const DEFAULT_ZIP_LIMITS = {
  maxEntries: 100000,
  maxTotalUncompressed: 4 * 1024 * 1024 * 1024, // 4 GiB
  maxEntrySize: 512 * 1024 * 1024,
};

/** Unix mode bits live in the high 16 bits of externalFileAttributes. */
const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;

/**
 * Resolve an archive entry name to a safe absolute path inside `destRoot`.
 * Returns null if the entry must be refused.
 */
function safeEntryPath(destRoot, entryName) {
  if (!entryName || entryName.length === 0) return null;

  // Normalise separators; some archives use backslashes.
  const normalised = entryName.replace(/\\/g, '/');

  // Absolute paths and drive letters are never acceptable.
  if (normalised.startsWith('/') || /^[a-zA-Z]:/.test(normalised)) return null;
  if (normalised.split('/').includes('..')) return null;
  if (normalised.includes('\0')) return null;

  const target = path.resolve(destRoot, normalised);
  const rel = path.relative(path.resolve(destRoot), target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;

  return target;
}

function isSymlinkEntry(entry) {
  const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
  return (mode & S_IFMT) === S_IFLNK;
}

/**
 * Extract a ZIP into `destRoot`, preserving the directory hierarchy.
 *
 * @param {string} zipPath
 * @param {string} destRoot
 * @param {object} [limits]
 * @returns {Promise<{entries: number, bytes: number, refused: string[]}>}
 */
function extractZip(zipPath, destRoot, limits = {}) {
  const cfg = { ...DEFAULT_ZIP_LIMITS, ...limits };

  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, autoClose: true }, (err, zipfile) => {
      if (err) return reject(err);

      const refused = [];
      let entries = 0;
      let bytes = 0;
      let settled = false;

      const fail = (e) => {
        if (settled) return;
        settled = true;
        try { zipfile.close(); } catch { /* already closing */ }
        reject(e);
      };

      zipfile.on('error', fail);

      zipfile.on('end', () => {
        if (settled) return;
        settled = true;
        resolve({ entries, bytes, refused });
      });

      zipfile.on('entry', (entry) => {
        (async () => {
          entries += 1;
          if (entries > cfg.maxEntries) {
            throw new Error(`Archive contains more than ${cfg.maxEntries} entries`);
          }

          if (isSymlinkEntry(entry)) {
            refused.push(`${entry.fileName} (symlink)`);
            return zipfile.readEntry();
          }

          const target = safeEntryPath(destRoot, entry.fileName);
          if (!target) {
            refused.push(`${entry.fileName} (unsafe path)`);
            return zipfile.readEntry();
          }

          // Directory entries end with '/'.
          if (/\/$/.test(entry.fileName)) {
            await fsp.mkdir(target, { recursive: true });
            return zipfile.readEntry();
          }

          if (entry.uncompressedSize > cfg.maxEntrySize) {
            refused.push(`${entry.fileName} (entry too large)`);
            return zipfile.readEntry();
          }

          bytes += entry.uncompressedSize;
          if (bytes > cfg.maxTotalUncompressed) {
            throw new Error('Archive exceeds the maximum total uncompressed size');
          }

          await fsp.mkdir(path.dirname(target), { recursive: true });

          await new Promise((res, rej) => {
            zipfile.openReadStream(entry, (streamErr, readStream) => {
              if (streamErr) return rej(streamErr);
              const out = fs.createWriteStream(target);
              readStream.on('error', rej);
              out.on('error', rej);
              out.on('close', res);
              readStream.pipe(out);
            });
          });

          zipfile.readEntry();
        })().catch(fail);
      });

      zipfile.readEntry();
    });
  });
}

/**
 * Rebuild a ZIP from a directory tree, preserving the hierarchy and file names.
 *
 * @param {string} sourceRoot
 * @param {string} zipPath
 */
async function createZip(sourceRoot, zipPath) {
  const zip = new yazl.ZipFile();

  const base = path.resolve(sourceRoot);
  let fileCount = 0;

  async function addDir(dir) {
    const items = await fsp.readdir(dir, { withFileTypes: true });
    for (const item of items) {
      const full = path.join(dir, item.name);
      if (item.isSymbolicLink()) continue; // never re-emit symlinks
      if (item.isDirectory()) {
        await addDir(full);
      } else if (item.isFile()) {
        const rel = path.relative(base, full).split(path.sep).join('/');
        zip.addFile(full, rel);
        fileCount += 1;
      }
    }
  }

  await addDir(base);

  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(zipPath);
    out.on('error', reject);
    out.on('close', resolve);
    zip.outputStream.on('error', reject);
    zip.outputStream.pipe(out);
    zip.end();
  });

  return { files: fileCount, zipPath };
}

module.exports = { extractZip, createZip, safeEntryPath, DEFAULT_ZIP_LIMITS };
