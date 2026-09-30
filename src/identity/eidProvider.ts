import { createHmac, timingSafeEqual } from 'node:crypto';
import { canonicalJson } from '../util/canonical';
import type {
  AssuranceLevel,
  CredentialFormat,
  IdentityVerificationResult,
  RawCredential,
} from '../domain/types';

/**
 * Vendor adapter layer for EU e-ID schemes (README risk 1: regulatory lock-in).
 *
 * Every marketplace plugs into the same `EidProvider` port; each vendor adapter
 * translates its own credential shape into one normalised `IdentityAssertion`.
 * Adding a third scheme means adding one adapter — no change to the KYC service,
 * the risk engine or the HTTP layer.
 *
 * The MVP validates credentials locally with an HMAC over the canonical payload,
 * mirroring what a production deployment does with the vendor's JWKS/eIDAS-PKI
 * signature. Swapping the validator is a single-method change per adapter.
 */
export interface EidProvider {
  /** Stable adapter id, recorded on every KYC record for audit. */
  readonly id: string;
  readonly format: CredentialFormat;
  /** Vendor-specific minimum eIDAS assurance level before we accept an identity. */
  readonly minimumAssurance: AssuranceLevel;
  verify(raw: RawCredential, expected: { subjectId: string }, now: Date): IdentityVerificationResult;
}

const ASSURANCE_RANK: Record<AssuranceLevel, number> = {
  none: 0,
  low: 1,
  substantial: 2,
  high: 3,
};

/** Base64url decode that rejects non-canonical input instead of silently coercing. */
function decodeBase64Url(value: string): string {
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(value)) {
    throw new Error('assertion is not base64url encoded');
  }
  return Buffer.from(value, 'base64url').toString('utf8');
}

interface DecodedAssertion {
  payload: Record<string, unknown>;
  signature: string;
  signed: string;
}

/**
 * Assertion envelope: `<base64url(canonical json)>.<base64url(hmac)>` where the
 * MAC covers the canonical JSON of every claim except `sig`.
 */
export function decodeAssertion(assertion: string): DecodedAssertion {
  const parts = assertion.split('.');
  if (parts.length !== 2) {
    throw new Error('assertion must have the form <payload>.<signature>');
  }
  const payloadJson = decodeBase64Url(parts[0]);
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(payloadJson) as Record<string, unknown>;
  } catch {
    throw new Error('assertion payload is not valid JSON');
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('assertion payload must be a JSON object');
  }
  const signature = parts[1];
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(signature)) {
    throw new Error('assertion signature is not base64url encoded');
  }
  const claims = { ...payload };
  delete claims.sig;
  return { payload, signature, signed: canonicalJson(claims) };
}

export function signAssertion(claims: Record<string, unknown>, secret: string): string {
  const signed = canonicalJson(claims);
  const signature = createHmac('sha256', secret).update(signed, 'utf8').digest('base64url');
  return `${Buffer.from(signed, 'utf8').toString('base64url')}.${signature}`;
}

export function verifySignature(signed: string, signature: string, secret: string): boolean {
  const expected = createHmac('sha256', secret).update(signed, 'utf8').digest();
  let provided: Buffer;
  try {
    provided = Buffer.from(signature, 'base64url');
  } catch {
    return false;
  }
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(expected, provided);
}

function stringClaim(payload: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function normaliseAssurance(value: string | undefined): AssuranceLevel {
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

function isoDate(value: string | undefined, field: string): string {
  const parsed = Date.parse(value ?? '');
  if (!value || Number.isNaN(parsed)) {
    throw new Error(`assertion field "${field}" is not a valid timestamp`);
  }
  return new Date(parsed).toISOString();
}

function dateOnly(value: string | undefined, field: string): string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`assertion field "${field}" must be an ISO date (yyyy-mm-dd)`);
  }
  return value;
}

/**
 * Shared validation pipeline for the adapters. Each adapter supplies a mapper
 * from vendor claims to the normalised assertion; the security checks (signature,
 * expiry, subject binding, assurance floor) live here so they cannot drift
 * between vendors.
 */
abstract class SignedAssertionProvider implements EidProvider {
  abstract readonly id: string;
  abstract readonly format: CredentialFormat;
  abstract readonly minimumAssurance: AssuranceLevel;
  protected abstract readonly secret: string;

  verify(raw: RawCredential, expected: { subjectId: string }, now: Date): IdentityVerificationResult {
    if (raw.format !== this.format) {
      return this.fail('credential_missing', `expected a ${this.format} assertion`, raw);
    }
    if (!raw.assertion) {
      return this.fail('credential_missing', 'assertion is empty', raw);
    }

    let decoded: DecodedAssertion;
    try {
      decoded = decodeAssertion(raw.assertion);
    } catch (error) {
      return this.fail('credential_malformed', (error as Error).message, raw);
    }

    if (!verifySignature(decoded.signed, decoded.signature, this.secret)) {
      return this.fail('signature_invalid', 'assertion signature does not verify', raw);
    }

    try {
      const issuer = stringClaim(decoded.payload, 'iss');
      const subjectId = stringClaim(decoded.payload, 'sub', 'subject_id');
      const fullName = stringClaim(decoded.payload, 'name', 'full_name');
      const dateOfBirth = stringClaim(decoded.payload, 'birth_date', 'birthdate');
      if (!issuer || !subjectId || !fullName || !dateOfBirth) {
        return this.fail('credential_malformed', 'assertion is missing iss/sub/name/birth date', raw);
      }
      if (subjectId !== expected.subjectId) {
        return this.fail('subject_mismatch', 'assertion subject does not match the submission', raw);
      }

      const expiresAt = isoDate(stringClaim(decoded.payload, 'exp', 'expires_at'), 'exp');
      if (Date.parse(expiresAt) <= now.getTime()) {
        return this.fail('credential_expired', 'assertion expired', raw);
      }

      const assurance = normaliseAssurance(stringClaim(decoded.payload, 'acr', 'assurance'));
      if (ASSURANCE_RANK[assurance] < ASSURANCE_RANK[this.minimumAssurance]) {
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
          dateOfBirth: dateOnly(dateOfBirth, 'birth date'),
          assurance,
          method: this.mapMethod(decoded.payload),
          issuer,
          issuedAt: isoDate(stringClaim(decoded.payload, 'iat', 'issued_at'), 'iat'),
          expiresAt,
          claims: this.auditClaims(decoded.payload),
        },
      };
    } catch (error) {
      return this.fail('credential_malformed', (error as Error).message, raw);
    }
  }

  protected abstract mapMethod(payload: Record<string, unknown>): string;

  protected abstract auditClaims(payload: Record<string, unknown>): Record<string, string>;

  protected fail(
    reason: Extract<IdentityVerificationResult, { verified: false }>['reason'],
    detail: string,
    raw: RawCredential,
  ): IdentityVerificationResult {
    return { verified: false, reason, detail, provider: `${this.id}:${raw.format}` };
  }
}

/** EU eIDAS eIDAS-1 / AAlink high-trust gateway (DE, NL, ES pilot deployments). */
export class EidasGatewayProvider extends SignedAssertionProvider {
  readonly id = 'eidas-gateway';
  readonly format: CredentialFormat = 'eidas';
  readonly minimumAssurance: AssuranceLevel = 'high';

  constructor(private readonly sharedSecret: string) {
    super();
  }

  protected get secret(): string {
    return this.sharedSecret;
  }

  protected mapMethod(payload: Record<string, unknown>): string {
    return `eidas-aalink:${String(payload.aalink ?? 'document')}`;
  }

  protected auditClaims(payload: Record<string, unknown>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const key of ['acr', 'aalink', 'iss', 'loa', 'auth_instant']) {
      const value = payload[key];
      if (typeof value === 'string') out[key] = value;
    }
    return out;
  }
}

/** FranceConnect+ OIDC id_token adapter. */
export class FranceConnectProvider extends SignedAssertionProvider {
  readonly id = 'franceconnect';
  readonly format: CredentialFormat = 'franceconnect';
  readonly minimumAssurance: AssuranceLevel = 'substantial';

  constructor(private readonly sharedSecret: string) {
    super();
  }

  protected get secret(): string {
    return this.sharedSecret;
  }

  protected mapMethod(payload: Record<string, unknown>): string {
    const amr = Array.isArray(payload.amr) ? payload.amr.join('+') : String(payload.amr ?? 'pwd');
    return `oidc:${amr}`;
  }

  protected auditClaims(payload: Record<string, unknown>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const key of ['acr', 'amr', 'iss', 'idp']) {
      const value = payload[key];
      if (typeof value === 'string' || Array.isArray(value)) out[key] = JSON.stringify(value);
    }
    return out;
  }
}

/** Registry keyed by credential format; unknown formats fail closed. */
export class EidProviderRegistry {
  private readonly providers = new Map<CredentialFormat, EidProvider>();

  constructor(providers: EidProvider[]) {
    for (const provider of providers) this.providers.set(provider.format, provider);
  }

  find(format: string | undefined): EidProvider | undefined {
    if (!format) return undefined;
    return this.providers.get(format as CredentialFormat);
  }

  ids(): string[] {
    return [...this.providers.values()].map((provider) => provider.id).sort();
  }
}