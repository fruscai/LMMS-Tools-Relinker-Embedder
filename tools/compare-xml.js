'use strict';
/**
 * compare-xml.js — how much of a project's XML actually changed?
 *
 * Answers the fidelity question directly: is everything other than the sample
 * paths byte-identical?
 *
 * Usage: node tools/compare-xml.js <a.mmpz|a.mmp> <b.mmpz|b.mmp>
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { decompressMmpz } = require('../src/core/mmpz');

const load = (p) => {
  const raw = fs.readFileSync(p);
  return (path.extname(p).toLowerCase() === '.mmpz' ? decompressMmpz(raw) : raw).toString('utf8');
};

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);

/** Blank every src="..." value so only NON-path differences remain. */
const maskSrc = (text) => text.replace(/\bsrc="[^"]*"/g, 'src="<MASKED>"');

const [, , fileA, fileB] = process.argv;
if (!fileA || !fileB) {
  console.error('usage: node tools/compare-xml.js <a> <b>');
  process.exit(2);
}

const a = load(fileA);
const b = load(fileB);

console.log(`A: ${path.basename(fileA)}  ${a.length} bytes  sha ${sha(a)}`);
console.log(`B: ${path.basename(fileB)}  ${b.length} bytes  sha ${sha(b)}`);
console.log(`identical: ${a === b}`);

const ma = maskSrc(a);
const mb = maskSrc(b);
console.log(`\nwith every src="…" masked out:`);
console.log(`  A ${ma.length} bytes sha ${sha(ma)}`);
console.log(`  B ${mb.length} bytes sha ${sha(mb)}`);
console.log(`  IDENTICAL APART FROM PATHS: ${ma === mb}`);

if (ma !== mb) {
  const la = ma.split('\n');
  const lb = mb.split('\n');
  console.log(`\n  line count: ${la.length} vs ${lb.length}`);

  // First differing line, for a concrete example.
  const n = Math.min(la.length, lb.length);
  let shown = 0;
  for (let i = 0; i < n && shown < 4; i++) {
    if (la[i] !== lb[i]) {
      console.log(`\n  first difference at line ${i + 1}:`);
      console.log(`    A: ${la[i].trim().slice(0, 150)}`);
      console.log(`    B: ${lb[i].trim().slice(0, 150)}`);
      shown++;
      break;
    }
  }

  // Structural fingerprint: element name counts.
  const tags = (t) => {
    const m = new Map();
    for (const x of t.matchAll(/<([A-Za-z0-9_:-]+)[\s/>]/g)) m.set(x[1], (m.get(x[1]) || 0) + 1);
    return m;
  };
  const ta = tags(a);
  const tb = tags(b);
  const all = new Set([...ta.keys(), ...tb.keys()]);
  const diffs = [...all].filter((k) => (ta.get(k) || 0) !== (tb.get(k) || 0));
  console.log(`\n  element counts differing: ${diffs.length ? diffs.length : 'none'}`);
  for (const d of diffs.slice(0, 12)) {
    console.log(`    ${d.padEnd(24)} A=${ta.get(d) || 0}  B=${tb.get(d) || 0}`);
  }

  // Whitespace / formatting fingerprint.
  const ws = (t) => ({
    lines: t.split('\n').length,
    tabs: (t.match(/\t/g) || []).length,
    crlf: (t.match(/\r\n/g) || []).length,
  });
  console.log('\n  formatting:', JSON.stringify(ws(a)), 'vs', JSON.stringify(ws(b)));
}
