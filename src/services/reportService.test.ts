import { buildContainer, type Container } from '../container';
import { verifyReportSignature } from './reportService';
import {
  eidasAssertion,
  healthySubmission,
  TEST_MARKETPLACE,
  TEST_NOW,
  TEST_REPORT_KEY,
  testConfig,
} from '../testing/fixtures';
import { containsPii } from '../security/redaction';
import { fixedClock } from '../util/clock';

function buildTestContainer(): Container {
  return buildContainer({ config: testConfig(), clock: fixedClock(TEST_NOW) });
}

describe('ReportService', () => {
  it('reports an empty period without dividing by zero', async () => {
    const container = buildTestContainer();
    const report = await container.reportService.generate(TEST_MARKETPLACE);

    expect(report.totals).toEqual({
      submissions: 0,
      verified: 0,
      review: 0,
      rejected: 0,
      blockedListings: 0,
      sanctionsHits: 0,
      averageRiskScore: 0,
    });
    expect(report.riskDistribution).toEqual({ low: 0, medium: 0, high: 0 });
    expect(report.records).toEqual([]);
  });

  it('aggregates decisions, risk bands and blocked listings', async () => {
    const container = buildTestContainer();
    await container.kycService.submit(TEST_MARKETPLACE, healthySubmission({ submissionId: 'kyc_approved_01' }));
    await container.kycService.submit(
      TEST_MARKETPLACE,
      healthySubmission({
        submissionId: 'kyc_pep_0001',
        claims: { politicallyExposed: true },
      }),
    );
    await container.kycService.submit(
      TEST_MARKETPLACE,
      healthySubmission({
        submissionId: 'kyc_forged_01',
        credential: { format: 'eidas', assertion: eidasAssertion({}, 'forged-secret') },
      }),
    );
    await container.listingGate.check({ marketplaceId: TEST_MARKETPLACE, listingId: 'listing-1', subjectId: 'seller-777' });
    await container.listingGate.check({ marketplaceId: TEST_MARKETPLACE, listingId: 'listing-2', subjectId: 'seller-nobody' });

    const report = await container.reportService.generate(TEST_MARKETPLACE);

    expect(report.totals).toMatchObject({
      submissions: 3,
      verified: 1,
      review: 1,
      rejected: 1,
      blockedListings: 2,
      averageRiskScore: 54,
    });
    expect(report.riskDistribution).toEqual({ low: 1, medium: 1, high: 1 });
    expect(report.records.map((record) => record.status)).toEqual(['verified', 'review', 'rejected']);
    expect(report.topRiskDrivers[0]).toMatchObject({ code: 'IDENTITY_NOT_VERIFIED', occurrences: 1 });
  });

  it('quotes evidence as credential digest and ledger anchor hash', async () => {
    const container = buildTestContainer();
    const { record } = await container.kycService.submit(TEST_MARKETPLACE, healthySubmission());
    const report = await container.reportService.generate(TEST_MARKETPLACE);

    expect(report.records[0]).toMatchObject({
      submissionId: record.submissionId,
      subjectId: 'seller-777',
      credentialDigest: record.credentialDigest,
      ledgerHash: record.ledgerAnchorHash,
      decidedAt: TEST_NOW,
    });
    expect(container.ledger.find(record.ledgerAnchorHash)).toBeDefined();
  });

  it('contains no personal data anywhere in the report', async () => {
    const container = buildTestContainer();
    await container.kycService.submit(TEST_MARKETPLACE, healthySubmission());
    const report = await container.reportService.generate(TEST_MARKETPLACE);

    expect(containsPii(report)).toBe(false);
    const serialised = JSON.stringify(report);
    for (const secret of ['Ines Ferreira', '1991-04-17', 'PT4417X', eidasAssertion()]) {
      expect(serialised).not.toContain(secret);
    }
    expect(report.attestation).toMatch(/no personal data/i);
  });

  it('signs the report so tampering is detectable', async () => {
    const container = buildTestContainer();
    await container.kycService.submit(TEST_MARKETPLACE, healthySubmission());
    const report = await container.reportService.generate(TEST_MARKETPLACE);

    expect(report.signature.alg).toBe('HMAC-SHA256');
    expect(verifyReportSignature(report, TEST_REPORT_KEY)).toBe(true);

    const tampered = { ...report, totals: { ...report.totals, verified: 99 } };
    expect(verifyReportSignature(tampered, TEST_REPORT_KEY)).toBe(false);
    expect(verifyReportSignature(report, 'another-key')).toBe(false);
  });

  it('honours an explicit reporting window', async () => {
    const clock = fixedClock('2025-03-10T00:00:00.000Z');
    const container = buildContainer({ config: testConfig(), clock });
    await container.kycService.submit(TEST_MARKETPLACE, healthySubmission({ submissionId: 'kyc_in_window' }));

    const report = await container.reportService.generate(TEST_MARKETPLACE, {
      from: '2025-03-01T00:00:00.000Z',
      to: '2025-03-31T00:00:00.000Z',
    });
    expect(report.totals.submissions).toBe(1);
    expect(report.window).toEqual({
      from: '2025-03-01T00:00:00.000Z',
      to: '2025-03-31T00:00:00.000Z',
    });
  });

  it('excludes submissions outside the window', async () => {
    const clock = fixedClock('2025-03-01T00:00:00.000Z');
    const container = buildContainer({ config: testConfig(), clock });
    await container.kycService.submit(TEST_MARKETPLACE, healthySubmission({ submissionId: 'kyc_before' }));
    clock.advance(20 * 24 * 60 * 60 * 1000);
    await container.kycService.submit(TEST_MARKETPLACE, healthySubmission({ submissionId: 'kyc_inside' }));

    const report = await container.reportService.generate(TEST_MARKETPLACE, {
      from: '2025-03-05T00:00:00.000Z',
      to: '2025-03-25T00:00:00.000Z',
    });
    expect(report.records.map((record) => record.submissionId)).toEqual(['kyc_inside']);
  });

  it('rejects an impossible window', async () => {
    const container = buildTestContainer();
    await expect(
      container.reportService.generate(TEST_MARKETPLACE, {
        from: '2025-04-01T00:00:00.000Z',
        to: '2025-03-01T00:00:00.000Z',
      }),
    ).rejects.toThrow(/must not be after/);
    await expect(
      container.reportService.generate(TEST_MARKETPLACE, { from: 'not-a-date' }),
    ).rejects.toThrow(/valid ISO/);
  });

  it('only reports the calling marketplace', async () => {
    const container = buildTestContainer();
    await container.kycService.submit(TEST_MARKETPLACE, healthySubmission({ submissionId: 'kyc_alpha' }));
    await container.kycService.submit('market-beta', healthySubmission({ submissionId: 'kyc_beta' }));

    const report = await container.reportService.generate('market-beta');
    expect(report.marketplaceId).toBe('market-beta');
    expect(report.records.map((record) => record.submissionId)).toEqual(['kyc_beta']);
  });
});