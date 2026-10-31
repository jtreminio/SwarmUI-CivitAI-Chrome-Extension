import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

test('built worker retains Send to SwarmUI context menu and reuses its target tab', async () => {
  const source = await readFile(new URL('../dist/background.js', import.meta.url), 'utf8');
  const data = { targetUrl: 'http://swarm.local:7801', usePopupWindow: false };
  const listeners = {};
  const created = [];
  const updated = [];
  const event = key => ({ addListener(callback) { (listeners[key] ??= []).push(callback); } });
  const chrome = {
    runtime: { id: 'test-extension', onMessage: event('message'), onInstalled: event('installed'), onStartup: event('startup'),
      getURL: path => `chrome-extension://test-extension/${path}`, openOptionsPage: async () => {}, lastError: null },
    permissions: { contains: async () => true },
    contextMenus: { onClicked: event('contextClick'), removeAll: callback => callback(), create: (config, callback) => { created.push(config); callback(); } },
    storage: { local: { get: async keys => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, data[key]])),
      set: async values => Object.assign(data, values), remove: async key => { delete data[key]; } }, onChanged: event('storage') },
    action: { onClicked: event('action') },
    tabs: { create: async options => { created.push(options); return { id: 10 }; },
      get: async () => ({ url: 'http://swarm.local:7801/Text2Image#history', windowId: 1 }),
      update: async (id, options) => { updated.push({ id, ...options }); } },
    windows: { update: async () => {} }
  };
  vm.runInNewContext(source, { chrome, URL, console, fetch, TextEncoder, structuredClone, AbortSignal, setTimeout });
  for (const callback of listeners.installed) callback();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(created.some(item => item.id === 'send-to-swarmui'));
  listeners.contextClick[0]({ menuItemId: 'send-to-swarmui', linkUrl: 'https://civitai.red/models/42' }, {});
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(created.some(item => item.url === 'http://swarm.local:7801/Text2Image?downloader=1&url=https%3A%2F%2Fcivitai.red%2Fmodels%2F42'));
  listeners.contextClick[0]({ menuItemId: 'send-to-swarmui', linkUrl: 'https://civitai.com/models/43' }, {});
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(updated[0].id, 10);
  assert.match(updated[0].url, /#swarmui-downloader=https%3A%2F%2Fcivitai.com%2Fmodels%2F43&t=/);
});
