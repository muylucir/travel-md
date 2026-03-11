/**
 * Valkey (Redis-compatible) caching layer for Next.js API routes.
 *
 * Two-tier cache:
 *   L1 = in-memory (api-cache.ts) — per-process, instant
 *   L2 = Valkey (ElastiCache Serverless) — shared, survives restarts
 *
 * Circuit-breaker: on connection failure, backs off exponentially
 * (5s → 60s cap) instead of blocking requests. Always fails open.
 */

import Redis from "ioredis";

const VALKEY_HOST =
  process.env.REDIS_HOST ||
  "REDACTED_VALKEY_HOST";
const VALKEY_PORT = parseInt(process.env.REDIS_PORT || "6379", 10);

// TTL presets (seconds)
export const ValkeyTTL = {
  GRAPH_STATIC: 60 * 60,     // 1h  — full graph visualization
  GRAPH_SEMI: 30 * 60,       // 30m — neighbors, package subgraph
  STATIC: 60 * 60,           // 1h  — countries, cities, regions
  SEMI_STATIC: 30 * 60,      // 30m — packages
  TRENDS: 5 * 60,            // 5m  — trends
} as const;

// ---------------------------------------------------------------------------
// Singleton client with circuit-breaker
// ---------------------------------------------------------------------------

let client: Redis | null = null;
let disabledUntil = 0;
let consecutiveFailures = 0;

const BACKOFF_BASE = 5_000;  // 5s
const BACKOFF_MAX = 60_000;  // 60s

function getBackoff(): number {
  return Math.min(BACKOFF_BASE * 2 ** (consecutiveFailures - 1), BACKOFF_MAX);
}

function getClient(): Redis | null {
  if (client) return client;

  const now = Date.now();
  if (now < disabledUntil) return null;

  try {
    const newClient = new Redis({
      host: VALKEY_HOST,
      port: VALKEY_PORT,
      tls: {},
      connectTimeout: 3000,
      commandTimeout: 2000,
      maxRetriesPerRequest: 1,
      lazyConnect: false,
      enableOfflineQueue: false,
    });

    newClient.on("error", (err) => {
      console.warn("[Valkey] Connection error:", err.message);
      resetClient();
    });

    client = newClient;
    if (consecutiveFailures > 0) {
      console.log(
        `[Valkey] Reconnected after ${consecutiveFailures} failure(s)`
      );
    }
    consecutiveFailures = 0;
    disabledUntil = 0;
    return client;
  } catch (err) {
    consecutiveFailures++;
    const backoff = getBackoff();
    disabledUntil = Date.now() + backoff;
    console.warn(
      `[Valkey] Connect failed (#${consecutiveFailures}), retry in ${backoff}ms:`,
      err instanceof Error ? err.message : err
    );
    return null;
  }
}

function resetClient(): void {
  const old = client;
  client = null;
  if (old) {
    try {
      old.disconnect();
    } catch {
      // ignore
    }
  }
  consecutiveFailures++;
  const backoff = getBackoff();
  disabledUntil = Date.now() + backoff;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const KEY_PREFIX = "web:";

/**
 * Get a cached value from Valkey. Returns undefined on miss or error.
 */
export async function valkeyGet<T>(key: string): Promise<T | undefined> {
  const c = getClient();
  if (!c) return undefined;

  try {
    const raw = await c.get(KEY_PREFIX + key);
    if (raw === null) return undefined;
    return JSON.parse(raw) as T;
  } catch (err) {
    console.warn("[Valkey] GET error:", err instanceof Error ? err.message : err);
    return undefined;
  }
}

/**
 * Set a cached value in Valkey with TTL in seconds.
 */
export async function valkeySet<T>(
  key: string,
  data: T,
  ttlSeconds: number
): Promise<void> {
  const c = getClient();
  if (!c) return;

  try {
    const serialized = JSON.stringify(data);
    await c.setex(KEY_PREFIX + key, ttlSeconds, serialized);
  } catch (err) {
    console.warn("[Valkey] SET error:", err instanceof Error ? err.message : err);
  }
}

/**
 * Delete all keys matching a prefix pattern. Returns deleted count.
 */
export async function valkeyInvalidate(prefix: string): Promise<number> {
  const c = getClient();
  if (!c) return 0;

  try {
    const pattern = KEY_PREFIX + prefix + "*";
    let deleted = 0;
    let cursor = "0";
    do {
      const [nextCursor, keys] = await c.scan(cursor, "MATCH", pattern, "COUNT", 100);
      cursor = nextCursor;
      if (keys.length > 0) {
        deleted += await c.del(...keys);
      }
    } while (cursor !== "0");
    return deleted;
  } catch (err) {
    console.warn("[Valkey] INVALIDATE error:", err instanceof Error ? err.message : err);
    return 0;
  }
}
