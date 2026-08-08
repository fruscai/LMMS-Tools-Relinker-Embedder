'use strict';
/**
 * End-to-end ZIP rehearsal: build an archive shaped like a real user's bundle
 * (several differently-named folders, nested projects, unrelated files), then
 * run the exact pipeline the GUI runs and verify the rebuilt archive.
 *
 * Run: node tests/e2e-zip.js
 */

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const engine = require('../src/core/engine');
const { extractZip, createZip } = require('../src/core/zip');
const { scanTree } = require('../src/core/scanner');
const { decompressMmpz, compressMmpz } = require('../src/core/mmpz');
const { buildReport, writeReports } = require('../src/core/report');

const OLD_STORED = 'C:/Users/Administrator/Desktop/future_garage_original/';
// What a Windows user actually pastes out of the LMMS "sample not found" dialog.
const OLD_PASTED = 'C:\\Users\\Administrator\\Desktop\\future_garage_original\\';
const NEW_PATH = 'C:\\Users\\NewUser\\Documents\\lmms\\samples\\GIGS\\';

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const tmp = (label) => fsp.mkdtemp(path.join(os.tmpdir(), `e2e-${label}-`));

async function buildSourceBundle(root) {
  const xml = fs.readFileSync(path.join(__dirname, 'fixtures', 'fixture.mmp'));
  const mmpz = compressMmpz(xml);

  const folders = [
    'Gig Set 1',
    'Gig Set 2 (live)',
    'Rehearsals/April',
    'Rehearsals/May 2026',
    'Archive/old takes/v2',
    'Ünïcode Sessions/日本語',
  ];

  let n = 0;
  for (const folder of folders) {
    const dir = path.join(root, folder);
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, `project ${(n += 1)}.mmpz`), mmpz);
    await fsp.writeFile(path.join(dir, `project ${(n += 1)}.mmp`), xml);
    // Unrelated files that must survive untouched.
    await fsp.writeFile(path.join(dir, 'notes.txt'), `notes for ${folder}`);
    await fsp.writeFile(path.join(dir, 'cover.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  }

  // A project that does not contain the bad path at all.
  await fsp.mkdir(path.join(root, 'Unrelated'), { recursive: true });
  const clean = xml.toString('utf8').split(OLD_STORED).join('D:/somewhere/else/');
  await fsp.writeFile(path.join(root, 'Unrelated', 'clean.mmpz'), compressMmpz(Buffer.from(clean, 'utf8')));

  return n;
}

(async () => {
  const stage = await tmp('stage');
  const sourceTree = path.join(stage, 'MyGigs');
  await fsp.mkdir(sourceTree, { recursive: true });
  const projectCount = await buildSourceBundle(sourceTree);

  const zipPath = path.join(stage, 'MyGigs.zip');
  await createZip(sourceTree, zipPath);
  const zipDigestBefore = sha256(fs.readFileSync(zipPath));

  console.log(`built archive with ${projectCount} matching projects + 1 clean project`);

  // ---- pipeline, exactly as ipc.js runs it ----
  const workingRoot = await tmp('extract');
  const extraction = await extractZip(zipPath, workingRoot);
  console.log('extracted entries:', extraction.entries, 'refused:', extraction.refused.length);

  const settings = { oldPath: OLD_PASTED, newPath: NEW_PATH, matchSeparatorVariants: true };

  const dryRun = await engine.scan(workingRoot, settings);
  console.log(
    `scan: ${dryRun.summary.projectsFound} projects ` +
      `(${dryRun.summary.mmpFound} .mmp, ${dryRun.summary.mmpzFound} .mmpz), ` +
      `${dryRun.summary.projectsWithMatches} contain the path, ` +
      `${dryRun.summary.totalOccurrences} references, ` +
      `${dryRun.summary.projectsWithoutMatches} need no changes`
  );

  const rebuildRoot = await tmp('rebuild');
  await engine.mirrorTree(workingRoot, rebuildRoot);
  const { records, summary } = await engine.repair(workingRoot, rebuildRoot, settings);

  const outZip = path.join(stage, 'MyGigs_RELINKED.zip');
  await createZip(rebuildRoot, outZip);
  summary.outputLocation = outZip;
  console.log('repair:', JSON.stringify(summary));

  const report = buildReport({ sourcePath: zipPath, outputPath: outZip, settings, records, summary });
  const reportPaths = await writeReports(report, stage);

  // ---- verification ----
  const verifyRoot = await tmp('verify');
  await extractZip(outZip, verifyRoot);
  const { projects } = await scanTree(verifyRoot);

  let checked = 0;
  for (const p of projects) {
    const raw = fs.readFileSync(p.absolutePath);
    const xml = p.format === 'mmpz' ? decompressMmpz(raw) : raw;
    const text = xml.toString('utf8');
    if (p.relativePath.includes('Unrelated')) {
      if (text.includes('C:/Users/NewUser')) throw new Error('clean project was modified');
      continue;
    }
    if (text.includes(OLD_STORED)) throw new Error(`old path remains in ${p.relativePath}`);
    if (!text.includes('C:/Users/NewUser/Documents/lmms/samples/GIGS/')) {
      throw new Error(`new path missing in ${p.relativePath}`);
    }
    checked += 1;
  }

  // Unrelated files preserved, hierarchy intact, source archive untouched.
  const notes = path.join(verifyRoot, 'Gig Set 2 (live)', 'notes.txt');
  if (!fs.existsSync(notes)) throw new Error('unrelated file missing from rebuilt archive');
  if (fs.readFileSync(notes, 'utf8') !== 'notes for Gig Set 2 (live)') {
    throw new Error('unrelated file was altered');
  }
  if (!fs.existsSync(path.join(verifyRoot, 'Ünïcode Sessions', '日本語'))) {
    throw new Error('unicode folder missing');
  }
  if (sha256(fs.readFileSync(zipPath)) !== zipDigestBefore) {
    throw new Error('source archive was modified');
  }

  console.log(`verified ${checked} repaired projects, hierarchy and extras intact`);
  console.log('source archive untouched:', sha256(fs.readFileSync(zipPath)) === zipDigestBefore);
  console.log('reports:', path.basename(reportPaths.json), path.basename(reportPaths.csv), path.basename(reportPaths.txt));
  console.log('\nALL E2E CHECKS PASSED');

  await fsp.rm(stage, { recursive: true, force: true });
  for (const d of [workingRoot, rebuildRoot, verifyRoot]) {
    await fsp.rm(d, { recursive: true, force: true });
  }
})().catch((err) => {
  console.error('E2E FAILED:', err.message);
  process.exit(1);
});
