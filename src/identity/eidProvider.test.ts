import {
  decodeAssertion,
  EidProviderRegistry,
  EidasGatewayProvider,
  FranceConnectProvider,
  signAssertion,
  verifySignature,
  type EidProvider,
} from './eidProvider';
import {
  TEST_EIDAS_SECRET,
  TEST_FRANCE_CONNECT_SECRET,
  eidasAssertion,
  franceConnectAssertion,
} from '../testing/fixtures';

const NOW = new Date('2025-03-01T09:00:00.000Z');
const EXPECTED = { subjectId: 'seller-777' };

const eidas = new EidasGatewayProvider(TEST_EIDAS_SECRET);
const franceConnect = new FranceConnectProvider(TEST_FRANCE_CONNECT_SECRET);

describe('assertion signing', () => {
  it('round-trips claims and verifies the MAC', () => {
    const assertion = signAssertion({ sub: 'seller-777', name: 'Ines Ferreira' }, TEST_EIDAS_SECRET);
    const decoded = decodeAssertion(assertion);
    expect(decoded.payload).toMatchObject({ sub: 'seller-777', name: 'Ines Ferreira' });
    expect(verifySignature(decoded.signed, decoded.signature, TEST_EIDAS_SECRET)).toBe(true);
    expect(verifySignature(decoded.signed, decoded.signature, 'wrong-secret')).toBe(false);
  });

  it('detects a tampered claim', () => {
    const assertion = signAssertion({ sub: 'seller-777' }, TEST_EIDAS_SECRET);
    const [payload, signature] = assertion.split('.');
    const forged = Buffer.from(JSON.stringify({ sub: 'attacker' }), 'utf8').toString('base64url');
    const decoded = decodeAssertion(`${forged}.${signature}`);
    expect(verifySignature(decoded.signed, decoded.signature, TEST_EIDAS_SECRET)).toBe(false);
    expect(decodeAssertion(assertion).payload).toEqual({ sub: 'seller-777' });
    expect(payload).toBeDefined();
  });

  it('rejects a malformed envelope', () => {
    expect(() => decodeAssertion('no-dot')).toThrow(/payload/);
    expect(() => decodeAssertion('!!!.***')).toThrow(/base64url/);
    expect(() => decodeAssertion('YWJj.###')).toThrow(/not valid JSON/);
    expect(() => decodeAssertion('YWJj.')).toThrow(/payload/);
    expect(() => decodeAssertion(`${Buffer.from('[1,2]').toString('base64url')}.sig`)).toThrow(
      /must be a JSON object/,
    );
    expect(() => decodeAssertion(`${Buffer.from('{"a":1}').toString('base64url')}.###`)).toThrow(
      /signature is not base64url/,
    );
  });
});

describe('EidasGatewayProvider', () => {
  it('normalises a valid high-assurance assertion', () => {
    const result = eidas.verify({ format: 'eidas', assertion: eidasAssertion() }, EXPECTED, NOW);
    expect(result.verified).toBe(true);
    if (!result.verified) return;
    expect(result.provider).toBe('eidas-gateway');
    expect(result.assertion).toMatchObject({
      subjectId: 'seller-777',
      fullName: 'Ines Ferreira',
      dateOfBirth: '1991-04-17',
      assurance: 'high',
      method: 'eidas-aalink:passport',
    });
    expect(result.assertion.claims).toEqual({ acr: 'high', aalink: 'passport', iss: 'https://eidas-gateway.demo/issuer' });
  });

  it('rejects a credential signed by the wrong vendor secret', () => {
    const result = eidas.verify(
      { format: 'eidas', assertion: eidasAssertion({}, 'attacker-secret') },
      EXPECTED,
      NOW,
    );
    expect(result).toMatchObject({ verified: false, reason: 'signature_invalid' });
  });

  it('rejects an assertion issued for a different subject', () => {
    const result = eidas.verify(
      { format: 'eidas', assertion: eidasAssertion({ sub: 'someone-else' }) },
      EXPECTED,
      NOW,
    );
    expect(result).toMatchObject({ verified: false, reason: 'subject_mismatch' });
  });

  it('rejects an expired assertion', () => {
    const result = eidas.verify(
      { format: 'eidas', assertion: eidasAssertion({ exp: '2025-02-01T00:00:00.000Z' }) },
      EXPECTED,
      NOW,
    );
    expect(result).toMatchObject({ verified: false, reason: 'credential_expired' });
  });

  it('enforces the high-assurance floor', () => {
    const result = eidas.verify(
      { format: 'eidas', assertion: eidasAssertion({ acr: 'low' }) },
      EXPECTED,
      NOW,
    );
    expect(result).toMatchObject({ verified: false, reason: 'assurance_too_low' });
  });

  it.each([
    ['an empty assertion', '', 'credential_missing'],
    ['garbage', 'not-base64.signature', 'credential_malformed'],
    ['a JSON body without the required claims', signAssertion({ sub: 'seller-777' }, TEST_EIDAS_SECRET), 'credential_malformed'],
    ['a non-ISO date of birth', eidasAssertion({ birth_date: '17/04/1991' }), 'credential_malformed'],
    ['a bad expiry timestamp', eidasAssertion({ exp: 'never' }), 'credential_malformed'],
  ])('rejects %s', (_label, assertion, reason) => {
    const result = eidas.verify({ format: 'eidas', assertion }, EXPECTED, NOW);
    expect(result).toMatchObject({ verified: false, reason });
  });

  it('ignores a credential presented in the wrong format', () => {
    const result = eidas.verify({ format: 'franceconnect', assertion: eidasAssertion() }, EXPECTED, NOW);
    expect(result).toMatchObject({ verified: false, reason: 'credential_missing' });
  });
});

describe('FranceConnectProvider', () => {
  it('normalises an OIDC id_token style assertion', () => {
    const result = franceConnect.verify(
      { format: 'franceconnect', assertion: franceConnectAssertion() },
      EXPECTED,
      NOW,
    );
    expect(result.verified).toBe(true);
    if (!result.verified) return;
    expect(result.assertion).toMatchObject({
      assurance: 'substantial',
      method: 'oidc:pwd+mfa',
      dateOfBirth: '1991-04-17',
    });
    // Strings stay verbatim; array claims are JSON-encoded for an unambiguous audit trail.
    expect(result.assertion.claims.idp).toBe('franceconnect');
    expect(result.assertion.claims.amr).toBe('["pwd","mfa"]');
  });

  it('accepts substantial assurance but not low', () => {
    const substantial = franceConnect.verify(
      { format: 'franceconnect', assertion: franceConnectAssertion({ acr: 'eidas-aalink-substantial' }) },
      EXPECTED,
      NOW,
    );
    expect(substantial.verified).toBe(true);

    const low = franceConnect.verify(
      { format: 'franceconnect', assertion: franceConnectAssertion({ acr: 'low' }) },
      EXPECTED,
      NOW,
    );
    expect(low).toMatchObject({ verified: false, reason: 'assurance_too_low' });
  });

  it('does not accept an eIDAS assertion signed with the FranceConnect secret', () => {
    const result = franceConnect.verify(
      { format: 'franceconnect', assertion: franceConnectAssertion({}, TEST_EIDAS_SECRET) },
      EXPECTED,
      NOW,
    );
    expect(result).toMatchObject({ verified: false, reason: 'signature_invalid' });
  });
});

describe('EidProviderRegistry', () => {
  const registry = new EidProviderRegistry([eidas, franceConnect]);

  it('resolves each supported format to its vendor adapter', () => {
    expect(registry.find('eidas')?.id).toBe('eidas-gateway');
    expect(registry.find('franceconnect')?.id).toBe('franceconnect');
    expect(registry.ids()).toEqual(['eidas-gateway', 'franceconnect']);
  });

  it('returns nothing for an unknown or missing format so the caller fails closed', () => {
    expect(registry.find('id.me')).toBeUndefined();
    expect(registry.find(undefined)).toBeUndefined();
  });

  it('accepts a third-party adapter through the same port', async () => {
    const custom: EidProvider = {
      id: 'id-me',
      format: 'eidas' as never,
      minimumAssurance: 'substantial',
      verify: async () => ({
        verified: true,
        provider: 'id-me',
        assertion: {
          subjectId: 'seller-777',
          fullName: 'Ines Ferreira',
          dateOfBirth: '1991-04-17',
          assurance: 'high',
          method: 'test',
          issuer: 'test',
          issuedAt: NOW.toISOString(),
          expiresAt: '2030-01-01T00:00:00.000Z',
          claims: {},
        },
      }),
    };
    const extended = new EidProviderRegistry([eidas, franceConnect, custom]);
    expect(extended.find('eidas')?.id).toBe('id-me');
    const result = await extended.find('eidas')?.verify({ format: 'eidas', assertion: 'x'.repeat(20) }, EXPECTED, NOW);
    expect(result?.verified).toBe(true);
    expect(extended.ids()).toEqual(['franceconnect', 'id-me']);
  });
});