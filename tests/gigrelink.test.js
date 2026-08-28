'use strict';
/**
 * Automatic gig-folder relinking, loaded from the shipped standalone tool so
 * these run against the same code the browser runs.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadCore(file) {
  const html = fs.readFileSync(path.join(__dirname, '..', 'web', file), 'utf8');
  const start = html.indexOf('/* CORE START');
  const end = html.indexOf('/* CORE END */');
  assert.ok(start !== -1 && end > start, `no CORE block in ${file}`);
  const context = { module: {}, console };
  vm.createContext(context);
  vm.runInContext(html.slice(start, end), context);
  return context;
}

const R = loadCore('lmms-path-relinker.html');

const node = (src) => `<sampleclip pos="0" src="${src}" len="192"/>`;
const doc = (...srcs) => `<?xml version="1.0"?><lmms-project>${srcs.map(node).join('')}</lmms-project>`;

test('an external Windows path becomes a usergig reference', () => {
  const r = R.applyAutoGig(doc('C:/Users/Old/Desktop/Audio/Kick.wav'));
  assert.match(r.text, /src="usergig:Kick\.wav"/);
  assert.strictEqual(r.occurrences, 1);
});

test('a unix absolute path becomes a usergig reference', () => {
  const r = R.applyAutoGig(doc('/home/user/samples/Snare.wav'));
  assert.match(r.text, /src="usergig:Snare\.wav"/);
});

test('a bare relative path becomes a usergig reference', () => {
  const r = R.applyAutoGig(doc('Audio Files/Chords.wav'));
  assert.match(r.text, /src="usergig:Chords\.wav"/);
});

test('an existing usergig reference is left alone', () => {
  const src = 'usergig:Piano.wav';
  const r = R.applyAutoGig(doc(src));
  assert.strictEqual(r.occurrences, 0);
  assert.match(r.text, /src="usergig:Piano\.wav"/);
});

test('a local reference is left alone', () => {
  const r = R.applyAutoGig(doc('local:resources/Kick.wav'));
  assert.strictEqual(r.occurrences, 0);
  assert.match(r.text, /src="local:resources\/Kick\.wav"/);
});

test('a factory sample is left alone', () => {
  const r = R.applyAutoGig(doc('factorysample:drumsynth/misc/clap.ds'));
  assert.strictEqual(r.occurrences, 0);
});

test('a bare factory directory path is left alone', () => {
  const r = R.applyAutoGig(doc('drums/kick_hiphop01.ogg'));
  assert.strictEqual(r.occurrences, 0);
});

test('classification names each prefix explicitly', () => {
  assert.strictEqual(R.classifyRef('local:a.wav'), 'portable');
  assert.strictEqual(R.classifyRef('usergig:a.wav'), 'portable');
  assert.strictEqual(R.classifyRef('usersample:a.wav'), 'portable');
  assert.strictEqual(R.classifyRef('factorysample:a.ds'), 'portable');
  assert.strictEqual(R.classifyRef('drums/a.ogg'), 'stock');
  assert.strictEqual(R.classifyRef('C:/x/a.wav'), 'external');
  assert.strictEqual(R.classifyRef('/x/a.wav'), 'external');
  assert.strictEqual(R.classifyRef('Audio/a.wav'), 'external');
});

test('windows backslashes are matched the same as forward slashes', () => {
  const r = R.applyAutoGig(doc('C:\\\\Users\\\\Old\\\\Audio\\\\Kick.wav'));
  assert.match(r.text, /src="usergig:Kick\.wav"/);
});

test('an XML entity in the name survives the rewrite', () => {
  const r = R.applyAutoGig(doc('usergig:R&amp;B Piano 83BPM.wav'));
  assert.strictEqual(r.occurrences, 0);
  const ext = R.applyAutoGig(doc('C:/Old/R&amp;B Piano 83BPM.wav'));
  assert.match(ext.text, /src="usergig:R&amp;B Piano 83BPM\.wav"/);
});

test('two different samples sharing a filename are reported as a collision', () => {
  const refs = ['C:/Old/A/Kick.wav', 'C:/Old/B/Kick.wav'];
  const { collisions } = R.planTargets(refs, 0);
  assert.strictEqual(collisions.length, 1);
  assert.strictEqual(collisions[0].name, 'Kick.wav');
  assert.strictEqual(collisions[0].owners.length, 2);
});

test('keeping one parent folder separates a colliding pair', () => {
  const refs = ['C:/Old/A/Kick.wav', 'C:/Old/B/Kick.wav'];
  const deeper = R.resolveDepth(refs);
  assert.strictEqual(deeper.keepParents, 1);
  assert.strictEqual(deeper.collisions.length, 0);
  assert.strictEqual(deeper.plan.get('C:/Old/A/Kick.wav'), 'usergig:A/Kick.wav');
  assert.strictEqual(deeper.plan.get('C:/Old/B/Kick.wav'), 'usergig:B/Kick.wav');
});

test('the same file referenced twice is not a collision', () => {
  const refs = ['C:/Old/A/Kick.wav', 'C:/Old/A/Kick.wav'];
  assert.strictEqual(R.planTargets(refs, 0).collisions.length, 0);
});

test('several colliding names are each reported', () => {
  const refs = ['A/Kick.wav', 'B/Kick.wav', 'A/Snare.wav', 'B/Snare.wav'];
  const { collisions } = R.planTargets(refs, 0);
  assert.strictEqual(collisions.length, 2);
  assert.deepStrictEqual([...collisions].map((c) => c.name).sort(), ['Kick.wav', 'Snare.wav']);
});

test('names differing only by case are kept apart', () => {
  const refs = ['A/Kick.wav', 'B/kick.wav'];
  assert.strictEqual(R.planTargets(refs, 0).collisions.length, 0);
});

test('the integrity check passes a correct rewrite', () => {
  const before = doc('C:/Old/Kick.wav', 'factorysample:drumsynth/a.ds');
  const r = R.applyAutoGig(before);
  assert.strictEqual(R.autoGigIntact(before, r.text, r.occurrences), true);
});

test('the integrity check rejects a change outside the sample paths', () => {
  const before = doc('C:/Old/Kick.wav');
  const r = R.applyAutoGig(before);
  const tampered = r.text.replace('<lmms-project>', '<lmms-project bpm="140">');
  assert.strictEqual(R.autoGigIntact(before, tampered, r.occurrences), false);
});

test('the integrity check rejects a wrong replacement count', () => {
  const before = doc('C:/Old/Kick.wav');
  const r = R.applyAutoGig(before);
  assert.strictEqual(R.autoGigIntact(before, r.text, r.occurrences + 1), false);
});

test('only the supported sample nodes are rewritten', () => {
  const other = '<tripleoscillator userwavefile0="C:/Old/Wave.wav"/>';
  const before = `<lmms-project>${node('C:/Old/Kick.wav')}${other}</lmms-project>`;
  const r = R.applyAutoGig(before);
  assert.strictEqual(r.occurrences, 1);
  assert.ok(r.text.includes(other));
});
