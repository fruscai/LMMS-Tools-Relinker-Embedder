'use strict';
/**
 * embed.js — write sample audio directly INTO the project file.
 *
 * Why this exists, in one line: a project that carries its audio inside itself
 * has nothing to resolve, so it cannot fail to find its samples.
 *
 * From LMMS's AudioFileProcessor:
 *
 *   save:  elem.setAttribute("src", m_sample.sampleFile());
 *          if (sampleFile().isEmpty()) elem.setAttribute("sampledata", toBase64());
 *
 *   load:  if src non-empty -> load that file; error if missing (NO fallback)
 *          else if sampledata -> Sample(SampleBuffer::fromBase64(data))
 *
 * Two consequences drive this whole module:
 *   1. `src` WINS. It must be removed, not blanked, or the embedded audio is
 *      ignored and a missing file produces LMMS's "0ms empty instrument".
 *   2. The payload is a raw SampleFrame array — two float32s per frame.
 *      Verified against LMMS's own placeholder "AAAAAAAAAAA=", which decodes
 *      to exactly 8 zero bytes: one silent stereo frame.
 *
 * Unlike bundling, this needs no `resources` folder, no `local:` prefix (so no
 * LMMS 1.3 requirement), and no particular working directory.
 */

const fs = require('fs');
const path = require('path');

const { decompressMmpz, compressMmpz } = require('./mmpz');
const { validateProjectText } = require('./mmp');

/** Elements whose `src` points at an audio sample. */
const SAMPLE_NODES = ['audiofileprocessor', 'sampleclip', 'sampletco'];

/**
 * LMMS prefixes carry NO slash after the colon (`usergig:Snare Sounds.wav`),
 * so path.basename() would return the prefix too and the lookup would miss.
 * This bug silently left a whole project unembedded during development.
 */
const LMMS_PREFIX = /^(factorysample|usersample|usergig|usersoundfont|local):/i;

/** Audio extensions LMMS can load as samples. */
const AUDIO_EXT = new Set(['.wav', '.aiff', '.aif', '.flac', '.ogg', '.mp3', '.raw']);

class EmbedError extends Error {
  constructor(message, code) { super(message); this.name = 'EmbedError'; this.code = code; }
}

/** The bare filename a reference points at, prefix stripped. */
function sampleNameOf(src) {
  return path.posix.basename(src.replace(/\\/g, '/').replace(LMMS_PREFIX, ''));
}

/** True for LMMS-managed references that resolve on any machine. */
function isFactoryReference(src) {
  return /^factorysample:/i.test(src);
}

/** ".mmpz" and ".mmpz.bak" are both qCompress containers. */
const isCompressed = (file) => /\.mmpz(\.bak)?$/i.test(file);

/** Any LMMS project file, including autosaves. */
const isProjectFile = (file) => /\.(mmpz|mmp)(\.bak)?$/i.test(file);

/* ------------------------------------------------------------------ *
 * WAV decoding
 * ------------------------------------------------------------------ */

/**
 * Decode a PCM/float WAV into LMMS's frame layout: interleaved stereo float32.
 * Mono is duplicated to both channels.
 */
function wavToSampleFrames(buffer) {
  if (buffer.length < 12 || buffer.toString('ascii', 0, 4) !== 'RIFF') {
    throw new EmbedError('not a RIFF/WAVE file', 'NOT_WAV');
  }

  let fmt = null;
  let data = null;
  let offset = 12;

  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = buffer.subarray(offset + 8, Math.min(offset + 8 + size, buffer.length));
    if (id === 'fmt ' && body.length >= 16) {
      fmt = {
        audioFormat: body.readUInt16LE(0),
        channels: body.readUInt16LE(2),
        sampleRate: body.readUInt32LE(4),
        bits: body.readUInt16LE(14),
      };
    } else if (id === 'data') {
      data = body;
    }
    offset += 8 + size + (size % 2); // chunks are word-aligned
  }

  if (!fmt) throw new EmbedError('missing fmt chunk', 'NO_FMT');
  if (!data) throw new EmbedError('missing data chunk', 'NO_DATA');
  if (fmt.audioFormat !== 1 && fmt.audioFormat !== 3) {
    throw new EmbedError(`unsupported WAV encoding ${fmt.audioFormat} (needs PCM or float)`, 'ENCODING');
  }

  const bytesPerSample = fmt.bits / 8;
  const stride = bytesPerSample * fmt.channels;
  const frameCount = Math.floor(data.length / stride);
  const out = Buffer.alloc(frameCount * 8);

  const read = (p) => {
    switch (fmt.bits) {
      case 8: return (data.readUInt8(p) - 128) / 128;
      case 16: return data.readInt16LE(p) / 32768;
      case 24: {
        const v = data[p] | (data[p + 1] << 8) | (data[p + 2] << 16);
        return ((v & 0x800000) ? v - 0x1000000 : v) / 8388608;
      }
      case 32: return fmt.audioFormat === 3
        ? data.readFloatLE(p)
        : data.readInt32LE(p) / 2147483648;
      default: throw new EmbedError(`unsupported bit depth ${fmt.bits}`, 'BIT_DEPTH');
    }
  };

  for (let i = 0; i < frameCount; i += 1) {
    const base = i * stride;
    const left = read(base);
    out.writeFloatLE(left, i * 8);
    out.writeFloatLE(fmt.channels > 1 ? read(base + bytesPerSample) : left, i * 8 + 4);
  }

  return { frames: out, info: fmt, frameCount };
}

/* ------------------------------------------------------------------ *
 * Sample index
 * ------------------------------------------------------------------ */

/**
 * Index every audio file under the given roots, keyed by filename.
 *
 * Searching by name is deliberate: a project's stored path is usually broken —
 * that is the whole problem — so the path cannot be trusted to locate the file.
 * Case-insensitive keys are kept alongside exact ones so a Windows-authored
 * project still matches on a case-sensitive filesystem.
 */
function indexSamples(roots, options = {}) {
  const maxDepth = options.maxDepth ?? 24;
  const exact = new Map();
  const lower = new Map();

  for (const root of roots) {
    if (!root || !fs.existsSync(root)) continue;
    const walk = (dir, depth) => {
      if (depth > maxDepth) return;
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isSymbolicLink()) continue;
        if (e.isDirectory()) { walk(full, depth + 1); continue; }
        if (!e.isFile()) continue;
        if (!AUDIO_EXT.has(path.extname(e.name).toLowerCase())) continue;
        if (!exact.has(e.name)) exact.set(e.name, full);
        const key = e.name.toLowerCase();
        if (!lower.has(key)) lower.set(key, full);
      }
    };
    walk(path.resolve(root), 0);
  }

  return {
    size: exact.size,
    find(name) {
      return exact.get(name) || lower.get(name.toLowerCase()) || null;
    },
  };
}

/* ------------------------------------------------------------------ *
 * Reading / scanning
 * ------------------------------------------------------------------ */

function readProjectText(file) {
  const raw = fs.readFileSync(file);
  const text = (isCompressed(file) ? decompressMmpz(raw) : raw).toString('utf8');
  const validation = validateProjectText(text);
  if (!validation.valid) {
    throw new EmbedError(`not a valid LMMS project: ${validation.reason}`, 'INVALID_PROJECT');
  }
  return text;
}

const NODE_RE = new RegExp(`<(?:${SAMPLE_NODES.join('|')})\\b[^>]*>`, 'g');

/**
 * Report what a project references and whether each sample can be located.
 * Read-only.
 */
function scanProject(file, index) {
  const text = readProjectText(file);
  const found = [];
  const missing = [];
  const factory = [];
  let emptySlots = 0;

  for (const tag of text.match(NODE_RE) || []) {
    const m = tag.match(/\bsrc="([^"]*)"/);
    if (!m) continue;
    const src = m[1];
    if (!src) { emptySlots += 1; continue; }
    if (isFactoryReference(src)) { factory.push(src); continue; }

    const name = sampleNameOf(src);
    (index.find(name) ? found : missing).push({ src, name });
  }

  return {
    references: found.length + missing.length + factory.length,
    embeddable: found.length,
    missing,
    factory: factory.length,
    emptySlots,
    ok: missing.length === 0,
  };
}

/* ------------------------------------------------------------------ *
 * Embedding
 * ------------------------------------------------------------------ */

const xmlEscape = (v) => v
  .replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Rewrite one project so every locatable sample is carried inside it.
 *
 * @param {string} file source project (never modified)
 * @param {string} destination where to write the embedded copy
 * @param {object} index from indexSamples()
 * @param {{cache?: Map, compressionLevel?: number}} [options]
 */
function embedProject(file, destination, index, options = {}) {
  const cache = options.cache || new Map();
  const text = readProjectText(file);

  let embedded = 0;
  let missing = 0;
  let emptySlots = 0;
  let factory = 0;
  const rates = new Set();

  const updated = text.replace(
    new RegExp(`<(${SAMPLE_NODES.join('|')})\\b([^>]*?)\\s*src="([^"]*)"([^>]*)>`, 'g'),
    (whole, tag, before, src, after) => {
      if (!src) { emptySlots += 1; return whole; }
      if (isFactoryReference(src)) { factory += 1; return whole; }

      const name = sampleNameOf(src);
      if (!cache.has(name)) {
        const located = index.find(name);
        if (!located) {
          cache.set(name, null);
        } else {
          try {
            const decoded = wavToSampleFrames(fs.readFileSync(located));
            cache.set(name, { b64: decoded.frames.toString('base64'), rate: decoded.info.sampleRate });
          } catch {
            cache.set(name, null);
          }
        }
      }

      const entry = cache.get(name);
      if (!entry) { missing += 1; return whole; }

      embedded += 1;
      rates.add(entry.rate);

      // Rebuild the tag. `after` may end with the self-closing "/", which must
      // not be left stranded in the middle of the attribute list.
      const selfClosing = /\/\s*$/.test(after);
      const attrs = `${before} ${after.replace(/\/\s*$/, '')}`
        .replace(/\s*\bsampledata="[^"]*"/g, '')
        .replace(/\s+/g, ' ')
        .trim();

      return `<${tag} ${attrs} sampledata="${xmlEscape(entry.b64)}"${selfClosing ? '/' : ''}>`;
    }
  );

  if (!validateProjectText(updated).valid) {
    throw new EmbedError('embedding produced invalid project XML', 'INVALID_RESULT');
  }
  // Nothing that received audio may still carry a src, or LMMS would prefer it.
  const conflicted = (updated.match(/<audiofileprocessor[^>]*\bsrc="[^"]+"[^>]*sampledata=/g) || []).length;
  if (conflicted) {
    throw new EmbedError(`${conflicted} node(s) kept src alongside sampledata`, 'SRC_CONFLICT');
  }

  const bytes = Buffer.from(updated, 'utf8');
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(
    destination,
    isCompressed(destination)
      ? compressMmpz(bytes, { level: options.compressionLevel })
      : bytes
  );

  return { embedded, missing, emptySlots, factory, rates: [...rates], size: fs.statSync(destination).size };
}

/** Every LMMS project under a tree, autosaves included. */
function findProjects(root, maxDepth = 32) {
  const found = [];
  const walk = (dir, depth) => {
    if (depth > maxDepth) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) walk(full, depth + 1);
      else if (isProjectFile(e.name)) found.push(full);
    }
  };
  walk(path.resolve(root), 0);
  return found.sort();
}

module.exports = {
  indexSamples,
  scanProject,
  embedProject,
  findProjects,
  readProjectText,
  wavToSampleFrames,
  sampleNameOf,
  isProjectFile,
  isCompressed,
  AUDIO_EXT,
  EmbedError,
};
