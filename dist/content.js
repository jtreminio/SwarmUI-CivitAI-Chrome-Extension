(() => {
  // lib/models.js
  var CHANNEL = "civitai-swarmui:capture:v1";
  var MAX_BODY_SIZE = 8 * 1024 * 1024;
  var MODEL_TYPES = /* @__PURE__ */ new Set(["Checkpoint", "LORA", "LoCon", "DoRA"]);
  function normalizeModelType(value) {
    return typeof value === "string" ? [...MODEL_TYPES].find((type) => type.toLowerCase() === value.toLowerCase()) ?? null : null;
  }
  var PROCEDURES = /* @__PURE__ */ new Set(["model.getAll", "model.getById", "modelVersion.getById"]);
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

  // lib/matching.js
  var STATUS_LABELS = {
    downloaded: "Downloaded",
    older: "New version available",
    different: "Different version downloaded"
  };

  // content.js
  var timer;
  var running = false;
  var changed = false;
  var generation = 0;
  var descriptionId = 0;
  var presentations = /* @__PURE__ */ new Map();
  var observed = /* @__PURE__ */ new WeakMap();
  var resizeObserver = typeof ResizeObserver === "function" ? new ResizeObserver((entries) => {
    for (const entry of entries) {
      const presentation = observed.get(entry.target);
      if (presentation) positionBanner(presentation);
    }
  }) : null;
  var descriptions = {
    downloaded: "This displayed version is downloaded in your SwarmUI library.",
    older: "New version available. Your SwarmUI library has an earlier published version of this model.",
    different: "Your SwarmUI library has another version. This displayed version is not confirmed downloaded."
  };
  var modelLink = (area) => area.querySelector('a[href*="/models/"]');
  function schedule() {
    changed = true;
    clearTimeout(timer);
    timer = setTimeout(() => {
      void updateCards();
    }, 150);
  }
  function cards() {
    const found = /* @__PURE__ */ new Map();
    if (!/^\/models(?:\/|$)/.test(location.pathname)) return found;
    for (const area of document.querySelectorAll("[data-card-hover]")) {
      const link = modelLink(area);
      if (!link) continue;
      const url = new URL(link.href, location.href);
      const modelId = Number(/^\/models\/(\d+)(?:\/|$)/.exec(url.pathname)?.[1]);
      const versionId = Number(url.searchParams.get("modelVersionId"));
      if (url.origin !== location.origin || !Number.isSafeInteger(modelId) || modelId <= 0 || !Number.isSafeInteger(versionId) || versionId <= 0) continue;
      const modelType = [...area.querySelectorAll("p")].map((element) => normalizeModelType(element.textContent.trim())).find(Boolean) ?? null;
      found.set(area, { modelId, versionId, modelType });
    }
    return found;
  }
  function removePresentation(area) {
    const presentation = presentations.get(area);
    if (!presentation) return;
    const { link, frame, description, banner, outline, header } = presentation;
    link.classList.remove("swarmui-card-preview");
    const tokens = (link.getAttribute("aria-describedby") ?? "").split(/\s+/).filter((token) => token && token !== description.id);
    if (tokens.length) link.setAttribute("aria-describedby", tokens.join(" "));
    else link.removeAttribute("aria-describedby");
    frame?.classList.remove("swarmui-downloaded-frame");
    area.classList.remove("swarmui-card");
    area.removeAttribute("data-swarmui-status");
    area.removeAttribute("data-swarmui-version");
    area.style.removeProperty("--swarmui-banner-height");
    header?.classList.remove("swarmui-card-header");
    description.remove();
    banner?.remove();
    outline?.remove();
    if (banner) {
      resizeObserver?.unobserve(banner);
      observed.delete(banner);
    }
    presentations.delete(area);
  }
  function clearPresentations() {
    for (const area of presentations.keys()) removePresentation(area);
  }
  function prunePresentations(current = cards()) {
    for (const [area, presentation] of presentations) {
      const card = current.get(area);
      if (!card || presentation.key !== `${card.modelId}:${card.versionId}` || modelLink(area) !== presentation.link || area.parentElement !== presentation.frame) removePresentation(area);
    }
  }
  function positionBanner(presentation) {
    if (!presentation.banner) return;
    const { area, banner } = presentation;
    const height = banner.offsetHeight || banner.getBoundingClientRect?.().height;
    const offset = Number.isFinite(height) && height > 0 ? Math.ceil(height) : 30;
    area.style.setProperty("--swarmui-banner-height", `${offset}px`);
  }
  function present(area, card, status) {
    let presentation = presentations.get(area);
    if (!STATUS_LABELS[status]) {
      removePresentation(area);
      return;
    }
    if (presentation && presentation.status !== status) {
      removePresentation(area);
      presentation = null;
    }
    if (!presentation) {
      const link = modelLink(area);
      const description = document.createElement("span");
      do {
        description.id = `swarmui-card-status-${++descriptionId}`;
      } while (document.getElementById(description.id));
      description.className = "swarmui-card-decoration swarmui-card-description";
      description.textContent = descriptions[status];
      presentation = { area, link, frame: area.parentElement, description, status, key: `${card.modelId}:${card.versionId}` };
      if (status === "older") {
        const outline = document.createElement("span");
        outline.className = "swarmui-card-decoration swarmui-update-frame";
        outline.setAttribute("aria-hidden", "true");
        presentation.outline = outline;
      }
      if (status === "older" || status === "downloaded") {
        const banner = document.createElement("span");
        banner.className = `swarmui-card-decoration swarmui-status-banner ${status === "older" ? "swarmui-update-banner" : "swarmui-downloaded-banner"}`;
        banner.setAttribute("aria-hidden", "true");
        const arrow = document.createElement("span");
        arrow.className = "swarmui-status-icon";
        arrow.textContent = status === "older" ? "\u2191" : "\u2713";
        const text = document.createElement("span");
        text.textContent = status === "older" ? "New version available" : "Downloaded";
        banner.append(arrow, text);
        presentation.banner = banner;
      }
      presentations.set(area, presentation);
      if (presentation.banner) {
        observed.set(presentation.banner, presentation);
        resizeObserver?.observe(presentation.banner);
      }
    }
    area.classList.add("swarmui-card");
    area.dataset.swarmuiStatus = status;
    area.dataset.swarmuiVersion = presentation.key;
    if (status === "downloaded") {
      presentation.link.classList.add("swarmui-card-preview");
      presentation.frame?.classList.add("swarmui-downloaded-frame");
    }
    const tokens = new Set((presentation.link.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean));
    tokens.add(presentation.description.id);
    presentation.link.setAttribute("aria-describedby", [...tokens].join(" "));
    for (const element of [presentation.description, presentation.outline, presentation.banner]) {
      if (element && element.parentElement !== area) area.append(element);
    }
    if (presentation.banner) {
      const header = area.querySelector(':scope > [class*="_header"]');
      if (header !== presentation.header) {
        presentation.header?.classList.remove("swarmui-card-header");
        presentation.header = header;
      }
      header?.classList.add("swarmui-card-header");
    }
    positionBanner(presentation);
  }
  async function updateCards() {
    const current = cards();
    prunePresentations(current);
    if (running) return;
    running = true;
    changed = false;
    const requestGeneration = generation;
    try {
      if (!current.size) return;
      const pending = [...new Map([...current.values()].map((card) => [`${card.modelId}:${card.versionId}`, card])).values()];
      const statuses = /* @__PURE__ */ new Map();
      for (let index = 0; index < pending.length; index += 500) {
        const response = await chrome.runtime.sendMessage({ type: "civitai:matches", cards: pending.slice(index, index + 500) });
        if (requestGeneration !== generation) return;
        if (!response?.ok || response.error || response.indexState === "unavailable") {
          clearPresentations();
          return;
        }
        for (const match of response.matches) statuses.set(`${match.modelId}:${match.versionId}`, match.status);
      }
      const latest = cards();
      prunePresentations(latest);
      for (const [area, card] of latest) present(area, card, statuses.get(`${card.modelId}:${card.versionId}`));
    } catch {
      clearPresentations();
    } finally {
      running = false;
      if (changed) schedule();
    }
  }
  var observer = new MutationObserver((mutations) => {
    const relevant = mutations.some((mutation) => !mutation.target.closest?.(".swarmui-card-decoration") && (mutation.type === "attributes" || [...mutation.addedNodes, ...mutation.removedNodes].some((node) => node.nodeType === 1 && !node.matches(".swarmui-card-decoration"))));
    if (relevant) {
      prunePresentations();
      schedule();
    }
  });
  observer.observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ["href"] });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.targetUrl) {
      generation++;
      clearPresentations();
    }
    if (changes.civitaiCollection || changes.targetUrl || changes.swarmIndexRefresh) schedule();
  });
  window.addEventListener("popstate", () => {
    prunePresentations();
    schedule();
  });
  window.addEventListener("resize", schedule);
  setInterval(schedule, 3e4);
  schedule();
  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== location.origin || event.data?.channel !== CHANNEL) return;
    const { models, url, error } = event.data;
    if (!error && (!isModelRequest(url) || !Array.isArray(models) || models.length > 500)) return;
    try {
      void chrome.runtime.sendMessage({ type: CHANNEL, models, url, error }).then(schedule).catch(() => {
      });
    } catch {
    }
  });
})();
