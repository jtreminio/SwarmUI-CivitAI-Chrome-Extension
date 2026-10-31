import test from 'node:test';
import assert from 'node:assert/strict';
import { Collector, COLLECTION_KEY } from '../lib/collector.js';

const record = id => ({ modelId: id, type: 'LORA', displayedVersionId: id + 100,
  versions: [{ modelVersionId: id + 100, publishedAt: 1000 }], hashes: [] });
function harness() {
  const data = {};
  const storage = {
    async get(key) { await Promise.resolve(); return structuredClone({ [key]: data[key] }); },
    async set(values) { await Promise.resolve(); Object.assign(data, structuredClone(values)); }
  };
  return { data, collector: new Collector({ storage, now: () => 1_800_000_000_000, fetch: () => assert.fail('Capture must not fetch') }) };
}

test('parallel passive captures preserve records and version dates without any fetch', async () => {
  const h = harness();
  await Promise.all([h.collector.ingest([record(1)], 'https://civitai.red'), h.collector.ingest([record(2)], 'https://civitai.com')]);
  const saved = h.data[COLLECTION_KEY];
  assert.equal(Object.keys(saved.models).length, 2);
  assert.equal(saved.responseCount, 2);
  assert.equal(saved.models[1].versions[0].publishedAt, 1000);
  assert.equal(saved.models[1].lookup, undefined);
});

test('migration preserves capture history but removes lookup states and cooldowns', async () => {
  const h = harness();
  h.data[COLLECTION_KEY] = { schemaVersion: 1, responseCount: 20, cooldowns: { 'https://civitai.red': 999999 },
    models: { 1: { ...record(1), lastSeen: 1_800_000_000_000, lookup: { status: 'pending', retryAt: 0 } } } };
  await h.collector.migrate();
  const saved = h.data[COLLECTION_KEY];
  assert.equal(saved.schemaVersion, 2);
  assert.equal(saved.responseCount, 20);
  assert.equal(saved.models[1].lookup, undefined);
  assert.equal(saved.cooldowns, undefined);
  assert.equal(saved.models[1].modelId, 1);
});

test('capture rejects invalid IDs/types and keeps diagnostics bounded', async () => {
  const h = harness();
  await h.collector.ingest([{ ...record(1), modelId: -1 }, { ...record(2), type: 'VAE' }, record(3)], 'https://civitai.red');
  assert.deepEqual(Object.keys(h.data[COLLECTION_KEY].models), ['3']);
  await h.collector.recordError('e'.repeat(500));
  assert.equal(h.data[COLLECTION_KEY].lastError.length, 300);
});
