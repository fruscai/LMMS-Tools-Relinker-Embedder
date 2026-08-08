'use strict';

const state = {
  sourcePath: null,
  scanned: null,
};

const el = (id) => document.getElementById(id);

const dropzone = el('dropzone');
const sourceChip = el('source-chip');
const sourcePathEl = el('source-path');
const oldPathInput = el('old-path');
const newPathInput = el('new-path');
const separatorToggle = el('separator-variants');
const scanBtn = el('scan-btn');
const repairBtn = el('repair-btn');
const statusEl = el('status');
const progress = el('progress');
const progressBar = el('progress-bar');

const MAX_PREVIEW_ROWS = 500;

/* ---------- helpers ---------- */

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function setStatus(message, tone = '') {
  statusEl.textContent = message || '';
  statusEl.className = `status${tone ? ` ${tone}` : ''}`;
}

function showProgress(show) {
  progress.hidden = !show;
  if (!show) progressBar.style.width = '0%';
}

function setSource(pathValue) {
  state.sourcePath = pathValue;
  state.scanned = null;
  sourcePathEl.textContent = pathValue || '';
  sourceChip.hidden = !pathValue;
  dropzone.hidden = Boolean(pathValue);
  el('preview').hidden = true;
  el('result').hidden = true;
  refreshButtons();
}

function refreshButtons() {
  // Both roots are required. An empty replacement would mean "delete this root
  // from every path", which is never the intent.
  const ready =
    Boolean(state.sourcePath) &&
    oldPathInput.value.trim().length > 0 &&
    newPathInput.value.trim().length > 0;
  scanBtn.disabled = !ready;
  // Repair stays locked until a scan has shown the user exactly what changes.
  repairBtn.disabled = !(state.scanned && state.scanned.summary.projectsWithMatches > 0);
}

/* ---------- source selection ---------- */

for (const button of document.querySelectorAll('[data-choose]')) {
  button.addEventListener('click', async () => {
    try {
      const chosen = await window.relinker.chooseSource(button.dataset.choose);
      if (chosen) {
        setSource(chosen);
        setStatus('');
      }
    } catch (err) {
      setStatus(err.message || String(err), 'error');
    }
  });
}

el('clear-source').addEventListener('click', () => {
  setSource(null);
  setStatus('');
});

['dragenter', 'dragover'].forEach((type) => {
  document.addEventListener(type, (event) => {
    event.preventDefault();
    dropzone.classList.add('dragging');
  });
});

['dragleave', 'drop'].forEach((type) => {
  document.addEventListener(type, (event) => {
    event.preventDefault();
    if (type === 'drop' || event.relatedTarget === null) {
      dropzone.classList.remove('dragging');
    }
  });
});

document.addEventListener('drop', (event) => {
  const file = event.dataTransfer && event.dataTransfer.files[0];
  if (!file) return;
  const resolved = window.relinker.pathForFile(file);
  if (!resolved) {
    setStatus('Could not read that item — use the Browse buttons instead.', 'error');
    return;
  }
  setSource(resolved);
  setStatus('');
});

/* ---------- live example ---------- */

function updateLiveExample() {
  const oldRoot = oldPathInput.value;
  const newRoot = newPathInput.value;
  const box = el('live-example');

  if (!oldRoot || !newRoot) {
    box.hidden = true;
    return;
  }

  const sample = 'Kick 01.wav';
  el('ex-before').textContent = oldRoot + sample;
  el('ex-after').textContent = newRoot + sample;
  box.hidden = false;
}

/** Nudge the user when the two roots end differently — a common slip. */
function updateHint() {
  const oldRoot = oldPathInput.value;
  const newRoot = newPathInput.value;
  const box = el('hint-box');

  const endsWithSep = (s) => /[\\/]$/.test(s);

  if (oldRoot && newRoot && endsWithSep(oldRoot) !== endsWithSep(newRoot)) {
    box.textContent =
      'One of these paths ends with a slash and the other does not. That still works, but the repaired paths may end up with a doubled or missing separator. Matching them is usually what you want.';
    box.hidden = false;
    return;
  }
  box.hidden = true;
}

function onInputsChanged() {
  state.scanned = null;
  updateLiveExample();
  updateHint();
  refreshButtons();
}

oldPathInput.addEventListener('input', onInputsChanged);
newPathInput.addEventListener('input', onInputsChanged);
separatorToggle.addEventListener('change', onInputsChanged);

/* ---------- rendering ---------- */

function stat(value, label, tone = '') {
  return `<div class="stat ${tone}"><div class="value">${value}</div><div class="label">${label}</div></div>`;
}

function badgeClass(status) {
  if (status === 'WILL MODIFY') return 'will-modify';
  if (status === 'NO MATCH') return 'no-match';
  return 'error';
}

function renderPreview(data) {
  const s = data.summary;

  el('headline').innerHTML =
    `<strong>${s.projectsFound}</strong> LMMS project${s.projectsFound === 1 ? '' : 's'} found · ` +
    `<strong>${s.projectsWithMatches}</strong> contain the supplied path · ` +
    `<strong>${s.totalOccurrences}</strong> path reference${s.totalOccurrences === 1 ? '' : 's'} will be replaced · ` +
    `<strong>${s.projectsWithoutMatches}</strong> require no changes`;

  el('preview-summary').innerHTML = [
    stat(s.foldersScanned, 'folders scanned'),
    stat(s.mmpFound, '.mmp files'),
    stat(s.mmpzFound, '.mmpz files'),
    stat(s.projectsWithMatches, 'projects to fix', 'good'),
    stat(s.totalOccurrences, 'references to replace', 'accent'),
    stat(s.projectsWithoutMatches, 'no changes needed'),
  ].join('');

  // Show which textual form matched, so nothing is a surprise.
  const variantTotals = {};
  for (const row of data.results) {
    for (const [label, count] of Object.entries(row.byVariant || {})) {
      variantTotals[label] = (variantTotals[label] || 0) + count;
    }
  }
  const note = el('variant-note');
  const labels = Object.keys(variantTotals);
  if (labels.length > 0 && !(labels.length === 1 && labels[0] === 'literal')) {
    note.innerHTML =
      'Matched by ' +
      labels.map((l) => `<strong>${escapeHtml(l)}</strong> (${variantTotals[l]})`).join(', ') +
      '. LMMS stores Windows paths with forward slashes, so a pasted backslash path matches the forward-slash form. The replacement keeps that same slash direction.';
    note.hidden = false;
  } else {
    note.hidden = true;
  }

  // A real before/after taken from the user's own projects.
  const realBox = el('real-example');
  if (s.example) {
    el('real-before').textContent = s.example.before;
    el('real-after').textContent = s.example.after;
    realBox.hidden = false;
  } else {
    realBox.hidden = true;
  }

  const affected = data.results.filter((r) => r.status !== 'NO MATCH');
  const rows = affected.slice(0, MAX_PREVIEW_ROWS);

  el('preview-table').querySelector('tbody').innerHTML = rows
    .map(
      (r) => `
      <tr>
        <td class="file">${escapeHtml(r.file)}</td>
        <td class="fmt">.${escapeHtml(r.format)}</td>
        <td class="num">${r.occurrences}</td>
        <td><span class="badge ${badgeClass(r.status)}">${escapeHtml(r.status)}</span>${
          r.message ? ` <span class="hint">${escapeHtml(r.message)}</span>` : ''
        }</td>
      </tr>`
    )
    .join('');

  const truncated = el('preview-truncated');
  if (affected.length > rows.length) {
    truncated.textContent = `Showing the first ${rows.length} of ${affected.length} affected projects — all of them will be repaired.`;
    truncated.hidden = false;
  } else {
    truncated.hidden = true;
  }

  el('preview').hidden = false;
}

function renderResult(data) {
  const s = data.summary;

  el('result-summary').innerHTML = [
    stat(s.projectsProcessed, 'projects processed'),
    stat(s.projectsModified, 'projects modified', 'good'),
    stat(s.replacements, 'path replacements', 'accent'),
    stat(s.projectsSkipped, 'projects skipped'),
    stat(s.validationFailures, 'validation failures', s.validationFailures > 0 ? 'bad' : ''),
  ].join('');

  el('result-note').textContent =
    s.validationFailures > 0
      ? 'Some projects failed validation and were left untouched'
      : 'Originals were not modified';

  el('output-location').textContent = data.outputPath;
  el('report-paths').textContent = data.reportPaths
    ? `Reports: ${data.reportPaths.json} · ${data.reportPaths.csv} · ${data.reportPaths.txt}`
    : '';
  el('result').hidden = false;
  el('result').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/* ---------- actions ---------- */

function currentSettings() {
  return {
    sourcePath: state.sourcePath,
    oldPath: oldPathInput.value,
    newPath: newPathInput.value,
    // Defaults to on, because LMMS stores Windows paths with forward slashes and
    // a pasted backslash path would otherwise match nothing. Can be turned off
    // for a strictly literal match.
    matchSeparatorVariants: separatorToggle.checked,
  };
}

scanBtn.addEventListener('click', async () => {
  setStatus('Scanning…');
  showProgress(true);
  scanBtn.disabled = true;
  repairBtn.disabled = true;
  el('result').hidden = true;

  try {
    const data = await window.relinker.scan(currentSettings());
    state.scanned = data;
    renderPreview(data);
    setStatus(
      data.summary.projectsWithMatches > 0
        ? 'Scan complete — review the preview, then press Repair.'
        : 'Scan complete — no project contains that path.',
      data.summary.projectsWithMatches > 0 ? 'done' : ''
    );
  } catch (err) {
    setStatus(err.message || String(err), 'error');
  } finally {
    showProgress(false);
    refreshButtons();
  }
});

repairBtn.addEventListener('click', async () => {
  if (!newPathInput.value.trim()) {
    setStatus('Enter a replacement path before repairing.', 'error');
    return;
  }

  setStatus('Repairing…');
  showProgress(true);
  scanBtn.disabled = true;
  repairBtn.disabled = true;

  try {
    const data = await window.relinker.repair(currentSettings());
    renderResult(data);
    setStatus(
      data.summary.validationFailures > 0
        ? 'Finished — some projects failed validation and were left alone.'
        : 'Repair complete.',
      data.summary.validationFailures > 0 ? 'error' : 'done'
    );
  } catch (err) {
    setStatus(err.message || String(err), 'error');
  } finally {
    showProgress(false);
    refreshButtons();
  }
});

el('reveal-btn').addEventListener('click', () => {
  const target = el('output-location').textContent;
  if (target) window.relinker.revealOutput(target);
});

window.relinker.onProgress(({ done, total }) => {
  if (!total) return;
  progressBar.style.width = `${Math.round((done / total) * 100)}%`;
  setStatus(`Working… ${done} of ${total} projects`);
});

refreshButtons();
