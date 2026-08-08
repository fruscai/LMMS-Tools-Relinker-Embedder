'use strict';
/**
 * Batch, scanning, ZIP-security and end-to-end engine tests (spec TEST 10).
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { compressMmpz, decompressMmpz } = require('../src/core/mmpz');
const { scanTree } = require('../src/core/scanner');
const { safeEntryPath, createZip, extractZip } = require('../src/core/zip');
const engine = require('../src/core/engine');
const { buildReport, toCsv, toText } = require('../src/core/report');

const FIXTURES = path.join(__dirname, 'fixtures');
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

const OLD_ROOT = 'C:/Users/Administrator/Desktop/future_garage_original/';
const NEW_ROOT = 'C:/Users/NewUser/Documents/lmms/samples/GIGS/';

async function tempDir(label) {
  return fsp.mkdtemp(path.join(os.tmpdir(), `relinker-${label}-`));
}

/** Build a nested tree of `count` projects, alternating .mmp and .mmpz. */
async function buildBatch(root, count) {
  const xml = fs.readFileSync(path.join(FIXTURES, 'fixture.mmp'));
  const compressed = compressMmpz(xml);

  for (let i = 0; i < count; i += 1) {
    const dir = path.join(root, `album${i % 7}`, `set${i % 13}`);
    await fsp.mkdir(dir, { recursive: true });
    if (i % 2 === 0) {
      await fsp.writeFile(path.join(dir, `song${i}.mmpz`), compressed);
    } else {
      await fsp.writeFile(path.join(dir, `song${i}.mmp`), xml);
    }
  }
  // Unrelated files that must be ignored by the scanner.
  await fsp.writeFile(path.join(root, 'notes.txt'), 'not a project');
  await fsp.writeFile(path.join(root, 'cover.png'), Buffer.from([0x89, 0x50]));
}

test('scanner finds only .mmp and .mmpz, and ignores unrelated files', async () => {
  const root = await tempDir('scan');
  await buildBatch(root, 20);

  const { projects, stats } = await scanTree(root);
  assert.strictEqual(projects.length, 20);
  assert.strictEqual(stats.mmpCount + stats.mmpzCount, 20);
  assert.ok(projects.every((p) => /\.(mmp|mmpz)$/.test(p.absolutePath)));

  await fsp.rm(root, { recursive: true, force: true });
});

test('scanner does not follow symlinks out of the tree', async () => {
  const root = await tempDir('symlink');
  const outside = await tempDir('outside');
  await fsp.writeFile(path.join(outside, 'escaped.mmp'), '<?xml version="1.0"?><lmms-project/>');
  await fsp.mkdir(path.join(root, 'inner'), { recursive: true });
  await fsp.symlink(outside, path.join(root, 'inner', 'link'), 'dir');

  const { projects, stats } = await scanTree(root);
  assert.strictEqual(projects.length, 0);
  assert.ok(stats.skippedSymlinks >= 1);

  await fsp.rm(root, { recursive: true, force: true });
  await fsp.rm(outside, { recursive: true, force: true });
});

test('ZIP-slip entry names are refused', () => {
  const dest = '/tmp/extract-here';
  assert.strictEqual(safeEntryPath(dest, '../../etc/passwd'), null);
  assert.strictEqual(safeEntryPath(dest, '/etc/passwd'), null);
  assert.strictEqual(safeEntryPath(dest, 'C:\\Windows\\system32\\evil.dll'), null);
  assert.strictEqual(safeEntryPath(dest, 'a/../../b'), null);
  assert.strictEqual(safeEntryPath(dest, 'ok/nested/file.mmpz'), path.join(dest, 'ok/nested/file.mmpz'));
});

test('ZIP round trip preserves the directory hierarchy and unrelated files', async () => {
  const src = await tempDir('zipsrc');
  await buildBatch(src, 6);
  const zipPath = path.join(await tempDir('zipout'), 'bundle.zip');

  await createZip(src, zipPath);
  const dest = await tempDir('zipdest');
  const result = await extractZip(zipPath, dest);

  assert.ok(result.entries > 0);
  const { projects } = await scanTree(dest);
  assert.strictEqual(projects.length, 6);
  assert.ok(fs.existsSync(path.join(dest, 'notes.txt')), 'unrelated files preserved');

  await fsp.rm(src, { recursive: true, force: true });
  await fsp.rm(dest, { recursive: true, force: true });
});

test('scan is a dry run and never modifies the source tree', async () => {
  const root = await tempDir('dryrun');
  await buildBatch(root, 10);

  const { projects } = await scanTree(root);
  const before = new Map();
  for (const p of projects) before.set(p.absolutePath, sha256(fs.readFileSync(p.absolutePath)));

  const { summary } = await engine.scan(root, { oldPath: OLD_ROOT, newPath: NEW_ROOT });
  assert.strictEqual(summary.projectsWithMatches, 10);
  assert.ok(summary.totalOccurrences > 10);

  for (const [file, digest] of before) {
    assert.strictEqual(sha256(fs.readFileSync(file)), digest, `${file} must be untouched`);
  }

  await fsp.rm(root, { recursive: true, force: true });
});

test('TEST 10 — several hundred nested projects repair correctly end to end', async () => {
  const root = await tempDir('batch-src');
  const out = await tempDir('batch-out');
  const COUNT = 300;
  await buildBatch(root, COUNT);

  const settings = { oldPath: OLD_ROOT, newPath: NEW_ROOT };
  const { records, summary } = await engine.repair(root, out, settings);

  assert.strictEqual(summary.projectsProcessed, COUNT);
  assert.strictEqual(summary.projectsModified, COUNT);
  assert.strictEqual(summary.validationFailures, 0);
  assert.ok(summary.replacements >= COUNT);

  // Every output file must decompress and contain the new root, not the old.
  const { projects } = await scanTree(out);
  assert.strictEqual(projects.length, COUNT);

  for (const p of projects) {
    const raw = fs.readFileSync(p.absolutePath);
    const xml = p.format === 'mmpz' ? decompressMmpz(raw) : raw;
    const text = xml.toString('utf8');
    assert.ok(!text.includes(OLD_ROOT), `${p.relativePath} still has the old root`);
    assert.ok(text.includes(NEW_ROOT), `${p.relativePath} missing the new root`);
  }

  // Directory hierarchy is mirrored.
  assert.ok(fs.existsSync(path.join(out, 'album0', 'set0')));

  // The report renders in all three formats.
  const report = buildReport({ sourcePath: root, outputPath: out, settings, records, summary });
  assert.strictEqual(report.files.length, COUNT);
  assert.ok(toCsv(report).startsWith('filename,format'));
  assert.ok(toText(report).includes('Projects modified'));

  await fsp.rm(root, { recursive: true, force: true });
  await fsp.rm(out, { recursive: true, force: true });
});

test('the source tree is never touched by a repair run', async () => {
  const root = await tempDir('nondestructive');
  const out = await tempDir('nondestructive-out');
  await buildBatch(root, 8);

  const { projects } = await scanTree(root);
  const before = new Map();
  for (const p of projects) before.set(p.absolutePath, sha256(fs.readFileSync(p.absolutePath)));

  await engine.repair(root, out, { oldPath: OLD_ROOT, newPath: NEW_ROOT });

  for (const [file, digest] of before) {
    assert.strictEqual(sha256(fs.readFileSync(file)), digest);
  }

  await fsp.rm(root, { recursive: true, force: true });
  await fsp.rm(out, { recursive: true, force: true });
});

test('a corrupt project is flagged and produces no output file', async () => {
  const root = await tempDir('corrupt-src');
  const out = await tempDir('corrupt-out');
  await fsp.copyFile(path.join(FIXTURES, 'corrupt.mmpz'), path.join(root, 'broken.mmpz'));

  const { records, summary } = await engine.repair(root, out, {
    oldPath: OLD_ROOT,
    newPath: NEW_ROOT,
  });

  assert.strictEqual(summary.projectsModified, 0);
  assert.strictEqual(summary.validationFailures, 1);
  assert.strictEqual(records[0].result, engine.STATUS.DECOMPRESSION_FAILED);
  assert.strictEqual(fs.existsSync(path.join(out, 'broken.mmpz')), false);

  await fsp.rm(root, { recursive: true, force: true });
  await fsp.rm(out, { recursive: true, force: true });
});

test('a project with no match is copied through unchanged', async () => {
  const root = await tempDir('nomatch-src');
  const out = await tempDir('nomatch-out');
  await fsp.copyFile(path.join(FIXTURES, 'fixture.mmpz'), path.join(root, 'song.mmpz'));

  const { summary } = await engine.repair(root, out, {
    oldPath: 'Z:/does/not/exist/',
    newPath: NEW_ROOT,
  });

  assert.strictEqual(summary.projectsModified, 0);
  assert.strictEqual(summary.projectsSkipped, 1);

  const copied = fs.readFileSync(path.join(out, 'song.mmpz'));
  const original = fs.readFileSync(path.join(FIXTURES, 'fixture.mmpz'));
  assert.strictEqual(sha256(copied), sha256(original), 'unchanged project must be copied verbatim');

  await fsp.rm(root, { recursive: true, force: true });
  await fsp.rm(out, { recursive: true, force: true });
});

test('output paths cannot escape the destination folder', () => {
  assert.throws(() => engine.assertInside('/tmp/out', '/tmp/out/../evil.mmpz'));
  assert.doesNotThrow(() => engine.assertInside('/tmp/out', '/tmp/out/nested/ok.mmpz'));
});

test('reports never contain audio data, only paths and counts', async () => {
  const root = await tempDir('report-src');
  const out = await tempDir('report-out');
  await buildBatch(root, 4);

  const settings = { oldPath: OLD_ROOT, newPath: NEW_ROOT };
  const { records, summary } = await engine.repair(root, out, settings);
  const report = buildReport({ sourcePath: root, outputPath: out, settings, records, summary });

  const serialised = JSON.stringify(report);
  assert.ok(!/RIFF|WAVE|OggS/.test(serialised));
  assert.ok(report.version && report.timestamp);

  await fsp.rm(root, { recursive: true, force: true });
  await fsp.rm(out, { recursive: true, force: true });
});
