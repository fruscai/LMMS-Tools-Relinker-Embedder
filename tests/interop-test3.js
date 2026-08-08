'use strict';
/**
 * TEST 3 helper — produce a repaired .mmpz for the LMMS interoperability check.
 *
 * Run: node tests/interop-test3.js
 * Then open / load the printed file with LMMS.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const engine = require('../src/core/engine');
const { decompressMmpz } = require('../src/core/mmpz');

// The path exactly as a Windows user would paste it out of LMMS's error dialog.
const OLD_PATH = 'C:\\Users\\Administrator\\Desktop\\future_garage_original\\';
const NEW_PATH = 'C:\\Users\\NewUser\\Documents\\lmms\\samples\\GIGS\\';

(async () => {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 't3-src-'));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 't3-out-'));

  fs.copyFileSync(path.join(__dirname, 'fixtures', 'fixture.mmpz'), path.join(src, 'song.mmpz'));

  const { summary, records } = await engine.repair(src, out, {
    oldPath: OLD_PATH,
    newPath: NEW_PATH,
  });

  console.log('summary:', JSON.stringify(summary));
  console.log('variants matched:', JSON.stringify(records[0].byVariant));

  const produced = path.join(out, 'song.mmpz');
  const xml = decompressMmpz(fs.readFileSync(produced)).toString('utf8');
  const srcs = [...new Set([...xml.matchAll(/src="([^"]+)"/g)].map((m) => m[1]))];
  console.log('sample paths now:');
  for (const s of srcs) console.log('   ', s);

  console.log('PRODUCED=' + produced);
})();
