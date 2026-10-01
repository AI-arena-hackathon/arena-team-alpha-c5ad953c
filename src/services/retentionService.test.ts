import { buildContainer, type Container } from '../container';
import {
  healthySubmission,
  TEST_MARKETPLACE,
  TEST_NOW,
  testConfig,
} from '../testing/fixtures';
import { fixedClock } from '../util/clock';
import { createDefaultRetentionPolicy } from './retentionService';

function buildTestContainer(overrides: { retentionPolicy?: Partial<ReturnType<typeof createDefaultRetentionPolicy>> } = {}): Container {
  return buildContainer({
    config: testConfig(),
    clock: fixedClock(TEST_NOW),
    startedAt: new Date(TEST_NOW),
    retentionPolicy: overrides.retentionPolicy,
  });
}

describe('RetentionService', () => {
  describe('policy', () => {
    it('returns the default policy when none provided', () => {
      const container = buildTestContainer();
      const policy = container.retentionService.getPolicy();

      expect(policy.kycRecordMaxAgeDays).toBe(2555); // 7 years
      expect(policy.listingDecisionMaxAgeDays).toBe(1095); // 3 years
      expect(policy.consentRecordMaxAgeDays).toBe(2555); // 7 years
      expect(policy.autoCleanupEnabled).toBe(false);
      expect(policy.cleanupSchedule).toBe('0 2 * * *');
    });

    it('merges custom policy with defaults', () => {
      const container = buildTestContainer({
        retentionPolicy: { kycRecordMaxAgeDays: 365, autoCleanupEnabled: true },
      });
      const policy = container.retentionService.getPolicy();

      expect(policy.kycRecordMaxAgeDays).toBe(365);
      expect(policy.autoCleanupEnabled).toBe(true);
      expect(policy.listingDecisionMaxAgeDays).toBe(1095); // default preserved
    });
  });

  describe('isKycRecordExpired', () => {
    it('returns true for records older than max age', () => {
      const clock = fixedClock('2025-01-01T00:00:00.000Z');
      const container = buildContainer({
        config: testConfig(),
        clock,
        retentionPolicy: { kycRecordMaxAgeDays: 30 },
      });

      const expiredRecord = { evaluatedAt: '2024-11-01T00:00:00.000Z' }; // 61 days old
      const freshRecord = { evaluatedAt: '2024-12-15T00:00:00.000Z' }; // 17 days old

      expect(container.retentionService.isKycRecordExpired(expiredRecord)).toBe(true);
      expect(container.retentionService.isKycRecordExpired(freshRecord)).toBe(false);
    });

    it('returns false for records exactly at max age boundary', () => {
      const clock = fixedClock('2025-01-01T00:00:00.000Z');
      const container = buildContainer({
        config: testConfig(),
        clock,
        retentionPolicy: { kycRecordMaxAgeDays: 30 },
      });

      const boundaryRecord = { evaluatedAt: '2024-12-02T00:00:00.000Z' }; // exactly 30 days
      expect(container.retentionService.isKycRecordExpired(boundaryRecord)).toBe(false);
    });
  });

  describe('runCleanup', () => {
    it('skips cleanup when autoCleanupEnabled is false', async () => {
      const container = buildTestContainer();
      await container.kycService.submit(TEST_MARKETPLACE, healthySubmission());

      const result = await container.retentionService.runCleanup(TEST_MARKETPLACE);

      expect(result.deletedKycRecords).toBe(0);
      expect(result.errors).toContain('Cleanup skipped: autoCleanupEnabled is false');
    });

    it('deletes expired records when autoCleanupEnabled is true', async () => {
      const clock = fixedClock('2025-01-01T00:00:00.000Z');
      const container = buildContainer({
        config: testConfig(),
        clock,
        retentionPolicy: { kycRecordMaxAgeDays: 30, autoCleanupEnabled: true },
      });

      // Submit an old record (expired)
      await container.kycService.submit(TEST_MARKETPLACE, healthySubmission({
        submissionId: 'kyc_old_001',
        subject: { ...healthySubmission().subject, subjectId: 'seller-old' },
      }));
      clock.advance(60 * 24 * 60 * 60 * 1000); // advance 60 days

      // Submit a fresh record (not expired)
      await container.kycService.submit(TEST_MARKETPLACE, healthySubmission({
        submissionId: 'kyc_fresh_001',
        subject: { ...healthySubmission().subject, subjectId: 'seller-fresh' },
      }));

      const result = await container.retentionService.runCleanup(TEST_MARKETPLACE);

      expect(result.deletedKycRecords).toBe(1);
      expect(result.errors).toHaveLength(0);

      // Verify the old record is gone
      const oldRecord = await container.kycService.getRecord(TEST_MARKETPLACE, 'kyc_old_001');
      expect(oldRecord).toBeUndefined();

      // Verify the fresh record remains
      const freshRecord = await container.kycService.getRecord(TEST_MARKETPLACE, 'kyc_fresh_001');
      expect(freshRecord).toBeDefined();
    });

    it('deletes all records for a subject when any record is expired', async () => {
      const clock = fixedClock('2025-01-01T00:00:00.000Z');
      const container = buildContainer({
        config: testConfig(),
        clock,
        retentionPolicy: { kycRecordMaxAgeDays: 30, autoCleanupEnabled: true },
      });

      // Submit two records for the same subject, one old and one new
      await container.kycService.submit(TEST_MARKETPLACE, healthySubmission({
        submissionId: 'kyc_old_001',
        subject: { ...healthySubmission().subject, subjectId: 'seller-multi' },
      }));
      clock.advance(60 * 24 * 60 * 60 * 1000); // advance 60 days
      await container.kycService.submit(TEST_MARKETPLACE, healthySubmission({
        submissionId: 'kyc_new_001',
        subject: { ...healthySubmission().subject, subjectId: 'seller-multi' },
      }));

      const result = await container.retentionService.runCleanup(TEST_MARKETPLACE);

      // Both records for the subject should be deleted
      expect(result.deletedKycRecords).toBe(2);

      const oldRecord = await container.kycService.getRecord(TEST_MARKETPLACE, 'kyc_old_001');
      const newRecord = await container.kycService.getRecord(TEST_MARKETPLACE, 'kyc_new_001');
      expect(oldRecord).toBeUndefined();
      expect(newRecord).toBeUndefined();
    });
  });

  describe('getCleanupPreview', () => {
    it('shows which subjects would be deleted without actually deleting', async () => {
      const clock = fixedClock('2025-01-01T00:00:00.000Z');
      const container = buildContainer({
        config: testConfig(),
        clock,
        retentionPolicy: { kycRecordMaxAgeDays: 30, autoCleanupEnabled: true },
      });

      await container.kycService.submit(TEST_MARKETPLACE, healthySubmission({
        submissionId: 'kyc_old_001',
        subject: { ...healthySubmission().subject, subjectId: 'seller-old' },
      }));
      clock.advance(60 * 24 * 60 * 60 * 1000);
      await container.kycService.submit(TEST_MARKETPLACE, healthySubmission({
        submissionId: 'kyc_fresh_001',
        subject: { ...healthySubmission().subject, subjectId: 'seller-fresh' },
      }));

      const preview = await container.retentionService.getCleanupPreview(TEST_MARKETPLACE);

      expect(preview.subjectsToDelete).toHaveLength(1);
      expect(preview.subjectsToDelete[0].subjectId).toBe('seller-old');
      expect(preview.subjectsToDelete[0].recordCount).toBe(1);
      expect(preview.totalRecordsToDelete).toBe(1);

      // Verify records still exist
      const oldRecord = await container.kycService.getRecord(TEST_MARKETPLACE, 'kyc_old_001');
      const freshRecord = await container.kycService.getRecord(TEST_MARKETPLACE, 'kyc_fresh_001');
      expect(oldRecord).toBeDefined();
      expect(freshRecord).toBeDefined();
    });
  });
});

describe('createDefaultRetentionPolicy', () => {
  it('returns the expected defaults', () => {
    const policy = createDefaultRetentionPolicy();

    expect(policy.kycRecordMaxAgeDays).toBe(2555);
    expect(policy.listingDecisionMaxAgeDays).toBe(1095);
    expect(policy.consentRecordMaxAgeDays).toBe(2555);
    expect(policy.autoCleanupEnabled).toBe(false);
    expect(policy.cleanupSchedule).toBe('0 2 * * *');
  });
});