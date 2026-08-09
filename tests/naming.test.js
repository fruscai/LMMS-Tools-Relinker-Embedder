'use strict';
/**
 * Output naming: the folder name records which stages ran.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');

const { suffixFor, outputPathFor } = require('../src/core/naming');

test('suffix reflects the stages applied', () => {
  assert.strictEqual(suffixFor({ relink: true }), '_RELINKED');
  assert.strictEqual(suffixFor({ bundle: true }), '_BUNDLED');
  assert.strictEqual(suffixFor({ relink: true, bundle: true }), '_RELINKED_BUNDLED');
  assert.strictEqual(suffixFor({}), '');
});

test('RELINKED always precedes BUNDLED, whatever order the flags arrive in', () => {
  // Bundling an already-bundled project fails, so relink-then-bundle is the
  // only valid order and the name must not imply otherwise.
  assert.strictEqual(suffixFor({ bundle: true, relink: true }), '_RELINKED_BUNDLED');
});

test('folder input keeps its name and gains the suffix', () => {
  const out = outputPathFor('/music/ProjectFolder', { relink: true }, { kind: 'folder', unique: false });
  assert.strictEqual(out, path.join('/music', 'ProjectFolder_RELINKED'));
});

test('zip input keeps its extension after the suffix', () => {
  const out = outputPathFor('/music/Bundle.zip', { relink: true }, { kind: 'zip', unique: false });
  assert.strictEqual(out, path.join('/music', 'Bundle_RELINKED.zip'));
});

test('single project keeps its extension after the suffix', () => {
  const out = outputPathFor('/music/song.mmpz', { relink: true }, { kind: 'file', unique: false });
  assert.strictEqual(out, path.join('/music', 'song_RELINKED.mmpz'));
});

test('bundle-only and both-stage names', () => {
  assert.strictEqual(
    outputPathFor('/music/Set', { bundle: true }, { kind: 'folder', unique: false }),
    path.join('/music', 'Set_BUNDLED')
  );
  assert.strictEqual(
    outputPathFor('/music/Set', { relink: true, bundle: true }, { kind: 'folder', unique: false }),
    path.join('/music', 'Set_RELINKED_BUNDLED')
  );
});

test('an existing result is never clobbered', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'naming-'));
  const source = path.join(dir, 'Songs');
  await fsp.mkdir(source);

  const first = outputPathFor(source, { relink: true }, { kind: 'folder' });
  assert.strictEqual(first, path.join(dir, 'Songs_RELINKED'));
  await fsp.mkdir(first);

  const second = outputPathFor(source, { relink: true }, { kind: 'folder' });
  assert.strictEqual(second, path.join(dir, 'Songs_RELINKED_2'));

  await fsp.rm(dir, { recursive: true, force: true });
});

test('collision counter goes before the extension for files', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'naming-'));
  const source = path.join(dir, 'song.mmpz');
  await fsp.writeFile(source, 'x');

  const first = outputPathFor(source, { bundle: true }, { kind: 'file' });
  assert.strictEqual(first, path.join(dir, 'song_BUNDLED.mmpz'));
  await fsp.writeFile(first, 'x');

  const second = outputPathFor(source, { bundle: true }, { kind: 'file' });
  assert.strictEqual(second, path.join(dir, 'song_BUNDLED_2.mmpz'));

  await fsp.rm(dir, { recursive: true, force: true });
});
