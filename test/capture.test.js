import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../dist/capture.js', import.meta.url), 'utf8');
const model = { id: 1, name: 'Capture fixture', type: 'Checkpoint', hashes: ['a'.repeat(64)], version: { id: 2 } };
const body = JSON.stringify({ result: { data: { json: { items: [model] } } } });
const endpoint = 'https://civitai.red/api/trpc/model.getAll';

function harness(fetcher = () => Promise.resolve(new Response(body))) {
  const messages = [];
  class XHR extends EventTarget {
    open(method, url) { this.method = method; this.url = url; }
    send() {}
    complete(text, status = 200, responseType = '') {
      this.status = status; this.responseType = responseType;
      this.responseText = text; this.response = responseType === 'json' ? JSON.parse(text) : text;
      this.dispatchEvent(new Event('loadend'));
    }
  }
  const location = { href: 'https://civitai.red/models', origin: 'https://civitai.red' };
  const window = { fetch: fetcher, postMessage: message => messages.push(message) };
  const context = vm.createContext({ window, XMLHttpRequest: XHR, location, URL, TextDecoder, Uint8Array, console });
  vm.runInContext(source, context);
  return { window, messages, XHR, location, context };
}

const flush = () => new Promise(resolve => setTimeout(resolve, 20));

test('fetch hook returns original promise and leaves response readable; duplicate installation has no effect', async () => {
  const original = Promise.resolve(new Response(body));
  const h = harness(() => original);
  vm.runInContext(source, h.context);
  const returned = h.window.fetch(endpoint);
  assert.equal(returned, original);
  assert.equal(await (await returned).text(), body);
  await flush();
  assert.equal(h.messages.length, 1);
  assert.equal(h.messages[0].models[0].modelId, 1);
  assert.equal(h.messages[0].models[0].versions[0].modelVersionId, 2);
});

test('unrelated responses and non-model pages are ignored; SPA entry into /models starts capture', async () => {
  const h = harness();
  await h.window.fetch('https://civitai.red/api/trpc/user.getMe');
  h.location.href = 'https://civitai.red/images';
  await h.window.fetch(endpoint);
  await flush();
  assert.equal(h.messages.length, 0);
  h.location.href = 'https://civitai.red/models?types=LORA';
  await h.window.fetch({ url: endpoint });
  await flush();
  assert.equal(h.messages.length, 1);
});

test('invalid captured JSON reports diagnostics without breaking page fetch', async () => {
  const h = harness(() => Promise.resolve(new Response('bad json')));
  const response = await h.window.fetch(endpoint);
  assert.equal(await response.text(), 'bad json');
  await flush();
  assert.match(h.messages[0].error, /Could not parse model response/);
});

test('XHR text and JSON work; reuse after an aborted request does not replay stale capture listeners', () => {
  const h = harness();
  const xhr = new h.XHR();
  xhr.open('GET', endpoint);
  xhr.send();
  xhr.complete('', 0);
  xhr.open('GET', endpoint);
  xhr.send();
  xhr.complete(body, 200, 'json');
  assert.equal(h.messages.length, 1);
  xhr.open('GET', endpoint);
  xhr.send();
  xhr.complete(body);
  assert.equal(h.messages.length, 2);
});

test('failed requests preserve the original rejection', async () => {
  const error = new Error('offline');
  const h = harness(() => Promise.reject(error));
  await assert.rejects(h.window.fetch(endpoint), failure => failure === error);
  await flush();
  assert.match(h.messages[0].error, /offline/);
});
