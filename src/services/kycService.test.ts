import { buildContainer, type Container } from '../container';
import type { KycSubmissionInput } from '../domain/types';
import { SubmissionValidationError } from './kycService';
import {
  eidasAssertion,
  franceConnectAssertion,
  healthySubmission,
  TEST_MARKETPLACE,
  TEST_NOW,
  testConfig,
} from '../testing/fixtures';
import { fixedClock } from '../util/clock';
import { containsPii, findPiiPaths } from '../security/redaction';

function buildTestContainer(): Container {
  return buildContainer({
    config: testConfig(),
    clock: fixedClock(TEST_NOW),
    startedAt: new Date(TEST_NOW),
  });
}

async function submit(
  container: Container,
  overrides: Partial<KycSubmissionInput> = {},
  marketplaceId = TEST_MARKETPLACE,
) {
  return container.kycService.submit(marketplaceId, healthySubmission(overrides));
}

describe('KycService.submit — verified creator', () => {
  it('approves a verified low-risk seller and returns an explainable record', async () => {
    const container = buildTestContainer();
    const { record, idempotentReplay, ledgerAnchor } = await submit(container);

    expect(idempotentReplay).toBe(false);
    expect(record.status).toBe('verified');
    expect(record.decision).toBe('approve');
    expect(record.risk.score).toBe(0);
    expect(record.risk.band).toBe('low');
    expect(record.risk.features).toHaveLength(0);
    expect(record.identity).toMatchObject({
      provider: 'eidas-gateway',
      assurance: 'high',
      method: 'eidas-aalink:passport',
    });
    expect(record.submissionId).toBe('kyc_submission_0001');
    expect(record.subjectId).toBe('seller-777');
    expect(record.listingId).toBe('listing-9001');
    expect(record.evaluatedAt).toBe(TEST_NOW);
    expect(ledgerAnchor.index).toBe(0);
    expect(record.ledgerAnchorHash).toBe(ledgerAnchor.hash);
  });

  it('accepts the second vendor adapter through the same service', async () => {
    const container = buildTestContainer();
    const { record } = await submit(container, {
      submissionId: 'kyc_submission_fc',
      credential: { format: 'franceconnect', assertion: franceConnectAssertion() },
    });
    expect(record.status).toBe('verified');
    expect(record.identity.provider).toBe('franceconnect');
    expect(record.identity.assurance).toBe('substantial');
  });

  it('stores personal data only inside the encrypted envelope', async () => {
    const container = buildTestContainer();
    const { record } = await submit(container);

    const plaintext = container.cipher.decrypt(record.personalDataEnvelope, record.submissionId) as Record<
      string,
      unknown
    >;
    expect(plaintext).toMatchObject({
      fullName: 'Ines Ferreira',
      dateOfBirth: '1991-04-17',
      assertedMethod: 'eidas-aalink:passport',
    });

    // The record minus its envelope must carry no personal data at all.
    const { personalDataEnvelope, ...rest } = record;
    expect(findPiiPaths(rest)).toEqual([]);
    expect(JSON.stringify(rest)).not.toContain('Ines Ferreira');
    expect(JSON.stringify(rest)).not.toContain('PT4417X');
    expect(personalDataEnvelope.alg).toBe('aes-256-gcm');
  });

  it('anchors the salted credential digest on the ledger without the credential', async () => {
    const container = buildTestContainer();
    const { record, ledgerAnchor } = await submit(container);
    const anchors = container.ledger.all();

    expect(anchors).toHaveLength(1);
    expect(anchors[0].type).toBe('kyc_proof');
    expect(anchors[0].hash).toBe(ledgerAnchor.hash);
    expect(anchors[0].credentialDigest).toBe(record.credentialDigest);
    const serialised = JSON.stringify(anchors);
    expect(serialised).not.toContain(eidasAssertion());
    expect(findPiiPaths(anchors)).toEqual([]);
  });

  it('produces a different credential digest for a different salt', async () => {
    const first = buildTestContainer();
    const second = buildContainer({
      config: testConfig({ credentialHashSalt: 'a-completely-different-salt' }),
      clock: fixedClock(TEST_NOW),
    });
    const a = await submit(first);
    const b = await submit(second);
    expect(a.record.credentialDigest).not.toBe(b.record.credentialDigest);
    expect(a.record.subjectId).toBe(b.record.subjectId);
  });

  it('retrieves the record by submission id, scoped to the marketplace', async () => {
    const container = buildTestContainer();
    const { record } = await submit(container);
    expect((await container.kycService.getRecord(TEST_MARKETPLACE, record.submissionId))?.status).toBe(
      'verified',
    );
    expect(await container.kycService.getRecord('other-market', record.submissionId)).toBeUndefined();
    expect(await container.kycService.getRecord(TEST_MARKETPLACE, 'unknown-submission')).toBeUndefined();
  });
});

describe('KycService.submit — risk outcomes', () => {
  it('rejects and freezes a sanctioned seller, and writes a sanctions notice anchor', async () => {
    const container = buildTestContainer();
    const { record } = await submit(container, {
      submissionId: 'kyc_submission_sanctioned',
      subject: {
        ...healthySubmission().subject,
        fullName: 'Viktor Petrovich Morozov',
        dateOfBirth: '1971-03-14',
      },
      credential: { format: 'eidas', assertion: eidasAssertion({ name: 'Viktor Petrovich Morozov', birth_date: '1971-03-14' }) },
    });

    expect(record.status).toBe('rejected');
    expect(record.decision).toBe('reject');
    expect(record.risk.score).toBe(100);
    expect(record.risk.sanctionsHits[0].reference).toBe('EU-2024-0001');

    const notices = container.ledger.all().filter((entry) => entry.type === 'sanctions_notice');
    expect(notices).toHaveLength(1);
    expect(notices[0].decision).toBe('reject');
  });

  it('rejects when the e-ID credential does not verify', async () => {
    const container = buildTestContainer();
    const { record } = await submit(container, {
      credential: { format: 'eidas', assertion: eidasAssertion({}, 'forged-secret') },
    });
    expect(record.status).toBe('rejected');
    expect(record.identity.assurance).toBe('none');
    expect(record.risk.overrides.map((item) => item.code)).toContain('IDENTITY_NOT_VERIFIED');
  });

  it('rejects a submission with no credential at all', async () => {
    const container = buildTestContainer();
    const { record } = await submit(container, { credential: undefined });
    expect(record.status).toBe('rejected');
    expect(record.risk.overrides[0].detail).toMatch(/credential_missing/);
  });

  it('routes a politically exposed seller to review with the reason recorded', async () => {
    const container = buildTestContainer();
    const { record } = await submit(container, {
      claims: { politicallyExposed: true, sourceOfFunds: 'business_revenue' },
    });
    expect(record.status).toBe('review');
    expect(record.decision).toBe('review');
    expect(record.risk.features.map((item) => item.code)).toContain('PEP_DECLARED');
  });

  it('rejects a minor even with a valid credential', async () => {
    const container = buildTestContainer();
    const { record } = await submit(container, {
      subject: { ...healthySubmission().subject, dateOfBirth: '2012-05-05' },
      credential: { format: 'eidas', assertion: eidasAssertion({ birth_date: '2012-05-05' }) },
    });
    expect(record.status).toBe('rejected');
    expect(record.risk.overrides.map((item) => item.code)).toContain('SUBJECT_UNDER_AGE');
  });

  it('flags a subject whose declared identity contradicts the e-ID assertion', async () => {
    const container = buildTestContainer();
    const { record } = await submit(container, {
      subject: { ...healthySubmission().subject, dateOfBirth: '1990-01-01' },
    });
    expect(record.status).toBe('review');
    expect(record.risk.features.map((item) => item.code)).toContain('DOB_MISMATCH');
  });
});

describe('KycService.submit — idempotency', () => {
  it('returns the original record for a repeated submission id', async () => {
    const container = buildTestContainer();
    const first = await submit(container);
    const second = await submit(container);

    expect(second.idempotentReplay).toBe(true);
    expect(second.record.credentialDigest).toBe(first.record.credentialDigest);
    expect(second.record.evaluatedAt).toBe(first.record.evaluatedAt);
    expect(container.ledger.length).toBe(1);
  });

  it('refuses to reuse a submission id for a different payload', async () => {
    const container = buildTestContainer();
    await submit(container);
    await expect(
      container.kycService.submit(TEST_MARKETPLACE, healthySubmission({ listingId: 'listing-other' })),
    ).rejects.toThrow(SubmissionValidationError);
  });

  it('keeps the same submission id isolated per marketplace', async () => {
    const container = buildTestContainer();
    await submit(container, {}, TEST_MARKETPLACE);
    const other = await submit(container, {}, 'market-beta');
    expect(other.idempotentReplay).toBe(false);
    expect(other.record.marketplaceId).toBe('market-beta');
  });

  it('generates a submission id when the partner omits one', async () => {
    const container = buildTestContainer();
    const submission = healthySubmission();
    delete submission.submissionId;
    const { record } = await container.kycService.submit(TEST_MARKETPLACE, submission);
    expect(record.submissionId).toMatch(/^kyc_[0-9a-f]{32}$/);
  });
});

describe('KycService.submit — input validation', () => {
  const container = buildTestContainer();

  it.each([
    ['consent not granted', { consent: { granted: false as never, capturedAt: '2025-02-28T12:00:00.000Z' } }, 'consent.granted'],
    [
      'malformed date of birth',
      { subject: { ...healthySubmission().subject, dateOfBirth: '17-04-1991' } },
      'subject.dateOfBirth',
    ],
    [
      'malformed document expiry',
      { subject: { ...healthySubmission().subject, document: { ...healthySubmission().subject.document, expiresOn: 'soon' } } },
      'subject.document.expiresOn',
    ],
    [
      'wallet address that is not a wallet',
      { subject: { ...healthySubmission().subject, wallet: { ...healthySubmission().subject.wallet, address: 'not-a-wallet' } } },
      'subject.wallet.address',
    ],
    [
      'negative wallet counters',
      { subject: { ...healthySubmission().subject, wallet: { ...healthySubmission().subject.wallet, volumeUsd: -1 } } },
      'subject.wallet',
    ],
    [
      'wallet first seen in the wrong format',
      { subject: { ...healthySubmission().subject, wallet: { ...healthySubmission().subject.wallet, firstSeenAt: 'last year' } } },
      'subject.wallet.firstSeenAt',
    ],
    [
      'consent timestamp in the wrong format',
      { consent: { granted: true, capturedAt: 'yesterday' } },
      'consent.capturedAt',
    ],
  ])('rejects %s', async (_label, overrides, field) => {
    await expect(submit(container, overrides as Partial<KycSubmissionInput>)).rejects.toMatchObject({
      name: 'SubmissionValidationError',
      field,
    });
  });

  it('writes nothing to the ledger or repository when validation fails', async () => {
    const local = buildTestContainer();
    await expect(
      submit(local, { consent: { granted: false as never, capturedAt: TEST_NOW } }),
    ).rejects.toThrow();
    expect(local.ledger.length).toBe(0);
    expect(await local.kycService.getSubjectHistory(TEST_MARKETPLACE, 'seller-777')).toHaveLength(0);
  });
});

describe('KycService decision logging', () => {
  it('logs an auditable, PII-free summary of every decision', async () => {
    const info = jest.fn();
    const container = buildContainer({ config: testConfig(), clock: fixedClock(TEST_NOW), logger: { info } });

    await container.kycService.submit(TEST_MARKETPLACE, healthySubmission());

    expect(info).toHaveBeenCalledTimes(1);
    const [message, summary] = info.mock.calls[0] as [string, Record<string, unknown>];
    expect(message).toBe('[kyc] submission evaluated');
    expect(summary).toMatchObject({
      submissionId: 'kyc_submission_0001',
      marketplaceId: TEST_MARKETPLACE,
      subjectId: 'seller-777',
      status: 'verified',
      decision: 'approve',
      riskScore: 0,
      sanctionsHits: 0,
      evaluatedAt: TEST_NOW,
    });
    const serialised = JSON.stringify(summary);
    expect(serialised).not.toContain('Ines Ferreira');
    expect(serialised).not.toContain('PT4417X');
    expect(containsPii(summary)).toBe(false);
  });

  it('records the reason codes that caused an escalation', async () => {
    const info = jest.fn();
    const container = buildContainer({ config: testConfig(), clock: fixedClock(TEST_NOW), logger: { info } });
    await container.kycService.submit(
      TEST_MARKETPLACE,
      healthySubmission({ claims: { politicallyExposed: true } }),
    );
    const summary = info.mock.calls[0][1] as Record<string, unknown>;
    expect(summary.status).toBe('review');
    expect(summary.reasonCodes).toEqual(['PEP_DECLARED', 'SOURCE_OF_FUNDS_UNKNOWN']);
  });

  it('runs without a logger configured', async () => {
    const container = buildTestContainer();
    await expect(submit(container)).resolves.toBeDefined();
  });
});

describe('KycService.getSubjectHistory', () => {
  it('returns submissions oldest first', async () => {
    const clock = fixedClock(TEST_NOW);
    const container = buildContainer({ config: testConfig(), clock });
    await submit(container, { submissionId: 'kyc_submission_aaa' });
    clock.advance(60_000);
    await submit(container, { submissionId: 'kyc_submission_bbb' });

    const history = await container.kycService.getSubjectHistory(TEST_MARKETPLACE, 'seller-777');
    expect(history.map((record) => record.submissionId)).toEqual([
      'kyc_submission_aaa',
      'kyc_submission_bbb',
    ]);
  });
});