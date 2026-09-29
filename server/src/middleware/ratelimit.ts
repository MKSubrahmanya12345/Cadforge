import type { NextFunction, Request, Response } from 'express';
import { env } from '../env.js';
import { createLogger } from '../logger.js';
import { HttpError } from './error.js';

const log = createLogger('ratelimit');

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();
let lastSweep = Date.now();

/** Periodic sweep so the bucket map cannot grow without bound. */
function sweep(now: number): void {
  if (now - lastSweep < 60_000) return;
  lastSweep = now;
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}

export function clientKey(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0]!.trim();
  }
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}

/**
 * Fixed-window in-memory rate limiter. One instance per process; behind a load
 * balancer you would move this to Redis, which is fine for a local tool.
 */
export function rateLimit(options?: { max?: number; windowMs?: number; prefix?: string }) {
  const max = options?.max ?? env.RATE_LIMIT_MAX;
  const windowMs = options?.windowMs ?? env.RATE_LIMIT_WINDOW_MS;
  const prefix = options?.prefix ?? '';

  return (req: Request, res: Response, next: NextFunction): void => {
    const now = Date.now();
    sweep(now);

    // Long-lived SSE streams must not count against the request budget.
    if (req.path.endsWith('/events')) {
      next();
      return;
    }

    const key = `${prefix}${clientKey(req)}`;
    const bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      res.setHeader('X-RateLimit-Limit', String(max));
      res.setHeader('X-RateLimit-Remaining', String(max - 1));
      next();
      return;
    }

    bucket.count += 1;
    if (bucket.count > max) {
      const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
      res.setHeader('Retry-After', String(retryAfter));
      log.warn('rate limit exceeded', { key, count: bucket.count });
      next(new HttpError(429, `Rate limit exceeded. Try again in ${retryAfter}s.`, 'rate_limited'));
      return;
    }

    res.setHeader('X-RateLimit-Limit', String(max));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, max - bucket.count)));
    next();
  };
}

/** Test hook. */
export function resetRateLimits(): void {
  buckets.clear();
  lastSweep = Date.now();
}
