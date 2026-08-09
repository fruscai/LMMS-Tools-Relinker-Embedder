'use strict';
/**
 * embed-samples.js — write the audio INTO the project file.
 *
 * LMMS AudioFileProcessor, from src (plugins/AudioFileProcessor):
 *
 *   save:  elem.setAttribute("src", m_sample.sampleFile());
 *          if (m_sample.sampleFile().isEmpty())
 *              elem.setAttribute("sampledata", m_sample.toBase64());
 *
 *   load:  if src is non-empty  -> load that file (error if missing)
 *          else if sampledata   -> Sample(SampleBuffer::fromBase64(sampleData))
 *
 * So `src` WINS. To use embedded audio the src attribute must be removed.
 *
 * SampleBuffer::toBase64 encodes the raw SampleFrame array. A SampleFrame is
 * two float32s (left, right) = 8 bytes — confirmed by LMMS's own placeholder
 * value "AAAAAAAAAAA=", which decodes to exactly 8 zero bytes (one silent
 * stereo frame).
 *
 * The result needs no external files, no resources folder, and no `local:`
 * prefix — so it does not depend on LMMS 1.3.
 *
 * Usage: node tools/embed-samples.js <project.mmpz> <sampleDir> <out.mmpz>
 */

const fs = require('fs');
const path = require('path');
const { decompressMmpz, compressMmpz } = require('../src/core/mmpz');

/** Decode a PCM WAV into interleaved stereo float32 (LMMS SampleFrame array). */
function wavToSampleFrames(buffer) {
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a RIFF/WAVE file');
  }

  let fmt = null;
  let data = null;
  let offset = 12;

  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = buffer.subarray(offset + 8, offset + 8 + size);
    if (id === 'fmt ') {
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

  if (!fmt || !data) throw new Error('missing fmt or data chunk');
  if (fmt.audioFormat !== 1 && fmt.audioFormat !== 3) {
    throw new Error(`unsupported WAV encoding ${fmt.audioFormat}`);
  }

  const bytesPerSample = fmt.bits / 8;
  const frameCount = Math.floor(data.length / (bytesPerSample * fmt.channels));
  const out = Buffer.alloc(frameCount * 8); // 2 x float32

  const readSample = (pos) => {
    switch (fmt.bits) {
      case 8:  return (data.readUInt8(pos) - 128) / 128;
      case 16: return data.readInt16LE(pos) / 32768;
      case 24: {
        const v = data[pos] | (data[pos + 1] << 8) | (data[pos + 2] << 16);
        return ((v & 0x800000) ? v - 0x1000000 : v) / 8388608;
      }
      case 32: return fmt.audioFormat === 3
        ? data.readFloatLE(pos)
        : data.readInt32LE(pos) / 2147483648;
      default: throw new Error(`unsupported bit depth ${fmt.bits}`);
    }
  };

  for (let i = 0; i < frameCount; i += 1) {
    const base = i * bytesPerSample * fmt.channels;
    const left = readSample(base);
    const right = fmt.channels > 1 ? readSample(base + bytesPerSample) : left;
    out.writeFloatLE(left, i * 8);
    out.writeFloatLE(right, i * 8 + 4);
  }

  return { frames: out, info: fmt, frameCount };
}

const xmlEscape = (v) => v
  .replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function main() {
  const [, , projectPath, sampleDir, outPath] = process.argv;
  if (!projectPath || !sampleDir || !outPath) {
    console.error('usage: node tools/embed-samples.js <project.mmpz> <sampleDir> <out.mmpz>');
    process.exit(2);
  }

  const raw = fs.readFileSync(projectPath);
  const isCompressed = path.extname(projectPath).toLowerCase() === '.mmpz';
  let xml = (isCompressed ? decompressMmpz(raw) : raw).toString('utf8');

  const cache = new Map();
  let embedded = 0;
  let skipped = 0;

  // Replace src="…" on audiofileprocessor nodes with sampledata="…".
  xml = xml.replace(
    /<audiofileprocessor\b([^>]*?)\s*src="([^"]*)"([^>]*)>/g,
    (whole, before, src, after) => {
      if (!src) { skipped += 1; return whole; }

      const name = path.basename(src.replace(/\\/g, '/'));
      if (!cache.has(name)) {
        const file = path.join(sampleDir, name);
        if (!fs.existsSync(file)) {
          console.error(`  ! sample not found, leaving src alone: ${name}`);
          cache.set(name, null);
        } else {
          const { frames, info, frameCount } = wavToSampleFrames(fs.readFileSync(file));
          cache.set(name, frames.toString('base64'));
          console.log(`  encoded ${name}: ${frameCount} frames @ ${info.sampleRate}Hz ` +
                      `${info.bits}-bit x${info.channels} -> ${(frames.length / 1048576).toFixed(2)} MB raw`);
        }
      }

      const b64 = cache.get(name);
      if (!b64) { skipped += 1; return whole; }

      embedded += 1;

      // Rebuild the tag carefully. `after` may end with the self-closing "/",
      // which must not be left in the middle of the attribute list.
      const selfClosing = /\/\s*$/.test(after);
      const attrs = `${before} ${after.replace(/\/\s*$/, '')}`
        .replace(/\s*\bsampledata="[^"]*"/g, '')   // drop any existing placeholder
        .replace(/\s+/g, ' ')
        .trim();

      return `<audiofileprocessor ${attrs} sampledata="${xmlEscape(b64)}"${selfClosing ? '/' : ''}>`;
    }
  );

  const bytes = Buffer.from(xml, 'utf8');
  fs.writeFileSync(outPath, path.extname(outPath).toLowerCase() === '.mmpz'
    ? compressMmpz(bytes) : bytes);

  console.log(`\n  embedded into ${embedded} instrument(s), skipped ${skipped}`);
  console.log(`  XML ${(bytes.length / 1048576).toFixed(2)} MB -> file ${(fs.statSync(outPath).size / 1048576).toFixed(2)} MB`);
}

main();
