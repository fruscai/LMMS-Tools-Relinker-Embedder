'use strict';
/**
 * pathReplace.js — deterministic old-root -> new-root substitution.
 *
 * There is no fuzzy matching here, by design. We only ever replace byte
 * sequences the user explicitly asked us to replace.
 *
 * Two real-world details make a naive `text.replaceAll(old, new)` wrong:
 *
 *  1. SEPARATORS. LMMS stores Windows paths with FORWARD slashes, e.g.
 *       src="C:/Users/Bob/Desktop/audio/kick.wav"
 *     but LMMS reports the missing path to the user, and Windows users
 *     naturally paste, backslashes. A literal-only match would find zero
 *     occurrences in the exact scenario this tool exists for. So we can also
 *     match the separator-swapped form. This is an explicit, labelled option,
 *     never a silent normalisation, and the scan shows which form matched.
 *
 *  2. XML ENTITIES. Attribute values are escaped by Qt's DOM writer, so a path
 *     containing & or " appears encoded. We match the encoded form too, and
 *     write the replacement back using the same encoding as the form matched.
 *
 * Everything else in the document is left untouched.
 */

/** Escape a string the way Qt's QDomDocument escapes an attribute value. */
function xmlEscapeAttr(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function toForwardSlashes(value) {
  return value.replace(/\\/g, '/');
}

function toBackSlashes(value) {
  return value.replace(/\//g, '\\');
}

/**
 * Build the set of (search, replacement) pairs to apply.
 *
 * Each variant keeps a human-readable label so the preview can tell the user
 * exactly which textual form was found in their projects.
 *
 * @param {string} oldRoot
 * @param {string} newRoot
 * @param {{matchSeparatorVariants?: boolean}} [options]
 * @returns {Array<{search: string, replacement: string, label: string}>}
 */
function buildVariants(oldRoot, newRoot, options = {}) {
  const matchSeparatorVariants = options.matchSeparatorVariants !== false;

  /** @type {Array<{search: string, replacement: string, label: string}>} */
  const variants = [];
  const seen = new Set();

  const push = (search, replacement, label) => {
    if (!search) return;
    if (seen.has(search)) return;
    seen.add(search);
    variants.push({ search, replacement, label });
  };

  // Exact literal form, as typed by the user.
  push(oldRoot, newRoot, 'literal');

  if (matchSeparatorVariants) {
    // Match the stored convention, and write the replacement using that same
    // convention so we never mix separator styles inside one path.
    push(toForwardSlashes(oldRoot), toForwardSlashes(newRoot), 'forward-slash');
    push(toBackSlashes(oldRoot), toBackSlashes(newRoot), 'back-slash');
  }

  // XML-escaped counterparts of everything above.
  for (const v of [...variants]) {
    const escaped = xmlEscapeAttr(v.search);
    if (escaped !== v.search) {
      push(escaped, xmlEscapeAttr(v.replacement), `${v.label} (xml-escaped)`);
    }
  }

  return variants;
}

/**
 * Apply variants in a single left-to-right pass.
 *
 * A single pass matters: replacing sequentially with separate passes could let
 * a later variant match text we just inserted. Scanning once, and always
 * continuing after the text we emitted, makes that impossible.
 *
 * At any position the longest matching variant wins, so a more specific form
 * is never pre-empted by a shorter one.
 *
 * @param {string} text
 * @param {Array<{search: string, replacement: string, label: string}>} variants
 * @returns {{text: string, occurrences: number, byVariant: Record<string, number>}}
 */
function applyVariants(text, variants) {
  const byVariant = Object.create(null);
  if (variants.length === 0) {
    return { text, occurrences: 0, byVariant };
  }

  const pieces = [];
  let cursor = 0; // start of the not-yet-emitted tail
  let searchFrom = 0;
  let occurrences = 0;

  for (;;) {
    let bestIndex = -1;
    let bestVariant = null;

    for (const variant of variants) {
      const index = text.indexOf(variant.search, searchFrom);
      if (index === -1) continue;
      const better =
        bestIndex === -1 ||
        index < bestIndex ||
        (index === bestIndex && variant.search.length > bestVariant.search.length);
      if (better) {
        bestIndex = index;
        bestVariant = variant;
      }
    }

    if (bestIndex === -1) break;

    pieces.push(text.slice(cursor, bestIndex), bestVariant.replacement);
    occurrences += 1;
    byVariant[bestVariant.label] = (byVariant[bestVariant.label] || 0) + 1;

    searchFrom = bestIndex + bestVariant.search.length;
    cursor = searchFrom;
  }

  if (occurrences === 0) {
    return { text, occurrences: 0, byVariant };
  }

  pieces.push(text.slice(cursor));
  return { text: pieces.join(''), occurrences, byVariant };
}

/**
 * Replace an old path root with a new one.
 *
 * @param {string} text project XML
 * @param {string} oldRoot
 * @param {string} newRoot
 * @param {{matchSeparatorVariants?: boolean}} [options]
 * @returns {{text: string, occurrences: number, byVariant: Record<string, number>, changed: boolean}}
 */
function replacePathRoot(text, oldRoot, newRoot, options = {}) {
  if (typeof oldRoot !== 'string' || oldRoot.length === 0) {
    throw new Error('oldRoot must be a non-empty string');
  }
  if (typeof newRoot !== 'string') {
    throw new Error('newRoot must be a string');
  }

  const variants = buildVariants(oldRoot, newRoot, options);
  const result = applyVariants(text, variants);

  return {
    text: result.text,
    occurrences: result.occurrences,
    byVariant: result.byVariant,
    changed: result.occurrences > 0 && result.text !== text,
  };
}

/**
 * Count occurrences without producing modified text (used by the dry-run scan).
 */
function countOccurrences(text, oldRoot, newRoot, options = {}) {
  const { occurrences, byVariant } = applyVariants(
    text,
    buildVariants(oldRoot, newRoot, options)
  );
  return { occurrences, byVariant };
}

/**
 * Pull one real before/after example out of a document, so the preview can show
 * the user an actual path from their own projects rather than a made-up one.
 *
 * @param {string} text
 * @param {Array<{search: string, replacement: string, label: string}>} variants
 * @returns {{before: string, after: string, label: string}|null}
 */
function extractExample(text, variants) {
  let bestIndex = -1;
  let bestVariant = null;

  for (const variant of variants) {
    const index = text.indexOf(variant.search);
    if (index === -1) continue;
    if (bestIndex === -1 || index < bestIndex) {
      bestIndex = index;
      bestVariant = variant;
    }
  }
  if (bestIndex === -1) return null;

  // Expand to the enclosing attribute value, so the example is a whole path.
  let start = text.lastIndexOf('"', bestIndex);
  let end = text.indexOf('"', bestIndex + bestVariant.search.length);
  if (start === -1 || end === -1 || end - start > 4096) {
    start = bestIndex - 1;
    end = bestIndex + bestVariant.search.length;
  }

  const before = text.slice(start + 1, end);
  const after = applyVariants(before, variants).text;

  return { before, after, label: bestVariant.label };
}

module.exports = {
  replacePathRoot,
  countOccurrences,
  buildVariants,
  extractExample,
  xmlEscapeAttr,
};
