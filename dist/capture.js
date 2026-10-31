(() => {
  // node_modules/devalue/src/constants.js
  var UNDEFINED = -1;
  var HOLE = -2;
  var NAN = -3;
  var POSITIVE_INFINITY = -4;
  var NEGATIVE_INFINITY = -5;
  var NEGATIVE_ZERO = -6;
  var SPARSE = -7;
  var MAX_ARRAY_LEN = 2 ** 32 - 1;
  var MAX_ARRAY_INDEX = MAX_ARRAY_LEN - 1;

  // node_modules/devalue/src/utils.js
  function is_valid_array_index(n) {
    if (!Number.isInteger(n)) return false;
    if (n < 0) return false;
    if (n > MAX_ARRAY_INDEX) return false;
    return true;
  }
  function is_valid_array_len(n) {
    if (!Number.isInteger(n)) return false;
    if (n < 0) return false;
    if (n > MAX_ARRAY_LEN) return false;
    return true;
  }

  // node_modules/devalue/src/base64.js
  function decode_native(base64) {
    return Uint8Array.fromBase64(base64).buffer;
  }
  function decode_buffer(base64) {
    return Uint8Array.from(Buffer.from(base64, "base64")).buffer;
  }
  function decode_legacy(base64) {
    const binary_string = atob(base64);
    const len = binary_string.length;
    const array = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      array[i] = binary_string.charCodeAt(i);
    }
    return array.buffer;
  }
  var native = typeof Uint8Array.fromBase64 === "function";
  var buffer = typeof process === "object" && process.versions?.node !== void 0;
  var decode64 = native ? decode_native : buffer ? decode_buffer : decode_legacy;

  // node_modules/devalue/src/operations.js
  function merge_operations(defaults, overrides) {
    if (!overrides) return defaults;
    const merged = (
      /** @type {T} */
      {}
    );
    for (
      const key of
      /** @type {(keyof T)[]} */
      Object.keys(defaults)
    ) {
      merged[key] = overrides[key] ?? defaults[key];
    }
    return merged;
  }
  var array_buffer_byte_length = Object.getOwnPropertyDescriptor(
    ArrayBuffer.prototype,
    "byteLength"
  ).get;
  var shared_array_buffer_byte_length = typeof SharedArrayBuffer === "undefined" ? void 0 : Object.getOwnPropertyDescriptor(SharedArrayBuffer.prototype, "byteLength").get;
  var parse_operations = {
    fromPrimitive: (primitive) => primitive,
    fromISOString: (iso) => new Date(iso),
    fromStringValue: (tag, text) => {
      if (tag === "URL") return new URL(text);
      if (tag === "URLSearchParams") return new URLSearchParams(text);
      return Temporal[tag.slice(9)].from(text);
    },
    fromArrayBuffer: (buffer2) => buffer2,
    fromRegExpInfo: (source, flags) => new RegExp(source, flags),
    fromViewInfo: (tag, buffer2, byteOffset, length) => {
      try {
        array_buffer_byte_length.call(buffer2);
      } catch (error) {
        if (!shared_array_buffer_byte_length) throw error;
        shared_array_buffer_byte_length.call(buffer2);
      }
      const Constructor = (
        /** @type {any} */
        globalThis[tag]
      );
      return byteOffset !== void 0 ? new Constructor(buffer2, byteOffset, length) : new Constructor(buffer2);
    },
    box: (value) => Object(value),
    createArray: (length) => new Array(length),
    createSparseArray: (length) => {
      const array = [];
      array[MAX_ARRAY_INDEX] = void 0;
      delete array[MAX_ARRAY_INDEX];
      array.length = length;
      return array;
    },
    createObject: () => ({}),
    createNullPrototypeObject: () => /* @__PURE__ */ Object.create(null),
    createSet: () => /* @__PURE__ */ new Set(),
    createMap: () => /* @__PURE__ */ new Map(),
    set: (target, key, value) => {
      target[key] = value;
    },
    addValue: (set, value) => {
      set.add(value);
    },
    addEntry: (map, key, value) => {
      map.set(key, value);
    }
  };
  var default_parse_operations = /* @__PURE__ */ Object.freeze(parse_operations);

  // node_modules/devalue/src/parse.js
  function parse(serialized, revivers, options) {
    return unflatten(JSON.parse(serialized), revivers, options);
  }
  function unflatten(parsed, revivers, options) {
    const ops = merge_operations(default_parse_operations, options?.operations);
    if (typeof parsed === "number") return hydrate(parsed, true);
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error("Invalid input");
    }
    const values = (
      /** @type {any[]} */
      parsed
    );
    const hydrated = Array(values.length);
    let hydrating = null;
    function hydrate(index, standalone = false) {
      if (index === UNDEFINED) return ops.fromPrimitive(void 0);
      if (index === NAN) return ops.fromPrimitive(NaN);
      if (index === POSITIVE_INFINITY) return ops.fromPrimitive(Infinity);
      if (index === NEGATIVE_INFINITY) return ops.fromPrimitive(-Infinity);
      if (index === NEGATIVE_ZERO) return ops.fromPrimitive(-0);
      if (standalone || typeof index !== "number") {
        throw new Error(`Invalid input`);
      }
      if (index in hydrated) return hydrated[index];
      if (index >= values.length) {
        throw new Error(`Invalid input`);
      }
      const value = values[index];
      if (!value || typeof value !== "object") {
        hydrated[index] = ops.fromPrimitive(value);
      } else if (Array.isArray(value)) {
        if (typeof value[0] === "string") {
          const type = value[0];
          const reviver = revivers && Object.hasOwn(revivers, type) ? revivers[type] : void 0;
          if (reviver) {
            let i = value[1];
            if (typeof i !== "number") {
              i = values.push(value[1]) - 1;
            }
            if (Object.hasOwn(hydrated, i)) {
              return hydrated[index] = reviver(hydrated[i]);
            }
            hydrating ??= /* @__PURE__ */ new Set();
            if (hydrating.has(i)) {
              throw new Error("Invalid circular reference");
            }
            hydrating.add(i);
            hydrated[index] = reviver(hydrate(i));
            hydrating.delete(i);
            return hydrated[index];
          }
          switch (type) {
            case "Date":
              hydrated[index] = ops.fromISOString(value[1]);
              break;
            case "Set":
              const set = ops.createSet();
              hydrated[index] = set;
              for (let i = 1; i < value.length; i += 1) {
                ops.addValue(set, hydrate(value[i]));
              }
              break;
            case "Map":
              const map = ops.createMap();
              hydrated[index] = map;
              for (let i = 1; i < value.length; i += 2) {
                ops.addEntry(map, hydrate(value[i]), hydrate(value[i + 1]));
              }
              break;
            case "RegExp":
              hydrated[index] = ops.fromRegExpInfo(value[1], value[2]);
              break;
            case "Object": {
              const wrapped_index = value[1];
              if (typeof values[wrapped_index] === "object" && values[wrapped_index][0] !== "BigInt") {
                throw new Error("Invalid input");
              }
              hydrated[index] = ops.box(hydrate(wrapped_index));
              break;
            }
            case "BigInt":
              hydrated[index] = ops.fromPrimitive(BigInt(value[1]));
              break;
            case "null":
              const obj = ops.createNullPrototypeObject();
              hydrated[index] = obj;
              for (let i = 1; i < value.length; i += 2) {
                const key = value[i];
                if (typeof key !== "string") {
                  throw new Error("Cannot parse an object with a non-string key");
                }
                if (key === "__proto__") {
                  throw new Error("Cannot parse an object with a `__proto__` property");
                }
                ops.set(obj, key, hydrate(value[i + 1]));
              }
              break;
            case "Int8Array":
            case "Uint8Array":
            case "Uint8ClampedArray":
            case "Int16Array":
            case "Uint16Array":
            case "Float16Array":
            case "Int32Array":
            case "Uint32Array":
            case "Float32Array":
            case "Float64Array":
            case "BigInt64Array":
            case "BigUint64Array":
            case "DataView": {
              if (values[value[1]][0] !== "ArrayBuffer") {
                throw new Error("Invalid data");
              }
              const buffer2 = hydrate(value[1]);
              hydrated[index] = ops.fromViewInfo(type, buffer2, value[2], value[3]);
              break;
            }
            case "ArrayBuffer": {
              const base64 = value[1];
              if (typeof base64 !== "string") {
                throw new Error("Invalid ArrayBuffer encoding");
              }
              hydrated[index] = ops.fromArrayBuffer(decode64(base64));
              break;
            }
            case "URL":
            case "URLSearchParams":
            case "Temporal.Duration":
            case "Temporal.Instant":
            case "Temporal.PlainDate":
            case "Temporal.PlainTime":
            case "Temporal.PlainDateTime":
            case "Temporal.PlainMonthDay":
            case "Temporal.PlainYearMonth":
            case "Temporal.ZonedDateTime": {
              hydrated[index] = ops.fromStringValue(type, value[1]);
              break;
            }
            default:
              throw new Error(`Unknown type ${type}`);
          }
        } else if (value[0] === SPARSE) {
          const len = value[1];
          if (!is_valid_array_len(len)) {
            throw new Error("Invalid input");
          }
          const array = ops.createSparseArray(len);
          hydrated[index] = array;
          for (let i = 2; i < value.length; i += 2) {
            const idx = value[i];
            if (!is_valid_array_index(idx) || idx >= len) {
              throw new Error("Invalid input");
            }
            ops.set(array, idx, hydrate(value[i + 1]));
          }
        } else {
          const array = ops.createArray(value.length);
          hydrated[index] = array;
          for (let i = 0; i < value.length; i += 1) {
            const n = value[i];
            if (n === HOLE) continue;
            ops.set(array, i, hydrate(n));
          }
        }
      } else {
        const object = ops.createObject();
        hydrated[index] = object;
        for (const key of Object.keys(value)) {
          if (key === "__proto__") {
            throw new Error("Cannot parse an object with a `__proto__` property");
          }
          ops.set(object, key, hydrate(value[key]));
        }
      }
      return hydrated[index];
    }
    return hydrate(0);
  }

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
  function isModelsPage(value) {
    const url = civitaiUrl(value);
    return !!url && /^\/models(?:\/|$)/.test(url.pathname);
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
  function extractModel(model) {
    const isVersion = id(model?.modelId) && model?.model;
    const modelId = id(isVersion ? model.modelId : model?.id);
    const type = normalizeModelType(isVersion ? model.model.type : model?.type);
    if (!modelId || !MODEL_TYPES.has(type)) return null;
    const versions = isVersion ? [model] : Array.isArray(model.modelVersions) ? model.modelVersions : model.version ? [model.version] : [];
    const hashes = [];
    for (const value of Array.isArray(model.hashes) ? model.hashes : []) {
      const hash = normalizeHash("SHA256", value);
      if (hash) hashes.push({ ...hash, modelVersionId: null, fileId: null, source: "listing" });
    }
    for (const version of versions) {
      if (!id(version?.id)) continue;
      for (const file of Array.isArray(version.files) ? version.files : []) {
        if (!["Model", "Pruned Model"].includes(file?.type)) continue;
        const pairs = Array.isArray(file.hashes) ? file.hashes.map((hash) => [hash?.type, hash?.hash]) : Object.entries(file.hashes ?? {});
        for (const [algorithm, value] of pairs) {
          const hash = normalizeHash(algorithm, value);
          if (hash) hashes.push({ ...hash, modelVersionId: version.id, fileId: id(file.id), source: "file" });
        }
      }
    }
    return {
      modelId,
      name: label(isVersion ? model.model.name : model.name),
      type,
      displayedVersionId: id(model.version?.id) ?? (isVersion ? id(model.id) : null),
      versions: versions.filter((version) => id(version?.id)).map(versionInfo),
      versionDetailsComplete: Array.isArray(model.modelVersions) && model.modelVersions.every((version) => Array.isArray(version.files)),
      hashes: uniqueHashes(hashes)
    };
  }
  function decodeData(data) {
    if (typeof data === "string") return parse(data);
    if (data && Object.hasOwn(data, "json")) return data.json;
    return data;
  }
  function extractModels(body, requestUrl) {
    if (!isModelRequest(requestUrl)) return [];
    if (typeof body === "string" && body.length > MAX_BODY_SIZE) throw new Error("Model response exceeds 8 MiB.");
    const payload = typeof body === "string" ? JSON.parse(body) : body;
    const url = new URL(requestUrl);
    let results;
    if (url.pathname.startsWith("/api/trpc/")) {
      const procedures = url.pathname.slice("/api/trpc/".length).split(",");
      const envelopes = Array.isArray(payload) ? payload : [payload];
      results = envelopes.flatMap((envelope, index) => {
        if (!PROCEDURES.has(procedures[index]) || !envelope?.result) return [];
        return [decodeData(envelope.result.data)];
      });
    } else {
      results = [payload];
    }
    const models = results.flatMap((data) => Array.isArray(data?.items) ? data.items : [data]).map(extractModel).filter(Boolean);
    return [...new Map(models.map((model) => [model.modelId, model])).values()];
  }

  // capture.js
  (() => {
    const marker = Symbol.for(CHANNEL);
    if (window[marker]) return;
    window[marker] = true;
    const originalFetch = window.fetch;
    const postMessage = window.postMessage.bind(window);
    function requestUrl(input) {
      try {
        return new URL(typeof input === "string" || input instanceof URL ? input : input.url, location.href).href;
      } catch {
        return "";
      }
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
          void reader.cancel().catch(() => {
          });
          throw new Error("Model response exceeds 8 MiB.");
        }
        chunks.push(value);
      }
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      emit(new TextDecoder().decode(bytes), url);
    }
    window.fetch = function(...args) {
      const url = requestUrl(args[0]);
      const capture = isModelsPage(location.href) && isModelRequest(url);
      const promise = Reflect.apply(originalFetch, this, args);
      if (capture) {
        void promise.then((response) => {
          if (response.ok) return observe(response, url);
        }).catch((error) => {
          postMessage({ channel: CHANNEL, error: `Model capture failed: ${error.message}`.slice(0, 300) }, location.origin);
        });
      }
      return promise;
    };
    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;
    const urls = /* @__PURE__ */ new WeakMap();
    XMLHttpRequest.prototype.open = function(method, url, ...rest) {
      urls.set(this, requestUrl(url));
      return Reflect.apply(originalOpen, this, [method, url, ...rest]);
    };
    XMLHttpRequest.prototype.send = function(...args) {
      const url = urls.get(this);
      if (isModelsPage(location.href) && isModelRequest(url)) {
        this.addEventListener("loadend", () => {
          if (this.status < 200 || this.status >= 300) return;
          if (this.responseType === "json") emit(this.response, url);
          else if (!this.responseType || this.responseType === "text") emit(this.responseText, url);
        }, { once: true });
      }
      return Reflect.apply(originalSend, this, args);
    };
  })();
})();
