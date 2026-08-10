'use strict';
/** Show every element and attribute that mentions a given string. */
const fs = require('fs');
const path = require('path');
const { decompressMmpz } = require('../src/core/mmpz');

const [, , file, needle = 'empty.wav'] = process.argv;
const raw = fs.readFileSync(file);
const xml = (/\.mmpz(\.bak)?$/i.test(file) ? decompressMmpz(raw) : raw).toString('utf8');

const seen = new Map();
for (const m of xml.matchAll(/<[^>]*>/g)) {
  const tag = m[0];
  if (!tag.includes(needle)) continue;
  const name = (tag.match(/^<([A-Za-z0-9_:-]+)/) || [])[1];
  for (const a of tag.matchAll(/([A-Za-z0-9_:-]+)="([^"]*)"/g)) {
    if (!a[2].includes(needle)) continue;
    const key = `${name}  ${a[1]}="${a[2]}"`;
    seen.set(key, (seen.get(key) || 0) + 1);
  }
}

console.log(`elements mentioning "${needle}":`);
for (const [k, n] of seen) console.log(`  ${n}x  <${k}>`);

const first = xml.match(/<[^>]*empty\.wav[^>]*>/);
if (first) {
  console.log('\nfirst full element:');
  console.log('  ' + first[0].slice(0, 400));
}
