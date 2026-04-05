/**
 * CACHE — Simple in-memory TTL cache for expensive repetitive operations.
 * 
 * Used to avoid redundant DB queries and LLM calls across:
 * - Brain context building (same lead context re-fetched within minutes)
 * - Pattern analysis (aggregated stats don't change per-request)
 * - Conversation history (same lead's history fetched by multiple modules)
 * - Research data (doesn't change between follow-up cycles)
 * - Lookback results (already-analyzed leads marked via DB, but cache prevents even the query)
 */

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

class TTLCache<T = any> {
  private store = new Map<string, CacheEntry<T>>();
  private readonly defaultTtlMs: number;
  private readonly maxSize: number;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(defaultTtlMs: number = 5 * 60 * 1000, maxSize: number = 500) {
    this.defaultTtlMs = defaultTtlMs;
    this.maxSize = maxSize;
    // Periodic cleanup every 5 minutes
    this.cleanupTimer = setInterval(() => this.cleanup(), 5 * 60 * 1000);
  }

  get(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T, ttlMs?: number): void {
    // Evict oldest entries if at capacity
    if (this.store.size >= this.maxSize) {
      const firstKey = this.store.keys().next().value;
      if (firstKey) this.store.delete(firstKey);
    }
    this.store.set(key, {
      value,
      expiresAt: Date.now() + (ttlMs ?? this.defaultTtlMs),
    });
  }

  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  invalidate(key: string): void {
    this.store.delete(key);
  }

  invalidatePrefix(prefix: string): void {
    const keys = Array.from(this.store.keys());
    for (const key of keys) {
      if (key.startsWith(prefix)) this.store.delete(key);
    }
  }

  clear(): void {
    this.store.clear();
  }

  get size(): number {
    return this.store.size;
  }

  private cleanup(): void {
    const now = Date.now();
    const entries = Array.from(this.store.entries());
    for (const [key, entry] of entries) {
      if (now > entry.expiresAt) this.store.delete(key);
    }
  }

  destroy(): void {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.store.clear();
  }
}

// --- Shared cache instances ---

/** Brain context cache — 5 min TTL (context doesn't change that fast) */
export const contextCache = new TTLCache(5 * 60 * 1000, 200);

/** Conversation history cache — 2 min TTL (new messages can arrive) */
export const conversationCache = new TTLCache(2 * 60 * 1000, 300);

/** Pattern analysis cache — 10 min TTL (aggregated stats are slow-moving) */
export const patternCache = new TTLCache(10 * 60 * 1000, 50);

/** Research data cache — 30 min TTL (research rarely changes) */
export const researchCache = new TTLCache(30 * 60 * 1000, 200);

/** General-purpose cache for misc operations */
export const generalCache = new TTLCache(5 * 60 * 1000, 100);

// --- Cache-wrapped helper ---

/**
 * Execute a function with caching. Returns cached value if available,
 * otherwise runs the function and caches the result.
 */
export async function cached<T>(
  cache: TTLCache<T>,
  key: string,
  fn: () => Promise<T>,
  ttlMs?: number
): Promise<T> {
  const existing = cache.get(key);
  if (existing !== undefined) return existing;
  const result = await fn();
  cache.set(key, result, ttlMs);
  return result;
}

export { TTLCache };
