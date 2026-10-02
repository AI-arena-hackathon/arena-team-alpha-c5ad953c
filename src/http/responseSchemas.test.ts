import {
  healthResponseSchema,
  healthDetailsResponseSchema,
  kycSubmitResponseSchema,
  kycRecordResponseSchema,
  subjectHistoryResponseSchema,
  listingCheckResponseSchema,
  complianceReportResponseSchema,
  ledgerVerifyResponseSchema,
  ledgerAnchorResponseSchema,
  errorResponseSchema,
  schedulerSummarySchema,
  schedulerMetricsSchema,
} from './responseSchemas';
import { testConfig } from '../testing/fixtures';
import { buildContainer } from '../container';
import { healthySubmission, TEST_MARKETPLACE, TEST_NOW } from '../testing/fixtures';
import { fixedClock } from '../util/clock';

function buildTestContainer() {
  return buildContainer({
    config: testConfig(),
    clock: fixedClock(TEST_NOW),
    startedAt: new Date(TEST_NOW),
  });
}

describe('HTTP response schemas', () => {
  let container: ReturnType<typeof buildTestContainer>;

  beforeEach(() => {
    container = buildTestContainer();
  });

  describe('healthResponseSchema', () => {
    it('validates the /health response shape', () => {
      const response = {
        status: 'ok',
        service: 'nft-kyc-hub',
        version: '0.1.0',
        startedAt: TEST_NOW,
        now: TEST_NOW,
        environment: 'test',
        adapters: ['eidas-gateway', 'franceconnect'],
        sanctionsList: 'eu-consolidated',
        warnings: [],
      };
      expect(healthResponseSchema.parse(response)).toMatchObject(response);
    });

    it('rejects invalid status', () => {
      const response = {
        status: 'error',
        service: 'nft-kyc-hub',
        version: '0.1.0',
        startedAt: TEST_NOW,
        now: TEST_NOW,
        environment: 'test',
        adapters: [],
        sanctionsList: 'eu-consolidated',
        warnings: [],
      };
      expect(() => healthResponseSchema.parse(response)).toThrow();
    });
  });

  describe('healthDetailsResponseSchema', () => {
    it('validates the /v1/health/details response shape', () => {
      const response = {
        status: 'ok',
        ledger: {
          valid: true,
          length: 1,
          headHash: 'a'.repeat(64),
          brokenAtIndex: null,
          detail: 'every anchor links to its predecessor and matches its payload digest',
        },
        submissions: ['market-alpha'],
      };
      expect(healthDetailsResponseSchema.parse(response)).toMatchObject(response);
    });
  });

  describe('scheduler health schemas', () => {
    const summary = {
      enabled: true,
      lastRefreshStatus: 'failed' as const,
      lastRefreshAt: '2025-03-01T09:00:00.000Z',
      consecutiveFailures: 2,
      circuitBreakerState: 'open' as const,
      totalRefreshes: 7,
      totalFailures: 2,
      installedEntries: 412,
      minEntries: 1,
    };

    it('validates the sanctions refresh summary on /health', () => {
      const response = {
        status: 'ok',
        service: 'nft-kyc-hub',
        version: '0.1.0',
        startedAt: TEST_NOW,
        now: TEST_NOW,
        environment: 'test',
        adapters: ['eidas-gateway'],
        sanctionsList: 'eu-consolidated',
        warnings: [],
        sanctionsScheduler: summary,
      };

      expect(healthResponseSchema.parse(response).sanctionsScheduler).toEqual(summary);
    });

    it('accepts a null summary when no feed is configured', () => {
      const response = {
        status: 'ok',
        service: 'nft-kyc-hub',
        version: '0.1.0',
        startedAt: TEST_NOW,
        now: TEST_NOW,
        environment: 'test',
        adapters: ['eidas-gateway'],
        sanctionsList: 'eu-consolidated',
        warnings: [],
        sanctionsScheduler: null,
      };

      expect(healthResponseSchema.parse(response).sanctionsScheduler).toBeNull();
    });

    it('rejects an unknown breaker state', () => {
      expect(() => schedulerSummarySchema.parse({ ...summary, circuitBreakerState: 'ajar' })).toThrow();
    });

    it('rejects a negative failure count', () => {
      expect(() => schedulerSummarySchema.parse({ ...summary, totalFailures: -1 })).toThrow();
    });

    it('validates the full metrics on /v1/health/details', () => {
      const response = {
        status: 'ok',
        ledger: {
          valid: true,
          length: 1,
          headHash: 'a'.repeat(64),
          brokenAtIndex: null,
          detail: 'ok',
        },
        submissions: ['market-alpha'],
        sanctionsScheduler: {
          ...summary,
          url: 'https://example.test/sanctions.json',
          intervalMs: 86_400_000,
          lastError: 'Failed to fetch sanctions feed: 503 Service Unavailable',
          nextRefreshAt: '2025-03-01T10:00:00.000Z',
          circuitBreakerOpenedAt: '2025-03-01T09:00:00.000Z',
          circuitBreakerNextAttemptAt: '2025-03-01T09:10:00.000Z',
        },
      };

      const parsed = healthDetailsResponseSchema.parse(response);
      expect(parsed.sanctionsScheduler).toMatchObject({
        lastError: 'Failed to fetch sanctions feed: 503 Service Unavailable',
        circuitBreakerNextAttemptAt: '2025-03-01T09:10:00.000Z',
      });
    });

    it('rejects a metrics payload missing the refresh error slot', () => {
      const { lastError: _omitted, ...withoutError } = {
        ...summary,
        url: null,
        intervalMs: 86_400_000,
        lastError: 'boom',
        nextRefreshAt: null,
        circuitBreakerOpenedAt: null,
        circuitBreakerNextAttemptAt: null,
      };

      expect(() => schedulerMetricsSchema.parse(withoutError)).toThrow();
    });
  });

  describe('kycSubmitResponseSchema', () => {
    it('validates a successful KYC submission response', async () => {
      const { record } = await container.kycService.submit(TEST_MARKETPLACE, healthySubmission());

      const response = {
        submissionId: record.submissionId,
        subjectId: record.subjectId,
        status: record.status,
        decision: record.decision,
        risk: {
          score: record.risk.score,
          band: record.risk.band,
          modelVersion: record.risk.modelVersion,
          reasons: record.risk.features.map((item) => ({
            code: item.code,
            label: item.label,
            weight: item.weight,
            detail: item.detail,
          })),
          sanctionsHits: record.risk.sanctionsHits,
        },
        identity: record.identity,
        credentialDigest: record.credentialDigest,
        ledger: { index: 0, hash: record.ledgerAnchorHash },
        idempotentReplay: false,
        listingBlocked: record.status !== 'verified',
      };

      expect(kycSubmitResponseSchema.parse(response)).toMatchObject(response);
    });

    it('validates a rejected submission response', async () => {
      const { record } = await container.kycService.submit(TEST_MARKETPLACE, healthySubmission({
        subject: { ...healthySubmission().subject, fullName: 'Viktor Petrovich Morozov', dateOfBirth: '1971-03-14' },
        credential: { format: 'eidas', assertion: (await import('../identity/eidProvider')).signAssertion({
          iss: 'https://eidas-gateway.demo/issuer', sub: 'seller-777',
          name: 'Viktor Petrovich Morozov', birth_date: '1971-03-14',
          acr: 'high', aalink: 'passport',
          iat: '2025-02-28T10:00:00.000Z', exp: '2026-02-28T10:00:00.000Z',
        }, 'test-eidas-secret') },
      }));

      const response = {
        submissionId: record.submissionId,
        subjectId: record.subjectId,
        status: record.status,
        decision: record.decision,
        risk: {
          score: record.risk.score,
          band: record.risk.band,
          modelVersion: record.risk.modelVersion,
          reasons: record.risk.features.map((item) => ({
            code: item.code,
            label: item.label,
            weight: item.weight,
            detail: item.detail,
          })),
          sanctionsHits: record.risk.sanctionsHits,
        },
        identity: record.identity,
        credentialDigest: record.credentialDigest,
        ledger: { index: 0, hash: record.ledgerAnchorHash },
        idempotentReplay: false,
        listingBlocked: record.status !== 'verified',
      };

      expect(kycSubmitResponseSchema.parse(response)).toMatchObject(response);
    });
  });

  describe('kycRecordResponseSchema', () => {
    it('validates a KYC record response', async () => {
      const { record } = await container.kycService.submit(TEST_MARKETPLACE, healthySubmission());

      const response = {
        submissionId: record.submissionId,
        subjectId: record.subjectId,
        listingId: record.listingId,
        status: record.status,
        decision: record.decision,
        risk: {
          score: record.risk.score,
          band: record.risk.band,
          reasons: record.risk.features,
          sanctionsHits: record.risk.sanctionsHits,
          modelVersion: record.risk.modelVersion,
        },
        identity: record.identity,
        credentialDigest: record.credentialDigest,
        ledgerAnchorHash: record.ledgerAnchorHash,
        consentCapturedAt: record.consentCapturedAt,
        submittedAt: record.submittedAt,
        evaluatedAt: record.evaluatedAt,
        evidenceStored: 'encrypted' as const,
      };

      expect(kycRecordResponseSchema.parse(response)).toMatchObject(response);
    });
  });

  describe('subjectHistoryResponseSchema', () => {
    it('validates a subject history response', async () => {
      await container.kycService.submit(TEST_MARKETPLACE, healthySubmission({ submissionId: 'kyc_submission_aaa' }));

      const history = await container.kycService.getSubjectHistory(TEST_MARKETPLACE, 'seller-777');

      const response = {
        subjectId: 'seller-777',
        submissions: history.length,
        currentStatus: history[history.length - 1]?.status ?? 'unknown',
        history: history.map((record) => ({
          submissionId: record.submissionId,
          subjectId: record.subjectId,
          listingId: record.listingId,
          status: record.status,
          decision: record.decision,
          risk: {
            score: record.risk.score,
            band: record.risk.band,
            reasons: record.risk.features,
            sanctionsHits: record.risk.sanctionsHits,
            modelVersion: record.risk.modelVersion,
          },
          identity: record.identity,
          credentialDigest: record.credentialDigest,
          ledgerAnchorHash: record.ledgerAnchorHash,
          consentCapturedAt: record.consentCapturedAt,
          submittedAt: record.submittedAt,
          evaluatedAt: record.evaluatedAt,
          evidenceStored: 'encrypted' as const,
        })),
      };

      expect(subjectHistoryResponseSchema.parse(response)).toMatchObject(response);
    });
  });

  describe('listingCheckResponseSchema', () => {
    it('validates an allowed listing check response', async () => {
      await container.kycService.submit(TEST_MARKETPLACE, healthySubmission());
      const decision = await container.listingGate.check({
        marketplaceId: TEST_MARKETPLACE,
        listingId: 'listing-9001',
        subjectId: 'seller-777',
      });

      const response = {
        listingId: decision.listingId,
        marketplaceId: decision.marketplaceId,
        subjectId: decision.subjectId,
        allowed: decision.allowed,
        status: decision.status,
        reason: decision.reason,
        requiredAction: decision.requiredAction,
        riskScore: decision.riskScore,
        checkedAt: decision.checkedAt,
      };

      expect(listingCheckResponseSchema.parse(response)).toMatchObject(response);
    });

    it('validates a blocked listing check response', async () => {
      const decision = await container.listingGate.check({
        marketplaceId: TEST_MARKETPLACE,
        listingId: 'listing-9001',
        subjectId: 'unknown-seller',
      });

      const response = {
        listingId: decision.listingId,
        marketplaceId: decision.marketplaceId,
        subjectId: decision.subjectId,
        allowed: decision.allowed,
        status: decision.status,
        reason: decision.reason,
        requiredAction: decision.requiredAction,
        riskScore: decision.riskScore,
        checkedAt: decision.checkedAt,
      };

      expect(listingCheckResponseSchema.parse(response)).toMatchObject(response);
    });
  });

  describe('complianceReportResponseSchema', () => {
    it('validates a compliance report response', async () => {
      await container.kycService.submit(TEST_MARKETPLACE, healthySubmission());
      const report = await container.reportService.generate(TEST_MARKETPLACE, {});

      const response = {
        reportId: report.reportId,
        generatedAt: report.generatedAt,
        window: report.window,
        marketplaceId: report.marketplaceId,
        totals: report.totals,
        riskDistribution: report.riskDistribution,
        topRiskDrivers: report.topRiskDrivers,
        records: report.records,
        signature: report.signature,
        attestation: report.attestation,
      };

      expect(complianceReportResponseSchema.parse(response)).toMatchObject(response);
    });
  });

  describe('ledgerVerifyResponseSchema', () => {
    it('validates a ledger verify response', async () => {
      const chain = await container.ledger.verify();
      const response = {
        valid: chain.valid,
        length: chain.length,
        headHash: chain.headHash,
        brokenAtIndex: chain.brokenAtIndex,
        detail: chain.detail,
      };
      expect(ledgerVerifyResponseSchema.parse(response)).toMatchObject(response);
    });
  });

  describe('ledgerAnchorResponseSchema', () => {
    it('validates a ledger anchor response', async () => {
      const { record } = await container.kycService.submit(TEST_MARKETPLACE, healthySubmission());
      const anchor = container.ledger.find(record.ledgerAnchorHash);
      if (!anchor) throw new Error('anchor not found');

      const response = {
        index: anchor.index,
        type: anchor.type,
        subjectId: anchor.subjectId,
        submissionId: anchor.submissionId,
        marketplaceId: anchor.marketplaceId,
        credentialDigest: anchor.credentialDigest,
        decision: anchor.decision,
        riskScore: anchor.riskScore,
        payloadDigest: anchor.payloadDigest,
        prevHash: anchor.prevHash,
        hash: anchor.hash,
        createdAt: anchor.createdAt,
      };

      expect(ledgerAnchorResponseSchema.parse(response)).toMatchObject(response);
    });
  });

  describe('errorResponseSchema', () => {
    it('validates an error response', () => {
      const response = {
        error: 'validation_failed',
        message: 'Request body validation failed',
        details: { field: 'subject.dateOfBirth', issue: 'must be an ISO date' },
      };
      expect(errorResponseSchema.parse(response)).toMatchObject(response);
    });

    it('validates an error response without details', () => {
      const response = {
        error: 'unauthorized',
        message: 'Invalid API key',
      };
      expect(errorResponseSchema.parse(response)).toMatchObject(response);
    });
  });
});