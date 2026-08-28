'use strict';
/**
 * Sample resolution for the embedder, loaded from the shipped standalone tool.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadCore() {
  const file = path.join(__dirname, '..', 'web', 'lmms-sample-embedder.html');
  const html = fs.readFileSync(file, 'utf8');
  const start = html.indexOf('/* CORE START');
  const end = html.indexOf('/* CORE END */');
  assert.ok(start !== -1 && end > start, 'no CORE block in the embedder');
  const context = {
    console,
    LMMS_PREFIX: /^(factorysample|usersample|usergig|usersoundfont|local):/i,
    xmlUnescape: (v) => String(v)
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'").replace(/&amp;/g, '&'),
  };
  vm.createContext(context);
  vm.runInContext(html.slice(start, end), context);
  return context;
}

const E = loadCore();
const index = (...paths) => new Map(paths.map((p) => [p, async () => p]));

test('a bare filename resolves when only one file carries it', () => {
  const r = E.resolveSample('usergig:Kick.wav', index('Kick.wav'), new Map());
  assert.strictEqual(r.status, 'found');
  assert.strictEqual(r.key, 'Kick.wav');
});

test('the same filename in two folders is ambiguous, never guessed', () => {
  const r = E.resolveSample('usergig:Kick.wav', index('A/Kick.wav', 'B/Kick.wav'), new Map());
  assert.strictEqual(r.status, 'ambiguous');
  assert.strictEqual(r.candidates.length, 2);
});

test('an exact full path wins over duplicate filenames', () => {
  const r = E.resolveSample('A/Kick.wav', index('A/Kick.wav', 'B/Kick.wav'), new Map());
  assert.strictEqual(r.status, 'found');
  assert.strictEqual(r.key, 'A/Kick.wav');
});

test('the longest unique suffix resolves a nested reference', () => {
  const samples = index('samples/drums/A/Kick.wav', 'samples/drums/B/Kick.wav');
  const r = E.resolveSample('C:/Old/Session/A/Kick.wav', samples, new Map());
  assert.strictEqual(r.status, 'found');
  assert.strictEqual(r.key, 'samples/drums/A/Kick.wav');
});

test('a windows reference matches a unix indexed path', () => {
  const r = E.resolveSample('C:\\Old\\Audio\\Kick.wav', index('Audio/Kick.wav'), new Map());
  assert.strictEqual(r.status, 'found');
});

test('a missing sample is reported as missing, not ambiguous', () => {
  const r = E.resolveSample('usergig:Nope.wav', index('Kick.wav'), new Map());
  assert.strictEqual(r.status, 'missing');
});

test('a user choice resolves an ambiguous reference and is reused', () => {
  const samples = index('A/Kick.wav', 'B/Kick.wav');
  const choices = new Map([['usergig:Kick.wav', 'B/Kick.wav']]);
  const r = E.resolveSample('usergig:Kick.wav', samples, choices);
  assert.strictEqual(r.status, 'found');
  assert.strictEqual(r.key, 'B/Kick.wav');
  const again = E.resolveSample('usergig:Kick.wav', samples, choices);
  assert.strictEqual(again.key, 'B/Kick.wav');
});

test('a stale choice does not resolve to a file that is gone', () => {
  const choices = new Map([['usergig:Kick.wav', 'B/Kick.wav']]);
  const r = E.resolveSample('usergig:Kick.wav', index('A/Kick.wav'), choices);
  assert.strictEqual(r.status, 'found');
  assert.strictEqual(r.key, 'A/Kick.wav');
});

test('case differences in the path still match on a case-insensitive volume', () => {
  const r = E.resolveSample('usergig:KICK.wav', index('audio/Kick.wav'), new Map());
  assert.strictEqual(r.status, 'found');
});

test('an ampersand in the name resolves', () => {
  const r = E.resolveSample('usergig:R&B Piano 83BPM.wav', index('R&B Piano 83BPM.wav'), new Map());
  assert.strictEqual(r.status, 'found');
});

test('an escaped ampersand from the raw XML resolves to the real filename', () => {
  const r = E.resolveSample('usergig:R&amp;B Piano 83BPM.wav', index('R&B Piano 83BPM.wav'), new Map());
  assert.strictEqual(r.status, 'found');
  assert.strictEqual(r.key, 'R&B Piano 83BPM.wav');
});

test('path suffixes are produced longest first', () => {
  assert.deepStrictEqual([...E.suffixes('a/b/c.wav')], ['a/b/c.wav', 'b/c.wav', 'c.wav']);
});
