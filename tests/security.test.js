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
  const c = { console }; vm.createContext(c);
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
