'use strict';
/**
 * Path-replacement tests (spec TESTS 5, 6, 7, 9).
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { replacePathRoot, buildVariants, xmlEscapeAttr } = require('../src/core/pathReplace');
const { decodeProjectText, validateProjectText } = require('../src/core/mmp');
const validator = require('../src/core/validator');

const FIXTURES = path.join(__dirname, 'fixtures');
const fixture = (name) => path.join(FIXTURES, name);
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

const REAL_OLD = 'C:/Users/Administrator/Desktop/future_garage_original/';
const REAL_NEW = 'C:/Users/NewUser/Documents/lmms/samples/GIGS/';

function loadFixtureText() {
  return decodeProjectText(fs.readFileSync(fixture('fixture.mmp'))).text;
}

test('TEST 5 — a single path changes and nothing else in the document moves', () => {
  const xml = '<?xml version="1.0"?><lmms-project><a src="/old/root/kick.wav"/><b keep="/old/rootx"/></lmms-project>';
  const result = replacePathRoot(xml, '/old/root/', '/new/place/');

  assert.strictEqual(result.occurrences, 1);
  assert.strictEqual(
    result.text,
    '<?xml version="1.0"?><lmms-project><a src="/new/place/kick.wav"/><b keep="/old/rootx"/></lmms-project>'
  );

  // Everything outside the replaced span is untouched.
  const before = xml.split('/old/root/kick.wav');
  const after = result.text.split('/new/place/kick.wav');
  assert.deepStrictEqual(before, after);
});

test('TEST 5 — the filename and any suffix after the root are preserved', () => {
  const xml = '<x src="C:/a/b/sub dir/Kick 01.wav"/>';
  const r = replacePathRoot(xml, 'C:/a/b/', 'D:/new root/');
  assert.strictEqual(r.text, '<x src="D:/new root/sub dir/Kick 01.wav"/>');
});

test('TEST 6 — every exact occurrence of the root is replaced', () => {
  const text = loadFixtureText();
  const expected = text.split(REAL_OLD).length - 1;
  assert.ok(expected > 1, 'fixture should contain several occurrences');

  const result = replacePathRoot(text, REAL_OLD, REAL_NEW);
  assert.strictEqual(result.occurrences, expected);
  assert.ok(!result.text.includes(REAL_OLD), 'no occurrence may remain');
  assert.strictEqual(result.text.split(REAL_NEW).length - 1, expected);
});

test('TEST 6 — unrelated sample references are left alone', () => {
  const text = loadFixtureText();
  const factoryBefore = text.split('factorysample:').length - 1;
  const result = replacePathRoot(text, REAL_OLD, REAL_NEW);
  assert.strictEqual(result.text.split('factorysample:').length - 1, factoryBefore);
});

test('TEST 7 — a non-matching path leaves the project completely unchanged', () => {
  const text = loadFixtureText();
  const result = replacePathRoot(text, 'Z:/nothing/here/', REAL_NEW);

  assert.strictEqual(result.occurrences, 0);
  assert.strictEqual(result.changed, false);
  assert.strictEqual(sha256(result.text), sha256(text));
});

test('LMMS stores Windows paths with forward slashes; separator variants find them', () => {
  const text = loadFixtureText();
  // What a Windows user actually pastes out of the LMMS error dialog.
  const pastedByUser = 'C:\\Users\\Administrator\\Desktop\\future_garage_original\\';

  const off = replacePathRoot(text, pastedByUser, REAL_NEW, {
    matchSeparatorVariants: false,
  });
  assert.strictEqual(off.occurrences, 0, 'literal-only matching cannot find it');

  const on = replacePathRoot(text, pastedByUser, REAL_NEW);
  assert.ok(on.occurrences > 0, 'separator-variant matching finds it');
  assert.ok(on.text.includes(REAL_NEW));
});

test('the replacement adopts the separator style of the form it matched', () => {
  const xml = '<x src="C:/a/b/kick.wav"/>';
  // User supplies both sides with backslashes; the file stores forward slashes.
  const r = replacePathRoot(xml, 'C:\\a\\b\\', 'D:\\new\\root\\');
  assert.strictEqual(r.text, '<x src="D:/new/root/kick.wav"/>');
  assert.ok(!r.text.includes('\\'), 'must not mix separator styles inside a path');
});

test('separator variants are reported so the preview can show what matched', () => {
  const xml = '<x src="C:/a/b/kick.wav"/>';
  const r = replacePathRoot(xml, 'C:\\a\\b\\', 'D:/new/');
  assert.deepStrictEqual(Object.keys(r.byVariant), ['forward-slash']);
});

test('XML-escaped paths are matched and re-escaped, not double-escaped', () => {
  const oldRoot = 'C:/Rock & Roll/samples/';
  const newRoot = 'C:/Jazz & Blues/audio/';
  const xml = `<x src="${xmlEscapeAttr(oldRoot)}kick.wav"/>`;
  assert.ok(xml.includes('&amp;'));

  const r = replacePathRoot(xml, oldRoot, newRoot);
  assert.strictEqual(r.occurrences, 1);
  assert.strictEqual(r.text, '<x src="C:/Jazz &amp; Blues/audio/kick.wav"/>');
  assert.ok(!r.text.includes('&amp;amp;'), 'must not double-escape');
});

test('TEST 9 — Unicode, accents and spaces survive replacement exactly', () => {
  const text = decodeProjectText(fs.readFileSync(fixture('unicode.mmp'))).text;
  const oldRoot = 'C:/Users/Bö/Desktop/Échantillons ünïcode/日本語/';
  const newRoot = 'D:/Müzik/Örnekler/サンプル/';

  const occurrencesBefore = text.split(oldRoot).length - 1;
  assert.ok(occurrencesBefore > 0);

  const r = replacePathRoot(text, oldRoot, newRoot);
  assert.strictEqual(r.occurrences, occurrencesBefore);
  assert.ok(r.text.includes(newRoot));
  assert.ok(!r.text.includes(oldRoot));

  // Re-encoding must be lossless.
  const bytes = Buffer.from(r.text, 'utf8');
  assert.strictEqual(bytes.toString('utf8'), r.text);
});

test('replacement never re-matches text it just inserted', () => {
  // Replacing a root with something that contains the old root must terminate
  // and must apply exactly once per original occurrence.
  const xml = '<x src="/a/kick.wav"/><y src="/a/snare.wav"/>';
  const r = replacePathRoot(xml, '/a/', '/a/nested/');
  assert.strictEqual(r.occurrences, 2);
  assert.strictEqual(r.text, '<x src="/a/nested/kick.wav"/><y src="/a/nested/snare.wav"/>');
});

test('the modified document is still a valid LMMS project', () => {
  const text = loadFixtureText();
  const r = replacePathRoot(text, REAL_OLD, REAL_NEW);
  assert.ok(validateProjectText(r.text).valid);
  assert.ok(validator.verifyStillValidProject(r.text).ok);
});

test('the document length changes by exactly the expected delta', () => {
  const text = loadFixtureText();
  const variants = buildVariants(REAL_OLD, REAL_NEW, {});
  const r = replacePathRoot(text, REAL_OLD, REAL_NEW);

  const check = validator.verifyDeltaConsistent(
    text,
    r.text,
    r.occurrences,
    variants,
    r.byVariant
  );
  assert.ok(check.ok, check.reason);
  assert.strictEqual(
    r.text.length - text.length,
    r.occurrences * (REAL_NEW.length - REAL_OLD.length)
  );
});

test('an empty old path is refused rather than matching everywhere', () => {
  assert.throws(() => replacePathRoot('<x/>', '', '/new/'));
});
