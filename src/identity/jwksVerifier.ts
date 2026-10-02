import { JwksClient } from 'jwks-rsa';
import * as jwt from 'jsonwebtoken';
import type { AssuranceLevel, CredentialFormat, IdentityVerificationResult, RawCredential } from '../domain/types';
import type { EidProvider } from './eidProvider';

export interface JwksProviderConfig {
  id: string;
  format: CredentialFormat;
  jwksUri: string;
  issuer: string;
  audience?: string;
  minimumAssurance: AssuranceLevel;
  /**
   * Optional JWKS transport override (resolves the JWKS document for a URI).
   * Production uses jwks-rsa's default HTTP client; tests and deployments with
   * a custom egress policy can inject their own.
   */
  fetcher?: (jwksUri: string) => Promise<{ keys: unknown[] }>;
}

interface DecodedJwtPayload {
  iss: string;
  sub: string;
  name?: string;
  full_name?: string;
  birth_date?: string;
  birthdate?: string;
  acr?: string;
  aalink?: string;
  amr?: string | string[];
  idp?: string;
  loa?: string;
  auth_instant?: string;
  iat?: string | number;
  exp?: string | number;
  aud?: string | string[];
  sig?: string;
  [key: string]: unknown;
}

interface JwksClientInterface {
  getSigningKey(kid: string): Promise<{ publicKey: string | Buffer }>;
}

/**
 * Copy the named vendor claims into the PII-free audit trail. Plain strings are
 * kept verbatim; array claims (e.g. OIDC `amr`) are JSON-encoded so the audit
 * value is unambiguous. Values of any other type are ignored.
 */
function auditStrings(payload: DecodedJwtPayload, keys: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === 'string') out[key] = value;
    else if (Array.isArray(value)) out[key] = JSON.stringify(value);
  }
  return out;
}

export class JwksVerifier implements EidProvider {
  readonly id: string;
  readonly format: CredentialFormat;
  readonly minimumAssurance: AssuranceLevel;
  private readonly jwksClient: JwksClientInterface;
  private readonly issuer: string;
  private readonly audience?: string;

  constructor(config: JwksProviderConfig) {
    this.id = config.id;
    this.format = config.format;
    this.minimumAssurance = config.minimumAssurance;
    this.issuer = config.issuer;
    this.audience = config.audience;
    this.jwksClient = new JwksClient({
      jwksUri: config.jwksUri,
      cache: true,
      cacheMaxAge: 600_000,
      rateLimit: true,
      jwksRequestsPerMinute: 10,
      fetcher: config.fetcher,
    }) as unknown as JwksClientInterface;
  }

  async verify(raw: RawCredential, expected: { subjectId: string }, now: Date): Promise<IdentityVerificationResult> {
    if (raw.format !== this.format) {
      return this.fail('credential_missing', `expected a ${this.format} assertion`, raw);
    }
    if (!raw.assertion) {
      return this.fail('credential_missing', 'assertion is empty', raw);
    }

    let payload: DecodedJwtPayload;
    try {
      payload = await this.verifyJwt(raw.assertion);
    } catch (error) {
      return this.handleJwtError(error, raw);
    }

    try {
      const issuer = payload.iss;
      const subjectId = payload.sub ?? payload.subject_id;
      const fullName = payload.name ?? payload.full_name;
      const dateOfBirth = payload.birth_date ?? payload.birthdate;

      if (!issuer || !subjectId || !fullName || !dateOfBirth) {
        return this.fail('credential_malformed', 'assertion is missing iss/sub/name/birth date', raw);
      }

      if (issuer !== this.issuer) {
        return this.fail('credential_malformed', `assertion issuer mismatch: expected ${this.issuer}`, raw);
      }

      if (subjectId !== expected.subjectId) {
        return this.fail('subject_mismatch', 'assertion subject does not match the submission', raw);
      }

      if (this.audience) {
        const aud = Array.isArray(payload.aud) ? payload.aud : payload.aud ? [payload.aud] : [];
        if (!aud.includes(this.audience)) {
          return this.fail('credential_malformed', `assertion audience mismatch`, raw);
        }
      }

      const expiresAt = this.parseTimestamp(payload.exp, 'exp');
      if (expiresAt <= now.getTime()) {
        return this.fail('credential_expired', 'assertion expired', raw);
      }

      const issuedAt = this.parseTimestamp(payload.iat, 'iat');
      if (issuedAt > now.getTime() + 60_000) {
        return this.fail('credential_malformed', 'assertion issued in the future', raw);
      }

      const assurance = this.normaliseAssurance(payload.acr ?? payload.loa);
      if (this.assuranceRank(assurance) < this.assuranceRank(this.minimumAssurance)) {
        return this.fail(
          'assurance_too_low',
          `${this.id} requires assurance >= ${this.minimumAssurance}`,
          raw,
        );
      }

      return {
        verified: true,
        provider: this.id,
        assertion: {
          subjectId,
          fullName,
          dateOfBirth: this.dateOnly(dateOfBirth),
          assurance,
          method: this.mapMethod(payload),
          issuer,
          issuedAt: new Date(issuedAt).toISOString(),
          expiresAt: new Date(expiresAt).toISOString(),
          claims: this.auditClaims(payload),
        },
      };
    } catch (error) {
      return this.fail('credential_malformed', (error as Error).message, raw);
    }
  }

  private async verifyJwt(token: string): Promise<DecodedJwtPayload> {
    const decoded = jwt.decode(token, { complete: true });
    if (!decoded || typeof decoded === 'string' || !decoded.header.kid) {
      throw new Error('invalid token format: missing kid header');
    }

    const signingKey = await this.jwksClient.getSigningKey(decoded.header.kid);
    const publicKey = signingKey.publicKey;

    const options: jwt.VerifyOptions = {
      issuer: this.issuer,
      clockTolerance: 30,
      algorithms: ['RS256', 'ES256', 'PS256'],
    };
    if (this.audience) {
      options.audience = this.audience;
    }

    return jwt.verify(token, publicKey, options) as DecodedJwtPayload;
  }

  private handleJwtError(error: unknown, raw: RawCredential): IdentityVerificationResult {
    const message = (error as Error).message;
    if (message.includes('expired') || message.includes('jwt expired')) {
      return this.fail('credential_expired', 'assertion expired', raw);
    }
    if (message.includes('signature') || message.includes('invalid token') || message.includes('verification failed')) {
      return this.fail('signature_invalid', 'assertion signature does not verify', raw);
    }
    if (message.includes('audience') || message.includes('issuer') || message.includes('invalid token')) {
      return this.fail('credential_malformed', message, raw);
    }
    return this.fail('credential_malformed', message, raw);
  }

  private parseTimestamp(value: string | number | undefined, field: string): number {
    if (value === undefined) {
      throw new Error(`assertion field "${field}" is missing`);
    }
    const parsed = typeof value === 'number' ? value * 1000 : Date.parse(value);
    if (Number.isNaN(parsed)) {
      throw new Error(`assertion field "${field}" is not a valid timestamp`);
    }
    return parsed;
  }

  private normaliseAssurance(value: string | undefined): AssuranceLevel {
    switch ((value ?? '').toLowerCase()) {
      case 'high':
      case 'eidas-aalink-high':
      case 'urn:eid:level:high':
        return 'high';
      case 'substantial':
      case 'eidas-aalink-substantial':
      case 'urn:eid:level:substantial':
        return 'substantial';
      case 'low':
      case 'eidas-aalink-low':
      case 'urn:eid:level:low':
        return 'low';
      default:
        return 'none';
    }
  }

  private assuranceRank(level: AssuranceLevel): number {
    const rank: Record<AssuranceLevel, number> = { none: 0, low: 1, substantial: 2, high: 3 };
    return rank[level];
  }

  private dateOnly(value: string): string {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      throw new Error('birth date must be an ISO date (yyyy-mm-dd)');
    }
    return value;
  }

  protected mapMethod(_payload: DecodedJwtPayload): string {
    return 'unknown';
  }

  protected auditClaims(_payload: DecodedJwtPayload): Record<string, string> {
    return {};
  }

  private fail(
    reason: Extract<IdentityVerificationResult, { verified: false }>['reason'],
    detail: string,
    _raw: RawCredential,
  ): IdentityVerificationResult {
    return { verified: false, reason, detail, provider: `${this.id}:${this.format}` };
  }
}

export function createEidasGatewayJwksVerifier(config: {
  jwksUri: string;
  issuer: string;
  audience?: string;
  minimumAssurance?: AssuranceLevel;
  fetcher?: (jwksUri: string) => Promise<{ keys: unknown[] }>;
}): JwksVerifier {
  return new class EidasGatewayJwksVerifier extends JwksVerifier {
    protected mapMethod(payload: DecodedJwtPayload): string {
      return `eidas-aalink:${String(payload.aalink ?? 'document')}`;
    }

    protected auditClaims(payload: DecodedJwtPayload): Record<string, string> {
      return auditStrings(payload, ['acr', 'aalink', 'iss', 'loa', 'auth_instant']);
    }
  }({
    id: 'eidas-gateway',
    format: 'eidas',
    jwksUri: config.jwksUri,
    issuer: config.issuer,
    audience: config.audience,
    minimumAssurance: config.minimumAssurance ?? 'high',
    fetcher: config.fetcher,
  });
}

export function createFranceConnectJwksVerifier(config: {
  jwksUri: string;
  issuer: string;
  audience?: string;
  minimumAssurance?: AssuranceLevel;
  fetcher?: (jwksUri: string) => Promise<{ keys: unknown[] }>;
}): JwksVerifier {
  return new class FranceConnectJwksVerifier extends JwksVerifier {
    protected mapMethod(payload: DecodedJwtPayload): string {
      const amr = Array.isArray(payload.amr) ? payload.amr.join('+') : String(payload.amr ?? 'pwd');
      return `oidc:${amr}`;
    }

    protected auditClaims(payload: DecodedJwtPayload): Record<string, string> {
      return auditStrings(payload, ['acr', 'amr', 'iss', 'idp']);
    }
  }({
    id: 'franceconnect',
    format: 'franceconnect',
    jwksUri: config.jwksUri,
    issuer: config.issuer,
    audience: config.audience,
    minimumAssurance: config.minimumAssurance ?? 'substantial',
    fetcher: config.fetcher,
  });
}