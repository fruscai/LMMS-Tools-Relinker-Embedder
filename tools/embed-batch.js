'use strict';
/**
 * embed-batch.js — embed sample audio into every project in a tree.
 *
 *   node tools/embed-batch.js <tree> <sampleDir> [outputDir] [--was-relinked]
 *
 * Produces one self-contained .mmpz per project, in the SAME folder structure
 * as the input. Unlike bundling, nothing is nested and no resources folder is
 * created, so the delivered layout matches the original snapshot tree.
 *
 * Why this exists: a bundle needs its folder kept intact and needs LMMS 1.3+
 * to understand `local:`. Embedded audio needs neither — there is no path to
 * resolve at all.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { execFileSync } = require('child_process');

const { decompressMmpz, compressMmpz } = require('../src/core/mmpz');
const { validateProjectText } = require('../src/core/mmp');
const { outputPathFor } = require('../src/core/naming');

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const positional = argv.filter((a) => !a.startsWith('--'));
const [tree, sampleDir, explicitOut] = positional;

if (!tree || !sampleDir) {
  console.error('usage: node tools/embed-batch.js <tree> <sampleDir> [outputDir] [--was-relinked]');
  process.exit(2);
}

const stages = { relink: flag('--was-relinked'), embed: true };
const outputRoot = explicitOut || outputPathFor(tree, stages, { kind: 'folder' });

const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;

/* --- WAV -> interleaved stereo float32 (LMMS SampleFrame array) --- */
function wavToSampleFrames(buffer) {
  if (buffer.toString('ascii', 0, 4) !== 'RIFF') throw new Error('not a RIFF file');
  let fmt = null, data = null, off = 12;
  while (off + 8 <= buffer.length) {
    const id = buffer.toString('ascii', off, off + 4);
    const size = buffer.readUInt32LE(off + 4);
    const body = buffer.subarray(off + 8, off + 8 + size);
    if (id === 'fmt ') {
      fmt = { audioFormat: body.readUInt16LE(0), channels: body.readUInt16LE(2),
              sampleRate: body.readUInt32LE(4), bits: body.readUInt16LE(14) };
    } else if (id === 'data') data = body;
    off += 8 + size + (size % 2);
  }
  if (!fmt || !data) throw new Error('missing fmt or data chunk');

  const bps = fmt.bits / 8;
  const frames = Math.floor(data.length / (bps * fmt.channels));
  const out = Buffer.alloc(frames * 8);
  const read = (p) => {
    switch (fmt.bits) {
      case 8: return (data.readUInt8(p) - 128) / 128;
      case 16: return data.readInt16LE(p) / 32768;
      case 24: { const v = data[p] | (data[p + 1] << 8) | (data[p + 2] << 16);
                 return ((v & 0x800000) ? v - 0x1000000 : v) / 8388608; }
      case 32: return fmt.audioFormat === 3 ? data.readFloatLE(p) : data.readInt32LE(p) / 2147483648;
      default: throw new Error(`unsupported bit depth ${fmt.bits}`);
    }
  };
  for (let i = 0; i < frames; i += 1) {
    const b = i * bps * fmt.channels;
    const l = read(b);
    out.writeFloatLE(l, i * 8);
    out.writeFloatLE(fmt.channels > 1 ? read(b + bps) : l, i * 8 + 4);
  }
  return { frames: out, info: fmt, frameCount: frames };
}

const xmlEscape = (v) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * The bare filename a reference points at.
 *
 * LMMS prefixes have NO slash after the colon — `usergig:Snare Sounds.wav` —
 * so path.basename() would return the whole string, prefix included, and the
 * lookup would silently miss. Strip the prefix first.
 *
 * `factorysample:` is intentionally still stripped: if the file is not in the
 * supplied sample directory it is reported and left alone, which is correct —
 * factory samples ship with LMMS and resolve on any machine.
 */
const LMMS_PREFIX = /^(factorysample|usersample|usergig|usersoundfont|local):/i;

function sampleNameOf(src) {
  const cleaned = src.replace(/\\/g, '/').replace(LMMS_PREFIX, '');
  return path.posix.basename(cleaned);
}

/** Cache of base64 payloads, so each sample is encoded once for the whole run. */
const encoded = new Map();
const rateWarnings = new Set();

function payloadFor(name) {
  if (encoded.has(name)) return encoded.get(name);
  const file = path.join(sampleDir, name);
  if (!fs.existsSync(file)) { encoded.set(name, null); return null; }
  const { frames, info, frameCount } = wavToSampleFrames(fs.readFileSync(file));
  // Embedded audio carries no sample-rate metadata; LMMS assumes its own rate.
  if (info.sampleRate !== 44100) rateWarnings.add(`${name} is ${info.sampleRate}Hz`);
  const b64 = frames.toString('base64');
  console.log(`  encoded ${name}: ${frameCount} frames @ ${info.sampleRate}Hz ${info.bits}-bit x${info.channels}`);
  encoded.set(name, b64);
  return b64;
}

function embedInto(xml) {
  let embedded = 0, missing = 0, emptySlots = 0;

  const out = xml.replace(
    /<audiofileprocessor\b([^>]*?)\s*src="([^"]*)"([^>]*)>/g,
    (whole, before, src, after) => {
      if (!src) { emptySlots += 1; return whole; }
      const name = sampleNameOf(src);
      const b64 = payloadFor(name);
      if (!b64) { missing += 1; return whole; }

      embedded += 1;
      const selfClosing = /\/\s*$/.test(after);
      const attrs = `${before} ${after.replace(/\/\s*$/, '')}`
        .replace(/\s*\bsampledata="[^"]*"/g, '')
        .replace(/\s+/g, ' ').trim();
      return `<audiofileprocessor ${attrs} sampledata="${xmlEscape(b64)}"${selfClosing ? '/' : ''}>`;
    }
  );

  return { xml: out, embedded, missing, emptySlots };
}

async function findProjects(root) {
  const found = [];
  async function walk(dir, depth) {
    if (depth > 32) return;
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) await walk(full, depth + 1);
      // Autosaves (.mmpz.bak) are LMMS projects too and carry the same broken
      // paths, so they get embedded as well — every LMMS file ends up
      // self-contained, not just the main one.
      else if (/\.(mmpz|mmp)(\.bak)?$/i.test(e.name)) found.push(full);
    }
  }
  await walk(path.resolve(root), 0);
  return found.sort();
}

(async () => {
  const projects = await findProjects(tree);
  console.log(`found ${projects.length} project(s)`);
  console.log(`samples from: ${sampleDir}`);
  console.log(`output:       ${outputRoot}\n`);

  // Mirror the ENTIRE tree first — Files.txt, rendered WAVs, .bak autosaves,
  // everything — with timestamps preserved. Only the .mmpz files are then
  // overwritten with self-contained versions. Nothing else changes, and no
  // resources folder is ever created.
  process.stdout.write('mirroring tree… ');
  const { mirrorTree } = require('../src/core/engine');
  const mirrored = await mirrorTree(tree, outputRoot);
  console.log(`${mirrored.files} file(s) copied\n`);

  const log = [];
  const totals = { processed: 0, written: 0, failed: 0, embedded: 0, missing: 0, bytes: 0 };

  for (const project of projects) {
    totals.processed += 1;
    const rel = path.relative(path.resolve(tree), project);
    const record = { project: rel };

    try {
      const raw = await fsp.readFile(project);
      // ".mmpz" and ".mmpz.bak" are both qCompress containers.
      const isZ = /\.mmpz(\.bak)?$/i.test(project);
      const xml = (isZ ? decompressMmpz(raw) : raw).toString('utf8');

      const result = embedInto(xml);

      if (!validateProjectText(result.xml).valid) throw new Error('embedding produced invalid XML');
      // Nothing that received sampledata may still carry a src attribute.
      const stillSrc = (result.xml.match(/<audiofileprocessor[^>]*\bsrc="[^"]+"[^>]*sampledata=/g) || []).length;
      if (stillSrc) throw new Error(`${stillSrc} node(s) kept src alongside sampledata`);

      const bytes = Buffer.from(result.xml, 'utf8');
      const destination = path.join(outputRoot, rel);
      await fsp.mkdir(path.dirname(destination), { recursive: true });
      await fsp.writeFile(destination, isZ ? compressMmpz(bytes) : bytes);

      const size = (await fsp.stat(destination)).size;
      totals.bytes += size;
      totals.embedded += result.embedded;
      totals.missing += result.missing;
      totals.written += 1;

      Object.assign(record, {
        embedded: result.embedded, missing: result.missing,
        emptySlots: result.emptySlots, size, result: 'EMBEDDED',
      });
      console.log(`[OK] ${rel} — ${result.embedded} embedded` +
        (result.missing ? `, ${result.missing} MISSING` : '') +
        (result.emptySlots ? `, ${result.emptySlots} empty slot(s)` : '') +
        ` — ${mb(size)}`);
    } catch (err) {
      totals.failed += 1;
      record.result = 'FAILED';
      record.message = err.message;
      console.log(`[FAILED] ${rel} — ${err.message}`);
    }
    log.push(record);
  }

  console.log('\n=== totals ===');
  console.log(`  projects:        ${totals.processed}`);
  console.log(`  written:         ${totals.written}`);
  console.log(`  failed:          ${totals.failed}`);
  console.log(`  samples embedded:${totals.embedded}`);
  if (totals.missing) console.log(`  MISSING samples: ${totals.missing}`);
  console.log(`  total size:      ${mb(totals.bytes)}`);
  for (const w of rateWarnings) console.log(`  NOTE: ${w} — embedded audio carries no rate metadata`);

  await fsp.writeFile(
    path.join(outputRoot, `embed-log-${new Date().toISOString().replace(/[:.]/g, '-')}.json`),
    JSON.stringify({ tree: path.resolve(tree), sampleDir, outputRoot, totals, projects: log }, null, 2)
  );
  console.log(`\noutput: ${outputRoot}`);
  process.exit(totals.failed ? 1 : 0);
})();
