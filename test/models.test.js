import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stringify } from 'devalue';
import { extractModels, isModelRequest, isModelsPage, mergeRecord, sanitizeRecord, normalizeHash } from '../lib/models.js';

const url = 'https://civitai.red/api/trpc/model.getAll';
const hash = 'a'.repeat(64);
const card = { id: 42, name: 'Example', type: 'LORA', hashes: [hash], version: { id: 99, name: 'v1' } };

test('real sample: 187 models, 175 with 1,133 SHA256 entries; no invented version associations', async () => {
  const text = await readFile(new URL('../samples/api.trpc.model.getAll.txt', import.meta.url), 'utf8');
  const models = extractModels(text, url);
  assert.equal(models.length, 187);
  assert.equal(models.filter(model => model.hashes.length).length, 175);
  assert.equal(models.reduce((n, model) => n + model.hashes.length, 0), 1133);
  assert.equal(models[0].modelId, 2458426);
  assert.equal(models[0].displayedVersionId, 3263843);
  assert.ok(models.every(model => model.hashes.every(hash => hash.modelVersionId === null && hash.fileId === null)));
});

test('devalue, SuperJSON, plain JSON and mixed batches preserve only allowed model results', () => {
  for (const data of [stringify({ items: [card] }), { json: { items: [card] }, meta: {} }, { items: [card] }]) {
    const result = extractModels({ result: { data } }, url);
    assert.equal(result[0].modelId, 42);
    assert.equal(result[0].versions[0].modelVersionId, 99);
  }
  const payload = [{ result: { data: { items: [{ ...card, id: 111 }] } } }, { result: { data: { items: [card] } } }];
  assert.deepEqual(extractModels(payload, `${url.replace('model.getAll', 'user.getMe,model.getAll')}?batch=1`).map(x => x.modelId), [42]);
});

test('only checkpoint, LoRA and LoCon model IDs survive; image/user IDs are not traversed', () => {
  const payload = { result: { data: { items: [card, { ...card, id: 43, type: 'LoCon' },
    { ...card, id: 44, type: 'Checkpoint' }, { ...card, id: 45, type: 'VAE' }, { id: 999, user: card }] } } };
  assert.deepEqual(extractModels(payload, url).map(x => x.modelId), [42, 43, 44]);
});

test('REST file hashes retain actual version/file IDs and exclude linked VAEs', () => {
  const body = { id: 99, modelId: 42, model: { name: 'Example', type: 'LORA' }, files: [
    { id: 5, type: 'Model', hashes: { SHA256: hash.toUpperCase(), AutoV2: 'AB12345678' } },
    { id: 6, type: 'VAE', hashes: { SHA256: 'b'.repeat(64) } },
    { id: 7, type: 'Pruned Model', hashes: [{ type: 'MD5', hash: 'c'.repeat(32) }] }
  ] };
  const [record] = extractModels(body, 'https://civitai.com/api/v1/model-versions/99');
  assert.equal(record.modelId, 42);
  assert.equal(record.hashes.length, 3);
  assert.deepEqual(record.hashes[0], { algorithm: 'SHA256', value: hash, modelVersionId: 99, fileId: 5, source: 'file' });
  assert.equal(record.hashes[1].value, 'ab12345678');
});

test('malformed hashes, unrelated hosts and unrelated API responses are rejected', () => {
  for (const bad of ['https://civitai.red.evil.test/api/trpc/model.getAll', 'https://civitai.com/api/trpc/user.getMe',
    'http://civitai.com/api/trpc/model.getAll', 'https://civitai.red/api/trpc/model.getAllExtra']) assert.equal(isModelRequest(bad), false);
  assert.equal(isModelsPage('https://civitai.com/models?types=LORA'), true);
  assert.equal(isModelsPage('https://civitai.red/models/42/example'), true);
  assert.equal(isModelsPage('https://civitai.red/images/42'), false);
  const [record] = extractModels({ result: { data: { items: [{ ...card, hashes: [hash, hash.toUpperCase(), 'bogus', 'f'.repeat(10)] }] } } }, url);
  assert.equal(record.hashes.length, 1);
  assert.throws(() => extractModels('bad json', url));
});

test('bridge validation strips arbitrary fields and invalid file/version associations', () => {
  const record = sanitizeRecord({ modelId: 42, type: 'LORA', secret: 'drop', versions: [], hashes: [
    { algorithm: 'SHA256', value: hash, modelVersionId: 123, fileId: 4 },
    { algorithm: 'SHA256', value: hash, modelVersionId: null, fileId: 5 },
    { algorithm: '__proto__', value: hash }
  ] });
  assert.equal(record.secret, undefined);
  assert.equal(record.hashes.length, 1);
  assert.equal(record.hashes[0].fileId, null);
  assert.equal(sanitizeRecord({ modelId: -1, type: 'LORA' }), null);
});

test('duplicate capture merges across both domains without losing version/file provenance', () => {
  const [record] = extractModels({ result: { data: { items: [card] } } }, url);
  const first = mergeRecord(null, record, 'https://civitai.com', 100);
  const second = mergeRecord(first, record, 'https://civitai.red', 200);
  assert.equal(second.hashes.length, 1);
  assert.equal(second.versions.length, 1);
  assert.equal(second.firstSeen, 100);
  assert.equal(second.lastSeen, 200);
});


test('AutoV3 capture retains file/version provenance and normalizes publication dates', () => {
  const [model] = extractModels({ id: 42, type: 'Checkpoint', modelVersions: [{ id: 100,
    name: 'v1', publishedAt: '2026-01-01T00:00:00Z', files: [{ id: 5, type: 'Model', hashes: { AutoV3: 'DA91BFBF41F0' } }] }] },
    'https://civitai.red/api/v1/models/42');
  assert.equal(model.hashes[0].value, 'da91bfbf41f0');
  assert.equal(model.hashes[0].modelVersionId, 100);
  assert.equal(model.hashes[0].fileId, 5);
  assert.equal(model.versions[0].publishedAt, Date.UTC(2026, 0, 1));
  assert.equal(normalizeHash('AutoV3', 'a'.repeat(10)), null);
});
