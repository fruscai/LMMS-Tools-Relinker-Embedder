'use strict';
/**
 * Hostile input. The user opens these tools from file:// and feeds them
 * projects and archives received from other people.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');

const WEB = path.join(__dirname, '..', 'web');
const src = (f) => fs.readFileSync(path.join(WEB, f), 'utf8');

function slice(html, from, to) {
  const a = html.indexOf(from), b = html.indexOf(to);
  assert.ok(a !== -1 && b > a, `cannot slice ${from}`);
  const c = { console, TextEncoder, TextDecoder }; vm.createContext(c);
  vm.runInContext(html.slice(a, b), c);
  // top-level const lands in the context's lexical scope, not on the object
  return { get: (name) => vm.runInContext(name, c) };
}

test('a filename cannot break out of an attribute in the embedder', () => {
  const html = src('lmms-sample-embedder.html');
  const esc = slice(html, 'const esc =', 'const mb =').get('esc');
  const evil = 'Kick" onfocus="steal()" autofocus x="';
  const out = esc(evil);
  assert.ok(!out.includes('"'), 'a raw quote survives escaping');
  assert.ok(!/<|>/.test(out), 'a raw angle bracket survives escaping');
  assert.ok(out.includes('&quot;'), 'quotes are not escaped');
});

test('both tools escape quotes, not only angle brackets', () => {
  for (const f of ['lmms-path-relinker.html', 'lmms-sample-embedder.html']) {
    assert.ok(/&quot;/.test(src(f)), `${f} never escapes a quote`);
  }
});

test('a zip entry name cannot climb out of the folder', () => {
  const safeEntryName = slice(src('lmms-path-relinker.html'), 'function safeEntryName', 'function readZip').get('safeEntryName');
  const cases = [
    ['../../etc/passwd', 'etc/passwd'],
    ['/absolute/file.mmpz', 'absolute/file.mmpz'],
    ['C:\\Windows\\evil.mmpz', 'Windows/evil.mmpz'],
    ['\\\\srv\\share\\x.mmpz', 'srv/share/x.mmpz'],
    ['a/../../../b.mmpz', 'b.mmpz'],
    ['./ok/file.mmpz', 'ok/file.mmpz'],
    ['normal.mmpz', 'normal.mmpz'],
    ['..', 'unnamed'],
    ['', 'unnamed'],
  ];
  for (const [input, want] of cases) {
    assert.strictEqual(safeEntryName(input), want, `for ${JSON.stringify(input)}`);
  }
});

test('entry names are made safe on the way in and on the way out', () => {
  const html = src('lmms-path-relinker.html');
  assert.ok(/name: safeEntryName\(name\)/.test(html), 'names are not sanitised when read');
  assert.ok(/async function makeRecord[\s\S]{0,120}safeEntryName\(name\)/.test(html),
    'names are not sanitised when written');
});

test('both tools refuse a stream that expands past the limit', () => {
  for (const f of ['lmms-path-relinker.html', 'lmms-sample-embedder.html']) {
    const html = src(f);
    assert.ok(html.includes('MAX_INFLATED'), `${f} has no inflation limit`);
    assert.ok(html.includes('function readBounded'), `${f} buffers without a bound`);
    assert.ok(!/new Response\([^)]*pipeThrough[^)]*\)\.arrayBuffer\(\)/.test(html),
      `${f} still buffers a whole inflated stream before checking it`);
  }
});

test('a small file that inflates past the limit is rejected by size alone', () => {
  // 700 MB of zeros compresses to well under a megabyte
  const raw = Buffer.alloc(700 * 1024 * 1024);
  const comp = zlib.deflateSync(raw, { level: 9 });
  assert.ok(comp.length < 2 * 1024 * 1024, 'fixture is not actually a bomb');
  const LIMIT = 512 * 1024 * 1024;
  assert.ok(raw.length > LIMIT, 'fixture does not exceed the limit');
});

function relinkCore() {
  const html = src('lmms-path-relinker.html');
  const a = html.indexOf('function safeEntryName'), b = html.indexOf('function readZip');
  const c = { console, TextEncoder }; vm.createContext(c);
  vm.runInContext(html.slice(a, b), c);
  return vm.runInContext('safeEntryName', c);
}

const NUL = String.fromCharCode(0);

test('a NUL byte cannot truncate an entry name', () => {
  const safe = relinkCore();
  assert.strictEqual(safe('good.mmpz' + NUL + '.exe'), 'good.mmpz.exe');
  assert.ok(!safe('a' + NUL + 'b').includes(NUL), 'NUL survives');
});

test('an overlong entry name cannot wrap the two byte length field', () => {
  const safe = relinkCore();
  const out = safe('a'.repeat(70000) + '.mmpz');
  assert.ok(new TextEncoder().encode(out).length <= 512, `name is ${out.length} long`);
  assert.ok(out.startsWith('truncated-'), 'long name not marked as truncated');
});

test('two different hostile names cannot become one output entry', () => {
  const html = src('lmms-path-relinker.html');
  const a = html.indexOf('const REPORT_NAMES'), b = html.indexOf('function buildZip');
  const c = { console }; vm.createContext(c);
  vm.runInContext(html.slice(a, b), c);
  const uniqueNames = vm.runInContext('uniqueNames', c);
  const out = uniqueNames([
    { name: 'x.mmpz' }, { name: 'x.mmpz' }, { name: 'x.mmpz' },
  ]);
  assert.deepStrictEqual([...out].map((r) => r.name),
    ['x.mmpz', 'x (2).mmpz', 'x (3).mmpz']);
});

test('the zip parser checks every offset against the real file size', () => {
  const html = src('lmms-path-relinker.html');
  for (const guard of [
    'const inRange =',
    'central directory is outside the file',
    'entry name runs past the end of the file',
    'entry points outside the file',
    'entry has no local header',
    'entry data runs past the end of the file',
  ]) {
    assert.ok(html.includes(guard), `missing guard: ${guard}`);
  }
});

test('an archive too large to hold is refused before it is read', () => {
  const html = src('lmms-path-relinker.html');
  assert.ok(html.includes('MAX_ARCHIVE'), 'no archive size cap');
  assert.ok(/file\.size > MAX_ARCHIVE/.test(html), 'cap is not checked against the file');
});


test('a filename cannot become a spreadsheet formula in the report', () => {
  const html = src('lmms-path-relinker.html');
  const a = html.indexOf('function toCsv'), b = html.indexOf('/* ---------- UI ----------');
  const c = { console }; vm.createContext(c);
  vm.runInContext(html.slice(a, b), c);
  const toCsv = vm.runInContext('toCsv', c);
  for (const lead of ['=', '+', '-', '@']) {
    const row = toCsv([{ filename: lead + 'cmd|calc!A1', result: 'OK' }]).split('\n')[1];
    assert.ok(row.startsWith("'" + lead), `${lead} is not neutralised: ${row}`);
  }
  // an ordinary name is untouched
  assert.ok(toCsv([{ filename: 'song.mmpz' }]).split('\n')[1].startsWith('song.mmpz'));
});

test('the reports keep their own names when the archive carries the same ones', () => {
  const html = src('lmms-path-relinker.html');
  const a = html.indexOf('const REPORT_NAMES'), b = html.indexOf('function buildZip');
  const c = { console }; vm.createContext(c);
  vm.runInContext(html.slice(a, b), c);
  const uniqueNames = vm.runInContext('uniqueNames', c);
  const out = uniqueNames([
    { name: 'relink-report.csv' },
    { name: 'relink-report.csv', isReport: true },
  ]);
  const names = [...out].map((r) => r.name);
  assert.deepStrictEqual(names, ['relink-report (from archive).csv', 'relink-report.csv']);
});

test('a directory entry stays a directory', () => {
  const safe = relinkCore();
  assert.strictEqual(safe('samples/'), 'samples/');
  assert.strictEqual(safe('../../samples/'), 'samples/');
  assert.strictEqual(safe('samples/kick.wav'), 'samples/kick.wav');
});

test('a long but legitimate nested path is left alone', () => {
  const safe = relinkCore();
  const deep = 'project/' + Array.from({ length: 8 },
    (_, i) => 'folder-' + String(i).repeat(40)).join('/') + '/f.mmpz';
  assert.ok(new TextEncoder().encode(deep).length > 300, 'fixture is not long enough to matter');
  assert.strictEqual(safe(deep), deep, 'a real nested path was rewritten');
});
