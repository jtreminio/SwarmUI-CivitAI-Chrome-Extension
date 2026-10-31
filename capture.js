import { CHANNEL, MAX_BODY_SIZE, extractModels, isModelRequest, isModelsPage } from './lib/models.js';

// Runs before Civitai scripts, in MAIN, so it can observe response bodies.
(() => {
  const marker = Symbol.for(CHANNEL);
  if (window[marker]) return;
  window[marker] = true;
  const originalFetch = window.fetch;
  const postMessage = window.postMessage.bind(window);

  function requestUrl(input) {
    try { return new URL(typeof input === 'string' || input instanceof URL ? input : input.url, location.href).href; }
    catch { return ''; }
  }

  function emit(body, url) {
    try {
      const models = extractModels(body, url);
      if (models.length) postMessage({ channel: CHANNEL, url: new URL(url).origin + new URL(url).pathname, models }, location.origin);
    } catch (error) {
      postMessage({ channel: CHANNEL, error: `Could not parse model response: ${error.message}`.slice(0, 300) }, location.origin);
    }
  }

  async function observe(response, url) {
    const clone = response.clone();
    const reader = clone.body?.getReader();
    if (!reader) return;
    const chunks = [];
    let length = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BODY_SIZE) {
        void reader.cancel().catch(() => {});
        throw new Error('Model response exceeds 8 MiB.');
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    emit(new TextDecoder().decode(bytes), url);
  }

  window.fetch = function (...args) {
    const url = requestUrl(args[0]);
    const capture = isModelsPage(location.href) && isModelRequest(url);
    const promise = Reflect.apply(originalFetch, this, args);
    if (capture) {
      // Side branch only: return the original promise/response without consuming it.
      void promise.then(response => {
        if (response.ok) return observe(response, url);
      }).catch(error => {
        postMessage({ channel: CHANNEL, error: `Model capture failed: ${error.message}`.slice(0, 300) }, location.origin);
      });
    }
    return promise;
  };

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  const urls = new WeakMap();
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    urls.set(this, requestUrl(url));
    return Reflect.apply(originalOpen, this, [method, url, ...rest]);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    const url = urls.get(this);
    if (isModelsPage(location.href) && isModelRequest(url)) {
      this.addEventListener('loadend', () => {
        if (this.status < 200 || this.status >= 300) return;
        if (this.responseType === 'json') emit(this.response, url);
        else if (!this.responseType || this.responseType === 'text') emit(this.responseText, url);
      }, { once: true });
    }
    return Reflect.apply(originalSend, this, args);
  };
})();
