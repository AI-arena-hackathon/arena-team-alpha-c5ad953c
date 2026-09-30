import type { NextFunction, Request, Response } from 'express';
import type { PartnerCredential } from '../../config';
import { safeEqual } from '../../security/encryption';
import { sha256Hex } from '../../util/id';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Marketplace identity resolved from the partner API key. */
      partner?: { marketplaceId: string };
    }
  }
}

/**
 * Partner authentication.
 *
 * Marketplaces authenticate with a bearer-ish `x-api-key` header (the deployed
 * topology fronts this with API Gateway + Cognito JWT; the middleware is the
 * single place that resolves the partner identity, so swapping the verifier is
 * local to this file). Keys are compared as SHA-256 digests in constant time and
 * the raw key is never logged or persisted.
 */
export function partnerAuth(partners: PartnerCredential[]) {
  return function auth(req: Request, res: Response, next: NextFunction): void {
    const presented = readApiKey(req);

    if (!presented) {
      res.status(401).json({
        error: 'unauthorized',
        message: 'missing partner credentials: send an x-api-key header',
      });
      return;
    }

    const match = partners.find((partner) => safeEqual(partner.keyHash, sha256Hex(presented)));
    if (!match) {
      res.status(401).json({ error: 'unauthorized', message: 'invalid partner API key' });
      return;
    }

    req.partner = { marketplaceId: match.marketplaceId };
    next();
  };
}

/** Reads the key from `x-api-key`, falling back to an `Authorization: ApiKey` header. */
export function readApiKey(req: Request): string | undefined {
  const header = req.header('x-api-key');
  if (header && header.trim()) return header.trim();
  const authorization = req.header('authorization');
  if (authorization && /^apikey\s+/i.test(authorization)) {
    const value = authorization.replace(/^apikey\s+/i, '').trim();
    return value || undefined;
  }
  return undefined;
}

/** Same as `readApiKey` but rejects before hashing if the header looks like a JWT/Cognito token. */
export function isJwtLike(value: string): boolean {
  return value.split('.').length === 3;
}