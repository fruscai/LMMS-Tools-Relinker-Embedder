'use strict';
/**
 * mmpz.js — Qt qCompress-compatible container for LMMS .mmpz project files.
 *
 * Format (see docs/LMMS_FORMAT_NOTES.md):
 *
 *   [ 4-byte unsigned big-endian uncompressed length ][ zlib stream ]
 *
 * LMMS writes this via `outfile.write(qCompress(xml.toUtf8()))` in
 * src/core/DataFile.cpp. qCompress with no explicit level uses Qt's default
 * of -1, which delegates to zlib's default compression level.
 *
 * This module has NO UI dependencies and does not touch the filesystem.
 */

const zlib = require('zlib');

/** Hard ceiling on decompressed project size, to bound decompression bombs. */
const DEFAULT_MAX_DECOMPRESSED = 256 * 1024 * 1024; // 256 MiB

/** Minimum viable file: 4-byte prefix + at least one byte of stream. */
const MIN_MMPZ_LENGTH = 5;

class MmpzError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'MmpzError';
    this.code = code;
  }
}

/**
 * Decompress a qCompress-format buffer into the original bytes.
 *
 * @param {Buffer} buffer raw .mmpz file bytes
 * @param {{maxDecompressed?: number, strictLength?: boolean}} [options]
 * @returns {Buffer} the uncompressed payload (LMMS project XML, UTF-8)
 */
function decompressMmpz(buffer, options = {}) {
  const maxDecompressed = options.maxDecompressed ?? DEFAULT_MAX_DECOMPRESSED;
  const strictLength = options.strictLength !== false;

  if (!Buffer.isBuffer(buffer)) {
    throw new MmpzError('Expected a Buffer', 'NOT_A_BUFFER');
  }
  if (buffer.length < MIN_MMPZ_LENGTH) {
    throw new MmpzError(
      `File is too short to be a .mmpz (${buffer.length} bytes, need at least ${MIN_MMPZ_LENGTH})`,
      'TOO_SHORT'
    );
  }

  const declaredSize = buffer.readUInt32BE(0);

  // Reject an absurd declared size before allocating anything.
  if (declaredSize > maxDecompressed) {
    throw new MmpzError(
      `Declared uncompressed size ${declaredSize} exceeds the limit of ${maxDecompressed} bytes`,
      'DECLARED_SIZE_TOO_LARGE'
    );
  }

  const stream = buffer.subarray(4);

  let inflated;
  try {
    inflated = zlib.inflateSync(stream, { maxOutputLength: maxDecompressed });
  } catch (err) {
    throw new MmpzError(
      `zlib inflate failed: ${err.message}`,
      'INFLATE_FAILED'
    );
  }

  // The declared length is part of the container contract. A mismatch means
  // the file is truncated or corrupt, so we refuse rather than guess.
  if (strictLength && inflated.length !== declaredSize) {
    throw new MmpzError(
      `Declared uncompressed size ${declaredSize} does not match actual ${inflated.length}`,
      'LENGTH_MISMATCH'
    );
  }

  return inflated;
}

/**
 * Compress bytes into the qCompress container format.
 *
 * @param {Buffer} payload the complete project XML as UTF-8 bytes
 * @param {{level?: number}} [options] level defaults to zlib's default (-1),
 *   matching Qt qCompress's default behaviour.
 * @returns {Buffer} .mmpz bytes
 */
function compressMmpz(payload, options = {}) {
  if (!Buffer.isBuffer(payload)) {
    throw new MmpzError('Expected a Buffer', 'NOT_A_BUFFER');
  }

  // Qt's qCompress returns a bare 4-byte zero prefix for empty input.
  if (payload.length === 0) {
    return Buffer.alloc(4);
  }

  const level = options.level ?? zlib.constants.Z_DEFAULT_COMPRESSION;

  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(payload.length, 0);

  const deflated = zlib.deflateSync(payload, { level });

  return Buffer.concat([prefix, deflated]);
}

/**
 * Cheap structural probe used by the scanner before committing to real work.
 * Does not inflate the stream.
 */
function looksLikeMmpz(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < MIN_MMPZ_LENGTH) return false;
  // zlib header: CMF low nibble 8 (deflate), and (CMF<<8|FLG) % 31 === 0.
  const cmf = buffer[4];
  const flg = buffer[5];
  if ((cmf & 0x0f) !== 8) return false;
  if (buffer.length < 6) return false;
  return ((cmf << 8) | flg) % 31 === 0;
}

module.exports = {
  decompressMmpz,
  compressMmpz,
  looksLikeMmpz,
  MmpzError,
  DEFAULT_MAX_DECOMPRESSED,
};
