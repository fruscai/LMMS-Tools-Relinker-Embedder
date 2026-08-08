'use strict';
/**
 * Independent verification that a .mmpz produced by the WEB build is
 * byte-for-byte what LMMS reads back.
 *
 * Usage: node tests/verify-web-output.js <browser-produced.mmpz>
 */

const fs = require('fs');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { decompressMmpz, compressMmpz } = require('../src/core/mmpz');
const { replacePathRoot } = require('../src/core/pathReplace');

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

const OLD_PASTED = 'C:\\Users\\Administrator\\Desktop\\future_garage_original\\';
const NEW_PATH = '/Users/aminebouzaher/Documents/lmms/samples/gig/';
const LMMS = '/Applications/LMMS.app/Contents/MacOS/lmms';

const browserFile = process.argv[2];
if (!browserFile) {
  console.error('usage: node tests/verify-web-output.js <file.mmpz>');
  process.exit(2);
}

// 1. Independently reconstruct the XML we expect, using the Node core.
const sourceXml = decompressMmpz(
  fs.readFileSync(require('path').join(__dirname, 'fixtures', 'fixture.mmpz'))
).toString('utf8');
const replaced = replacePathRoot(sourceXml, OLD_PASTED, NEW_PATH);
const intended = Buffer.from(replaced.text, 'utf8');

// 2. What the browser actually produced.
const browserBytes = fs.readFileSync(browserFile);
const fromBrowser = decompressMmpz(browserBytes);

// 3. What LMMS itself recovers from that same file.
const dump = execFileSync(LMMS, ['-d', browserFile], { maxBuffer: 5e8 });
const lmmsXml =
  dump.length === fromBrowser.length + 1 && dump[dump.length - 1] === 0x0a
    ? dump.subarray(0, fromBrowser.length)
    : dump;

// 4. A Node-built equivalent, to isolate the only real difference.
const nodeBytes = compressMmpz(intended);

const results = [
  ['occurrences replaced', replaced.occurrences],
  ['intended XML bytes', intended.length],
  ['browser XML bytes', fromBrowser.length],
  ['LMMS-recovered bytes', lmmsXml.length],
];
for (const [k, v] of results) console.log(k.padEnd(24), v);

console.log('');
console.log('sha intended            ', sha(intended));
console.log('sha browser decompressed', sha(fromBrowser));
console.log('sha LMMS recovered      ', sha(lmmsXml));

console.log('');
const a = fromBrowser.equals(intended);
const b = lmmsXml.equals(intended);
const c = lmmsXml.equals(fromBrowser);
console.log('browser output == intended XML :', a);
console.log('LMMS recovered == intended XML :', b);
console.log('LMMS recovered == browser bytes:', c);

console.log('');
console.log('--- the only difference is the compressed container ---');
console.log('compressed size   node:', nodeBytes.length, ' browser:', browserBytes.length,
            ' delta:', browserBytes.length - nodeBytes.length, 'bytes');
console.log('length prefix     node:', nodeBytes.readUInt32BE(0),
            ' browser:', browserBytes.readUInt32BE(0),
            ' identical:', nodeBytes.readUInt32BE(0) === browserBytes.readUInt32BE(0));
console.log('zlib header       node:', nodeBytes.subarray(4, 6).toString('hex'),
            ' browser:', browserBytes.subarray(4, 6).toString('hex'));

process.exit(a && b && c ? 0 : 1);
