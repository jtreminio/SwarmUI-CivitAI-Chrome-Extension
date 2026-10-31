import { normalizeModelType } from './models.js';

export const STATUS_LABELS = {
  downloaded: 'Downloaded', older: 'New version available', different: 'Different version downloaded'
};

export function matchItems(cards, collection) {
  const items = [];
  const unknown = [];
  for (const card of cards) {
    const record = collection?.models?.[card.modelId];
    const type = normalizeModelType(record?.type) ?? normalizeModelType(card.modelType);
    if (!type) { unknown.push({ ...card, status: 'unknown' }); continue; }
    const published = record?.versions?.find(version => version.modelVersionId === card.versionId)?.publishedAt;
    items.push({ modelId: card.modelId, modelVersionId: card.versionId, modelType: type,
      publishedAt: Number.isSafeInteger(published) && published >= 0 && published <= 253402300799999 ? published : null });
  }
  return { items, unknown };
}
