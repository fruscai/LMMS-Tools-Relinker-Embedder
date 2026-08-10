'use strict';
/**
 * compat12.js — make an embedded project openable and audible in LMMS 1.2.
 *
 * Two separate problems, both measured against a real 1.2.2 install:
 *
 * 1. SILENCE. LMMS 1.2 checks the "sampledata" attribute but then reads
 *    "srcdata" (bug present across stable-1.2), so embedded audio never loads
 *    and the project renders silence with no error. Writing the same base64 to
 *    both attributes fixes it. 1.3 reads sampledata and ignores srcdata.
 *
 * 2. MODALS. A project saved by 1.3 carries a <midicontrollers> node per
 *    instrument track. 1.2 does not know it and throws "Plugin not found"
 *    once per track. The nodes are all-zero, so dropping them loses nothing.
 *
 * The header is only reverted to 1.2.2 when the body contains no 1.3-only
 * elements. Relabelling a genuinely 1.3 project would make it fail worse.
 *
 * Usage: node tools/compat12.js <in.mmpz> <out.mmpz>
 */

const fs = require('fs');
const path = require('path');
const { decompressMmpz, compressMmpz } = require('../src/core/mmpz');

const LMMS13_ONLY = ['midiclip', 'automationclip', 'mixer', 'mixerchannel', 'sampleclip'];

function inspect(xml) {
  const blockers = LMMS13_ONLY.filter((t) => new RegExp('<' + t + '\\b').test(xml));
  const nodes = xml.match(/<midicontrollers\b[^>]*>/g) || [];
  const empty = nodes.filter((n) => [...n.matchAll(/="([^"]*)"/g)].every((m) => m[1] === '0'));
  const header = (xml.match(/<lmms-project[^>]*>/) || [''])[0];
  return { blockers, midiControllers: nodes.length, removable: empty.length,
           claims13: /creatorversion="1\.3/.test(header), header };
}

/** Duplicate every sampledata payload onto srcdata so 1.2 can read it. */
function addSrcData(xml) {
  let n = 0;
  const out = xml.replace(/<(audiofileprocessor|sampleclip|sampletco)\b([^>]*)>/g, (whole, tag, attrs) => {
    const m = attrs.match(/\bsampledata="([^"]*)"/);
    if (!m || !m[1]) return whole;
    if (/\bsrcdata="/.test(attrs)) return whole;   // already done
    n += 1;
    const selfClosing = /\/\s*$/.test(attrs);
    const body = attrs.replace(/\/\s*$/, '');
    return `<${tag}${body} srcdata="${m[1]}"${selfClosing ? '/' : ''}>`;
  });
  return { xml: out, added: n };
}

/** Remove 1.3-only cruft and, where safe, revert the header. */
function stripFor12(xml) {
  const before = inspect(xml);
  let out = xml;
  let removed = 0;

  if (before.midiControllers > 0 && before.removable === before.midiControllers) {
    removed = before.midiControllers;
    out = out
      .replace(/\s*<midicontrollers\b[^>]*\/>/g, '')
      .replace(/\s*<midicontrollers\b[^>]*>[\s\S]*?<\/midicontrollers>/g, '');
  }

  let headerChanged = false;
  if (before.blockers.length === 0 && before.claims13) {
    out = out.replace(/<lmms-project[^>]*>/, (tag) => {
      headerChanged = true;
      return tag
        .replace(/creatorversion="[^"]*"/, 'creatorversion="1.2.2"')
        .replace(/\bversion="(?!1\.0")[^"]*"/, 'version="1.0"');
    });
  }

  return { xml: out, removed, headerChanged, blockers: before.blockers };
}

if (require.main === module) {
  const [, , input, output] = process.argv;
  if (!input || !output) {
    console.error('usage: node tools/compat12.js <in.mmpz> <out.mmpz>');
    process.exit(2);
  }

  const raw = fs.readFileSync(input);
  const compressed = /\.mmpz(\.bak)?$/i.test(input);
  const xml = (compressed ? decompressMmpz(raw) : raw).toString('utf8');

  const before = inspect(xml);
  console.log('before:');
  console.log('  ' + before.header.slice(0, 110));
  console.log(`  midicontrollers ${before.midiControllers} (${before.removable} all-zero)`);
  console.log(`  1.3-only elements: ${before.blockers.length ? before.blockers.join(', ') : 'none'}`);

  const a = addSrcData(xml);
  const b = stripFor12(a.xml);

  console.log('\nchanges:');
  console.log(`  srcdata added to ${a.added} node(s)`);
  console.log(`  midicontrollers removed: ${b.removed}`);
  console.log(`  header reverted: ${b.headerChanged}`);
  if (b.blockers.length) console.log(`  NOT 1.2-loadable regardless: ${b.blockers.join(', ')}`);

  const bytes = Buffer.from(b.xml, 'utf8');
  fs.writeFileSync(output, /\.mmpz$/i.test(output) ? compressMmpz(bytes) : bytes);
  console.log('\nafter:');
  console.log('  ' + (b.xml.match(/<lmms-project[^>]*>/) || [''])[0].slice(0, 110));
  console.log(`  ${(fs.statSync(output).size / 1048576).toFixed(1)} MB`);
}

module.exports = { inspect, addSrcData, stripFor12 };
