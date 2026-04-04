import { Redis } from "@upstash/redis";

const client = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const PREFIX = "click2kart";

// Log connection (Upstash REST is stateless, so we just log configuration)
console.log("Upstash Redis (REST) Client Initialized");

/**
 * Get or set cache helper with prefix and logging
 */
export const getOrSetCache = async (key, cb, ttl = 3600) => {
  const fullKey = `${PREFIX}:${key}`;
  try {
    const cachedValue = await client.get(fullKey);
    
    if (cachedValue) {
      console.log(`🚀 [CACHE HIT]: ${fullKey}`);
      // Upstash SDK handles JSON automatically if it was stored as an object,
      // but to be safe and consistent with previous logic, we check.
      return typeof cachedValue === 'string' ? JSON.parse(cachedValue) : cachedValue;
    }

    console.log(`🐢 [CACHE MISS]: ${fullKey}`);
    const freshData = await cb();
    if (freshData !== undefined && freshData !== null) {
      await client.set(fullKey, JSON.stringify(freshData), { ex: ttl });
    }
    return freshData;
  } catch (error) {
    console.error(`Cache error for key ${fullKey}:`, error);
    return await cb(); // Fallback to DB
  }
};

/**
 * Delete cache key(s) or patterns
 */
export const delCache = async (keys) => {
  try {
    const prepareKey = (k) => (k.startsWith(PREFIX) ? k : `${PREFIX}:${k}`);

    if (Array.isArray(keys)) {
      for (const key of keys) {
        const fullKey = prepareKey(key);
        if (fullKey.includes("*")) {
          const matchingKeys = await client.keys(fullKey);
          if (matchingKeys.length > 0) await client.del(...matchingKeys);
        } else {
          await client.del(fullKey);
        }
      }
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
  try {
    await client.incr(`${PREFIX}:version:${namespace}`);
  } catch (error) {
    console.error(`Redis bump version error for ${namespace}:`, error);
  }
};

// No-op for connectRedis as Upstash REST is stateless
export const connectRedis = async () => {
  // REST client doesn't need explicit connect
};

/**
 * Rate limiting logic using Upstash INCR
 * (Extracted from middleware to keep client logic consistent)
 */
export const incrRateLimit = async (key) => {
  return await client.incr(key);
};

export const expireRateLimit = async (key, seconds) => {
  return await client.expire(key, seconds);
};

export const ttlRateLimit = async (key) => {
  return await client.ttl(key);
};

export default client;
