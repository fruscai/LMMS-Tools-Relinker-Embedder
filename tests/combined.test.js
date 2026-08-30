'use strict';
/**
 * The combined page carries the two standalone tools verbatim. If either drifts
 * from its payload, the combined tool ships something nobody tested.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const WEB = path.join(__dirname, '..', 'web');
const read = (f) => fs.readFileSync(path.join(WEB, f));
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

const combined = read('lmms-tools.html').toString('utf8');

const payload = (pane) => {
  const m = combined.match(new RegExp(`'${pane}':"([A-Za-z0-9+/=]+)"`));
  assert.ok(m, `no ${pane} payload`);
  return Buffer.from(m[1], 'base64');
};

test('the relink pane is the standalone relinker, byte for byte', () => {
  assert.strictEqual(sha(payload('pane-relink')), sha(read('lmms-path-relinker.html')));
});

test('the embed pane is the standalone embedder, byte for byte', () => {
  assert.strictEqual(sha(payload('pane-embed')), sha(read('lmms-sample-embedder.html')));
});

test('the embedder offers no folder or ZIP input', () => {
  const embed = payload('pane-embed').toString('utf8');
  assert.ok(!embed.includes('id="pick-zip"'), 'ZIP button still present');
  assert.ok(!embed.includes('id="pick-folder"'), 'folder button still present');
  assert.ok(!embed.includes('id="file-zip"'), 'ZIP input still present');
  assert.ok(embed.includes('id="pick-file"'), 'project file button missing');
});

test('the embedder carries no LMMS 1.2 compatibility pass', () => {
  const embed = payload('pane-embed').toString('utf8');
  for (const dead of ['makeCompat12', 'inspectCompat', 'ccTotal', 'blockers13']) {
    assert.ok(!embed.includes(dead), `${dead} still present`);
  }
  assert.ok(embed.includes('srcdata'), 'srcdata must stay, 1.2 reads it');
});

test('the relinker writes usergig and never a bare gig path', () => {
  const relink = payload('pane-relink').toString('utf8');
  assert.ok(relink.includes("const GIG_PREFIX = 'usergig:'"), 'wrong gig prefix');
  assert.ok(!relink.includes("const GIG_PREFIX = 'gig/'"), 'bare gig prefix still present');
});

test('no em dash survives in any shipped file', () => {
  for (const f of ['lmms-tools.html', 'lmms-path-relinker.html', 'lmms-sample-embedder.html']) {
    assert.ok(!read(f).toString('utf8').includes('—'), `em dash in ${f}`);
  }
});

test('the contact line reads exactly as specified', () => {
  assert.ok(combined.includes('(Project Amethyst).'), 'contact line wrong');
  assert.ok(combined.includes('Amine Bo.'), 'name wrong');
});

test('no assistant or editor name appears in the shipped files', () => {
  const banned = /claude|anthropic|copilot|chatgpt|openai|codex/i;
  for (const f of ['lmms-tools.html', 'lmms-path-relinker.html', 'lmms-sample-embedder.html']) {
    assert.ok(!banned.test(read(f).toString('utf8')), `tool name in ${f}`);
  }
});

test('the download anchor is in the document when it is clicked', () => {
  // Firefox will not start a download from a detached anchor.
  for (const f of ['lmms-path-relinker.html', 'lmms-sample-embedder.html']) {
    const src = read(f).toString('utf8');
    const block = src.slice(src.indexOf("$('download-btn').addEventListener"));
    const handler = block.slice(0, block.indexOf('});') + 3);
    assert.ok(handler.includes('appendChild(a)'), `${f}: anchor not attached`);
    assert.ok(handler.indexOf('appendChild(a)') < handler.indexOf('a.click()'),
      `${f}: anchor attached after the click`);
    assert.ok(handler.includes('a.remove()'), `${f}: anchor left in the document`);
  }
});

test('a run in progress locks the source in both tools', () => {
  const relink = read('lmms-path-relinker.html').toString('utf8');
  const embed = read('lmms-sample-embedder.html').toString('utf8');
  assert.ok(relink.includes('state.busy'), 'relinker has no busy flag');
  assert.ok(embed.includes('state.busy'), 'embedder has no busy flag');
  // the guards must exist on the paths that can change the source mid-run
  assert.ok(/document\.addEventListener\('drop'[\s\S]{0,400}state\.busy/.test(relink),
    'relinker drop is not guarded');
  assert.ok(/function useProjectFile[\s\S]{0,200}state\.busy/.test(embed),
    'embedder load is not guarded');
});

test('file inputs are cleared so the same file can be picked twice', () => {
  const relink = read('lmms-path-relinker.html').toString('utf8');
  const embed = read('lmms-sample-embedder.html').toString('utf8');
  assert.ok(relink.includes('function resetFileInputs'), 'relinker never resets its inputs');
  assert.ok(/file-project[\s\S]{0,80}value = ''/.test(embed), 'embedder never resets its inputs');
});

test('the relinker names an unreadable project instead of dropping it silently', () => {
  const relink = read('lmms-path-relinker.html').toString('utf8');
  assert.ok(!relink.includes('/* unreadable: omit */'), 'unreadable projects still dropped silently');
  assert.ok(relink.includes("record.result = 'UNREADABLE'"), 'no UNREADABLE result recorded');
});

test('an embed result is discarded when another project was loaded', () => {
  const embed = read('lmms-sample-embedder.html').toString('utf8');
  assert.ok(embed.includes('const runId = ++state.run'), 'runs are not tagged');
  assert.ok(embed.includes('if (runId !== state.run) return;'), 'stale run can still publish output');
});
