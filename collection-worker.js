import { CHANNEL, civitaiUrl, isModelRequest, normalizeModelType } from './lib/models.js';
import { Collector, COLLECTION_KEY } from './lib/collector.js';
import { Matcher } from './lib/swarm.js';
import { matchItems } from './lib/matching.js';

const matcher = new Matcher({ storage: chrome.storage.local, permissions: chrome.permissions });
const collector = new Collector({ storage: chrome.storage.local });

// Retire the old lookup cache when upgrading, including when a worker resumes.
async function migrate() {
  await chrome.storage.local.remove(['swarmInventory', 'resolveMissingHashes']);
  await collector.migrate();
}
void migrate().catch(error => console.error('Capture cache migration failed:', error.message));

async function match(cards, force = false) {
  await collector.writes;
  const stored = await chrome.storage.local.get(COLLECTION_KEY);
  const { items, unknown } = matchItems(cards, stored[COLLECTION_KEY]);
  const result = await matcher.match(items, { force });
  return { indexState: result.indexState, indexRevision: result.indexRevision, coverage: result.coverage,
    error: result.error ?? null, matches: [...result.results.map(value => ({ modelId: value.modelId,
      versionId: value.modelVersionId, status: value.status })), ...unknown] };
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id) return;
  const origin = civitaiUrl(sender.url)?.origin;
  const fromOptions = sender.url === chrome.runtime.getURL('options.html');
  const fromPage = origin && sender.tab && sender.frameId === 0;
  let task;
  if (message?.type === CHANNEL && fromPage) {
    if (typeof message.error === 'string') task = collector.recordError(message.error);
    else if (isModelRequest(message.url) && civitaiUrl(message.url)?.origin === origin
      && Array.isArray(message.models) && message.models.length <= 500) task = collector.ingest(message.models, origin);
  } else if (message?.type === 'swarm:check' && fromOptions) {
    task = match([], true);
  } else if (message?.type === 'civitai:matches' && (fromPage || fromOptions)
    && Array.isArray(message.cards) && message.cards.length <= 500) {
    const cards = message.cards.filter(card => Number.isSafeInteger(card?.modelId) && card.modelId > 0
      && Number.isSafeInteger(card?.versionId) && card.versionId > 0).map(card => ({ modelId: card.modelId,
      versionId: card.versionId, modelType: normalizeModelType(card.modelType) }));
    task = match(cards);
  }
  if (!task) return;
  task.then(result => { respond({ ok: true, ...result }); }, error => {
    console.error('Civitai bridge failed:', error.message);
    respond({ ok: false, error: error.message });
  });
  return true;
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.targetUrl) matcher.invalidate();
});
chrome.permissions.onRemoved?.addListener(() => { matcher.invalidate(); });
chrome.action.onClicked.addListener(() => { void chrome.runtime.openOptionsPage(); });
