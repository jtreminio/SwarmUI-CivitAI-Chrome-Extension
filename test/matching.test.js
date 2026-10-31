import test from 'node:test';
import assert from 'node:assert/strict';
import { matchItems } from '../lib/matching.js';

const collection = { models: { 42: { type: 'Checkpoint', displayedVersionId: 200, versions: [
  { modelVersionId: 100, publishedAt: 1000 }, { modelVersionId: 200, publishedAt: 2000 }
], hashes: [{ algorithm: 'AutoV3', value: 'a'.repeat(12), modelVersionId: 100 }] } } };

test('batch uses card-specific version date, not globally displayed version or hashes', () => {
  const result = matchItems([{ modelId: 42, versionId: 100 }], collection);
  assert.deepEqual(result.items, [{ modelId: 42, modelVersionId: 100, modelType: 'Checkpoint', publishedAt: 1000 }]);
  assert.equal(result.items[0].hashes, undefined);
});

test('unknown dates remain null; createdAt and version IDs never establish order in Chrome', () => {
  const result = matchItems([{ modelId: 42, versionId: 300 }], collection);
  assert.equal(result.items[0].publishedAt, null);
});

test('SSR card type can match without captured record; missing type remains unknown', () => {
  const result = matchItems([{ modelId: 42, versionId: 100, modelType: 'LoRA' }, { modelId: 43, versionId: 101 }], {});
  assert.equal(result.items[0].modelType, 'LORA');
  assert.equal(result.items[0].publishedAt, null);
  assert.equal(result.unknown[0].status, 'unknown');
});

test('dates obey backend integer bounds and LoCon/DoRA aliases are supported', () => {
  for (const publishedAt of [-1, 1.5, 253402300800000, '2026-01-01']) {
    assert.equal(matchItems([{ modelId: 1, versionId: 2 }], { models: { 1: { type: 'DoRA', versions: [{ modelVersionId: 2, publishedAt }] } } }).items[0].publishedAt, null);
  }
  for (const modelType of ['LoRA', 'LORA', 'LoCon', 'LoCON', 'DoRA']) {
    assert.equal(matchItems([{ modelId: 1, versionId: 2, modelType }], {}).items.length, 1);
  }
  assert.equal(matchItems([{ modelId: 1, versionId: 2 }], { models: { 1: { type: 'Checkpoint', versions: [{ modelVersionId: 2, publishedAt: 0 }] } } }).items[0].publishedAt, 0);
});
