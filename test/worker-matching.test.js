import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { CHANNEL } from '../lib/models.js';

const source = await readFile(new URL('../dist/background.js', import.meta.url), 'utf8');

test('built worker sends batch observations to backend, retires legacy cache without alarms, and exposes only statuses', async () => {
  const data = { targetUrl: 'http://swarm.test:7801', swarmInventory: { files: ['old-private-file'] }, resolveMissingHashes: true };
  const listeners = {};
  const calls = [];
  const event = name => ({ addListener: callback => { (listeners[name] ??= []).push(callback); } });
  const chrome = {
    runtime: { id: 'extension', onMessage: event('message'), onInstalled: event('installed'), onStartup: event('startup'),
      getURL: path => `chrome-extension://extension/${path}`, openOptionsPage: async () => {} },
    permissions: { contains: async () => true, onRemoved: event('permissionRemoved') },
    storage: { local: { get: async keys => structuredClone(Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, data[key]]))),
      set: async values => Object.assign(data, structuredClone(values)),
      remove: async keys => { for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key]; } }, onChanged: event('storage') },
    action: { onClicked: event('action') }, contextMenus: { onClicked: event('context') }
  };
  let unknown = false;
  const fetcher = async (url, options) => {
    const body = JSON.parse(options.body); calls.push({ url, body });
    if (url.endsWith('GetNewSession')) return Response.json({ session_id: 'private-session' });
    assert.ok(url.endsWith('WhatTheDuckMatchCivitaiVersions'));
    assert.ok(body.items.length <= 500);
    return Response.json({ schemaVersion: 1, indexState: 'partial', indexRevision: 'unchanged',
      coverage: { localFiles: 184, identifiedFiles: 150, unresolvedFiles: 34 },
      results: body.items.map(item => ({ modelId: item.modelId, modelVersionId: item.modelVersionId,
        status: unknown ? 'unknown' : item.modelVersionId === 100 ? 'downloaded' : 'older',
        secretFilePath: 'private-local-filename', ownedVersionIds: [100] })) });
  };
  vm.runInNewContext(source, { chrome, URL, console, fetch: fetcher, TextEncoder, structuredClone, AbortSignal });
  const send = (message, sender) => new Promise(resolve => {
    const handled = listeners.message.some(listener => listener(message, sender, resolve));
    if (!handled) resolve(undefined);
  });
  const sender = { id: 'extension', url: 'https://civitai.red/models', tab: { id: 1 }, frameId: 0 };
  await send({ type: CHANNEL, url: 'https://civitai.red/api/trpc/model.getAll', models: [{ modelId: 42, type: 'Checkpoint',
    displayedVersionId: 200, versions: [{ modelVersionId: 100, publishedAt: 1000 }, { modelVersionId: 200, publishedAt: 2000 }], hashes: [] }] }, sender);
  const message = { type: 'civitai:matches', cards: [{ modelId: 42, versionId: 100 }, { modelId: 42, versionId: 200 }] };
  const response = await send(message, sender);
  assert.equal(response.ok, true);
  assert.deepEqual(Array.from(response.matches, match => match.status), ['downloaded', 'older']);
  assert.equal(response.indexState, 'partial');
  assert.ok(!JSON.stringify(response).includes('private'));
  assert.ok(!JSON.stringify(data).includes('private'));
  assert.equal(data.swarmInventory, undefined);
  assert.equal(data.resolveMissingHashes, undefined);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].body.items, [
    { modelId: 42, modelVersionId: 100, modelType: 'Checkpoint', publishedAt: 1000 },
    { modelId: 42, modelVersionId: 200, modelType: 'Checkpoint', publishedAt: 2000 }
  ]);
  assert.ok(calls.every(call => call.url.startsWith('http://swarm.test:7801/API/')));
  assert.equal(await send(message, { ...sender, url: 'https://evil.test/models' }), undefined);
  assert.equal(await send({ type: 'swarm:check' }, sender), undefined);
  assert.equal(await send({ type: 'civitai:retry' }, { id: 'extension', url: 'chrome-extension://extension/options.html' }), undefined);
  unknown = true;
  // Permission/target invalidation forces a new query even with unchanged revision.
  listeners.permissionRemoved[0]();
  const second = await send(message, sender);
  assert.deepEqual(Array.from(second.matches, match => match.status), ['unknown', 'unknown']);
  assert.equal(calls.length, 4);
});
