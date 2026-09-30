import type { IdentityVerificationFailure, IdentityVerificationSuccess } from '../domain/types';
import { MODEL_VERSION, RiskEngine, THRESHOLDS, type RiskEngineInput } from './engine';
import { SanctionsScreener } from './sanctions';

const NOW = new Date('2025-03-01T09:00:00.000Z');

const verifiedIdentity: IdentityVerificationSuccess = {
  verified: true,
  provider: 'eidas-gateway',
  assertion: {
    subjectId: 'seller-777',
    fullName: 'Ines Ferreira',
    dateOfBirth: '1991-04-17',
    assurance: 'high',
    method: 'eidas-aalink:passport',
    issuer: 'https://eidas-gateway.demo/issuer',
    issuedAt: '2025-02-28T10:00:00.000Z',
    expiresAt: '2026-02-28T10:00:00.000Z',
    claims: { acr: 'high' },
  },
};

const failedIdentity: IdentityVerificationFailure = {
  verified: false,
  reason: 'signature_invalid',
  detail: 'assertion signature does not verify',
  provider: 'eidas-gateway:eidas',
};

function input(overrides: Partial<RiskEngineInput> = {}): RiskEngineInput {
  return {
    subjectId: 'seller-777',
    fullName: 'Ines Ferreira',
    dateOfBirth: '1991-04-17',
    countryCode: 'PT',
    documentType: 'passport',
    documentExpiresOn: '2031-04-16',
    wallet: {
      address: '0x' + '1'.repeat(40),
      firstSeenAt: '2021-06-01T00:00:00.000Z',
      transactionCount: 412,
      volumeUsd: 48_000,
    },
    claims: { politicallyExposed: false, sourceOfFunds: 'salary' },
    identity: verifiedIdentity,
    consentGranted: true,
    now: NOW,
    ...overrides,
  };
}

describe('RiskEngine', () => {
  const engine = new RiskEngine();

  it('approves a verified, low-risk EU creator with no risk reasons', () => {
    const assessment = engine.assess(input());
    expect(assessment.score).toBe(0);
    expect(assessment.band).toBe('low');
    expect(assessment.decision).toBe('approve');
    expect(assessment.features).toHaveLength(0);
    expect(assessment.overrides).toHaveLength(0);
    expect(assessment.modelVersion).toBe(MODEL_VERSION);
    expect(assessment.assessedAt).toBe(NOW.toISOString());
  });

  it('rejects and reports the programme when a sanctioned name matches', () => {
    const assessment = engine.assess(
      input({ fullName: 'Viktor Petrovich Morozov', dateOfBirth: '1971-03-14' }),
    );
    expect(assessment.decision).toBe('reject');
    expect(assessment.score).toBe(100);
    expect(assessment.sanctionsHits).toHaveLength(1);
    expect(assessment.overrides.map((item) => item.code)).toContain('SANCTIONS_MATCH');
    expect(assessment.overrides[0].detail).toContain('EU 833/2014');
  });

  it('rejects when the e-ID assertion cannot be verified, whatever the other features say', () => {
    const assessment = engine.assess(input({ identity: failedIdentity }));
    expect(assessment.decision).toBe('reject');
    expect(assessment.overrides.map((item) => item.code)).toEqual(['IDENTITY_NOT_VERIFIED']);
    expect(assessment.overrides[0].detail).toContain('signature_invalid');
  });

  it('refuses to process a subject without recorded consent', () => {
    const assessment = engine.assess(input({ consentGranted: false }));
    expect(assessment.decision).toBe('reject');
    expect(assessment.overrides.map((item) => item.code)).toContain('CONSENT_MISSING');
  });

  it('refuses a minor', () => {
    const assessment = engine.assess(input({ dateOfBirth: '2015-01-01' }));
    expect(assessment.decision).toBe('reject');
    expect(assessment.overrides.map((item) => item.code)).toContain('SUBJECT_UNDER_AGE');
  });

  it('routes a politically exposed person to human review rather than auto-refusal', () => {
    const assessment = engine.assess(input({ claims: { politicallyExposed: true } }));
    expect(assessment.decision).toBe('review');
    expect(assessment.overrides).toHaveLength(0);
    expect(assessment.features.map((item) => item.code)).toContain('PEP_DECLARED');
  });

  it.each([
    ['HIGH_RISK_JURISDICTION', { countryCode: 'IR' }, 'review'],
    ['DOCUMENT_EXPIRED', { documentExpiresOn: '2024-01-01' }, 'review'],
    ['NEW_WALLET', { wallet: { ...input().wallet, firstSeenAt: '2025-02-28T00:00:00.000Z' } }, 'score'],
    ['LOW_WALLET_ACTIVITY', { wallet: { ...input().wallet, transactionCount: 1 } }, 'score'],
    ['HIGH_WALLET_VOLUME', { wallet: { ...input().wallet, volumeUsd: 900_000 } }, 'review'],
    ['SOURCE_OF_FUNDS_UNKNOWN', { claims: {} }, 'score'],
    ['NON_EEA_SUBJECT', { countryCode: 'US' }, 'score'],
    ['ELEVATED_RISK_JURISDICTION', { countryCode: 'RU' }, 'score'],
    ['DOCUMENT_EXPIRING', { documentExpiresOn: '2025-03-15' }, 'score'],
  ])('raises %s as an explainable feature', (code, overrides, severity) => {
    const assessment = engine.assess(input(overrides as Partial<RiskEngineInput>));
    const found = assessment.features.find((item) => item.code === code);
    expect(found).toBeDefined();
    expect(found?.detail).toBeTruthy();
    expect(found?.weight).toBeGreaterThan(0);
    expect(found?.severity).toBe(severity);
  });

  it.each([
    ['an expired document alone', { documentExpiresOn: '2024-01-01' }],
    ['a single name mismatch alone', { fullName: 'Someone Entirely Else' }],
    ['a single high-risk jurisdiction alone', { countryCode: 'KP' }],
  ])('routes %s to review regardless of the weighted total', (_label, overrides) => {
    const assessment = engine.assess(input(overrides as Partial<RiskEngineInput>));
    expect(assessment.decision).toBe('review');
    expect(assessment.overrides).toHaveLength(0);
  });

  it('proves the score threshold alone is not what escalates a non-aggregable signal', () => {
    // 25 points, far below the review threshold: the decision is still "review"
    // because DOCUMENT_EXPIRED is a review-only signal.
    const assessment = engine.assess(input({ documentExpiresOn: '2024-01-01' }));
    expect(assessment.score).toBe(25);
    expect(assessment.score).toBeLessThan(THRESHOLDS.reviewAt);
    expect(assessment.band).toBe('low');
    expect(assessment.decision).toBe('review');
  });

  it('flags a name that differs from the e-ID assertion', () => {
    const assessment = engine.assess(input({ fullName: 'Ines Ferreira-Silva' }));
    expect(assessment.features.map((item) => item.code)).toContain('NAME_MISMATCH');
    expect(assessment.decision).toBe('review');
  });

  it('does not treat punctuation, case or word order as a name mismatch', () => {
    for (const variant of ['FERREIRA, Ines', 'ines  ferreira', 'Inés Ferreira']) {
      const assessment = engine.assess(input({ fullName: variant }));
      expect(assessment.features.map((item) => item.code)).not.toContain('NAME_MISMATCH');
    }
  });

  it('flags a date of birth that differs from the e-ID assertion', () => {
    const assessment = engine.assess(input({ dateOfBirth: '1991-04-18' }));
    expect(assessment.features.map((item) => item.code)).toContain('DOB_MISMATCH');
  });

  it('escalates to the high band once the cumulative score crosses the threshold', () => {
    const assessment = engine.assess(
      input({
        countryCode: 'RU',
        documentExpiresOn: '2025-03-10',
        wallet: { ...input().wallet, firstSeenAt: '2025-02-28T00:00:00.000Z', transactionCount: 1 },
        claims: { sourceOfFunds: 'unknown' },
      }),
    );
    expect(assessment.score).toBeGreaterThanOrEqual(THRESHOLDS.highAt);
    expect(assessment.band).toBe('high');
    expect(assessment.decision).toBe('review');
  });

  it('never returns a score outside 0-100', () => {
    const worst = engine.assess(
      input({
        fullName: 'Viktor Petrovich Morozov',
        dateOfBirth: '1971-03-14',
        countryCode: 'KP',
        claims: { politicallyExposed: true, sourceOfFunds: 'unknown' },
        wallet: { ...input().wallet, firstSeenAt: '2025-02-28T00:00:00.000Z', transactionCount: 0, volumeUsd: 5_000_000 },
      }),
    );
    expect(worst.score).toBe(100);
    expect(worst.band).toBe('high');
  });

  it('uses the configured screener, so the list in force decides the outcome', () => {
    const emptyListEngine = new RiskEngine(new SanctionsScreener([], 'empty-list'));
    const clean = emptyListEngine.assess(input());
    expect(clean.sanctionsHits).toHaveLength(0);
    expect(clean.decision).toBe('approve');

    const listedNameEngine = new RiskEngine(
      new SanctionsScreener(
        [{ reference: 'EU-TEST', name: 'Ines Ferreira', programme: 'test programme', listName: 'custom' }],
        'custom',
      ),
    );
    const blocked = listedNameEngine.assess(input());
    expect(blocked.sanctionsHits).toHaveLength(1);
    expect(blocked.decision).toBe('reject');
  });

  it('is deterministic for identical inputs', () => {
    const first = engine.assess(input({ claims: { politicallyExposed: true } }));
    const second = engine.assess(input({ claims: { politicallyExposed: true } }));
    expect(first).toEqual(second);
  });
});