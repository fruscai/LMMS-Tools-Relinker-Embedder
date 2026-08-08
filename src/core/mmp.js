'use strict';
/**
 * mmp.js — load and validate uncompressed LMMS project XML.
 *
 * Deliberately does NOT parse into a DOM. The whole point of this tool is that
 * the bytes we do not touch stay exactly as they were, so the project is
 * handled as text and never re-serialised.
 */

/** UTF-8 byte-order mark. LMMS does not write one, but we tolerate it. */
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

class MmpError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'MmpError';
    this.code = code;
  }
}

/**
 * Decode project bytes to text, refusing anything that would not survive a
 * round trip back to the identical bytes.
 *
 * This guard matters: Buffer#toString('utf8') silently substitutes U+FFFD for
 * invalid sequences, which would corrupt a project on re-encode. We would
 * rather flag the file than quietly damage it.
 *
 * @param {Buffer} buffer
 * @returns {{text: string, hadBom: boolean}}
 */
function decodeProjectText(buffer) {
  if (!Buffer.isBuffer(buffer)) {
    throw new MmpError('Expected a Buffer', 'NOT_A_BUFFER');
  }

  const hadBom = buffer.length >= 3 && buffer.subarray(0, 3).equals(BOM);
  const body = hadBom ? buffer.subarray(3) : buffer;

  const text = body.toString('utf8');

  if (!Buffer.from(text, 'utf8').equals(body)) {
    throw new MmpError(
      'Project bytes are not valid UTF-8; refusing to edit because re-encoding would alter the file',
      'NOT_VALID_UTF8'
    );
  }

  return { text, hadBom };
}

/**
 * Re-encode text to bytes using the same framing the source had.
 * @param {string} text
 * @param {boolean} hadBom
 * @returns {Buffer}
 */
function encodeProjectText(text, hadBom) {
  const body = Buffer.from(text, 'utf8');
  return hadBom ? Buffer.concat([BOM, body]) : body;
}

/**
 * Confirm the content is an LMMS project document.
 *
 * This is a content sniff, not a schema validation. We only need enough
 * confidence that we are editing a real project and not an unrelated file.
 *
 * @param {string} text
 * @returns {{valid: boolean, reason?: string, docType?: string}}
 */
function validateProjectText(text) {
  if (typeof text !== 'string' || text.length === 0) {
    return { valid: false, reason: 'Empty content' };
  }

  // Look only at the head of the document; the root element appears early.
  const head = text.slice(0, 4096);

  if (!/<\?xml\s/.test(head)) {
    return { valid: false, reason: 'Missing XML declaration' };
  }

  // LMMS writes <!DOCTYPE lmms-project> and a <lmms-project ...> root.
  // Presets and tracks use different roots, which we do not handle in V1.
  const rootMatch = head.match(/<(lmms-project|multimedia-project)[\s>]/);
  if (!rootMatch) {
    return {
      valid: false,
      reason: 'No <lmms-project> root element found',
    };
  }

  return { valid: true, docType: rootMatch[1] };
}

/**
 * Convenience: bytes -> validated text.
 * @param {Buffer} buffer
 */
function loadProject(buffer) {
  const { text, hadBom } = decodeProjectText(buffer);
  const validation = validateProjectText(text);
  if (!validation.valid) {
    throw new MmpError(
      `Not a valid LMMS project: ${validation.reason}`,
      'INVALID_PROJECT'
    );
  }
  return { text, hadBom, docType: validation.docType };
}

module.exports = {
  decodeProjectText,
  encodeProjectText,
  validateProjectText,
  loadProject,
  MmpError,
};
