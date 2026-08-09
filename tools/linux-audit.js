'use strict';
/**
 * linux-audit.js — will these bundles open on a Linux machine?
 *
 * The bundles are produced on macOS, whose filesystem is case-INSENSITIVE by
 * default. Linux is case-SENSITIVE. A reference whose capitalisation differs
 * from the file on disk works perfectly here and fails there, silently, with a
 * missing sample. That is the main risk this checks for.
 *
 * Usage: node tools/linux-audit.js <bundleRoot>
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const bundle = require('../src/core/bundle');

const root = process.argv[2];
if (!root) {
  console.error('usage: node tools/linux-audit.js <bundleRoot>');
  process.exit(2);
}

/** Characters that are legal on macOS but problematic or illegal on Linux. */
const NUL = /\0/;

async function findBundles(dir, out = [], depth = 0) {
  if (depth > 32) return out;
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return out; }
  const hasResources = entries.some((e) => e.isDirectory() && e.name === 'resources');
  const project = entries.find((e) => e.isFile() && /\.(mmpz|mmp)$/i.test(e.name));
  if (hasResources && project) {
    out.push({ dir, project: path.join(dir, project.name) });
    return out;
  }
  for (const e of entries) {
    if (e.isDirectory() && !e.isSymbolicLink()) await findBundles(path.join(dir, e.name), out, depth + 1);
  }
  return out;
}

(async () => {
  const bundles = await findBundles(path.resolve(root));
  console.log(`auditing ${bundles.length} bundle(s) for Linux portability\n`);

  const problems = [];
  let totalRefs = 0;

  for (const b of bundles) {
    const label = path.relative(path.resolve(root), b.dir);
    const { text } = await bundle.readProject(b.project);
    const refs = bundle.collectReferences(text);
    totalRefs += refs.length;

    const resourcesDir = path.join(b.dir, 'resources');
    const onDisk = await fsp.readdir(resourcesDir);

    for (const ref of refs) {
      // 1. Nothing may point outside the bundle.
      if (!ref.src.startsWith('local:')) {
        problems.push(`${label}: absolute/external reference "${ref.src}"`);
        continue;
      }
      // 2. Backslashes break on Linux.
      if (ref.src.includes('\\')) {
        problems.push(`${label}: backslash in reference "${ref.src}"`);
      }
      // 3. Case-exact match — the macOS-vs-Linux trap.
      const name = path.basename(ref.src.slice('local:'.length));
      if (!onDisk.includes(name)) {
        const ci = onDisk.find((f) => f.toLowerCase() === name.toLowerCase());
        problems.push(
          ci
            ? `${label}: CASE MISMATCH — project wants "${name}", disk has "${ci}" (works on macOS, FAILS on Linux)`
            : `${label}: missing resource "${name}"`
        );
      }
      // 4. NUL / path separators inside a filename.
      if (NUL.test(name) || name.includes('/')) {
        problems.push(`${label}: illegal character in resource name "${name}"`);
      }
    }

    // 5. Resource filenames that collide case-insensitively would have been
    //    merged on macOS but stay distinct on Linux (and vice versa).
    const lower = new Map();
    for (const f of onDisk) {
      const k = f.toLowerCase();
      if (lower.has(k)) problems.push(`${label}: case-colliding resources "${lower.get(k)}" and "${f}"`);
      lower.set(k, f);
    }
  }

  console.log(`references checked: ${totalRefs}`);
  if (problems.length === 0) {
    console.log('\nNo Linux portability problems found:');
    console.log('  - every reference uses the relative local: prefix');
    console.log('  - no backslashes');
    console.log('  - every resource matches its reference with exact case');
    console.log('  - no case-colliding filenames');
    process.exit(0);
  }

  console.log(`\n${problems.length} problem(s):`);
  for (const p of problems.slice(0, 40)) console.log('  ' + p);
  process.exit(1);
})().catch((err) => {
  console.error('audit failed:', err.message);
  process.exit(1);
});
