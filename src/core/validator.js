'use strict';
/**
 * validator.js — integrity checks around the read/modify/write pipeline.
 *
 * The contract this module enforces:
 *
 *   qUncompress(producedMmpz) === intended modified XML bytes
 *
 * We never trust that compression "probably worked": every .mmpz we are about
 * to write is decompressed again in memory and compared byte-for-byte against
 * the bytes we meant to store. If that comparison fails, nothing is written.
 */

const crypto = require('crypto');
const { decompressMmpz, compressMmpz } = require('./mmpz');
const { validateProjectText } = require('./mmp');

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/**
 * Verify that a .mmpz buffer decompresses to exactly `expectedBytes`.
 *
 * @param {Buffer} producedMmpz
 * @param {Buffer} expectedBytes
 * @returns {{ok: boolean, reason?: string, expectedSha?: string, actualSha?: string}}
 */
function verifyRoundTrip(producedMmpz, expectedBytes) {
  let decoded;
  try {
    decoded = decompressMmpz(producedMmpz);
  } catch (err) {
    return { ok: false, reason: `round-trip decompression failed: ${err.message}` };
  }

  const expectedSha = sha256(expectedBytes);
  const actualSha = sha256(decoded);

  if (!decoded.equals(expectedBytes)) {
    return {
      ok: false,
      reason: `round-trip mismatch (expected ${expectedBytes.length} bytes, got ${decoded.length})`,
      expectedSha,
      actualSha,
    };
  }

  return { ok: true, expectedSha, actualSha };
}

/**
 * Compress and immediately verify. Returns the buffer only if it is provably
 * correct.
 *
 * @param {Buffer} xmlBytes
 * @returns {{ok: boolean, buffer?: Buffer, reason?: string, expectedSha?: string, actualSha?: string}}
 */
function compressVerified(xmlBytes) {
  let produced;
  try {
    produced = compressMmpz(xmlBytes);
  } catch (err) {
    return { ok: false, reason: `compression failed: ${err.message}` };
  }

  const check = verifyRoundTrip(produced, xmlBytes);
  if (!check.ok) return check;

  return { ok: true, buffer: produced, ...check };
}

/**
 * Confirm modified text still looks like an LMMS project. Guards against a
 * replacement string that would break the document (for example one containing
 * a raw quote that closes an attribute early).
 *
 * @param {string} modifiedText
 */
function verifyStillValidProject(modifiedText) {
  const result = validateProjectText(modifiedText);
  return result.valid
    ? { ok: true }
    : { ok: false, reason: `modified content is no longer a valid project: ${result.reason}` };
}

/**
 * Sanity-check that we changed only what we intended.
 *
 * The size delta of a pure root substitution is exactly
 *   occurrences * (newRoot.length - oldRoot.length)
 * in characters. A mismatch means something other than the requested roots
 * moved, so we refuse the file.
 *
 * Note this is computed in UTF-16 code units on the JS strings, which is the
 * same unit both lengths are measured in, so it holds for non-ASCII paths too.
 *
 * @param {string} originalText
 * @param {string} modifiedText
 * @param {number} occurrences
 * @param {Array<{search: string, replacement: string, label: string}>} variants
 * @param {Record<string, number>} byVariant
 */
function verifyDeltaConsistent(originalText, modifiedText, occurrences, variants, byVariant) {
  let expectedDelta = 0;
  for (const variant of variants) {
    const count = byVariant[variant.label] || 0;
    expectedDelta += count * (variant.replacement.length - variant.search.length);
  }

  const actualDelta = modifiedText.length - originalText.length;
  if (actualDelta !== expectedDelta) {
    return {
      ok: false,
      reason: `unexpected change in document length (expected delta ${expectedDelta}, got ${actualDelta})`,
    };
  }
  return { ok: true };
}

module.exports = {
  sha256,
  verifyRoundTrip,
  compressVerified,
  verifyStillValidProject,
  verifyDeltaConsistent,
};
