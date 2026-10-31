import { permissionOrigin, serverUrl, INDEX_STATUS_KEY } from './lib/swarm.js';
import { STATUS_LABELS } from './lib/matching.js';

const targetUrlInput = document.getElementById('target-url');
const usePopupWindowInput = document.getElementById('use-popup-window');
const status = document.getElementById('status');
const modelFilter = document.getElementById('model-filter');
let collection = { schemaVersion: 2, models: {}, responseCount: 0 };
let indexStatus;
let renderGeneration = 0;
let matchingTimer;

void chrome.storage.local.get(['targetUrl', 'usePopupWindow', INDEX_STATUS_KEY, 'civitaiCollection']).then(settings => {
  targetUrlInput.value = settings.targetUrl ?? '';
  usePopupWindowInput.checked = settings.usePopupWindow === true;
  indexStatus = settings[INDEX_STATUS_KEY];
  collection = settings.civitaiCollection ?? collection;
  renderIndex(); renderCollection();
});

document.getElementById('options-form').addEventListener('submit', async event => {
  event.preventDefault();
  const raw = targetUrlInput.value.trim();
  let normalized;
  try { normalized = serverUrl(raw)?.href ?? ''; }
  catch { setStatus('Enter a valid SwarmUI server URL.', true); return; }
  try {
    // Request server access directly within the submit gesture.
    if (normalized && !await chrome.permissions.request({ origins: [permissionOrigin(normalized)] })) {
      setStatus('Server access was not granted. Save again to enable matching.', true); return;
    }
    await chrome.storage.local.set({ targetUrl: normalized, usePopupWindow: usePopupWindowInput.checked });
    if (normalized) await checkIndex();
    else {
      await chrome.storage.local.remove(INDEX_STATUS_KEY);
      setStatus('Saved. Set a SwarmUI server URL to enable version badges.');
    }
  } catch (error) { setStatus(error.message, true); }
});

function setStatus(message, error = false) {
  status.textContent = message;
  status.style.color = error ? '#b00020' : '#146c2e';
}

function renderIndex() {
  const element = document.getElementById('index-summary');
  if (!indexStatus) { element.textContent = 'Save your server URL to connect WhatTheDuck.'; return; }
  const coverage = indexStatus.coverage;
  element.textContent = indexStatus.error || (indexStatus.indexState === 'unavailable' ? 'WhatTheDuck index unavailable. Check SwarmUI logs.'
    : `Index ${indexStatus.indexState} · ${coverage ? `${coverage.identifiedFiles} of ${coverage.localFiles} local files identified · ${coverage.unresolvedFiles} unresolved` : 'coverage unavailable'} · checked ${new Date(indexStatus.checkedAt).toLocaleTimeString()}`);
}

async function checkIndex() {
  setStatus('Checking WhatTheDuck index…');
  const response = await chrome.runtime.sendMessage({ type: 'swarm:check' });
  if (!response?.ok || response.error) throw new Error(response?.error || 'Could not connect to WhatTheDuck.');
  if (response.indexState === 'unavailable') throw new Error('WhatTheDuck index unavailable. Check SwarmUI logs.');
  await chrome.storage.local.set({ swarmIndexRefresh: Date.now() });
  setStatus(`Connected. Index ${response.indexState}. Visible cards recheck automatically.`);
  renderCollection();
}

document.getElementById('check-index').addEventListener('click', async () => {
  try { await checkIndex(); } catch (error) { setStatus(error.message, true); }
});

function renderCollection() {
  const generation = ++renderGeneration;
  clearTimeout(matchingTimer);
  const records = Object.values(collection.models).sort((a, b) => b.lastSeen - a.lastSeen);
  const withHashes = records.filter(record => record.hashes.length).length;
  document.getElementById('capture-summary').textContent = `${records.length} models · ${withHashes} with captured hashes · ${collection.responseCount} captured responses`;
  document.getElementById('capture-error').textContent = collection.lastError || '';
  const filter = modelFilter.value.toLowerCase().trim();
  const filtered = records.filter(record => `${record.name} ${record.modelId} ${record.versions.map(version => version.modelVersionId).join(' ')}`.toLowerCase().includes(filter));
  const shown = filtered.slice(0, 100);
  const rows = document.getElementById('model-rows');
  rows.replaceChildren();
  const cells = new Map();
  for (const record of shown) {
    const row = document.createElement('tr');
    const name = document.createElement('td');
    const link = document.createElement('a');
    link.textContent = record.name || `Model ${record.modelId}`;
    link.href = `${record.origin}/models/${record.modelId}`;
    link.target = '_blank'; link.rel = 'noopener noreferrer';
    name.append(link); row.append(name);
    for (const value of [record.type, record.modelId, record.displayedVersionId ?? '—', record.hashes.length]) {
      const cell = document.createElement('td'); cell.textContent = value; row.append(cell);
    }
    const matchCell = document.createElement('td'); matchCell.textContent = 'Unconfirmed'; row.append(matchCell);
    cells.set(`${record.modelId}:${record.displayedVersionId}`, matchCell);
    rows.append(row);
  }
  document.getElementById('row-summary').textContent = `Showing ${shown.length} of ${filtered.length} matching models. Export includes the full collection.`;
  matchingTimer = setTimeout(async () => {
    const cards = shown.filter(record => record.displayedVersionId).map(record => ({ modelId: record.modelId, versionId: record.displayedVersionId }));
    if (!cards.length) return;
    try {
      const response = await chrome.runtime.sendMessage({ type: 'civitai:matches', cards });
      if (generation !== renderGeneration || !response?.ok || response.error || response.indexState === 'unavailable') return;
      for (const match of response.matches) {
        const cell = cells.get(`${match.modelId}:${match.versionId}`);
        if (cell) cell.textContent = STATUS_LABELS[match.status] ?? 'Unconfirmed';
      }
    } catch { /* Keep unconfirmed on connection errors. */ }
  }, 150);
}

modelFilter.addEventListener('input', renderCollection);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes[INDEX_STATUS_KEY]) { indexStatus = changes[INDEX_STATUS_KEY].newValue; renderIndex(); }
  if (changes.civitaiCollection) collection = changes.civitaiCollection.newValue ?? { schemaVersion: 2, models: {}, responseCount: 0 };
  if (changes.targetUrl || changes.civitaiCollection) renderCollection();
});
setInterval(renderCollection, 30_000);

document.getElementById('export-models').addEventListener('click', () => {
  const exported = { schemaVersion: 2, exportedAt: new Date().toISOString(), models: Object.values(collection.models) };
  const url = URL.createObjectURL(new Blob([JSON.stringify(exported, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url;
  link.download = `civitai-models-${new Date().toISOString().slice(0, 10)}.json`;
  link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
});
