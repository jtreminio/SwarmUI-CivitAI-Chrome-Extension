import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { parseHTML } from 'linkedom';

const html = await readFile(new URL('../options.html', import.meta.url), 'utf8');
const source = await readFile(new URL('../dist/options.js', import.meta.url), 'utf8');
const flush = () => new Promise(resolve => setTimeout(resolve, 10));

function harness() {
  const { document, window } = parseHTML(html);
  const data = { targetUrl: 'http://swarm.test:7801', usePopupWindow: true,
    swarmIndexStatus: { indexState: 'partial', coverage: { localFiles: 184, identifiedFiles: 149, unresolvedFiles: 35 }, checkedAt: 1_800_000_000_000 },
    civitaiCollection: { schemaVersion: 2, responseCount: 2, models: { 42: { modelId: 42, name: 'Test', type: 'Checkpoint',
      origin: 'https://civitai.red', displayedVersionId: 100, versions: [{ modelVersionId: 100 }], hashes: [], lastSeen: 1 } } } };
  const timers = [];
  const order = [];
  let state = 'partial';
  let result = 'unknown';
  let endpointError;
  const listeners = [];
  const chrome = { permissions: { request: async value => { order.push({ type: 'permission', value }); return true; } },
    storage: { local: { get: async keys => Object.fromEntries(keys.map(key => [key, data[key]])),
      set: async value => { order.push({ type: 'storage', value }); Object.assign(data, value); },
      remove: async key => { delete data[key]; } }, onChanged: { addListener: callback => listeners.push(callback) } },
    runtime: { sendMessage: async message => {
      order.push({ type: 'message', message });
      return { ok: true, indexState: state, error: endpointError, matches: (message.cards ?? []).map(card => ({ ...card, status: result })) };
    } } };
  vm.runInNewContext(source, { chrome, document, console, URL, Blob,
    setInterval: () => {}, setTimeout: callback => { timers.push(callback); return timers.length; },
    clearTimeout: id => { if (id) timers[id - 1] = null; } });
  return { document, window, data, order, state: value => { state = value; }, result: value => { result = value; },
    error: value => { endpointError = value; }, async run() { await flush(); for (const timer of timers.splice(0)) timer?.(); await flush(); } };
}

test('options show backend coverage and keep unknown results unconfirmed', async () => {
  const h = harness(); await h.run();
  assert.match(h.document.getElementById('index-summary').textContent, /149 of 184/);
  assert.equal(h.document.querySelector('#model-rows tr td:last-child').textContent, 'Unconfirmed');
  assert.equal(h.document.getElementById('resolve-missing-hashes'), null);
  assert.equal(h.document.getElementById('retry-lookups'), null);
});

test('Save requests server permission within gesture, preserves popup setting, and checks endpoint', async () => {
  const h = harness(); await h.run(); h.order.length = 0;
  h.document.getElementById('target-url').value = 'http://another.test:7801/proxy/Text2Image';
  h.document.getElementById('options-form').dispatchEvent(new h.window.Event('submit', { cancelable: true }));
  await h.run();
  assert.equal(h.order[0].type, 'permission');
  assert.deepEqual(Array.from(h.order[0].value.origins), ['http://another.test:7801/*']);
  assert.equal(h.data.targetUrl, 'http://another.test:7801/proxy/');
  assert.equal(h.data.usePopupWindow, true);
  assert.ok(h.order.some(entry => entry.message?.type === 'swarm:check'));
  assert.match(h.document.getElementById('status').textContent, /Connected. Index partial/);
});

test('unavailable index never displays a positive row; missing route gives update message', async () => {
  const h = harness(); h.state('unavailable'); h.result('downloaded'); await h.run();
  assert.equal(h.document.querySelector('#model-rows tr td:last-child').textContent, 'Unconfirmed');
  h.error('Update WhatTheDuck and restart SwarmUI: its Civitai matching endpoint is unavailable.');
  h.document.getElementById('check-index').click(); await h.run();
  assert.match(h.document.getElementById('status').textContent, /Update WhatTheDuck/);
});
