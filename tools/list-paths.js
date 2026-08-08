'use strict';
/**
 * list-paths.js — report the external sample paths actually stored in a set of
 * projects, so the user can copy an exact root to relink.
 *
 * This is reporting only. It does not guess, match filenames, or search the
 * filesystem for anything.
 *
 * Usage: node tools/list-paths.js <folder|zip|project>
 */

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');

const engine = require('../src/core/engine');
const { extractZip } = require('../src/core/zip');
const { scanTree } = require('../src/core/scanner');

const [, , source] = process.argv;
if (!source) {
  console.error('usage: node tools/list-paths.js <folder|zip|project>');
  process.exit(2);
}

/** LMMS's own prefixes for bundled/relative content — not broken absolute paths. */
const NON_ABSOLUTE_PREFIXES = ['factorysample:', 'usersample:', 'usergig:', 'usersoundfont:'];

function parentRoot(p) {
  const cut = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return cut === -1 ? p : p.slice(0, cut + 1);
}

(async () => {
  const stat = await fsp.lstat(source);
  let root = source;
  let temp = null;

  if (stat.isFile() && path.extname(source).toLowerCase() === '.zip') {
    temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'relinker-list-'));
    await extractZip(source, temp);
    root = temp;
  }

  const { projects } = await scanTree(root);

  const rootCounts = new Map();
  const prefixCounts = new Map();
  const examples = new Map();
  let unreadable = 0;

  for (const project of projects) {
    const loaded = await engine.readProjectText(project);
    if (loaded.error) {
      unreadable += 1;
      continue;
    }
    for (const match of loaded.text.matchAll(/src="([^"]*)"/g)) {
      const value = match[1];
      if (!value) continue;

      const prefix = NON_ABSOLUTE_PREFIXES.find((p) => value.startsWith(p));
      if (prefix) {
        prefixCounts.set(prefix, (prefixCounts.get(prefix) || 0) + 1);
        continue;
      }

      const dir = parentRoot(value);
      rootCounts.set(dir, (rootCounts.get(dir) || 0) + 1);
      if (!examples.has(dir)) examples.set(dir, value);
    }
  }

  console.log(`projects read: ${projects.length - unreadable} / ${projects.length}`);
  if (unreadable) console.log(`unreadable:    ${unreadable}`);

  console.log('\nExternal sample path roots found (copy one of these as the Incorrect path):');
  const sorted = [...rootCounts.entries()].sort((a, b) => b[1] - a[1]);
  if (sorted.length === 0) {
    console.log('  (none — every sample reference uses an LMMS prefix)');
  }
  for (const [dir, count] of sorted) {
    console.log(`\n  ${count} reference(s)`);
    console.log(`  root:    ${dir}`);
    console.log(`  example: ${examples.get(dir)}`);
  }

  if (prefixCounts.size) {
    console.log('\nLMMS-managed references (left alone by this tool):');
    for (const [prefix, count] of prefixCounts) {
      console.log(`  ${prefix.padEnd(16)} ${count}`);
    }
  }

  if (temp) await fsp.rm(temp, { recursive: true, force: true });
})().catch((err) => {
  console.error('failed:', err.message);
  process.exit(1);
});
