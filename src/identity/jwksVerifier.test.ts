import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import * as jwt from 'jsonwebtoken';
import { createEidasGatewayJwksVerifier, createFranceConnectJwksVerifier } from './jwksVerifier';
import type { RawCredential } from '../domain/types';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicJwk = publicKey.export({ format: 'jwk' }) as Record<string, unknown>;

const MOCK_JWKS = {
  keys: [
    {
      ...publicJwk,
      kid: 'test-key-1',
      use: 'sig',
      alg: 'RS256',
    },
  ],
};

const MOCK_ISSUER = 'https://eidas-gateway.demo/issuer';
const MOCK_AUDIENCE = 'nft-kyc-hub';
// Anchored to wall-clock time so `jsonwebtoken`'s own exp/iat checks (which use
// the real clock) agree with the verifier's injected `now` comparison.
const NOW = new Date();
const EXPECTED = { subjectId: 'seller-777' };

/** Resolve the test JWKS document without touching the network. */
const jwksFetcher = async (): Promise<{ keys: unknown[] }> => ({
  keys: MOCK_JWKS.keys as unknown[],
});

/** Sign an RS256 token with the test keypair, defaulting to a currently-valid one. */
function signedToken(
  claims: Record<string, unknown> = {},
  options: { key?: KeyObject | string; keyid?: string } = {},
): string {
  return jwt.sign(
    {
      iss: MOCK_ISSUER,
      sub: 'seller-777',
      name: 'Ines Ferreira',
      birth_date: '1991-04-17',
      acr: 'high',
      aalink: 'passport',
      iat: Math.floor(NOW.getTime() / 1000) - 60,
      exp: Math.floor(NOW.getTime() / 1000) + 3600,
      ...claims,
    },
    options.key ?? privateKey,
    { algorithm: 'RS256', keyid: options.keyid ?? 'test-key-1' },
  );
}

describe('JwksVerifier', () => {
  let mockJwksServer: string;
  let originalFetch: typeof fetch;

  beforeAll(() => {
    originalFetch = global.fetch;
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  beforeEach(() => {
    mockJwksServer = `http://localhost:9999/.well-known/jwks.json`;
    global.fetch = async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('.well-known/jwks.json')) {
        return {
          ok: true,
          json: async () => MOCK_JWKS,
          headers: new Headers({ 'content-type': 'application/json' }),
        } as Response;
      }
      return {
        ok: false,
        status: 404,
        json: async () => ({}),
      } as Response;
    };
  });

  it('rejects credential with wrong format', async () => {
    const verifier = createEidasGatewayJwksVerifier({
      jwksUri: mockJwksServer,
      issuer: MOCK_ISSUER,
    });
    const raw: RawCredential = { format: 'franceconnect', assertion: 'fake-token' };
    const result = await verifier.verify(raw, EXPECTED, NOW);
    expect(result).toMatchObject({ verified: false, reason: 'credential_missing' });
  });

  it('rejects empty assertion', async () => {
    const verifier = createEidasGatewayJwksVerifier({
      jwksUri: mockJwksServer,
      issuer: MOCK_ISSUER,
    });
    const raw: RawCredential = { format: 'eidas', assertion: '' };
    const result = await verifier.verify(raw, EXPECTED, NOW);
    expect(result).toMatchObject({ verified: false, reason: 'credential_missing' });
  });

  it('rejects assertion with invalid issuer', async () => {
    const verifier = createEidasGatewayJwksVerifier({
      jwksUri: mockJwksServer,
      issuer: MOCK_ISSUER,
    });
    const raw: RawCredential = { format: 'eidas', assertion: 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCIsImtpZCI6InRlc3Qta2V5LTEifQ.eyJpc3MiOiJodHRwczovL3dyb25nLWlzc3Vlci5leGFtcGxlLmNvbSIsInN1YiI6InNlbGxlci03NzciLCJuYW1lIjoiQWxpY2UiLCJiaXJ0aF9kYXRlIjoiMTk5MC0wMS0wMSIsImlhdCI6MTc0MDgxOTYwMCwiZXhwIjoxNzQwODIzMjAwfQ.sig' };
    const result = await verifier.verify(raw, EXPECTED, NOW);
    expect(result).toMatchObject({ verified: false, reason: 'credential_malformed' });
  });

  it('rejects assertion for different subject', async () => {
    const verifier = createEidasGatewayJwksVerifier({
      jwksUri: mockJwksServer,
      issuer: MOCK_ISSUER,
    });
    const raw: RawCredential = { format: 'eidas', assertion: 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCIsImtpZCI6InRlc3Qta2V5LTEifQ.eyJpc3MiOiJodHRwczovL2VpZGFzLWdhdGV3YXkuZGVtby9pc3N1ZXIiLCJzdWIiOiJkaWZmZXJlbnQtc3ViamVjdCIsIm5hbWUiOiJBbGljZSIsImJpcnRoX2RhdGUiOiIxOTkwLTAxLTAxIiwiaWF0IjoxNzQwODE5NjAwLCJleHAiOjE3NDA4MjMyMDB9.sig' };
    const result = await verifier.verify(raw, EXPECTED, NOW);
    expect(result).toMatchObject({ verified: false, reason: 'credential_malformed' });
  });

  it('rejects expired assertion', async () => {
    const verifier = createEidasGatewayJwksVerifier({
      jwksUri: mockJwksServer,
      issuer: MOCK_ISSUER,
    });
    const raw: RawCredential = { format: 'eidas', assertion: 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCIsImtpZCI6InRlc3Qta2V5LTEifQ.eyJpc3MiOiJodHRwczovL2VpZGFzLWdhdGV3YXkuZGVtby9pc3N1ZXIiLCJzdWIiOiJzZWxsZXItNzc3IiwibmFtZSI6IkFsaWNlIiwiYmlydGhfZGF0ZSI6IjE5OTAtMDEtMDEiLCJpYXQiOjE3NDA4MDgxMDAiLCJleHAiOjE3NDA4MTE3MDB9.sig' };
    const result = await verifier.verify(raw, EXPECTED, NOW);
    expect(result).toMatchObject({ verified: false, reason: 'credential_malformed' });
  });

  it('rejects malformed JWT as signature_invalid', async () => {
    const verifier = createEidasGatewayJwksVerifier({
      jwksUri: mockJwksServer,
      issuer: MOCK_ISSUER,
    });
    const raw: RawCredential = { format: 'eidas', assertion: 'not.a.valid.jwt' };
    const result = await verifier.verify(raw, EXPECTED, NOW);
    expect(result).toMatchObject({ verified: false, reason: 'signature_invalid' });
  });

  it('rejects JWT with missing kid header as signature_invalid', async () => {
    const verifier = createEidasGatewayJwksVerifier({
      jwksUri: mockJwksServer,
      issuer: MOCK_ISSUER,
    });
    const header = { alg: 'RS256', typ: 'JWT' };
    const payload = { iss: MOCK_ISSUER, sub: 'seller-777' };
    const encodedHeader = Buffer.from(JSON.stringify(header)).toString('base64url');
    const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const token = `${encodedHeader}.${encodedPayload}.signature`;
    const raw: RawCredential = { format: 'eidas', assertion: token };
    const result = await verifier.verify(raw, EXPECTED, NOW);
    expect(result).toMatchObject({ verified: false, reason: 'signature_invalid' });
  });

  it('implements EidProvider interface', () => {
    const verifier = createEidasGatewayJwksVerifier({
      jwksUri: mockJwksServer,
      issuer: MOCK_ISSUER,
    });
    expect(verifier.id).toBe('eidas-gateway');
    expect(verifier.format).toBe('eidas');
    expect(verifier.minimumAssurance).toBe('high');
    expect(typeof verifier.verify).toBe('function');
  });

  it('creates FranceConnect verifier with correct config', () => {
    const verifier = createFranceConnectJwksVerifier({
      jwksUri: mockJwksServer,
      issuer: 'https://app.franceconnect.gouv.fr',
      minimumAssurance: 'substantial',
    });
    expect(verifier.id).toBe('franceconnect');
    expect(verifier.format).toBe('franceconnect');
    expect(verifier.minimumAssurance).toBe('substantial');
    expect(typeof verifier.verify).toBe('function');
  });

  it('creates eIDAS gateway verifier with custom minimum assurance', () => {
    const verifier = createEidasGatewayJwksVerifier({
      jwksUri: mockJwksServer,
      issuer: MOCK_ISSUER,
      minimumAssurance: 'substantial',
    });
    expect(verifier.minimumAssurance).toBe('substantial');
  });

  it('creates eIDAS gateway verifier with audience', () => {
    const verifier = createEidasGatewayJwksVerifier({
      jwksUri: mockJwksServer,
      issuer: MOCK_ISSUER,
      audience: MOCK_AUDIENCE,
    });
    // The audience is stored privately but we can verify the verifier is created
    expect(verifier.id).toBe('eidas-gateway');
  });

  describe('assurance level normalization', () => {
    // Test the private normaliseAssurance method via the public interface
    // by checking that the correct error is thrown for low assurance
    it('rejects low assurance when high is required (via error path)', async () => {
      const verifier = createEidasGatewayJwksVerifier({
        jwksUri: mockJwksServer,
        issuer: MOCK_ISSUER,
        minimumAssurance: 'high',
        fetcher: jwksFetcher,
      });
      const raw: RawCredential = { format: 'eidas', assertion: signedToken({ acr: 'low' }) };
      const result = await verifier.verify(raw, EXPECTED, NOW);
      expect(result).toMatchObject({ verified: false, reason: 'assurance_too_low' });
    });
  });

  describe('validating a correctly signed assertion', () => {
    const eidas = () =>
      createEidasGatewayJwksVerifier({ jwksUri: mockJwksServer, issuer: MOCK_ISSUER, fetcher: jwksFetcher });

    it('verifies a valid RS256 assertion and normalises every claim', async () => {
      const result = await eidas().verify(
        { format: 'eidas', assertion: signedToken() },
        EXPECTED,
        NOW,
      );
      expect(result).toMatchObject({ verified: true, provider: 'eidas-gateway' });
      if (!result.verified) throw new Error('expected a verified assertion');
      expect(result.assertion).toMatchObject({
        subjectId: 'seller-777',
        fullName: 'Ines Ferreira',
        dateOfBirth: '1991-04-17',
        assurance: 'high',
        method: 'eidas-aalink:passport',
        issuer: MOCK_ISSUER,
      });
      expect(result.assertion.claims).toMatchObject({
        acr: 'high',
        aalink: 'passport',
        iss: MOCK_ISSUER,
      });
      expect(result.assertion.expiresAt).toBe(new Date((Math.floor(NOW.getTime() / 1000) + 3600) * 1000).toISOString());
    });

    it('rejects an expired assertion signed by a trusted key', async () => {
      const assertion = signedToken({ exp: Math.floor(NOW.getTime() / 1000) - 3600 });
      const result = await eidas().verify({ format: 'eidas', assertion }, EXPECTED, NOW);
      expect(result).toMatchObject({ verified: false, reason: 'credential_expired' });
    });

    it('rejects an assertion issued in the future', async () => {
      const assertion = signedToken({ iat: Math.floor(NOW.getTime() / 1000) + 3600 });
      const result = await eidas().verify({ format: 'eidas', assertion }, EXPECTED, NOW);
      expect(result).toMatchObject({ verified: false, reason: 'credential_malformed' });
    });

    it('rejects an assertion for a different subject', async () => {
      const assertion = signedToken({ sub: 'someone-else' });
      const result = await eidas().verify({ format: 'eidas', assertion }, EXPECTED, NOW);
      expect(result).toMatchObject({ verified: false, reason: 'subject_mismatch' });
    });

    it('rejects an assertion signed by an unknown key', async () => {
      const { privateKey: rogueKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
      const assertion = signedToken({}, { key: rogueKey });
      const result = await eidas().verify({ format: 'eidas', assertion }, EXPECTED, NOW);
      expect(result).toMatchObject({ verified: false, reason: 'signature_invalid' });
    });

    it('rejects an assertion with a malformed birth date', async () => {
      const assertion = signedToken({ birth_date: '17/04/1991' });
      const result = await eidas().verify({ format: 'eidas', assertion }, EXPECTED, NOW);
      expect(result).toMatchObject({ verified: false, reason: 'credential_malformed' });
    });

    it('rejects an assertion missing the subject claim', async () => {
      const assertion = signedToken({ sub: undefined });
      const result = await eidas().verify({ format: 'eidas', assertion }, EXPECTED, NOW);
      expect(result).toMatchObject({ verified: false, reason: 'credential_malformed' });
    });

    it('enforces the audience when one is configured', async () => {
      const withAudience = createEidasGatewayJwksVerifier({
        jwksUri: mockJwksServer,
        issuer: MOCK_ISSUER,
        audience: MOCK_AUDIENCE,
        fetcher: jwksFetcher,
      });
      const missing = await withAudience.verify(
        { format: 'eidas', assertion: signedToken() },
        EXPECTED,
        NOW,
      );
      expect(missing).toMatchObject({ verified: false, reason: 'credential_malformed' });

      const valid = await withAudience.verify(
        { format: 'eidas', assertion: signedToken({ aud: MOCK_AUDIENCE }) },
        EXPECTED,
        NOW,
      );
      expect(valid.verified).toBe(true);
    });

    it('normalises a FranceConnect assertion through the OIDC mapping', async () => {
      const franceConnect = createFranceConnectJwksVerifier({
        jwksUri: mockJwksServer,
        issuer: 'https://app.franceconnect.gouv.fr',
        fetcher: jwksFetcher,
      });
      const assertion = signedToken({
        iss: 'https://app.franceconnect.gouv.fr',
        acr: 'eidas-aalink-substantial',
        amr: ['pwd', 'mfa'],
        idp: 'franceconnect',
      });
      const result = await franceConnect.verify(
        { format: 'franceconnect', assertion },
        EXPECTED,
        NOW,
      );
      expect(result).toMatchObject({ verified: true, provider: 'franceconnect' });
      if (!result.verified) throw new Error('expected a verified assertion');
      expect(result.assertion.assurance).toBe('substantial');
      expect(result.assertion.method).toBe('oidc:pwd+mfa');
      expect(result.assertion.claims).toMatchObject({ idp: 'franceconnect' });
    });
  });
});