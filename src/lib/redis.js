import { Redis } from "@upstash/redis";

// Redis cache is explicitly disabled per instructions: all data will be fetched directly from MongoDB
export const REDIS_ENABLED = process.env.ENABLE_REDIS === "true";

let client = null;
if (REDIS_ENABLED && process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
  try {
    client = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    });
    console.log("🚀 Upstash Redis (REST) Client Initialized");
  } catch (err) {
    console.warn("⚠️ Redis initialization failed, running in direct DB mode:", err.message);
    client = null;
  }
} else {
  console.log("ℹ️ Redis caching is DISABLED. Direct database querying is active.");
}

const PREFIX = "click2kart";

/**
 * Get or set cache helper - when Redis is disabled, executes callback directly against DB
 */
export const getOrSetCache = async (key, cb, ttl = 3600) => {
  if (!REDIS_ENABLED || !client) {
    return await cb();
  }
  const fullKey = `${PREFIX}:${key}`;
  try {
    const cachedValue = await client.get(fullKey);
    if (cachedValue) {
      return typeof cachedValue === "string" ? JSON.parse(cachedValue) : cachedValue;
    }
    const freshData = await cb();
    if (freshData !== undefined && freshData !== null) {
      await client.set(fullKey, JSON.stringify(freshData), { ex: ttl });
    }
    return freshData;
  } catch (error) {
    return await cb(); // Fallback to DB
  }
};

/**
 * Delete cache key(s) or patterns
 */
export const delCache = async (keys) => {
  if (!REDIS_ENABLED || !client) return;
  try {
    const prepareKey = (k) => (k.startsWith(PREFIX) ? k : `${PREFIX}:${k}`);

    if (Array.isArray(keys)) {
      const keysToDelete = [];
      for (const key of keys) {
        const fullKey = prepareKey(key);
        if (fullKey.includes("*")) {
          const matchingKeys = await client.keys(fullKey);
          if (matchingKeys.length > 0) keysToDelete.push(...matchingKeys);
        } else {
          keysToDelete.push(fullKey);
        }
      }
      if (keysToDelete.length > 0) await client.del(...keysToDelete);
    } else {
      const fullKey = prepareKey(keys);
      if (fullKey.includes("*")) {
        const matchingKeys = await client.keys(fullKey);
        if (matchingKeys.length > 0) await client.del(...matchingKeys);
      } else {
        await client.del(fullKey);
      }
    }
  } catch (error) {
    console.error("Redis Delete Error:", error);
  }
};

/**
 * Get current version of a cache namespace
 */
export const getCacheVersion = async (namespace) => {
  if (!REDIS_ENABLED || !client) return "1";
  try {
    const version = await client.get(`${PREFIX}:version:${namespace}`);
    return version || "1";
  } catch {
    return "1";
  }
};

/**
 * Increment version of a cache namespace
 */
export const bumpCacheVersion = async (namespace) => {
  if (!REDIS_ENABLED || !client) return;
  try {
    await client.incr(`${PREFIX}:version:${namespace}`);
  } catch (error) {
    console.error(`Redis bump version error for ${namespace}:`, error);
  }
};

// No-op for connectRedis as Upstash REST is stateless
export const connectRedis = async () => {};

/**
 * Rate limiting logic
 */
export const incrRateLimit = async (key) => {
  if (!REDIS_ENABLED || !client) return 1;
  return await client.incr(key);
};

export const expireRateLimit = async (key, seconds) => {
  if (!REDIS_ENABLED || !client) return 1;
  return await client.expire(key, seconds);
};

export const ttlRateLimit = async (key) => {
  if (!REDIS_ENABLED || !client) return 60;
  return await client.ttl(key);
};

/**
 * Get Cache Metrics (Hits/Misses)
 */
export const getCacheMetrics = async () => {
  if (!REDIS_ENABLED || !client) {
    return { hits: 0, misses: 0, hitRate: "0% (Redis Disabled - Direct DB Mode)" };
  }
  try {
    const [hits, misses] = await client.mget(
      `${PREFIX}:metrics:hits`,
      `${PREFIX}:metrics:misses`
    );
    return {
      hits: parseInt(hits || 0),
      misses: parseInt(misses || 0),
      hitRate: hits ? ((parseInt(hits) / (parseInt(hits) + parseInt(misses || 0))) * 100).toFixed(2) + "%" : "0%"
    };
  } catch (error) {
    console.error("Error fetching metrics:", error);
    return { hits: 0, misses: 0, hitRate: "0%" };
  }
};

export default client;
