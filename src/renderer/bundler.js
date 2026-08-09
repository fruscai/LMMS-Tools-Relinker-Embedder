'use strict';

const state = { mode: 'bundle', sourcePath: null, checked: null, lmms: null };
const $ = (id) => document.getElementById(id);

const escapeHtml = (v) => String(v ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function setStatus(msg, tone = '') {
  $('status').textContent = msg || '';
  $('status').className = `status${tone ? ` ${tone}` : ''}`;
}

/* ---------- LMMS availability ---------- */

async function checkLmms() {
  const pill = $('lmms-pill');
  try {
    const info = await window.bundler.detectLmms();
    state.lmms = info;
    if (info.ok) {
      pill.className = 'lmms-pill ok';
      $('lmms-text').textContent = (info.version || 'LMMS').replace(/^LMMS\s*/, 'LMMS ');
    } else {
      pill.className = 'lmms-pill bad';
      $('lmms-text').textContent = info.path ? 'LMMS too old — needs 1.3.0-alpha+' : 'LMMS not found';
      setStatus(info.reason || 'LMMS is required to build bundles.', 'error');
    }
  } catch {
    pill.className = 'lmms-pill bad';
    $('lmms-text').textContent = 'LMMS not found';
  }
  refresh();
}

/* ---------- mode ---------- */

for (const card of document.querySelectorAll('.mode-card')) {
  card.addEventListener('click', () => {
    for (const c of document.querySelectorAll('.mode-card')) c.classList.remove('selected');
    card.classList.add('selected');
    state.mode = card.dataset.mode;
    state.checked = null;

    const needsPaths = state.mode === 'relink+bundle';
    $('path-step').hidden = !needsPaths;
    $('run-step-num').textContent = needsPaths ? '4' : '3';

    $('check-panel').hidden = true;
    $('result-panel').hidden = true;
    setStatus('');
    refresh();
  });
}

/* ---------- source ---------- */

function setSource(p) {
  state.sourcePath = p;
  state.checked = null;
  $('source-path').textContent = p || '';
  $('source-chip').hidden = !p;
  $('dropzone').hidden = Boolean(p);
  $('check-panel').hidden = true;
  $('result-panel').hidden = true;
  refresh();
}

for (const b of document.querySelectorAll('[data-choose]')) {
  b.addEventListener('click', async () => {
    const chosen = await window.bundler.chooseSource(b.dataset.choose);
    if (chosen) { setSource(chosen); setStatus(''); }
  });
}

$('clear-source').addEventListener('click', () => { setSource(null); setStatus(''); });

['dragenter', 'dragover'].forEach((t) => document.addEventListener(t, (e) => {
  e.preventDefault(); $('dropzone').classList.add('dragging');
}));
['dragleave', 'drop'].forEach((t) => document.addEventListener(t, (e) => {
  e.preventDefault(); if (t === 'drop') $('dropzone').classList.remove('dragging');
}));
document.addEventListener('drop', (e) => {
  const f = e.dataTransfer && e.dataTransfer.files[0];
  if (!f) return;
  const p = window.bundler.pathForFile(f);
  if (!p) { setStatus('Could not read that item — use the Browse buttons.', 'error'); return; }
  setSource(p); setStatus('');
});

for (const id of ['old-path', 'new-path']) {
  $(id).addEventListener('input', () => { state.checked = null; refresh(); });
}

/* ---------- enablement ---------- */

function refresh() {
  const lmmsOk = state.lmms && state.lmms.ok;
  const pathsOk = state.mode === 'bundle'
    || ($('old-path').value.trim() && $('new-path').value.trim());
  const ready = Boolean(lmmsOk && state.sourcePath && pathsOk);

  $('check-btn').disabled = !ready;
  // Building is only unlocked once a check has shown at least one ready project.
  $('run-btn').disabled = !(ready && state.checked && state.checked.summary.ready > 0);
}

const payload = () => ({
  sourcePath: state.sourcePath,
  mode: state.mode,
  oldPath: $('old-path').value,
  newPath: $('new-path').value,
  stripEmpty: $('opt-strip').checked,
  dedupe: $('opt-dedupe').checked,
});

const stat = (v, l, tone = '') =>
  `<div class="stat ${tone}"><div class="value">${v}</div><div class="label">${l}</div></div>`;

const badgeFor = (s) =>
  s === 'READY' ? 'ready'
  : s === 'EMPTY SLOTS' || s === 'ALREADY BUNDLED' ? 'warn'
  : 'bad';

/* ---------- check ---------- */

$('check-btn').addEventListener('click', async () => {
  setStatus('Checking…');
  $('check-btn').disabled = true; $('run-btn').disabled = true;
  $('progress').hidden = false; $('result-panel').hidden = true;

  try {
    const data = await window.bundler.check(payload());
    state.checked = data;
    const s = data.summary;

    $('check-headline').innerHTML =
      `<strong>${s.projects}</strong> project(s) · ` +
      `<strong>${s.ready}</strong> ready to bundle · ` +
      `<strong>${s.blocked}</strong> need attention · ` +
      `<strong>${s.resolvedRefs}/${s.totalRefs}</strong> samples resolve`;

    $('check-summary').innerHTML = [
      stat(s.projects, 'projects'),
      stat(s.ready, 'ready', 'good'),
      stat(s.blocked, 'need attention', s.blocked ? 'bad' : ''),
      stat(s.resolvedRefs, 'samples found', 'good'),
    ].join('');

    // Turn the numbers into an actual recommendation.
    const advice = $('check-advice');
    const missing = data.results.filter((r) => r.status === 'MISSING SAMPLES').length;
    const empties = data.results.filter((r) => r.status === 'EMPTY SLOTS').length;

    if (missing > 0 && state.mode === 'bundle') {
      advice.className = 'advice warn';
      advice.innerHTML =
        `<strong>${missing} project(s) have samples LMMS cannot find.</strong> ` +
        'Bundling copies files from the paths inside the project, so a broken path copies nothing — ' +
        'those bundles would open silently with no audio. Switch to <em>“No — LMMS reports missing samples”</em> ' +
        'and supply the correct folder.';
      advice.hidden = false;
    } else if (empties > 0 && !$('opt-strip').checked) {
      advice.className = 'advice warn';
      advice.innerHTML =
        `<strong>${empties} project(s) contain an instrument with no sample loaded.</strong> ` +
        'LMMS refuses to bundle those. Tick <em>“Strip empty sample slots”</em> to handle it.';
      advice.hidden = false;
    } else if (s.ready === s.projects && s.projects > 0) {
      advice.className = 'advice good';
      advice.innerHTML = 'Every project resolves all of its samples. Safe to build.';
      advice.hidden = false;
    } else {
      advice.hidden = true;
    }

    $('check-body').innerHTML = data.results.map((r) => `
      <tr>
        <td class="file">${escapeHtml(r.file)}</td>
        <td class="num">${r.references}</td>
        <td><span class="badge ${badgeFor(r.status)}">${escapeHtml(r.status)}</span>
            <div class="detail">${escapeHtml(r.detail)}</div></td>
      </tr>`).join('');

    $('check-panel').hidden = false;
    setStatus(s.ready > 0 ? 'Check complete — review, then build.' : 'Nothing is ready to bundle.',
      s.ready > 0 ? 'done' : 'error');
  } catch (err) {
    setStatus(err.message || String(err), 'error');
  } finally {
    $('progress').hidden = true;
    refresh();
  }
});

/* ---------- run ---------- */

$('run-btn').addEventListener('click', async () => {
  setStatus('Building bundles…');
  $('check-btn').disabled = true; $('run-btn').disabled = true;
  $('progress').hidden = false;

  try {
    const data = await window.bundler.run(payload());
    const t = data.totals;

    $('result-summary').innerHTML = [
      stat(t.processed, 'projects'),
      stat(t.bundled, 'bundled', 'good'),
      stat(t.blocked, 'skipped'),
      stat(t.failed, 'failed', t.failed ? 'bad' : ''),
      ...(t.bytesBefore
        ? [stat(`${((1 - t.bytesAfter / t.bytesBefore) * 100).toFixed(0)}%`, 'size saved', 'good')]
        : []),
    ].join('');

    $('result-note').textContent = data.mode === 'relink+bundle'
      ? 'Paths were fixed, then bundled — originals untouched'
      : 'Bundled — originals untouched';

    $('output-location').textContent = data.outputRoot;
    $('report-line').textContent = data.reportPaths
      ? `Report: ${data.reportPaths.json}`
      : '';
    $('result-panel').hidden = false;
    $('result-panel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });

    setStatus(t.failed ? 'Finished with failures — see the report.' : 'Bundles built.',
      t.failed ? 'error' : 'done');
  } catch (err) {
    setStatus(err.message || String(err), 'error');
  } finally {
    $('progress').hidden = true;
    refresh();
  }
});

$('reveal-btn').addEventListener('click', () => {
  const t = $('output-location').textContent;
  if (t) window.bundler.reveal(t);
});

window.bundler.onProgress(({ done, total }) => {
  if (!total) return;
  $('progress-bar').style.width = `${Math.round((done / total) * 100)}%`;
  setStatus(`Working… ${done} of ${total}`);
});

checkLmms();
refresh();
