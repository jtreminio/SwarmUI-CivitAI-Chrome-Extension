import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { parseHTML } from 'linkedom';

const source = await readFile(new URL('../dist/content.js', import.meta.url), 'utf8');
const flush = () => new Promise(resolve => setTimeout(resolve, 10));
const cardMarkup = (id = 42, version = 200) => `<div class="native-card" data-card-root><div data-card-hover><a href="/models/${id}/example?modelVersionId=${version}" aria-describedby="native-help"><img style="filter:blur(8px)"></a><div class="native_header"><button aria-label="More options">Menu</button></div><div class="native_footer"><p>Checkpoint</p><p>Example model</p><button>Creator</button><span>Native stats</span></div></div></div>`;

function harness(responder) {
  const { document, window } = parseHTML(`<html><body>${cardMarkup()}<span id="native-help">Native description</span><a href="/models/42?modelVersionId=100">credit outside card</a></body></html>`);
  const timers = [];
  const intervals = [];
  const listeners = [];
  const messages = [];
  const observed = new Set();
  let resize;
  class RO {
    constructor(callback) { resize = callback; }
    observe(element) { observed.add(element); }
    unobserve(element) { observed.delete(element); }
  }
  const chrome = { runtime: { sendMessage: async message => { messages.push(message); return responder(message); } },
    storage: { onChanged: { addListener: callback => listeners.push(callback) } } };
  vm.runInNewContext(source, { document, window, chrome, URL, console,
    location: { href: 'https://civitai.red/models', origin: 'https://civitai.red', pathname: '/models' },
    MutationObserver: window.MutationObserver, ResizeObserver: RO,
    setTimeout: callback => { timers.push(callback); return timers.length; },
    clearTimeout: id => { if (id) timers[id - 1] = null; }, setInterval: (callback, delay) => intervals.push({ callback, delay }) });
  return { document, messages, listeners, intervals, observed, resize: target => resize([{ target }]), async run() {
    const tasks = timers.splice(0);
    for (const task of tasks) task?.();
    await flush();
  } };
}

const response = (message, status, indexState = 'ready') => ({ ok: true, indexState, indexRevision: 'same',
  matches: message.cards.map(card => ({ ...card, status })) });
const areaOf = h => h.document.querySelector('[data-card-hover]');
const assertClear = h => {
  assert.equal(h.document.querySelector('[data-swarmui-status]'), null);
  assert.equal(h.document.querySelector('.swarmui-card-preview'), null);
  assert.equal(h.document.querySelector('.swarmui-downloaded-frame'), null);
  assert.equal(h.document.querySelector('.swarmui-card-decoration'), null);
  assert.equal(h.document.querySelector('.swarmui-card-header'), null);
  assert.equal(h.observed.size, 0);
};

test('older version gets rail/banner without duplicate decorations or changing native controls', async () => {
  const h = harness(message => response(message, 'older'));
  const header = h.document.querySelector('.native_header');
  const footer = h.document.querySelector('.native_footer');
  await h.run();
  assert.equal(h.messages[0].cards.length, 1);
  assert.equal(h.messages[0].cards[0].versionId, 200);
  assert.equal(areaOf(h).dataset.swarmuiStatus, 'older');
  assert.equal(h.document.querySelector('.swarmui-update-banner').textContent, '↑New version available');
  assert.ok(h.document.querySelector('.swarmui-update-frame'));
  assert.equal(h.document.querySelector('.native_header'), header);
  assert.equal(h.document.querySelector('.native_footer'), footer);
  assert.equal(h.document.querySelector('.swarmui-version-badge'), null);
  h.listeners[0]({ swarmIndexRefresh: {} }, 'local'); await h.run();
  assert.equal(h.document.querySelectorAll('.swarmui-update-banner').length, 1);
  assert.equal(h.document.querySelectorAll('.swarmui-update-frame').length, 1);
  assert.equal(h.document.querySelectorAll('.swarmui-card-description').length, 1);
});

test('downloaded styles only the preview and frame, preserving image blur and accessible native descriptions', async () => {
  const h = harness(message => response(message, 'downloaded')); await h.run();
  const area = areaOf(h);
  const link = area.querySelector('a');
  const description = h.document.querySelector('.swarmui-card-description');
  assert.equal(area.dataset.swarmuiStatus, 'downloaded');
  assert.ok(link.classList.contains('swarmui-card-preview'));
  assert.ok(area.parentElement.classList.contains('swarmui-downloaded-frame'));
  assert.match(link.getAttribute('aria-describedby'), /native-help/);
  assert.ok(link.getAttribute('aria-describedby').includes(description.id));
  assert.match(description.textContent, /displayed version is downloaded/);
  assert.equal(link.querySelector('img').style.filter, 'blur(8px)');
  assert.equal(link.hasAttribute('aria-disabled'), false);
  assert.equal(h.document.querySelectorAll('.swarmui-update-banner').length, 0);
  assert.equal(h.document.querySelector('.swarmui-downloaded-banner').textContent, '✓Downloaded');
  assert.ok(area.querySelector('.native_header').classList.contains('swarmui-card-header'));
  assert.equal(area.style.getPropertyValue('--swarmui-banner-height'), '30px');
});

test('different and unknown never look downloaded or advertise an upgrade', async () => {
  for (const status of ['different', 'unknown']) {
    const h = harness(message => response(message, status)); await h.run();
    assert.equal(h.document.querySelector('.swarmui-card-preview'), null);
    assert.equal(h.document.querySelector('.swarmui-downloaded-frame'), null);
    assert.equal(h.document.querySelector('.swarmui-update-banner'), null);
    assert.equal(h.document.querySelector('.swarmui-update-frame'), null);
    if (status === 'unknown') assertClear(h);
  }
});

test('periodic query removes ownership even when index revision stays unchanged', async () => {
  let status = 'downloaded';
  const h = harness(message => response(message, status, 'partial')); await h.run();
  assert.ok(h.document.querySelector('.swarmui-card-preview'));
  status = 'unknown'; assert.equal(h.intervals[0].delay, 30_000);
  h.intervals[0].callback(); await h.run();
  assert.equal(h.messages.length, 2); assertClear(h);
  assert.equal(areaOf(h).querySelector('a').getAttribute('aria-describedby'), 'native-help');
});

test('status transitions remove old ownership and update cues completely', async () => {
  let status = 'older';
  const h = harness(message => response(message, status)); await h.run();
  for (const next of ['downloaded', 'different', 'unknown', 'older', 'unknown']) {
    status = next; h.intervals[0].callback(); await h.run();
    assert.equal(!!h.document.querySelector('.swarmui-update-banner'), next === 'older');
    assert.equal(!!h.document.querySelector('.swarmui-update-frame'), next === 'older');
    assert.equal(!!h.document.querySelector('.swarmui-card-preview'), next === 'downloaded');
    assert.equal(!!h.document.querySelector('.swarmui-downloaded-frame'), next === 'downloaded');
  }
  assertClear(h);
});

test('unavailable index and messaging failure remove all positive styling', async () => {
  for (const status of ['downloaded', 'older']) {
    let state = 'ready'; let fail = false;
    const h = harness(message => { if (fail) throw new Error('offline'); return response(message, status, state); });
    await h.run(); state = 'unavailable'; h.intervals[0].callback(); await h.run(); assertClear(h);
    state = 'ready'; h.intervals[0].callback(); await h.run();
    assert.ok(h.document.querySelector('[data-swarmui-status]'));
    fail = true; h.intervals[0].callback(); await h.run(); assertClear(h);
  }
});

test('server change clears styling immediately and discards delayed ownership response', async () => {
  let hold = false; let complete;
  const h = harness(message => hold ? new Promise(resolve => { complete = () => resolve(response(message, 'downloaded')); }) : response(message, 'downloaded'));
  await h.run(); hold = true; h.intervals[0].callback(); await h.run();
  h.listeners[0]({ targetUrl: { newValue: 'http://another.test' } }, 'local'); assertClear(h);
  complete(); await flush(); assertClear(h);
});

test('more than 500 rendered cards are split into matching batches', async () => {
  const h = harness(message => response(message, 'downloaded'));
  h.document.body.innerHTML = Array.from({ length: 501 }, (_, index) => cardMarkup(index + 1, index + 1000)).join('');
  await h.run();
  assert.deepEqual(h.messages.map(message => message.cards.length), [500, 1]);
  assert.equal(h.document.querySelectorAll('.swarmui-card-preview').length, 501);
  assert.equal(h.document.querySelectorAll('.swarmui-update-banner').length, 0);
});

test('recycled version loses styling immediately and never inherits delayed update results', async () => {
  let hold = false; let complete;
  const h = harness(message => hold ? new Promise(resolve => { complete = () => resolve(response(message, 'older')); }) : response(message, 'older'));
  await h.run(); hold = true; h.intervals[0].callback(); await h.run();
  areaOf(h).querySelector('a').setAttribute('href', '/models/42/example?modelVersionId=300');
  await flush(); assertClear(h);
  complete(); await flush(); assertClear(h);
});

test('removed cards release styles and resize observers', async () => {
  const h = harness(message => response(message, 'older')); await h.run();
  const root = h.document.querySelector('[data-card-root]'); const area = areaOf(h);
  assert.equal(h.observed.size, 1);
  root.remove(); await flush();
  assert.equal(area.hasAttribute('data-swarmui-status'), false);
  assert.equal(area.querySelector('.swarmui-card-decoration'), null);
  assert.equal(h.observed.size, 0);
});

test('both banner heights reserve space above native chips and menus without backend requests', async () => {
  for (const status of ['downloaded', 'older']) {
    const h = harness(message => response(message, status));
    await h.run();
    const area = areaOf(h); const header = area.querySelector('.native_header');
    const banner = area.querySelector('.swarmui-status-banner');
    assert.ok(header.classList.contains('swarmui-card-header'));
    assert.equal(area.style.getPropertyValue('--swarmui-banner-height'), '30px');
    let height = 47.5;
    banner.getBoundingClientRect = () => ({ height });
    h.resize(banner);
    assert.equal(area.style.getPropertyValue('--swarmui-banner-height'), '48px');
    height = 30; h.resize(banner);
    assert.equal(area.style.getPropertyValue('--swarmui-banner-height'), '30px');
    Object.defineProperty(banner, 'offsetHeight', { value: 30 });
    height = 90; h.resize(banner);
    assert.equal(area.style.getPropertyValue('--swarmui-banner-height'), '30px');
    assert.equal(h.messages.length, 1);
  }
});

test('replacement native header and model link keep layout and accessibility tracking correct', async () => {
  const h = harness(message => response(message, 'older')); await h.run();
  const area = areaOf(h);
  const oldHeader = area.querySelector('.native_header');
  const header = h.document.createElement('div'); header.className = 'replacement_header';
  header.style.transform = 'translateZ(0)';
  oldHeader.replaceWith(header); await flush(); await h.run();
  assert.equal(oldHeader.classList.contains('swarmui-card-header'), false);
  assert.equal(header.classList.contains('swarmui-card-header'), true);
  assert.equal(header.style.transform, 'translateZ(0)');
  assert.equal(h.observed.size, 1);
  const oldLink = area.querySelector('a');
  const newLink = oldLink.cloneNode(true); newLink.setAttribute('aria-describedby', 'new-native-help');
  oldLink.replaceWith(newLink); await flush(); await h.run();
  assert.equal(oldLink.getAttribute('aria-describedby'), 'native-help');
  assert.match(newLink.getAttribute('aria-describedby'), /new-native-help/);
  assert.equal(area.querySelectorAll('.swarmui-card-description').length, 1);
});

test('removing a top bar restores native header positioning and decorative classes', async () => {
  let status = 'downloaded';
  const h = harness(message => response(message, status));
  const frame = h.document.querySelector('.native-card');
  frame.classList.add('civitai-cosmetic-frame');
  await h.run();
  const area = areaOf(h); const header = area.querySelector('.native_header');
  status = 'older'; h.intervals[0].callback(); await h.run();
  assert.ok(header.classList.contains('swarmui-card-header'));
  assert.equal(area.querySelector('.swarmui-downloaded-banner'), null);
  assert.ok(area.querySelector('.swarmui-update-banner'));
  status = 'unknown'; h.intervals[0].callback(); await h.run();
  assertClear(h);
  assert.equal(area.style.getPropertyValue('--swarmui-banner-height'), '');
  assert.equal(header.className, 'native_header');
  assert.ok(frame.classList.contains('civitai-cosmetic-frame'));
});
