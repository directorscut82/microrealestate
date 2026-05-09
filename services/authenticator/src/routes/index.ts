import express, { Request, Response, NextFunction, Router } from 'express';
import landlordRouter from './landlord.js';
import locale from 'locale';
import tenantRouter from './tenant.js';

// In-memory rate limiter for auth endpoints
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_WINDOW_MS = 60_000; // 1 minute
const RATE_MAX_ATTEMPTS = 10; // 10 attempts per minute per IP

function authRateLimit(req: Request, res: Response, next: NextFunction) {
  const key = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const entry = rateLimitMap.get(key);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(key, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return next();
  }
  if (entry.count >= RATE_MAX_ATTEMPTS) {
    res.set('Retry-After', '60');
    return res.status(429).json({ message: 'Too many attempts, please try again later' });
  }
  entry.count++;
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
  router.use(authRateLimit);
  router.use('/landlord', landlordRouter());
  router.use('/tenant', tenantRouter());
  return router;
}
