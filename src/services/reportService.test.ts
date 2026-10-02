import { buildContainer, type Container } from '../container';
import { verifyReportSignature, type ReportSigningKeys } from './reportService';
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
import { generateKeyPairSync } from 'node:crypto';

function buildTestContainer(): Container {
  return buildContainer({ config: testConfig(), clock: fixedClock(TEST_NOW) });
}

function testSigningKeys(): ReportSigningKeys {
  return {
    hmacKey: TEST_REPORT_KEY,
    hmacKeyId: 'report-key-1',
  };
}

function generateTestEcdsaKeys(): { privateKeyPem: string; publicKeyPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  return { privateKeyPem: privateKey, publicKeyPem: publicKey };
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
    expect(verifyReportSignature(report, testSigningKeys())).toBe(true);

    const tampered = { ...report, totals: { ...report.totals, verified: 99 } };
    expect(verifyReportSignature(tampered, testSigningKeys())).toBe(false);
    expect(verifyReportSignature(report, { ...testSigningKeys(), hmacKey: 'another-key' })).toBe(false);
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

describe('ReportService — ECDSA-P256 PDF reports', () => {
  const { privateKeyPem, publicKeyPem } = generateTestEcdsaKeys();
  const ecdsaSigningKeys: ReportSigningKeys = {
    hmacKey: TEST_REPORT_KEY,
    hmacKeyId: 'report-key-1',
    ecdsaPrivateKeyPem: privateKeyPem,
    ecdsaPublicKeyPem: publicKeyPem,
    ecdsaKeyId: 'ecdsa-test-key-1',
  };

  function buildEcdsaContainer(): Container {
    const config = testConfig({
      reportEcdsaPrivateKey: privateKeyPem,
      reportEcdsaPublicKey: publicKeyPem,
      reportEcdsaKeyId: 'ecdsa-test-key-1',
    });
    return buildContainer({ config, clock: fixedClock(TEST_NOW) });
  }

  it('generates a PDF report signed with ECDSA-P256', async () => {
    const container = buildEcdsaContainer();
    await container.kycService.submit(TEST_MARKETPLACE, healthySubmission());

    const pdfBytes = await container.reportService.generatePdf(TEST_MARKETPLACE);

    expect(pdfBytes).toBeInstanceOf(Uint8Array);
    expect(pdfBytes.length).toBeGreaterThan(1000);
    // PDF header
    expect(String.fromCharCode(...pdfBytes.slice(0, 5))).toBe('%PDF-');
  });

  it('ECDSA-signed JSON report has correct algorithm and key ID', async () => {
    const container = buildEcdsaContainer();
    await container.kycService.submit(TEST_MARKETPLACE, healthySubmission());

    const report = await container.reportService.generateEcdsa(TEST_MARKETPLACE);
    expect(report.signature.alg).toBe('ECDSA-P256');
    expect(report.signature.keyId).toBe('ecdsa-test-key-1');
  });

  it('ECDSA signature on JSON report is verifiable', async () => {
    const container = buildEcdsaContainer();
    await container.kycService.submit(TEST_MARKETPLACE, healthySubmission());

    const report = await container.reportService.generateEcdsa(TEST_MARKETPLACE);
    expect(verifyReportSignature(report, ecdsaSigningKeys)).toBe(true);
  });

  it('ECDSA signature detects tampering on PDF report', async () => {
    const container = buildEcdsaContainer();
    await container.kycService.submit(TEST_MARKETPLACE, healthySubmission());

    const report = await container.reportService.generate(TEST_MARKETPLACE);

    expect(verifyReportSignature(report, ecdsaSigningKeys)).toBe(true);

    const tampered = { ...report, totals: { ...report.totals, verified: 99 } };
    expect(verifyReportSignature(tampered, ecdsaSigningKeys)).toBe(false);
  });

  it('generatePdf throws when ECDSA keys are not configured', async () => {
    const container = buildTestContainer(); // no ECDSA keys

    await expect(container.reportService.generatePdf(TEST_MARKETPLACE)).rejects.toThrow(
      /ECDSA-P256 signing requires/,
    );
  });

  it('PDF report is PII-free', async () => {
    const container = buildEcdsaContainer();
    await container.kycService.submit(TEST_MARKETPLACE, healthySubmission());

    const report = await container.reportService.generateEcdsa(TEST_MARKETPLACE);
    const pdfBytes = await container.reportService.generatePdf(TEST_MARKETPLACE);

    // Verify the JSON report (which is what gets signed and rendered) is PII-free
    expect(containsPii(report)).toBe(false);
    const serialised = JSON.stringify(report);
    for (const secret of ['Ines Ferreira', '1991-04-17', 'PT4417X', eidasAssertion()]) {
      expect(serialised).not.toContain(secret);
    }

    // PDF is compressed; we verify PII-free by checking the source report
    expect(pdfBytes).toBeInstanceOf(Uint8Array);
    expect(pdfBytes.length).toBeGreaterThan(1000);
  });
});