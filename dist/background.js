(() => {
  // lib/models.js
  var CHANNEL = "civitai-swarmui:capture:v1";
  var MAX_BODY_SIZE = 8 * 1024 * 1024;
  var MODEL_TYPES = /* @__PURE__ */ new Set(["Checkpoint", "LORA", "LoCon", "DoRA"]);
  function normalizeModelType(value) {
    return typeof value === "string" ? [...MODEL_TYPES].find((type) => type.toLowerCase() === value.toLowerCase()) ?? null : null;
  }
  var PROCEDURES = /* @__PURE__ */ new Set(["model.getAll", "model.getById", "modelVersion.getById"]);
  var HASH_LENGTHS = { SHA256: 64, AutoV3: 12, AutoV2: 10, AutoV1: 8, SHA1: 40, MD5: 32, CRC32: 8, BLAKE3: 64 };
  function civitaiUrl(value) {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && ["civitai.com", "civitai.red"].includes(url.hostname) && !url.port && !url.username && !url.password ? url : null;
    } catch {
      return null;
    }
  }
  function isModelRequest(value) {
    const url = civitaiUrl(value);
    if (!url) return false;
    if (/^\/api\/v1\/(?:models(?:\/\d+)?|model-versions\/\d+)\/?$/.test(url.pathname)) return true;
    return url.pathname.startsWith("/api/trpc/") && url.pathname.slice("/api/trpc/".length).split(",").some((name) => PROCEDURES.has(name));
  }
  function id(value) {
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }
  function label(value) {
    return typeof value === "string" ? value.slice(0, 300) : "";
  }
  function date(value) {
    const time = value instanceof Date ? value.getTime() : typeof value === "string" ? Date.parse(value) : value;
    return Number.isSafeInteger(time) && time >= 0 && time <= 253402300799999 ? time : null;
  }
  function versionInfo(version) {
    return {
      modelVersionId: version.modelVersionId ?? version.id,
      name: label(version.name),
      baseModel: label(version.baseModel),
      publishedAt: date(version.publishedAt),
      createdAt: date(version.createdAt)
    };
  }
  function normalizeHash(algorithm, value) {
    const canonical = Object.keys(HASH_LENGTHS).find((key) => key.toLowerCase() === String(algorithm).toLowerCase());
    if (!canonical || typeof value !== "string" || value.length !== HASH_LENGTHS[canonical] || !/^[a-f\d]+$/i.test(value)) return null;
    return { algorithm: canonical, value: value.toLowerCase() };
  }
  function hashKey(hash) {
    return `${hash.algorithm}:${hash.value}:${hash.modelVersionId ?? ""}:${hash.fileId ?? ""}`;
  }
  function uniqueHashes(hashes) {
    return [...new Map(hashes.map((hash) => [hashKey(hash), hash])).values()];
  }
  function sanitizeRecord(record) {
    if (!id(record?.modelId) || !normalizeModelType(record.type)) return null;
    const versions = (Array.isArray(record.versions) ? record.versions : []).slice(0, 500).filter((version) => id(version?.modelVersionId)).map(versionInfo);
    const hashes = (Array.isArray(record.hashes) ? record.hashes : []).slice(0, 2e3).flatMap((value) => {
      const hash = normalizeHash(value?.algorithm, value?.value);
      if (!hash) return [];
      const versionId = id(value.modelVersionId);
      if (versionId && !versions.some((version) => version.modelVersionId === versionId)) return [];
      return [{
        ...hash,
        modelVersionId: versionId,
        fileId: versionId ? id(value.fileId) : null,
        source: versionId ? "file" : "listing"
      }];
    });
    return {
      modelId: record.modelId,
      name: label(record.name),
      type: normalizeModelType(record.type),
      displayedVersionId: id(record.displayedVersionId),
      versions,
      hashes: uniqueHashes(hashes),
      versionDetailsComplete: record.versionDetailsComplete === true
    };
  }
  function mergeRecord(previous, incoming, origin, now = Date.now()) {
    const changedVersion = previous && incoming.displayedVersionId && previous.displayedVersionId !== incoming.displayedVersionId;
    const versions = new Map((previous?.versions ?? []).map((version) => [version.modelVersionId, version]));
    for (const version of incoming.versions) {
      const old = versions.get(version.modelVersionId);
      versions.set(version.modelVersionId, Object.fromEntries(Object.entries({ ...old, ...version }).map(([key, value]) => [key, value === null || value === void 0 || value === "" ? old?.[key] ?? value : value])));
    }
    return {
      ...incoming,
      displayedVersionId: incoming.displayedVersionId ?? previous?.displayedVersionId ?? null,
      versions: [...versions.values()].slice(-500),
      versionDetailsComplete: incoming.versionDetailsComplete || !changedVersion && previous?.versionDetailsComplete || false,
      hashes: uniqueHashes([...previous?.hashes ?? [], ...incoming.hashes]).slice(-2e3),
      origin,
      firstSeen: previous?.firstSeen ?? now,
      lastSeen: now
    };
  }

  // lib/collector.js
  var COLLECTION_KEY = "civitaiCollection";
  var DAY = 24 * 60 * 6e4;
  var emptyCollection = () => ({ schemaVersion: 2, models: {}, responseCount: 0, lastCaptureAt: null, lastError: null });
  var Collector = class {
    constructor({ storage, now = Date.now }) {
      this.storage = storage;
      this.now = now;
      this.writes = Promise.resolve();
    }
    update(change) {
      const write = this.writes.then(async () => {
        const stored = await this.storage.get(COLLECTION_KEY);
        const collection = stored[COLLECTION_KEY] ?? emptyCollection();
        collection.schemaVersion = 2;
        delete collection.cooldowns;
        for (const record of Object.values(collection.models)) delete record.lookup;
        const result = change(collection);
        const records = Object.values(collection.models).sort((a, b) => b.lastSeen - a.lastSeen);
        let bytes = 0;
        collection.models = Object.fromEntries(records.filter((record, index) => {
          bytes += new TextEncoder().encode(JSON.stringify(record)).length;
          return index < 2e3 && bytes < 6 * 1024 * 1024 && this.now() - record.lastSeen < 30 * DAY;
        }).map((record) => [record.modelId, record]));
        await this.storage.set({ [COLLECTION_KEY]: collection });
        return result;
      });
      this.writes = write.catch(() => {
      });
      return write;
    }
    async migrate() {
      const stored = await this.storage.get(COLLECTION_KEY);
      if (stored[COLLECTION_KEY]?.schemaVersion === 2) return;
      return this.update(() => {
      });
    }
    async ingest(records, origin) {
      await this.update((collection) => {
        for (const value of records) {
          const record = sanitizeRecord(value);
          if (!record) continue;
          collection.models[record.modelId] = mergeRecord(collection.models[record.modelId], record, origin, this.now());
        }
        collection.responseCount++;
        collection.lastCaptureAt = this.now();
        collection.lastError = null;
      });
    }
    async recordError(message) {
      await this.update((collection) => {
        collection.lastError = String(message).slice(0, 300);
      });
    }
  };

  // lib/swarm.js
  var INDEX_STATUS_KEY = "swarmIndexStatus";
  var MATCH_ROUTE = "WhatTheDuckMatchCivitaiVersions";
  var CACHE_MS = 2e3;
  var MISSING_ENDPOINT = "Update WhatTheDuck and restart SwarmUI: its Civitai matching endpoint is unavailable.";
  var STATES = /* @__PURE__ */ new Set(["ready", "partial", "unavailable"]);
  var STATUSES = /* @__PURE__ */ new Set(["downloaded", "older", "different", "unknown"]);
  function serverUrl(value) {
    if (!value) return null;
    const url = new URL(/^https?:\/\//i.test(value) ? value : `http://${value}`);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Invalid SwarmUI server URL.");
    url.pathname = url.pathname.replace(/\/Text2Image\/?$/i, "").replace(/\/+$/, "") + "/";
    url.search = "";
    url.hash = "";
    return url;
  }
  function permissionOrigin(value) {
    const url = serverUrl(value);
    return url ? `${url.origin}/*` : null;
  }
  function validateResponse(data, items) {
    if (data.schemaVersion !== 1 || !STATES.has(data.indexState) || !Array.isArray(data.results) || data.results.length !== items.length) throw new Error("WhatTheDuck returned an invalid matching response.");
    const results = data.results.map((result, index) => {
      const item = items[index];
      if (result?.modelId !== item.modelId || result?.modelVersionId !== item.modelVersionId || !STATUSES.has(result.status)) throw new Error("WhatTheDuck returned mismatched version results.");
      return {
        modelId: item.modelId,
        modelVersionId: item.modelVersionId,
        status: data.indexState === "unavailable" ? "unknown" : result.status
      };
    });
    const counts = data.coverage;
    const coverage = counts && ["localFiles", "identifiedFiles", "unresolvedFiles"].every((key) => Number.isSafeInteger(counts[key]) && counts[key] >= 0) ? { localFiles: counts.localFiles, identifiedFiles: counts.identifiedFiles, unresolvedFiles: counts.unresolvedFiles } : null;
    return {
      schemaVersion: 1,
      indexState: data.indexState,
      indexRevision: typeof data.indexRevision === "string" ? data.indexRevision.slice(0, 200) : null,
      coverage,
      results
    };
  }
  var SwarmClient = class {
    constructor({ fetch: fetcher = globalThis.fetch.bind(globalThis) } = {}) {
      this.fetch = fetcher;
      this.sessions = /* @__PURE__ */ new Map();
    }
    clear() {
      this.sessions.clear();
    }
    async post(base, route, body) {
      const response = await this.fetch(new URL(`API/${route}`, base).href, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        redirect: "error",
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(2e4)
      });
      if (route === MATCH_ROUTE && response.status === 404) throw new Error(MISSING_ENDPOINT);
      let data;
      try {
        data = await response.json();
      } catch {
        throw new Error("SwarmUI returned an invalid response. Sign in to SwarmUI if required.");
      }
      if (data.error_id === "invalid_session_id") return data;
      if (route === MATCH_ROUTE && data.error_id === "bad_route") throw new Error(MISSING_ENDPOINT);
      if (!response.ok || data.error || data.error_id) throw new Error(String(data.error ?? `SwarmUI HTTP ${response.status}`).slice(0, 200));
      return data;
    }
    async session(base) {
      if (!this.sessions.has(base.href)) {
        const pending = this.post(base, "GetNewSession", {}).then((data) => {
          if (typeof data.session_id !== "string" || !data.session_id) throw new Error("Sign in to SwarmUI to establish a session.");
          return data.session_id;
        });
        this.sessions.set(base.href, pending);
        pending.catch(() => {
          if (this.sessions.get(base.href) === pending) this.sessions.delete(base.href);
        });
      }
      return this.sessions.get(base.href);
    }
    async match(target, items) {
      if (!Array.isArray(items) || items.length > 500) throw new Error("A matching batch must contain at most 500 items.");
      const base = serverUrl(target);
      if (!base) throw new Error("Set a SwarmUI server URL in options.");
      let session = await this.session(base);
      let data = await this.post(base, MATCH_ROUTE, { session_id: session, items });
      if (data.error_id === "invalid_session_id") {
        if (await this.sessions.get(base.href) === session) this.sessions.delete(base.href);
        session = await this.session(base);
        data = await this.post(base, MATCH_ROUTE, { session_id: session, items });
      }
      if (data.error_id === "invalid_session_id") throw new Error("SwarmUI session expired. Sign in and retry.");
      return validateResponse(data, items);
    }
  };
  var Matcher = class {
    constructor({ storage, permissions, client = new SwarmClient(), now = Date.now }) {
      Object.assign(this, { storage, permissions, client, now });
      this.cache = /* @__PURE__ */ new Map();
      this.generation = 0;
    }
    invalidate() {
      this.generation++;
      this.cache.clear();
      this.client.clear();
    }
    async match(items, { force = false } = {}) {
      let target;
      const generation = this.generation;
      let result;
      try {
        target = serverUrl((await this.storage.get("targetUrl")).targetUrl)?.href;
        if (!target) throw new Error("Set a SwarmUI server URL in options.");
        const permission = { origins: [permissionOrigin(target)] };
        if (!await this.permissions.contains(permission)) throw new Error("Save options to allow access to your SwarmUI server.");
        const key = JSON.stringify([target, items]);
        let cached = this.cache.get(key);
        if (force || !cached || !cached.pending && this.now() - cached.at >= CACHE_MS) {
          cached = { pending: true, at: this.now() };
          const entry = cached;
          entry.promise = this.client.match(target, items).then((value) => {
            entry.pending = false;
            entry.at = this.now();
            return value;
          }, (error) => {
            if (this.cache.get(key) === entry) this.cache.delete(key);
            throw error;
          });
          this.cache.set(key, entry);
          while (this.cache.size > 50) this.cache.delete(this.cache.keys().next().value);
        }
        result = await cached.promise;
        const current2 = serverUrl((await this.storage.get("targetUrl")).targetUrl)?.href;
        if (generation !== this.generation || current2 !== target) throw new Error("SwarmUI server changed. Rechecking card versions.");
        if (!await this.permissions.contains(permission)) throw new Error("SwarmUI server access was removed. Save options to reconnect.");
      } catch (error) {
        result = {
          schemaVersion: 1,
          indexState: "unavailable",
          indexRevision: null,
          coverage: null,
          results: items.map((item) => ({ modelId: item.modelId, modelVersionId: item.modelVersionId, status: "unknown" })),
          error: error.message
        };
      }
      const summary = {
        target: target ?? null,
        indexState: result.indexState,
        indexRevision: result.indexRevision,
        coverage: result.coverage,
        error: result.error ?? null,
        checkedAt: this.now()
      };
      let current;
      try {
        current = serverUrl((await this.storage.get("targetUrl")).targetUrl)?.href;
      } catch {
      }
      if (current === target && generation === this.generation) {
        await this.storage.set({ [INDEX_STATUS_KEY]: summary });
      }
      return result;
    }
  };

  // lib/matching.js
  function matchItems(cards, collection) {
    const items = [];
    const unknown = [];
    for (const card of cards) {
      const record = collection?.models?.[card.modelId];
      const type = normalizeModelType(record?.type) ?? normalizeModelType(card.modelType);
      if (!type) {
        unknown.push({ ...card, status: "unknown" });
        continue;
      }
      const published = record?.versions?.find((version) => version.modelVersionId === card.versionId)?.publishedAt;
      items.push({
        modelId: card.modelId,
        modelVersionId: card.versionId,
        modelType: type,
        publishedAt: Number.isSafeInteger(published) && published >= 0 && published <= 253402300799999 ? published : null
      });
    }
    return { items, unknown };
  }

  // collection-worker.js
  var matcher = new Matcher({ storage: chrome.storage.local, permissions: chrome.permissions });
  var collector = new Collector({ storage: chrome.storage.local });
  async function migrate() {
    await chrome.alarms.clear("civitai-hash-lookups");
    await chrome.storage.local.remove(["swarmInventory", "resolveMissingHashes"]);
    await collector.migrate();
  }
  void migrate().catch((error) => console.error("Capture cache migration failed:", error.message));
  async function match(cards, force = false) {
    await collector.writes;
    const stored = await chrome.storage.local.get(COLLECTION_KEY);
    const { items, unknown } = matchItems(cards, stored[COLLECTION_KEY]);
    const result = await matcher.match(items, { force });
    return {
      indexState: result.indexState,
      indexRevision: result.indexRevision,
      coverage: result.coverage,
      error: result.error ?? null,
      matches: [...result.results.map((value) => ({
        modelId: value.modelId,
        versionId: value.modelVersionId,
        status: value.status
      })), ...unknown]
    };
  }
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id) return;
    const origin = civitaiUrl(sender.url)?.origin;
    const fromOptions = sender.url === chrome.runtime.getURL("options.html");
    const fromPage = origin && sender.tab && sender.frameId === 0;
    let task;
    if (message?.type === CHANNEL && fromPage) {
      if (typeof message.error === "string") task = collector.recordError(message.error);
      else if (isModelRequest(message.url) && civitaiUrl(message.url)?.origin === origin && Array.isArray(message.models) && message.models.length <= 500) task = collector.ingest(message.models, origin);
    } else if (message?.type === "swarm:check" && fromOptions) {
      task = match([], true);
    } else if (message?.type === "civitai:matches" && (fromPage || fromOptions) && Array.isArray(message.cards) && message.cards.length <= 500) {
      const cards = message.cards.filter((card) => Number.isSafeInteger(card?.modelId) && card.modelId > 0 && Number.isSafeInteger(card?.versionId) && card.versionId > 0).map((card) => ({
        modelId: card.modelId,
        versionId: card.versionId,
        modelType: normalizeModelType(card.modelType)
      }));
      task = match(cards);
    }
    if (!task) return;
    task.then((result) => {
      respond({ ok: true, ...result });
    }, (error) => {
      console.error("Civitai bridge failed:", error.message);
      respond({ ok: false, error: error.message });
    });
    return true;
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.targetUrl) matcher.invalidate();
  });
  chrome.permissions.onRemoved?.addListener(() => {
    matcher.invalidate();
  });
  chrome.action.onClicked.addListener(() => {
    void chrome.runtime.openOptionsPage();
  });

  // background.js
  var STORAGE_KEYS = {
    targetUrl: "targetUrl",
    targetTabId: "targetTabId",
    usePopupWindow: "usePopupWindow"
  };
  var SOURCE_URL_PARAM_KEY = "url";
  var DOWNLOADER_PARAM_KEY = "downloader";
  var DOWNLOADER_PARAM_VALUE = "1";
  var SWARMUI_PATH_SEGMENT = "Text2Image";
  var IN_PLACE_HASH_KEY = "swarmui-downloader";
  var MENU_ID = "send-to-swarmui";
  var MENU_TITLE = "Send to SwarmUI";
  chrome.runtime.onInstalled.addListener(() => {
    void initializeExtension();
  });
  chrome.runtime.onStartup.addListener(() => {
    void createContextMenu().catch((error) => {
      console.error("Failed to recreate context menu on startup:", error);
    });
  });
  chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId !== MENU_ID) {
      return;
    }
    const sourceUrl = getSourceUrl(info, tab);
    if (!sourceUrl) {
      console.warn("No URL available for right-click context:", info);
      return;
    }
    void handleForwardMessage(sourceUrl).catch(async (error) => {
      console.error("Failed to forward source URL:", error);
      if (shouldOpenOptionsForError(error)) {
        await chrome.runtime.openOptionsPage();
      }
    });
  });
  async function ensureDefaultSettings() {
    const { targetUrl, usePopupWindow } = await chrome.storage.local.get([
      STORAGE_KEYS.targetUrl,
      STORAGE_KEYS.usePopupWindow
    ]);
    if (!targetUrl) {
      await chrome.storage.local.set({ [STORAGE_KEYS.targetUrl]: "" });
    }
    if (typeof usePopupWindow !== "boolean") {
      await chrome.storage.local.set({ [STORAGE_KEYS.usePopupWindow]: false });
    }
  }
  async function initializeExtension() {
    try {
      await ensureDefaultSettings();
      await createContextMenu();
    } catch (error) {
      console.error("Failed to initialize extension:", error);
    }
  }
  function createContextMenu() {
    return new Promise((resolve, reject) => {
      chrome.contextMenus.removeAll(() => {
        const removeError = chrome.runtime.lastError;
        if (removeError) {
          reject(new Error(removeError.message));
          return;
        }
        chrome.contextMenus.create(
          {
            id: MENU_ID,
            title: MENU_TITLE,
            contexts: ["all"]
          },
          () => {
            const createError = chrome.runtime.lastError;
            if (createError) {
              reject(new Error(createError.message));
              return;
            }
            resolve();
          }
        );
      });
    });
  }
  function getSourceUrl(info, tab) {
    if (info.linkUrl) {
      return info.linkUrl;
    }
    if (tab?.url) {
      return tab.url;
    }
    if (info.pageUrl) {
      return info.pageUrl;
    }
    if (info.frameUrl) {
      return info.frameUrl;
    }
    return null;
  }
  function shouldOpenOptionsForError(error) {
    if (!(error instanceof Error)) {
      return false;
    }
    return error.message.includes("SwarmUI server URL");
  }
  async function handleForwardMessage(sourceUrl) {
    const { targetUrl, usePopupWindow } = await chrome.storage.local.get([
      STORAGE_KEYS.targetUrl,
      STORAGE_KEYS.usePopupWindow
    ]);
    if (!targetUrl) {
      throw new Error("Set a SwarmUI server URL in extension options before forwarding URLs.");
    }
    const forwardUrl = buildForwardUrl(targetUrl, sourceUrl);
    const tabId = await getOrCreateTargetTab(targetUrl, sourceUrl, forwardUrl, usePopupWindow === true);
    await chrome.storage.local.set({ [STORAGE_KEYS.targetTabId]: tabId });
  }
  function buildForwardUrl(targetUrl, sourceUrl) {
    const parsed = parseTargetServerUrl(targetUrl);
    parsed.pathname = buildText2ImagePath(parsed.pathname);
    parsed.search = "";
    parsed.hash = "";
    parsed.searchParams.set(DOWNLOADER_PARAM_KEY, DOWNLOADER_PARAM_VALUE);
    parsed.searchParams.set(SOURCE_URL_PARAM_KEY, sourceUrl);
    return parsed.toString();
  }
  function parseTargetServerUrl(targetUrl) {
    const parsed = tryParseHttpOrHttpsUrl(targetUrl);
    if (parsed) {
      return parsed;
    }
    const fallback = tryParseHttpOrHttpsUrl(`http://${targetUrl}`);
    if (fallback) {
      return fallback;
    }
    throw new Error("SwarmUI server URL is invalid. Update extension options.");
  }
  function tryParseHttpOrHttpsUrl(candidate) {
    try {
      const parsed = new URL(candidate);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }
  function buildText2ImagePath(currentPath) {
    const trimmed = currentPath.replace(/\/+$/, "");
    if (!trimmed || trimmed === "/") {
      return `/${SWARMUI_PATH_SEGMENT}`;
    }
    if (trimmed.endsWith(`/${SWARMUI_PATH_SEGMENT}`)) {
      return trimmed;
    }
    return `${trimmed}/${SWARMUI_PATH_SEGMENT}`;
  }
  function normalizePath(pathname) {
    let normalized = pathname.replace(/\/+$/, "");
    return normalized || "/";
  }
  function isTabOnTargetText2Image(tabUrl, targetServerUrl) {
    const current = tryParseHttpOrHttpsUrl(tabUrl);
    if (!current) {
      return false;
    }
    const target = parseTargetServerUrl(targetServerUrl);
    if (current.origin !== target.origin) {
      return false;
    }
    return normalizePath(current.pathname) === normalizePath(buildText2ImagePath(target.pathname));
  }
  function buildInPlaceHash(sourceUrl) {
    const encoded = encodeURIComponent(sourceUrl);
    return `${IN_PLACE_HASH_KEY}=${encoded}&t=${Date.now()}`;
  }
  function buildInPlaceTabUrl(existingTabUrl, sourceUrl) {
    const parsed = tryParseHttpOrHttpsUrl(existingTabUrl);
    if (!parsed) {
      return null;
    }
    parsed.hash = buildInPlaceHash(sourceUrl);
    return parsed.toString();
  }
  async function getOrCreateTargetTab(targetUrl, sourceUrl, forwardUrl, usePopupWindow) {
    const { targetTabId } = await chrome.storage.local.get(STORAGE_KEYS.targetTabId);
    if (typeof targetTabId === "number") {
      try {
        const existingTab = await chrome.tabs.get(targetTabId);
        if (isTabOnTargetText2Image(existingTab.url, targetUrl)) {
          const inPlaceUrl = buildInPlaceTabUrl(existingTab.url, sourceUrl);
          await chrome.tabs.update(targetTabId, {
            active: true,
            ...inPlaceUrl ? { url: inPlaceUrl } : {}
          });
          if (typeof existingTab.windowId === "number") {
            await chrome.windows.update(existingTab.windowId, { focused: true });
          }
        } else {
          await chrome.tabs.update(targetTabId, { url: forwardUrl, active: true });
          if (typeof existingTab.windowId === "number") {
            await chrome.windows.update(existingTab.windowId, { focused: true });
          }
        }
        return targetTabId;
      } catch {
        await chrome.storage.local.remove(STORAGE_KEYS.targetTabId);
      }
    }
    return await createTargetTab(forwardUrl, usePopupWindow === true);
  }
  async function createTargetTab(forwardUrl, usePopupWindow) {
    if (usePopupWindow) {
      const createdWindow = await chrome.windows.create({
        url: forwardUrl,
        type: "popup",
        focused: true,
        width: 1400,
        height: 1e3
      });
      const popupTabId = createdWindow.tabs?.[0]?.id;
      if (typeof popupTabId !== "number") {
        throw new Error("Unable to create popup target tab.");
      }
      return popupTabId;
    }
    const tab = await chrome.tabs.create({
      url: forwardUrl,
      active: true
    });
    if (typeof tab.id !== "number") {
      throw new Error("Unable to create target tab.");
    }
    return tab.id;
  }
})();
