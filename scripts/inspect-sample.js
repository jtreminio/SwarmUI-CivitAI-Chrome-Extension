import { readFile } from 'node:fs/promises';
import { extractModels } from '../lib/models.js';

const models = extractModels(await readFile(new URL('../samples/api.trpc.model.getAll.txt', import.meta.url), 'utf8'),
  'https://civitai.red/api/trpc/model.getAll');
console.log(JSON.stringify({
  models: models.length,
  withHashes: models.filter(model => model.hashes.length).length,
  withoutHashes: models.filter(model => !model.hashes.length).length,
  sha256: models.reduce((count, model) => count + model.hashes.length, 0),
  firstModel: models[0],
  missing: models.filter(model => !model.hashes.length).map(({ modelId, displayedVersionId }) => ({ modelId, displayedVersionId }))
}, null, 2));
