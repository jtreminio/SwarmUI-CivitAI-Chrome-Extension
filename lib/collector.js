import { mergeRecord, sanitizeRecord } from './models.js';

export const COLLECTION_KEY = 'civitaiCollection';
const DAY = 24 * 60 * 60_000;
const emptyCollection = () => ({ schemaVersion: 2, models: {}, responseCount: 0, lastCaptureAt: null, lastError: null });

// Passive capture only. Civitai identity resolution belongs to WhatTheDuck.
export class Collector {
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
        return index < 2000 && bytes < 6 * 1024 * 1024 && this.now() - record.lastSeen < 30 * DAY;
      }).map(record => [record.modelId, record]));
      await this.storage.set({ [COLLECTION_KEY]: collection });
      return result;
    });
    this.writes = write.catch(() => {});
    return write;
  }

  async migrate() {
    const stored = await this.storage.get(COLLECTION_KEY);
    if (stored[COLLECTION_KEY]?.schemaVersion === 2) return;
    return this.update(() => {});
  }

  async ingest(records, origin) {
    await this.update(collection => {
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
    await this.update(collection => { collection.lastError = String(message).slice(0, 300); });
  }
}
