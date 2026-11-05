'use strict';

/**
 * Simple in-memory TTL cache for a single Hostinger Node process.
 */
class TtlCache {
  constructor() {
    this.store = new Map();
  }

  get(key) {
    const entry = this.store.get(key);
    if (!entry) return null;
    const age = Date.now() - entry.storedAt;
    return {
      value: entry.value,
      storedAt: entry.storedAt,
      ageMs: age,
      stale: age > entry.ttlMs,
      ttlMs: entry.ttlMs,
    };
  }

  set(key, value, ttlMs) {
    this.store.set(key, { value, storedAt: Date.now(), ttlMs });
    return value;
  }

  /**
   * Return fresh cache or fetch+store. On fetch failure, return stale if present.
   */
  async getOrFetch(key, ttlMs, fetcher) {
    const hit = this.get(key);
    if (hit && !hit.stale) {
      return { data: hit.value, cached: true, storedAt: hit.storedAt, ageMs: hit.ageMs };
    }
    try {
      const value = await fetcher();
      this.set(key, value, ttlMs);
      return { data: value, cached: false, storedAt: Date.now(), ageMs: 0 };
    } catch (err) {
      if (hit) {
        return {
          data: hit.value,
          cached: true,
          stale: true,
          storedAt: hit.storedAt,
          ageMs: hit.ageMs,
          error: err.message,
        };
      }
      throw err;
    }
  }
}

const cache = new TtlCache();

module.exports = { cache, TtlCache };
