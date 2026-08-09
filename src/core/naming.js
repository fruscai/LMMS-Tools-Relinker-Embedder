'use strict';
/**
 * naming.js — output naming, derived from what was actually done.
 *
 * The folder name should tell you which stages a project went through without
 * having to open anything:
 *
 *   relink only          ProjectFolder_RELINKED
 *   bundle only          ProjectFolder_BUNDLED
 *   relink then bundle   ProjectFolder_RELINKED_BUNDLED
 *
 * Order is fixed as RELINKED before BUNDLED because that is the only order the
 * pipeline supports — bundling an already-bundled project produces an empty
 * bundle, so it is always relink first.
 */

const fs = require('fs');
const path = require('path');

const STAGE_SUFFIX = { relink: 'RELINKED', bundle: 'BUNDLED', embed: 'EMBEDDED' };
const STAGE_ORDER = ['relink', 'bundle', 'embed'];

/**
 * @param {{relink?: boolean, bundle?: boolean}} stages
 * @returns {string} e.g. "_RELINKED_BUNDLED", or "" when nothing was done
 */
function suffixFor(stages = {}) {
  const parts = STAGE_ORDER.filter((s) => stages[s]).map((s) => STAGE_SUFFIX[s]);
  return parts.length ? `_${parts.join('_')}` : '';
}

/**
 * Build the output path beside the source, reflecting the stages applied.
 *
 * @param {string} sourcePath folder, .zip, or single project file
 * @param {{relink?: boolean, bundle?: boolean}} stages
 * @param {{kind?: 'folder'|'zip'|'file', unique?: boolean}} [options]
 */
function outputPathFor(sourcePath, stages, options = {}) {
  const resolved = path.resolve(sourcePath);
  const suffix = suffixFor(stages);

  const kind = options.kind || inferKind(resolved);
  const parent = path.dirname(resolved);

  let candidate;
  if (kind === 'folder') {
    candidate = path.join(parent, `${path.basename(resolved)}${suffix}`);
  } else {
    const ext = path.extname(resolved);
    const base = path.basename(resolved, ext);
    candidate = path.join(parent, `${base}${suffix}${ext}`);
  }

  return options.unique === false ? candidate : uniquePath(candidate, kind);
}

function inferKind(resolved) {
  try {
    if (fs.statSync(resolved).isDirectory()) return 'folder';
  } catch { /* fall through */ }
  return path.extname(resolved).toLowerCase() === '.zip' ? 'zip' : 'file';
}

/** Never clobber an existing result; add a counter instead. */
function uniquePath(candidate, kind) {
  if (!fs.existsSync(candidate)) return candidate;

  const ext = kind === 'folder' ? '' : path.extname(candidate);
  const base = kind === 'folder'
    ? candidate
    : path.join(path.dirname(candidate), path.basename(candidate, ext));

  for (let n = 2; n < 1000; n += 1) {
    const next = `${base}_${n}${ext}`;
    if (!fs.existsSync(next)) return next;
  }
  throw new Error(`Could not find a free output name for ${candidate}`);
}

module.exports = { suffixFor, outputPathFor, uniquePath, STAGE_SUFFIX };
