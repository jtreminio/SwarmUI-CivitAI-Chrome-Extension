import { parse as parseDevalue } from 'devalue';

export const CHANNEL = 'civitai-swarmui:capture:v1';
export const MAX_BODY_SIZE = 8 * 1024 * 1024;
export const MODEL_TYPES = new Set(['Checkpoint', 'LORA', 'LoCon', 'DoRA']);
export function normalizeModelType(value) {
  return typeof value === 'string' ? [...MODEL_TYPES].find(type => type.toLowerCase() === value.toLowerCase()) ?? null : null;
}
const PROCEDURES = new Set(['model.getAll', 'model.getById', 'modelVersion.getById']);
const HASH_LENGTHS = { SHA256: 64, AutoV3: 12, AutoV2: 10, AutoV1: 8, SHA1: 40, MD5: 32, CRC32: 8, BLAKE3: 64 };

export function civitaiUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && ['civitai.com', 'civitai.red'].includes(url.hostname)
      && !url.port && !url.username && !url.password ? url : null;
  } catch {
    return null;
  }
}

export function isModelsPage(value) {
  const url = civitaiUrl(value);
  return !!url && /^\/models(?:\/|$)/.test(url.pathname);
}

export function isModelRequest(value) {
  const url = civitaiUrl(value);
  if (!url) return false;
  if (/^\/api\/v1\/(?:models(?:\/\d+)?|model-versions\/\d+)\/?$/.test(url.pathname)) return true;
  return url.pathname.startsWith('/api/trpc/')
    && url.pathname.slice('/api/trpc/'.length).split(',').some(name => PROCEDURES.has(name));
}

function id(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function label(value) {
  return typeof value === 'string' ? value.slice(0, 300) : '';
}

function date(value) {
  const time = value instanceof Date ? value.getTime() : typeof value === 'string' ? Date.parse(value) : value;
  return Number.isSafeInteger(time) && time >= 0 && time <= 253402300799999 ? time : null;
}

function versionInfo(version) {
  return { modelVersionId: version.modelVersionId ?? version.id, name: label(version.name),
    baseModel: label(version.baseModel), publishedAt: date(version.publishedAt), createdAt: date(version.createdAt) };
}

export function normalizeHash(algorithm, value) {
  const canonical = Object.keys(HASH_LENGTHS).find(key => key.toLowerCase() === String(algorithm).toLowerCase());
  if (!canonical || typeof value !== 'string' || value.length !== HASH_LENGTHS[canonical]
    || !/^[a-f\d]+$/i.test(value)) return null;
  return { algorithm: canonical, value: value.toLowerCase() };
}

export function hashKey(hash) {
  return `${hash.algorithm}:${hash.value}:${hash.modelVersionId ?? ''}:${hash.fileId ?? ''}`;
}

function uniqueHashes(hashes) {
  return [...new Map(hashes.map(hash => [hashKey(hash), hash])).values()];
}

function extractModel(model) {
  // A version response has its parent model under `model`, not in its own `id`.
  const isVersion = id(model?.modelId) && model?.model;
  const modelId = id(isVersion ? model.modelId : model?.id);
  const type = normalizeModelType(isVersion ? model.model.type : model?.type);
  if (!modelId || !MODEL_TYPES.has(type)) return null;
  const versions = isVersion ? [model] : Array.isArray(model.modelVersions)
    ? model.modelVersions : model.version ? [model.version] : [];
  const hashes = [];
  // Feed hashes span the parent model. They are NOT hashes of `version.id`.
  for (const value of Array.isArray(model.hashes) ? model.hashes : []) {
    const hash = normalizeHash('SHA256', value);
    if (hash) hashes.push({ ...hash, modelVersionId: null, fileId: null, source: 'listing' });
  }
  for (const version of versions) {
    if (!id(version?.id)) continue;
    for (const file of Array.isArray(version.files) ? version.files : []) {
      // REST responses can include a linked VAE belonging to a different version.
      if (!['Model', 'Pruned Model'].includes(file?.type)) continue;
      const pairs = Array.isArray(file.hashes)
        ? file.hashes.map(hash => [hash?.type, hash?.hash]) : Object.entries(file.hashes ?? {});
      for (const [algorithm, value] of pairs) {
        const hash = normalizeHash(algorithm, value);
        if (hash) hashes.push({ ...hash, modelVersionId: version.id, fileId: id(file.id), source: 'file' });
      }
    }
  }
  return {
    modelId,
    name: label(isVersion ? model.model.name : model.name),
    type,
    displayedVersionId: id(model.version?.id) ?? (isVersion ? id(model.id) : null),
    versions: versions.filter(version => id(version?.id)).map(versionInfo),
    versionDetailsComplete: Array.isArray(model.modelVersions)
      && model.modelVersions.every(version => Array.isArray(version.files)),
    hashes: uniqueHashes(hashes)
  };
}

function decodeData(data) {
  if (typeof data === 'string') return parseDevalue(data);
  // SuperJSON dates remain ISO strings in json; versionInfo normalizes their units.
  if (data && Object.hasOwn(data, 'json')) return data.json;
  return data;
}

export function extractModels(body, requestUrl) {
  if (!isModelRequest(requestUrl)) return [];
  if (typeof body === 'string' && body.length > MAX_BODY_SIZE) throw new Error('Model response exceeds 8 MiB.');
  const payload = typeof body === 'string' ? JSON.parse(body) : body;
  const url = new URL(requestUrl);
  let results;
  if (url.pathname.startsWith('/api/trpc/')) {
    const procedures = url.pathname.slice('/api/trpc/'.length).split(',');
    const envelopes = Array.isArray(payload) ? payload : [payload];
    results = envelopes.flatMap((envelope, index) => {
      if (!PROCEDURES.has(procedures[index]) || !envelope?.result) return [];
      return [decodeData(envelope.result.data)];
    });
  } else {
    results = [payload];
  }
  const models = results.flatMap(data => Array.isArray(data?.items) ? data.items : [data])
    .map(extractModel).filter(Boolean);
  return [...new Map(models.map(model => [model.modelId, model])).values()];
}

// The MAIN-world bridge is page-accessible. Validate it again before persistence.
export function sanitizeRecord(record) {
  if (!id(record?.modelId) || !normalizeModelType(record.type)) return null;
  const versions = (Array.isArray(record.versions) ? record.versions : []).slice(0, 500)
    .filter(version => id(version?.modelVersionId)).map(versionInfo);
  const hashes = (Array.isArray(record.hashes) ? record.hashes : []).slice(0, 2000).flatMap(value => {
    const hash = normalizeHash(value?.algorithm, value?.value);
    if (!hash) return [];
    const versionId = id(value.modelVersionId);
    if (versionId && !versions.some(version => version.modelVersionId === versionId)) return [];
    return [{ ...hash, modelVersionId: versionId, fileId: versionId ? id(value.fileId) : null,
      source: versionId ? 'file' : 'listing' }];
  });
  return { modelId: record.modelId, name: label(record.name), type: normalizeModelType(record.type),
    displayedVersionId: id(record.displayedVersionId), versions, hashes: uniqueHashes(hashes),
    versionDetailsComplete: record.versionDetailsComplete === true };
}

export function mergeRecord(previous, incoming, origin, now = Date.now()) {
  const changedVersion = previous && incoming.displayedVersionId
    && previous.displayedVersionId !== incoming.displayedVersionId;
  const versions = new Map((previous?.versions ?? []).map(version => [version.modelVersionId, version]));
  for (const version of incoming.versions) {
    const old = versions.get(version.modelVersionId);
    versions.set(version.modelVersionId, Object.fromEntries(Object.entries({ ...old, ...version })
      .map(([key, value]) => [key, value === null || value === undefined || value === '' ? old?.[key] ?? value : value])));
  }
  return {
    ...incoming,
    displayedVersionId: incoming.displayedVersionId ?? previous?.displayedVersionId ?? null,
    versions: [...versions.values()].slice(-500),
    versionDetailsComplete: incoming.versionDetailsComplete || (!changedVersion && previous?.versionDetailsComplete) || false,
    hashes: uniqueHashes([...(previous?.hashes ?? []), ...incoming.hashes]).slice(-2000),
    origin,
    firstSeen: previous?.firstSeen ?? now,
    lastSeen: now
  };
}
