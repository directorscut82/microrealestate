import express, { Request, Response, NextFunction, Router } from 'express';
import landlordRouter from './landlord.js';
import locale from 'locale';
import tenantRouter from './tenant.js';

// In-memory rate limiter for credential-handling auth endpoints only.
// Applied per-route (signin/signup/forgotpassword) so an attacker burning
// IPs on /signin can't lock active users out of /refreshtoken or /session.
//
// Three subtle bugs the previous version had and we close here:
//   (a) `req.ip` reads X-Forwarded-For, which a client can spoof when the
//       trust-proxy chain misbehaves. We key on `req.socket.remoteAddress`
//       (the actual connecting peer — the gateway container) for the IP
//       fallback, never the X-F-F header.
//   (b) Successful logins consumed the budget too, so a busy NAT/CGNAT
//       block of legit users could exhaust the limit. We only increment
//       AFTER the response finishes and ONLY when status >= 400.
//   (c) Per-IP keys lock out shared-NAT users for one bad actor's mistakes.
//       For email-bearing payloads we key by lower-cased email instead, so
//       the limit is per-account, not per-IP.
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_WINDOW_MS = 60_000; // 1 minute
const RATE_MAX_ATTEMPTS = 20; // bumped from 10 — was too tight for parallel legit users

export function authRateLimit(req: Request, res: Response, next: NextFunction) {
  const key =
    req.body?.email && typeof req.body.email === 'string'
      ? `email:${req.body.email.toLowerCase()}`
      : `ip:${req.socket.remoteAddress || 'unknown'}`;
  const now = Date.now();
  const entry = rateLimitMap.get(key);

  // If the bucket is full, refuse before doing any work.
  if (entry && now <= entry.resetAt && entry.count >= RATE_MAX_ATTEMPTS) {
    res.set('Retry-After', '60');
    return res
      .status(429)
      .json({ message: 'Too many attempts, please try again later' });
  }

  // Defer the increment until we know whether the call actually failed.
  // Successful sign-ins (status < 400) MUST NOT consume the budget.
  res.on('finish', () => {
    if (res.statusCode < 400) {
      return;
    }
    const tNow = Date.now();
    const existing = rateLimitMap.get(key);
    if (!existing || tNow > existing.resetAt) {
      rateLimitMap.set(key, { count: 1, resetAt: tNow + RATE_WINDOW_MS });
      return;
    }
    existing.count++;
  });

  return next();
}

// Periodically clean up expired entries to prevent memory leak
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimitMap) {
    if (now > entry.resetAt) {
      rateLimitMap.delete(key);
    }
  }
}, 5 * 60_000); // every 5 minutes

export default function (): Router {
  const router = express.Router();
  router.use(locale(['fr-FR', 'en-US', 'pt-BR', 'de-DE', 'es-CO', 'el'], 'en-US'));
  router.use('/landlord', landlordRouter());
  router.use('/tenant', tenantRouter());
  return router;
}
