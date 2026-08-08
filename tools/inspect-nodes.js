'use strict';
/**
 * inspect-nodes.js — report which XML elements carry sample references.
 *
 * Used to derive the bundle scope filter from real projects rather than
 * assuming node names.
 *
 * Usage: node tools/inspect-nodes.js <project.mmp|project.mmpz> [...]
 */

const fs = require('fs');
const path = require('path');
const { decompressMmpz } = require('../src/core/mmpz');

const files = process.argv.slice(2);
if (!files.length) {
  console.error('usage: node tools/inspect-nodes.js <project> [...]');
  process.exit(2);
}

const bySrcTag = new Map();
const tagCounts = new Map();

for (const file of files) {
  const raw = fs.readFileSync(file);
  const xml = (path.extname(file).toLowerCase() === '.mmpz' ? decompressMmpz(raw) : raw)
    .toString('utf8');

  // Elements that carry a src attribute.
  for (const m of xml.matchAll(/<([A-Za-z0-9_:-]+)\b([^>]*)>/g)) {
    const tag = m[1];
    const attrs = m[2];
    tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);

    const src = attrs.match(/\bsrc="([^"]*)"/);
    if (!src) continue;
    if (!bySrcTag.has(tag)) bySrcTag.set(tag, { total: 0, examples: new Set() });
    const entry = bySrcTag.get(tag);
    entry.total += 1;
    if (entry.examples.size < 3) entry.examples.add(src[1] || '(empty)');
  }
}

console.log('=== elements carrying src="…" ===');
for (const [tag, info] of [...bySrcTag].sort((a, b) => b[1].total - a[1].total)) {
  console.log(`${tag.padEnd(24)} ${String(info.total).padStart(4)} refs`);
  for (const e of info.examples) console.log(`    e.g. ${e}`);
}

console.log('\n=== instrument-ish elements present ===');
for (const tag of ['sf2player', 'gigplayer', 'patman', 'audiofileprocessor',
                   'sampleclip', 'sampletco', 'vestige', 'slicert']) {
  const n = tagCounts.get(tag);
  if (n) console.log(`  ${tag.padEnd(22)} ${n}`);
}
