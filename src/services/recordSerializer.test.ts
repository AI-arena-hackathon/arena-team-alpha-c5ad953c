import { recordSerializer } from '../services/recordSerializer';
import { healthySubmission, testConfig, TEST_NOW } from '../testing/fixtures';
import { buildContainer } from '../container';
import { fixedClock } from '../util/clock';
import type { KycRecord } from '../domain/types';

function buildTestContainer() {
  return buildContainer({
    config: testConfig(),
    clock: fixedClock(TEST_NOW),
    startedAt: new Date(TEST_NOW),
  });
}

async function createTestRecord(): Promise<KycRecord> {
  const container = buildTestContainer();
  const { record } = await container.kycService.submit('market-alpha', healthySubmission());
  return record;
}

describe('KycRecordSerializer', () => {
  let record: KycRecord;

  beforeAll(async () => {
    record = await createTestRecord();
  });

  describe('toPublicRecord', () => {
    it('returns a PII-free record for API responses', () => {
      const publicRecord = recordSerializer.toPublicRecord(record);

      expect(publicRecord).toMatchObject({
        submissionId: record.submissionId,
        subjectId: record.subjectId,
        status: record.status,
        decision: record.decision,
        credentialDigest: record.credentialDigest,
        ledgerAnchorHash: record.ledgerAnchorHash,
        consentCapturedAt: record.consentCapturedAt,
        submittedAt: record.submittedAt,
        evaluatedAt: record.evaluatedAt,
        evidenceStored: 'encrypted',
      });
      expect(publicRecord.risk).toMatchObject({
        score: record.risk.score,
        band: record.risk.band,
        modelVersion: record.risk.modelVersion,
      });
      expect(publicRecord.identity).toEqual(record.identity);
    });

    it('excludes the encrypted personal data envelope', () => {
      const publicRecord = recordSerializer.toPublicRecord(record);
      expect('personalDataEnvelope' in publicRecord).toBe(false);
    });

    it('includes listingId when present', () => {
      const publicRecord = recordSerializer.toPublicRecord(record);
      expect(publicRecord.listingId).toBe('listing-9001');
    });

    it('serializes risk reasons with full detail', () => {
      const publicRecord = recordSerializer.toPublicRecord(record);
      expect(publicRecord.risk.reasons).toEqual(
        record.risk.features.map((item) => ({
          code: item.code,
          label: item.label,
          weight: item.weight,
          detail: item.detail,
        })),
      );
    });

    it('contains no PII fields', () => {
      const publicRecord = recordSerializer.toPublicRecord(record);
      recordSerializer.assertNoPii(publicRecord, 'public record');
    });
  });

  describe('toLogSummary', () => {
    it('returns a PII-free summary for structured logging', () => {
      const summary = recordSerializer.toLogSummary(record);

      expect(summary).toMatchObject({
        submissionId: record.submissionId,
        subjectId: record.subjectId,
        status: record.status,
        decision: record.decision,
        riskScore: record.risk.score,
        riskBand: record.risk.band,
        reasonCodes: record.risk.features.map((item) => item.code),
        sanctionsHits: record.risk.sanctionsHits.length,
        ledgerHash: record.ledgerAnchorHash,
        evaluatedAt: record.evaluatedAt,
      });
    });

    it('includes marketplaceId', () => {
      const summary = recordSerializer.toLogSummary(record);
      expect(summary.marketplaceId).toBe('market-alpha');
    });

    it('contains no PII fields', () => {
      const summary = recordSerializer.toLogSummary(record);
      recordSerializer.assertNoPii(summary, 'log summary');
    });
  });

  describe('toReportRecord', () => {
    it('returns minimal evidence for compliance reports', () => {
      const reportRecord = recordSerializer.toReportRecord(record);

      expect(reportRecord).toMatchObject({
        submissionId: record.submissionId,
        subjectId: record.subjectId,
        status: record.status,
        riskScore: record.risk.score,
        riskBand: record.risk.band,
        credentialDigest: record.credentialDigest,
        ledgerHash: record.ledgerAnchorHash,
        decidedAt: record.evaluatedAt,
      });
    });

    it('contains no PII fields', () => {
      const reportRecord = recordSerializer.toReportRecord(record);
      recordSerializer.assertNoPii(reportRecord, 'report record');
    });
  });

  describe('serializeForReport', () => {
    it('serializes multiple records for compliance reports', () => {
      const records = [record];
      const serialized = recordSerializer.serializeForReport(records);

      expect(serialized).toHaveLength(1);
      expect(serialized[0]).toMatchObject({
        submissionId: record.submissionId,
        subjectId: record.subjectId,
      });
    });

    it('contains no PII fields in any record', () => {
      const records = [record];
      const serialized = recordSerializer.serializeForReport(records);
      recordSerializer.assertNoPii(serialized, 'report records array');
    });
  });

  describe('serializeListingDecision', () => {
    it('serializes a listing decision for API responses', () => {
      const decision = {
        listingId: 'listing-123',
        marketplaceId: 'market-alpha',
        subjectId: 'seller-777',
        allowed: true,
        status: 'verified' as const,
        reason: 'seller is KYC-verified',
        requiredAction: 'none',
        riskScore: 15,
        checkedAt: TEST_NOW,
      };

      const serialized = recordSerializer.serializeListingDecision(decision);

      expect(serialized).toEqual(decision);
    });

    it('contains no PII fields', () => {
      const decision = {
        listingId: 'listing-123',
        marketplaceId: 'market-alpha',
        subjectId: 'seller-777',
        allowed: false,
        status: 'review' as const,
        reason: 'pending review',
        requiredAction: 'wait',
        riskScore: 45,
        checkedAt: TEST_NOW,
      };

      const serialized = recordSerializer.serializeListingDecision(decision);
      recordSerializer.assertNoPii(serialized, 'listing decision');
    });
  });

  describe('serializeRisk', () => {
    it('serializes risk assessment for API responses', () => {
      const serialized = recordSerializer.serializeRisk(record.risk);

      expect(serialized).toMatchObject({
        score: record.risk.score,
        band: record.risk.band,
        modelVersion: record.risk.modelVersion,
      });
      expect(serialized.reasons).toHaveLength(record.risk.features.length);
      expect(serialized.sanctionsHits).toEqual(record.risk.sanctionsHits);
    });

    it('contains no PII fields', () => {
      const serialized = recordSerializer.serializeRisk(record.risk);
      recordSerializer.assertNoPii(serialized, 'risk assessment');
    });
  });

  describe('PII detection', () => {
    it('detects PII field names in nested objects', () => {
      const payload = {
        user: {
          fullName: 'John Doe',
          address: {
            street: '123 Main St',
          },
        },
      };

      const paths = recordSerializer.findPiiPaths(payload);
      expect(paths).toContain('$.user.fullName');
      expect(paths).toContain('$.user.address.street');
    });

    it('detects PII field names in arrays', () => {
      const payload = {
        users: [
          { fullName: 'Alice' },
          { dateOfBirth: '1990-01-01' },
        ],
      };

      const paths = recordSerializer.findPiiPaths(payload);
      expect(paths).toContain('$.users[0].fullName');
      expect(paths).toContain('$.users[1].dateOfBirth');
    });

    it('returns empty array for clean payloads', () => {
      const payload = {
        submissionId: 'kyc_123',
        status: 'verified',
        riskScore: 10,
      };

      const paths = recordSerializer.findPiiPaths(payload);
      expect(paths).toHaveLength(0);
    });

    it('assertNoPii throws on PII detection', () => {
      const payload = { fullName: 'John Doe' };
      expect(() => recordSerializer.assertNoPii(payload, 'test context')).toThrow(
        'PII leak detected in test context',
      );
    });

    it('assertNoPii passes on clean payloads', () => {
      const payload = { submissionId: 'kyc_123', status: 'verified' };
      expect(() => recordSerializer.assertNoPii(payload, 'test context')).not.toThrow();
    });
  });
});