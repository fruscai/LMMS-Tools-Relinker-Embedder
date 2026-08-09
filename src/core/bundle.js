'use strict';
/**
 * bundle.js — LMMS project bundling, with verification before and after.
 *
 * The governing constraint, from the spec:
 *
 *   makebundle COPIES files. It does not FIND them.
 *
 * LMMS resolves each sample path, copies whatever sits at that location into a
 * resources folder, and rewrites the reference to `local:resources/<name>`. A
 * path that does not resolve simply produces a bundle with a missing resource.
 * Nothing errors loudly. The result looks self-contained and plays silence.
 *
 * So the pipeline is ordered and gated:
 *
 *   1. Resolve      (the relinker, or recreating the original directory)
 *   2. VERIFY       <- the whole point. Never bundle an unverified project.
 *   3. Bundle       (lmms makebundle)
 *   4. Dedupe       (ours: LMMS copies once per reference, not per file)
 *   5. Validate     (prove the bundle is actually self-contained)
 *
 * Verified against LMMS 1.3.0-alpha on macOS. Corrections to the original spec,
 * established by running the real binary:
 *
 *   - The syntax is `lmms makebundle <in> [out]` — an action, lowercase, NOT
 *     a `--makeBundle` flag.
 *   - `.mmpz` input works directly; no decompress-to-`.mmp` step is needed.
 *   - Output is `<out>/<basename(out)>.mmpz` plus `<out>/resources/`. The
 *     project file is named after the OUTPUT argument, not the source project.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const { decompressMmpz, compressMmpz } = require('./mmpz');
const { decodeProjectText, encodeProjectText, validateProjectText } = require('./mmp');
const { xmlEscapeAttr } = require('./pathReplace');
const validator = require('./validator');

/**
 * Element types whose `src` attribute points at an audio sample.
 *
 * `sf2player` is deliberately excluded: soundfonts resolve against a different
 * base directory, and rewriting them would break them. `sampleclip` is the
 * LMMS 1.3 name; `sampletco` is the older one, kept so both load.
 */
const SAMPLE_NODES = new Set(['audiofileprocessor', 'sampleclip', 'sampletco']);

/** Prefixes LMMS resolves itself, against their own base directories. */
const PREFIX_ROOTS = {
  'factorysample:': 'factory',
  'usersample:': 'userSamples',
  'usergig:': 'gig',
  'usersoundfont:': 'soundfont',
  'local:': 'projectLocal',
};

class BundleError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'BundleError';
    this.code = code;
  }
}

/* ------------------------------------------------------------------ *
 * LMMS detection
 * ------------------------------------------------------------------ */

/**
 * Where LMMS installs itself, per platform. Checked in order.
 * Override with the LMMS_PATH environment variable or an explicit argument.
 */
function defaultLmmsPaths() {
  const home = os.homedir();
  if (process.platform === 'win32') {
    return [
      'C:\\Program Files\\LMMS\\lmms.exe',
      'C:\\Program Files (x86)\\LMMS\\lmms.exe',
      path.join(home, 'AppData\\Local\\Programs\\LMMS\\lmms.exe'),
      path.join(home, 'AppData\\Local\\LMMS\\lmms.exe'),
    ];
  }
  if (process.platform === 'darwin') {
    return [
      '/Applications/LMMS.app/Contents/MacOS/lmms',
      path.join(home, 'Applications/LMMS.app/Contents/MacOS/lmms'),
      '/opt/homebrew/bin/lmms',
      '/usr/local/bin/lmms',
    ];
  }
  return [
    '/usr/bin/lmms',
    '/usr/local/bin/lmms',
    '/snap/bin/lmms',
    path.join(home, '.local/bin/lmms'),
  ];
}

/**
 * Where LMMS keeps factory samples, per platform.
 * Used when resolving `factorysample:` references.
 */
function defaultFactorySamples() {
  if (process.platform === 'win32') {
    return ['C:\\Program Files\\LMMS\\data\\samples', 'C:\\Program Files (x86)\\LMMS\\data\\samples'];
  }
  if (process.platform === 'darwin') {
    return ['/Applications/LMMS.app/Contents/share/lmms/samples'];
  }
  return ['/usr/share/lmms/samples', '/usr/local/share/lmms/samples'];
}

/** The user's LMMS working directory, which holds `samples/`. */
function defaultWorkingDir() {
  return path.join(os.homedir(), process.platform === 'win32' ? 'Documents\\lmms' : 'Documents/lmms');
}

/**
 * Locate LMMS and confirm this build can bundle.
 *
 * makebundle and the `local:` prefix only exist from 1.3.0-alpha onwards, so
 * anything older must be refused rather than silently producing nothing.
 */
async function detectLmms(binaryPath = null) {
  const candidates = binaryPath
    ? [binaryPath]
    : [process.env.LMMS_PATH, ...defaultLmmsPaths()].filter(Boolean);
  const found = candidates.find((c) => fs.existsSync(c));

  if (!found) {
    return {
      ok: false,
      searched: candidates,
      reason:
        'No LMMS binary found. Install LMMS 1.3.0-alpha or later, or set the ' +
        'LMMS_PATH environment variable to its location.',
    };
  }

  let version = 'unknown';
  let help = '';
  try {
    const v = await execFileAsync(found, ['--version'], { maxBuffer: 1 << 20 });
    version = (v.stdout || '').split('\n')[0].trim();
  } catch (err) {
    return { ok: false, path: found, reason: `Could not run LMMS: ${err.message}` };
  }

  try {
    const h = await execFileAsync(found, ['--help'], { maxBuffer: 1 << 20 });
    help = `${h.stdout || ''}${h.stderr || ''}`;
  } catch (err) {
    // Some builds exit non-zero on --help; the output is still usable.
    help = `${err.stdout || ''}${err.stderr || ''}`;
  }

  // Ask the binary what it supports rather than parsing a version number.
  const supportsMakeBundle = /\bmakebundle\b/i.test(help);

  return {
    ok: supportsMakeBundle,
    path: found,
    version,
    supportsMakeBundle,
    reason: supportsMakeBundle
      ? undefined
      : `This LMMS build has no "makebundle" action (${version}). 1.3.0-alpha or later is required.`,
  };
}

/* ------------------------------------------------------------------ *
 * Reference collection and resolution
 * ------------------------------------------------------------------ */

/**
 * Collect every in-scope sample reference from project XML.
 *
 * @param {string} xmlText
 * @returns {Array<{tag: string, src: string}>}
 */
function collectReferences(xmlText) {
  const refs = [];
  for (const match of xmlText.matchAll(/<([A-Za-z0-9_:-]+)\b([^>]*)>/g)) {
    const tag = match[1];
    if (!SAMPLE_NODES.has(tag)) continue;
    const src = match[2].match(/\bsrc="([^"]*)"/);
    if (!src || !src[1]) continue;
    refs.push({ tag, src: decodeXmlEntities(src[1]) });
  }
  return refs;
}

/**
 * Count in-scope nodes carrying an EMPTY src attribute.
 *
 * These are instrument slots with no sample loaded — common in early snapshots.
 * They matter because LMMS cannot bundle a project that contains one:
 *
 *   QFile::copy: Empty or null file name
 *   ERROR: Failed to copy resource
 *   "Failed to copy resources."
 *
 * It then writes no project file but still exits 0, so the failure is silent
 * unless we look for it. Detecting this up front turns it into a clear,
 * reported block instead of a mysterious missing output.
 */
function countEmptyReferences(xmlText) {
  let empty = 0;
  for (const match of xmlText.matchAll(/<([A-Za-z0-9_:-]+)\b([^>]*)>/g)) {
    if (!SAMPLE_NODES.has(match[1])) continue;
    const src = match[2].match(/\bsrc="([^"]*)"/);
    if (src && src[1] === '') empty += 1;
  }
  return empty;
}

function decodeXmlEntities(value) {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Absolute if it starts with a drive letter or a slash, the way LMMS treats it. */
function isAbsolute(src) {
  return /^[A-Za-z]:[\\/]/.test(src) || src.startsWith('/') || src.startsWith('\\');
}

/** Case-exact existence check. A case-insensitive filesystem will happily lie. */
function existsExact(filePath) {
  try {
    if (!fs.existsSync(filePath)) return false;
    const dir = path.dirname(filePath);
    const base = path.basename(filePath);
    return fs.readdirSync(dir).includes(base);
  } catch {
    return false;
  }
}

/**
 * Resolve a reference the way LMMS does.
 *
 * @param {string} src
 * @param {{userSamples: string, factory: string, gig: string, soundfont: string, projectDir?: string}} dirs
 */
function resolveReference(src, dirs) {
  if (!src) return { resolved: false, reason: 'empty reference' };

  for (const [prefix, root] of Object.entries(PREFIX_ROOTS)) {
    if (!src.startsWith(prefix)) continue;
    const rest = src.slice(prefix.length);

    const base =
      root === 'factory' ? dirs.factory
      : root === 'userSamples' ? dirs.userSamples
      : root === 'gig' ? dirs.gig
      : root === 'soundfont' ? dirs.soundfont
      : dirs.projectDir;

    if (!base) {
      return { resolved: false, kind: root, reason: `no base directory configured for ${prefix}` };
    }
    const full = path.resolve(base, rest);
    return existsExact(full)
      ? { resolved: true, kind: root, path: full }
      : { resolved: false, kind: root, path: full, reason: 'file not found' };
  }

  if (isAbsolute(src)) {
    return existsExact(src)
      ? { resolved: true, kind: 'absolute', path: src }
      : { resolved: false, kind: 'absolute', path: src, reason: 'file not found' };
  }

  // Bare relative: user samples directory first, then factory.
  for (const [kind, base] of [['userSamples', dirs.userSamples], ['factory', dirs.factory]]) {
    if (!base) continue;
    const full = path.resolve(base, src);
    if (existsExact(full)) return { resolved: true, kind, path: full };
  }

  return { resolved: false, kind: 'relative', reason: 'not found under user samples or factory samples' };
}

/** Read a project file (either container) into text. */
async function readProject(projectPath) {
  const raw = await fsp.readFile(projectPath);
  const isCompressed = path.extname(projectPath).toLowerCase() === '.mmpz';
  const bytes = isCompressed ? decompressMmpz(raw) : raw;
  const { text, hadBom } = decodeProjectText(bytes);
  const validation = validateProjectText(text);
  if (!validation.valid) {
    throw new BundleError(`Not a valid LMMS project: ${validation.reason}`, 'INVALID_PROJECT');
  }
  return { text, hadBom, isCompressed };
}

/**
 * STAGE 2 — verify every in-scope reference resolves before bundling.
 *
 * @returns {{ok: boolean, total: number, resolvedCount: number, unresolved: Array}}
 */
async function verifyProject(projectPath, dirs) {
  const { text } = await readProject(projectPath);
  const refs = collectReferences(text);
  const emptyReferences = countEmptyReferences(text);

  const unresolved = [];
  let resolvedCount = 0;

  for (const ref of refs) {
    const result = resolveReference(ref.src, {
      ...dirs,
      projectDir: path.dirname(path.resolve(projectPath)),
    });
    if (result.resolved) resolvedCount += 1;
    else unresolved.push({ src: ref.src, tag: ref.tag, reason: result.reason, tried: result.path });
  }

  // A project already using local: references cannot be bundled again. LMMS
  // reports "Failed to copy resources", writes no project file, and still exits
  // 0 — another silent failure. Bundle from the relinked source instead.
  const alreadyBundled = refs.some((r) => r.src.startsWith('local:'));

  return {
    // An empty sample slot makes LMMS refuse to write the bundle at all, so it
    // blocks just as firmly as an unresolved path.
    ok: unresolved.length === 0 && emptyReferences === 0,
    alreadyBundled,
    total: refs.length,
    resolvedCount,
    unresolved,
    emptyReferences,
    blockedReason:
      unresolved.length > 0 ? 'unresolved references'
      : emptyReferences > 0 ? `${emptyReferences} empty sample slot(s) — LMMS cannot bundle these`
      : undefined,
    rebundleWarning: alreadyBundled
      ? 'already bundled (local: references) — bundling again produces an empty bundle'
      : undefined,
    uniqueReferenced: new Set(refs.map((r) => r.src)).size,
  };
}

/* ------------------------------------------------------------------ *
 * STAGE 2b — strip empty sample slots (opt-in)
 * ------------------------------------------------------------------ */

/**
 * Remove the empty `src=""` attribute from sampleless instrument nodes.
 *
 * An instrument dragged in but never given a sample is silent in LMMS and
 * harmless — but `makebundle` tries to copy a file with no name, errors, and
 * abandons the entire bundle while still exiting 0.
 *
 * This is the narrowest edit that fixes it. Only the empty attribute is
 * removed: the node keeps every other setting, the instrument track survives,
 * and no musical content is touched. Removing the whole track also works but
 * deletes structure for no benefit.
 *
 * Writes a NEW file; the source project is never modified.
 *
 * @param {string} projectPath source project
 * @param {string} outputPath where to write the stripped copy
 */
async function stripEmptySampleSlots(projectPath, outputPath) {
  const { text, hadBom, isCompressed } = await readProject(projectPath);

  const before = countEmptyReferences(text);
  if (before === 0) {
    return { changed: false, stripped: 0 };
  }

  // Match only nodes we care about, and only an EMPTY src attribute.
  const nodePattern = new RegExp(
    `(<(?:${[...SAMPLE_NODES].join('|')})\\b[^>]*?)\\s*\\bsrc=""`,
    'g'
  );
  const updated = text.replace(nodePattern, '$1');

  const after = countEmptyReferences(updated);
  if (after !== 0) {
    throw new BundleError(
      `Strip left ${after} empty slot(s) behind; refusing to write`,
      'STRIP_INCOMPLETE'
    );
  }

  // Nothing except those attributes may have moved.
  const expectedDelta = -[...text.matchAll(nodePattern)].reduce(
    (sum, m) => sum + (m[0].length - m[1].length), 0
  );
  if (updated.length - text.length !== expectedDelta) {
    throw new BundleError('Strip changed more than the empty attributes', 'STRIP_DELTA');
  }

  if (!validateProjectText(updated).valid) {
    throw new BundleError('Strip produced invalid project XML', 'STRIP_INVALID');
  }

  const bytes = encodeProjectText(updated, hadBom);
  await fsp.mkdir(path.dirname(path.resolve(outputPath)), { recursive: true });

  if (isCompressed) {
    const compressed = validator.compressVerified(bytes);
    if (!compressed.ok) {
      throw new BundleError(`Strip recompression failed: ${compressed.reason}`, 'STRIP_RECOMPRESS');
    }
    await fsp.writeFile(outputPath, compressed.buffer);
  } else {
    await fsp.writeFile(outputPath, bytes);
  }

  return { changed: true, stripped: before, outputPath };
}

/* ------------------------------------------------------------------ *
 * STAGE 3 — bundle
 * ------------------------------------------------------------------ */

/**
 * Invoke `lmms makebundle`.
 *
 * LMMS refuses to write where a resources folder already exists. Clearing a
 * previous bundle must be an explicit choice by the caller, never a silent
 * delete of someone's work.
 */
async function makeBundle(lmmsPath, inputProject, outputDir, options = {}) {
  const resourcesDir = path.join(outputDir, 'resources');

  if (fs.existsSync(resourcesDir)) {
    if (!options.overwrite) {
      throw new BundleError(
        `A bundle already exists at ${outputDir}. Pass overwrite to replace it.`,
        'BUNDLE_EXISTS'
      );
    }
    await fsp.rm(outputDir, { recursive: true, force: true });
  }

  await fsp.mkdir(path.dirname(path.resolve(outputDir)), { recursive: true });

  const env = { ...process.env };
  // Headless hosts need a display for the Qt app even though this path has no GUI.
  if (process.platform === 'linux' && !env.DISPLAY && !env.QT_QPA_PLATFORM) {
    env.QT_QPA_PLATFORM = 'offscreen';
  }

  let stdout = '';
  let stderr = '';
  try {
    const result = await execFileAsync(
      lmmsPath,
      ['makebundle', path.resolve(inputProject), path.resolve(outputDir)],
      { maxBuffer: 1 << 24, env, timeout: options.timeoutMs ?? 300000 }
    );
    stdout = result.stdout || '';
    stderr = result.stderr || '';
  } catch (err) {
    throw new BundleError(
      `makebundle failed: ${err.message}${err.stderr ? ` — ${err.stderr}` : ''}`,
      'MAKEBUNDLE_FAILED'
    );
  }

  // The bundled project is named after the output directory, not the source.
  const expected = path.join(outputDir, `${path.basename(outputDir)}.mmpz`);
  const projectFile = fs.existsSync(expected) ? expected : await findProjectIn(outputDir);

  if (!projectFile) {
    throw new BundleError(`makebundle produced no project file in ${outputDir}`, 'NO_OUTPUT');
  }

  return { projectFile, resourcesDir, stdout, stderr };
}

async function findProjectIn(dir) {
  try {
    const entries = await fsp.readdir(dir);
    const hit = entries.find((e) => /\.(mmpz|mmp)$/i.test(e));
    return hit ? path.join(dir, hit) : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * STAGE 4 — dedupe (ours, not LMMS)
 * ------------------------------------------------------------------ */

const sha256File = async (filePath) =>
  crypto.createHash('sha256').update(await fsp.readFile(filePath)).digest('hex');

/**
 * Collapse byte-identical resources inside ONE bundle.
 *
 * LMMS copies once per reference rather than per unique file, so a project
 * referencing three samples eighteen times ships eighteen copies. Measured on a
 * real project: 4.5 MB of audio became a 29 MB bundle.
 *
 * Dedupe is strictly within a single bundle. Resources are never shared between
 * bundles and never symlinked, because every snapshot has to stay independently
 * playable on its own with no sample files present.
 *
 * Files are grouped by content hash, so two different files that merely share a
 * name are never merged.
 */
async function dedupeBundle(bundleDir, options = {}) {
  const resourcesDir = path.join(bundleDir, 'resources');
  if (!fs.existsSync(resourcesDir)) {
    throw new BundleError(`No resources folder in ${bundleDir}`, 'NO_RESOURCES');
  }

  const projectFile = await findProjectIn(bundleDir);
  if (!projectFile) throw new BundleError(`No project file in ${bundleDir}`, 'NO_PROJECT');

  const files = (await fsp.readdir(resourcesDir)).filter((f) => !f.startsWith('.'));

  // Group by content hash.
  const byHash = new Map();
  let bytesBefore = 0;
  for (const name of files) {
    const full = path.join(resourcesDir, name);
    const stat = await fsp.stat(full);
    if (!stat.isFile()) continue;
    bytesBefore += stat.size;
    const hash = await sha256File(full);
    if (!byHash.has(hash)) byHash.set(hash, []);
    byHash.get(hash).push({ name, size: stat.size });
  }

  /**
   * Pick the canonical name for each group: prefer the one LMMS did not append
   * a counter to, then the shortest, then alphabetical. Keeps the natural name.
   */
  const rename = new Map(); // duplicate name -> canonical name
  const keep = new Set();

  for (const group of byHash.values()) {
    const sorted = [...group].sort((a, b) => {
      const aC = /-\d+(\.[^.]+)?$/.test(a.name) ? 1 : 0;
      const bC = /-\d+(\.[^.]+)?$/.test(b.name) ? 1 : 0;
      if (aC !== bC) return aC - bC;
      if (a.name.length !== b.name.length) return a.name.length - b.name.length;
      return a.name.localeCompare(b.name);
    });
    const canonical = sorted[0].name;
    keep.add(canonical);
    for (const item of sorted.slice(1)) rename.set(item.name, canonical);
  }

  if (rename.size === 0) {
    return { changed: false, filesBefore: files.length, filesAfter: files.length,
             bytesBefore, bytesAfter: bytesBefore, freed: 0 };
  }

  // Rewrite the project's references. Matching the FULL attribute value (with
  // its closing quote) means "Snare.wav" can never partially match "Snare-1.wav".
  const { text, hadBom, isCompressed } = await readProject(projectFile);

  let updated = text;
  let rewrites = 0;
  for (const [from, to] of rename) {
    const search = `src="local:resources/${xmlEscapeAttr(from)}"`;
    const replace = `src="local:resources/${xmlEscapeAttr(to)}"`;
    const parts = updated.split(search);
    rewrites += parts.length - 1;
    updated = parts.join(replace);
  }

  if (!validateProjectText(updated).valid) {
    throw new BundleError('Dedupe produced invalid project XML; nothing written', 'DEDUPE_INVALID');
  }

  const modifiedBytes = encodeProjectText(updated, hadBom);

  // Write the project first, verifying the container round-trips, and only
  // delete redundant files once the rewrite is safely on disk.
  if (isCompressed) {
    const compressed = validator.compressVerified(modifiedBytes);
    if (!compressed.ok) {
      throw new BundleError(`Dedupe recompression failed: ${compressed.reason}`, 'DEDUPE_RECOMPRESS');
    }
    await fsp.writeFile(projectFile, compressed.buffer);
  } else {
    await fsp.writeFile(projectFile, modifiedBytes);
  }

  let freed = 0;
  if (!options.dryRun) {
    for (const name of rename.keys()) {
      const full = path.join(resourcesDir, name);
      try {
        freed += (await fsp.stat(full)).size;
        await fsp.rm(full);
      } catch { /* already gone */ }
    }
  }

  const remaining = (await fsp.readdir(resourcesDir)).filter((f) => !f.startsWith('.'));

  return {
    changed: true,
    filesBefore: files.length,
    filesAfter: remaining.length,
    bytesBefore,
    bytesAfter: bytesBefore - freed,
    freed,
    rewrites,
    collapsed: rename.size,
  };
}

/* ------------------------------------------------------------------ *
 * STAGE 4b — normalise for Linux
 * ------------------------------------------------------------------ */

/**
 * Repair anything in a finished bundle that works on macOS or Windows but
 * would break on Linux.
 *
 * The dangerous case is capitalisation. macOS is case-insensitive by default,
 * Linux is case-sensitive. A reference to `Snare.wav` when the file on disk is
 * `snare.wav` loads perfectly here and silently fails there — the grader gets a
 * project that looks fine and plays silence. Exactly the failure mode this
 * whole pipeline exists to prevent.
 *
 * Fixes applied (the reference is rewritten to match the file on disk, rather
 * than renaming the user's files):
 *
 *   - backslashes in a local: reference    -> forward slashes
 *   - reference whose case differs from disk -> corrected to the real name
 *   - resource filenames that collide case-insensitively -> reported, not
 *     silently merged
 *
 * Anything it cannot safely repair is reported instead of guessed at.
 */
async function normalizeForLinux(bundleDir, options = {}) {
  const resourcesDir = path.join(bundleDir, 'resources');
  if (!fs.existsSync(resourcesDir)) {
    throw new BundleError(`No resources folder in ${bundleDir}`, 'NO_RESOURCES');
  }
  const projectFile = await findProjectIn(bundleDir);
  if (!projectFile) throw new BundleError(`No project file in ${bundleDir}`, 'NO_PROJECT');

  const onDisk = (await fsp.readdir(resourcesDir)).filter((f) => !f.startsWith('.'));
  const byLower = new Map();
  const collisions = [];
  for (const name of onDisk) {
    const key = name.toLowerCase();
    if (byLower.has(key)) collisions.push([byLower.get(key), name]);
    else byLower.set(key, name);
  }

  const { text, hadBom, isCompressed } = await readProject(projectFile);

  const fixes = [];
  const unfixable = [];
  let updated = text;

  for (const ref of collectReferences(text)) {
    if (!ref.src.startsWith('local:')) {
      unfixable.push({ src: ref.src, reason: 'not a local: reference — bundling did not complete' });
      continue;
    }

    let rest = ref.src.slice('local:'.length);
    let changed = false;

    // Backslashes are a legal filename character on Linux, so a Windows-style
    // separator would be read as part of the name rather than a path.
    if (rest.includes('\\')) {
      rest = rest.replace(/\\/g, '/');
      changed = true;
    }

    const dir = path.posix.dirname(rest);
    const base = path.posix.basename(rest);

    if (!onDisk.includes(base)) {
      const actual = byLower.get(base.toLowerCase());
      if (actual) {
        rest = (dir === '.' ? '' : `${dir}/`) + actual;
        changed = true;
      } else {
        unfixable.push({ src: ref.src, reason: 'no matching resource file' });
        continue;
      }
    }

    if (!changed) continue;

    const from = `src="${xmlEscapeAttr(ref.src)}"`;
    const to = `src="${xmlEscapeAttr(`local:${rest}`)}"`;
    if (updated.includes(from)) {
      updated = updated.split(from).join(to);
      fixes.push({ from: ref.src, to: `local:${rest}` });
    }
  }

  if (fixes.length === 0) {
    return { changed: false, fixes: [], unfixable, collisions, checked: onDisk.length };
  }

  if (!validateProjectText(updated).valid) {
    throw new BundleError('Linux normalisation produced invalid XML; nothing written', 'NORMALIZE_INVALID');
  }

  if (!options.dryRun) {
    const bytes = encodeProjectText(updated, hadBom);
    if (isCompressed) {
      const compressed = validator.compressVerified(bytes);
      if (!compressed.ok) {
        throw new BundleError(`Normalisation recompression failed: ${compressed.reason}`, 'NORMALIZE_RECOMPRESS');
      }
      await fsp.writeFile(projectFile, compressed.buffer);
    } else {
      await fsp.writeFile(projectFile, bytes);
    }
  }

  return { changed: true, fixes, unfixable, collisions, checked: onDisk.length };
}

/**
 * Read-only Linux portability report for a finished bundle.
 * @returns {{ok: boolean, problems: string[], references: number}}
 */
async function auditLinuxPortability(bundleDir) {
  const resourcesDir = path.join(bundleDir, 'resources');
  const projectFile = await findProjectIn(bundleDir);
  const problems = [];

  if (!fs.existsSync(resourcesDir)) return { ok: false, problems: ['no resources folder'], references: 0 };
  if (!projectFile) return { ok: false, problems: ['no project file'], references: 0 };

  const onDisk = (await fsp.readdir(resourcesDir)).filter((f) => !f.startsWith('.'));
  const { text } = await readProject(projectFile);
  const refs = collectReferences(text);

  const seenLower = new Map();
  for (const name of onDisk) {
    const key = name.toLowerCase();
    if (seenLower.has(key)) problems.push(`case-colliding resources: "${seenLower.get(key)}" and "${name}"`);
    seenLower.set(key, name);
  }

  for (const ref of refs) {
    if (!ref.src.startsWith('local:')) {
      problems.push(`non-local reference: ${ref.src}`);
      continue;
    }
    if (ref.src.includes('\\')) problems.push(`backslash in reference: ${ref.src}`);
    const base = path.posix.basename(ref.src.slice('local:'.length));
    if (!onDisk.includes(base)) {
      const ci = onDisk.find((f) => f.toLowerCase() === base.toLowerCase());
      problems.push(ci
        ? `case mismatch: project wants "${base}", disk has "${ci}"`
        : `missing resource: "${base}"`);
    }
    if (base.includes('\0')) problems.push(`NUL byte in resource name`);
  }

  return { ok: problems.length === 0, problems, references: refs.length };
}

/* ------------------------------------------------------------------ *
 * STAGE 5 — validate
 * ------------------------------------------------------------------ */

/**
 * Prove the bundle is genuinely self-contained.
 *
 * Note a deliberate change from the original spec: it asked that the resource
 * count match the reference count. After dedupe that is wrong by design — the
 * correct invariant is that the resource count matches the number of DISTINCT
 * referenced filenames, and that nothing is orphaned.
 */
async function validateBundle(bundleDir) {
  const checks = [];
  const fail = (name, detail) => checks.push({ name, ok: false, detail });
  const pass = (name, detail) => checks.push({ name, ok: true, detail });

  const resourcesDir = path.join(bundleDir, 'resources');

  if (!fs.existsSync(resourcesDir)) {
    fail('resources folder exists', resourcesDir);
    return { ok: false, checks };
  }

  const resources = (await fsp.readdir(resourcesDir)).filter((f) => !f.startsWith('.'));

  const projectFile = await findProjectIn(bundleDir);
  if (!projectFile) {
    fail('bundled project file present', bundleDir);
    return { ok: false, checks };
  }
  pass('bundled project file present', path.basename(projectFile));

  const { text } = await readProject(projectFile);
  const refs = collectReferences(text);

  // A project with no samples legitimately has an empty resources folder — it
  // is self-contained by definition. Only demand resources when it needs them.
  if (refs.length === 0) {
    pass('no sample references — empty resources folder is correct', `${resources.length} file(s)`);
  } else if (resources.length > 0) {
    pass('resources folder is not empty', `${resources.length} file(s)`);
  } else {
    fail('resources folder is not empty', 'empty, but the project references samples');
  }

  const notLocal = refs.filter((r) => !r.src.startsWith('local:'));
  notLocal.length === 0
    ? pass('every sample reference uses local:', `${refs.length} reference(s)`)
    : fail('every sample reference uses local:', `${notLocal.length} still absolute, e.g. ${notLocal[0].src}`);

  // Every referenced file must exist, with exact case.
  const referencedNames = new Set();
  const missing = [];
  for (const ref of refs) {
    if (!ref.src.startsWith('local:')) continue;
    const rel = ref.src.slice('local:'.length);
    const name = path.basename(rel);
    referencedNames.add(name);
    if (!resources.includes(name)) missing.push(name);
  }
  missing.length === 0
    ? pass('all referenced resources present (case exact)', `${referencedNames.size} distinct`)
    : fail('all referenced resources present (case exact)', `missing: ${[...new Set(missing)].join(', ')}`);

  // After dedupe: resources should equal DISTINCT referenced names, no orphans.
  const orphans = resources.filter((r) => !referencedNames.has(r));
  orphans.length === 0
    ? pass('no orphaned resources', `${resources.length} file(s) all referenced`)
    : fail('no orphaned resources', `unreferenced: ${orphans.slice(0, 5).join(', ')}`);

  return {
    ok: checks.every((c) => c.ok),
    checks,
    referenceCount: refs.length,
    distinctReferenced: referencedNames.size,
    resourceCount: resources.length,
  };
}

/**
 * Sample search roots for the current platform, honouring env overrides.
 * Returns the first factory directory that actually exists.
 */
function defaultSampleDirs() {
  const working = process.env.LMMS_WORKING_DIR || defaultWorkingDir();
  const factory = process.env.LMMS_FACTORY_SAMPLES
    || defaultFactorySamples().find((p) => fs.existsSync(p))
    || defaultFactorySamples()[0];

  return {
    userSamples: process.env.LMMS_USER_SAMPLES || path.join(working, 'samples'),
    factory,
    gig: process.env.LMMS_GIG_DIR || path.join(working, 'samples', 'gig'),
    soundfont: process.env.LMMS_SF2_DIR || path.join(working, 'samples', 'soundfonts'),
  };
}

module.exports = {
  detectLmms,
  defaultSampleDirs,
  defaultLmmsPaths,
  collectReferences,
  countEmptyReferences,
  resolveReference,
  verifyProject,
  stripEmptySampleSlots,
  makeBundle,
  dedupeBundle,
  normalizeForLinux,
  auditLinuxPortability,
  validateBundle,
  readProject,
  existsExact,
  SAMPLE_NODES,
  BundleError,
};
