export const INDEX_STATUS_KEY = 'swarmIndexStatus';
export const MATCH_ROUTE = 'WhatTheDuckMatchCivitaiVersions';
const CACHE_MS = 2000;
const MISSING_ENDPOINT = 'Update WhatTheDuck and restart SwarmUI: its Civitai matching endpoint is unavailable.';
const STATES = new Set(['ready', 'partial', 'unavailable']);
const STATUSES = new Set(['downloaded', 'older', 'different', 'unknown']);

export function serverUrl(value) {
  if (!value) return null;
  const url = new URL(/^https?:\/\//i.test(value) ? value : `http://${value}`);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid SwarmUI server URL.');
  url.pathname = url.pathname.replace(/\/Text2Image\/?$/i, '').replace(/\/+$/, '') + '/';
  url.search = ''; url.hash = '';
  return url;
}

export function permissionOrigin(value) {
  const url = serverUrl(value);
  return url ? `${url.origin}/*` : null;
}

function validateResponse(data, items) {
  if (data.schemaVersion !== 1 || !STATES.has(data.indexState) || !Array.isArray(data.results)
    || data.results.length !== items.length) throw new Error('WhatTheDuck returned an invalid matching response.');
  const results = data.results.map((result, index) => {
    const item = items[index];
    if (result?.modelId !== item.modelId || result?.modelVersionId !== item.modelVersionId
      || !STATUSES.has(result.status)) throw new Error('WhatTheDuck returned mismatched version results.');
    return { modelId: item.modelId, modelVersionId: item.modelVersionId,
      status: data.indexState === 'unavailable' ? 'unknown' : result.status };
  });
  const counts = data.coverage;
  const coverage = counts && ['localFiles', 'identifiedFiles', 'unresolvedFiles'].every(key => Number.isSafeInteger(counts[key]) && counts[key] >= 0)
    ? { localFiles: counts.localFiles, identifiedFiles: counts.identifiedFiles, unresolvedFiles: counts.unresolvedFiles } : null;
  return { schemaVersion: 1, indexState: data.indexState,
    indexRevision: typeof data.indexRevision === 'string' ? data.indexRevision.slice(0, 200) : null, coverage, results };
}

export class SwarmClient {
  constructor({ fetch: fetcher = globalThis.fetch.bind(globalThis) } = {}) {
    this.fetch = fetcher;
    this.sessions = new Map();
  }

  clear() { this.sessions.clear(); }

  async post(base, route, body) {
    const response = await this.fetch(new URL(`API/${route}`, base).href, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', redirect: 'error',
      body: JSON.stringify(body), signal: AbortSignal.timeout(20_000)
    });
    if (route === MATCH_ROUTE && response.status === 404) throw new Error(MISSING_ENDPOINT);
    let data;
    try { data = await response.json(); }
    catch { throw new Error('SwarmUI returned an invalid response. Sign in to SwarmUI if required.'); }
    if (data.error_id === 'invalid_session_id') return data;
    if (route === MATCH_ROUTE && data.error_id === 'bad_route') throw new Error(MISSING_ENDPOINT);
    if (!response.ok || data.error || data.error_id) throw new Error(String(data.error ?? `SwarmUI HTTP ${response.status}`).slice(0, 200));
    return data;
  }

  async session(base) {
    if (!this.sessions.has(base.href)) {
      const pending = this.post(base, 'GetNewSession', {}).then(data => {
        if (typeof data.session_id !== 'string' || !data.session_id) throw new Error('Sign in to SwarmUI to establish a session.');
        return data.session_id;
      });
      this.sessions.set(base.href, pending);
      pending.catch(() => { if (this.sessions.get(base.href) === pending) this.sessions.delete(base.href); });
    }
    return this.sessions.get(base.href);
  }

  async match(target, items) {
    if (!Array.isArray(items) || items.length > 500) throw new Error('A matching batch must contain at most 500 items.');
    const base = serverUrl(target);
    if (!base) throw new Error('Set a SwarmUI server URL in options.');
    let session = await this.session(base);
    let data = await this.post(base, MATCH_ROUTE, { session_id: session, items });
    if (data.error_id === 'invalid_session_id') {
      // Avoid discarding a newer session another concurrent request already renewed.
      if (await this.sessions.get(base.href) === session) this.sessions.delete(base.href);
      session = await this.session(base);
      data = await this.post(base, MATCH_ROUTE, { session_id: session, items });
    }
    if (data.error_id === 'invalid_session_id') throw new Error('SwarmUI session expired. Sign in and retry.');
    return validateResponse(data, items);
  }
}

export class Matcher {
  constructor({ storage, permissions, client = new SwarmClient(), now = Date.now }) {
    Object.assign(this, { storage, permissions, client, now });
    this.cache = new Map();
    this.generation = 0;
  }

  invalidate() { this.generation++; this.cache.clear(); this.client.clear(); }

  async match(items, { force = false } = {}) {
    let target;
    const generation = this.generation;
    let result;
    try {
      target = serverUrl((await this.storage.get('targetUrl')).targetUrl)?.href;
      if (!target) throw new Error('Set a SwarmUI server URL in options.');
      const permission = { origins: [permissionOrigin(target)] };
      if (!await this.permissions.contains(permission)) throw new Error('Save options to allow access to your SwarmUI server.');
      const key = JSON.stringify([target, items]);
      let cached = this.cache.get(key);
      if (force || !cached || (!cached.pending && this.now() - cached.at >= CACHE_MS)) {
        cached = { pending: true, at: this.now() };
        const entry = cached;
        entry.promise = this.client.match(target, items).then(value => {
          entry.pending = false; entry.at = this.now(); return value;
        }, error => { if (this.cache.get(key) === entry) this.cache.delete(key); throw error; });
        this.cache.set(key, entry);
        while (this.cache.size > 50) this.cache.delete(this.cache.keys().next().value);
      }
      result = await cached.promise;
      const current = serverUrl((await this.storage.get('targetUrl')).targetUrl)?.href;
      if (generation !== this.generation || current !== target) throw new Error('SwarmUI server changed. Rechecking card versions.');
      if (!await this.permissions.contains(permission)) throw new Error('SwarmUI server access was removed. Save options to reconnect.');
    } catch (error) {
      result = { schemaVersion: 1, indexState: 'unavailable', indexRevision: null, coverage: null,
        results: items.map(item => ({ modelId: item.modelId, modelVersionId: item.modelVersionId, status: 'unknown' })),
        error: error.message };
    }
    // Store connection/coverage information only. Ownership results and sessions stay in memory.
    const summary = { target: target ?? null, indexState: result.indexState, indexRevision: result.indexRevision,
      coverage: result.coverage, error: result.error ?? null, checkedAt: this.now() };
    let current;
    try { current = serverUrl((await this.storage.get('targetUrl')).targetUrl)?.href; } catch { /* Invalid settings. */ }
    if (current === target && generation === this.generation) {
      await this.storage.set({ [INDEX_STATUS_KEY]: summary });
    }
    return result;
  }
}
