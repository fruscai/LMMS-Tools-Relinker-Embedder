'use strict';
/**
 * Compression-layer tests (spec TESTS 1, 2, 4, 8 + golden-file checks).
 *
 * Fixtures are genuine LMMS output, not synthesised XML, so these tests
 * exercise the real format rather than our own idea of it.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const { decompressMmpz, compressMmpz, looksLikeMmpz, MmpzError } = require('../src/core/mmpz');

const FIXTURES = path.join(__dirname, 'fixtures');
const fixture = (name) => path.join(FIXTURES, name);
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** Locate an LMMS binary for the interoperability tests, if one is installed. */
function findLmms() {
  const candidates = [
    '/Applications/LMMS.app/Contents/MacOS/lmms',
    '/usr/bin/lmms',
    '/usr/local/bin/lmms',
  ];
  return candidates.find((c) => fs.existsSync(c)) || null;
}

test('rejects files shorter than 5 bytes', () => {
  assert.throws(
    () => decompressMmpz(fs.readFileSync(fixture('truncated.mmpz'))),
    (err) => err instanceof MmpzError && err.code === 'TOO_SHORT'
  );
});

test('TEST 8 — corrupt mmpz is rejected, never silently accepted', () => {
  assert.throws(
    () => decompressMmpz(fs.readFileSync(fixture('corrupt.mmpz'))),
    (err) => err instanceof MmpzError && err.code === 'INFLATE_FAILED'
  );
});

test('rejects an absurd declared decompressed size', () => {
  // 0xFFFFFFFF declared, tiny stream: must fail before allocating.
  const bomb = Buffer.concat([
    Buffer.from([0xff, 0xff, 0xff, 0xff]),
    compressMmpz(Buffer.from('x')).subarray(4),
  ]);
  assert.throws(
    () => decompressMmpz(bomb, { maxDecompressed: 1024 }),
    (err) => err.code === 'DECLARED_SIZE_TOO_LARGE'
  );
});

test('rejects a length-prefix that disagrees with the payload', () => {
  const good = compressMmpz(Buffer.from('<?xml version="1.0"?><lmms-project/>'));
  const tampered = Buffer.from(good);
  tampered.writeUInt32BE(999999, 0);
  assert.throws(
    () => decompressMmpz(tampered),
    (err) => err.code === 'LENGTH_MISMATCH'
  );
});

test('the 4-byte prefix is the uncompressed length, big-endian', () => {
  const payload = Buffer.from('hello lmms', 'utf8');
  const compressed = compressMmpz(payload);
  assert.strictEqual(compressed.readUInt32BE(0), payload.length);
  // zlib stream, not gzip: gzip would start 1f 8b.
  assert.strictEqual(compressed[4] & 0x0f, 8, 'expected zlib deflate CMF');
  assert.notStrictEqual(compressed.subarray(4, 6).toString('hex'), '1f8b');
});

test('genuine LMMS .mmpz decompresses and declares its true length', () => {
  const raw = fs.readFileSync(fixture('fixture.mmpz'));
  assert.ok(looksLikeMmpz(raw));
  const xml = decompressMmpz(raw);
  assert.strictEqual(raw.readUInt32BE(0), xml.length);
  assert.match(xml.subarray(0, 200).toString('utf8'), /<!DOCTYPE lmms-project>/);
});

test('TEST 2 — XML -> compressMmpz -> decompressMmpz returns the original bytes exactly', () => {
  const original = fs.readFileSync(fixture('fixture.mmp'));
  const roundTripped = decompressMmpz(compressMmpz(original));
  assert.ok(roundTripped.equals(original), 'round trip must be byte-exact');
  assert.strictEqual(sha256(roundTripped), sha256(original));
});

test('TEST 2 — round trip holds for Unicode project content', () => {
  const original = fs.readFileSync(fixture('unicode.mmp'));
  const roundTripped = decompressMmpz(compressMmpz(original));
  assert.ok(roundTripped.equals(original));
});

test('empty payload matches qCompress behaviour (four zero bytes)', () => {
  assert.ok(compressMmpz(Buffer.alloc(0)).equals(Buffer.alloc(4)));
});

test('TEST 4 — our compression is interchangeable with the LMMS-produced container', (t) => {
  // Decompress a genuine LMMS .mmpz, recompress it ourselves, and confirm the
  // XML recovered from each is identical. This is the real compatibility bar.
  const lmmsProduced = fs.readFileSync(fixture('fixture.mmpz'));
  const xmlFromLmms = decompressMmpz(lmmsProduced);

  const ourProduced = compressMmpz(xmlFromLmms);
  const xmlFromOurs = decompressMmpz(ourProduced);

  assert.strictEqual(sha256(xmlFromOurs), sha256(xmlFromLmms));

  // Byte equality of the compressed streams is informative, not required.
  // On this toolchain it does hold; see docs/LMMS_FORMAT_NOTES.md.
  const byteIdentical = ourProduced.equals(lmmsProduced);
  t.diagnostic(
    `compressed stream byte-identical to LMMS: ${byteIdentical} (zlib ${process.versions.zlib})`
  );
});

test('golden file — decompressed bytes are stable across runs', () => {
  const xml = decompressMmpz(fs.readFileSync(fixture('fixture.mmpz')));
  const goldenPath = fixture('fixture.mmp.sha256');

  const digest = sha256(xml);
  if (!fs.existsSync(goldenPath)) {
    fs.writeFileSync(goldenPath, digest + '\n', 'utf8');
  }
  assert.strictEqual(digest, fs.readFileSync(goldenPath, 'utf8').trim());
});

test('TEST 1 — decompressMmpz matches `lmms -d` output', (t) => {
  const lmms = findLmms();
  if (!lmms) return t.skip('LMMS is not installed on this machine');

  const ours = decompressMmpz(fs.readFileSync(fixture('fixture.mmpz')));
  const dumped = execFileSync(lmms, ['-d', fixture('fixture.mmpz')], {
    maxBuffer: 512 * 1024 * 1024,
  });

  // The CLI dump appends a single trailing newline that is not part of the
  // stored project bytes; everything before it must match exactly.
  const trimmed =
    dumped.length === ours.length + 1 && dumped[dumped.length - 1] === 0x0a
      ? dumped.subarray(0, ours.length)
      : dumped;

  assert.strictEqual(sha256(trimmed), sha256(ours));
});
