/**
 * Lightweight in-memory cache for Next.js API routes (server-side only).
 *
 * Eliminates redundant Neptune Gremlin queries from the trend management
 * dashboard, which triggers /api/graph/trends, /countries, /cities on every
 * page load and filter change.
 *
 * - Per-key TTL with stale eviction on read
 * - Manual invalidation by prefix (e.g. invalidate("trends") clears all
 *   trend-related entries)
 * - Size cap to prevent unbounded memory growth
 */

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

const MAX_ENTRIES = 200;

const store = new Map<string, CacheEntry<unknown>>();

export function cacheGet<T>(key: string): T | undefined {
  const entry = store.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    store.delete(key);
    return undefined;
  }
  return entry.data as T;
}

export function cacheSet<T>(key: string, data: T, ttlMs: number): void {
  // Evict oldest entries if at capacity
  if (store.size >= MAX_ENTRIES) {
    const firstKey = store.keys().next().value;
    if (firstKey !== undefined) store.delete(firstKey);
  }
  store.set(key, { data, expiresAt: Date.now() + ttlMs });
}

/**
 * Delete all entries whose key starts with `prefix`.
 * Returns number of deleted entries.
 */
export function cacheInvalidate(prefix: string): number {
  let deleted = 0;
  for (const key of [...store.keys()]) {
    if (key.startsWith(prefix)) {
      store.delete(key);
      deleted++;
    }
  }
  return deleted;
}

// TTL presets (milliseconds)
export const TTL = {
  STATIC: 60 * 60 * 1000,      // 1h  — countries, cities, regions, attractions, hotels, routes
  SEMI_STATIC: 30 * 60 * 1000, // 30m — package list, package detail
  TRENDS: 5 * 60 * 1000,       // 5m  — trends (refreshed often, invalidated on collect)
} as const;
