import { buildContainer, type Container } from '../container';
import {
  TEST_MARKETPLACE,
  TEST_NOW,
  testConfig,
} from '../testing/fixtures';
import { fixedClock } from '../util/clock';

function buildTestContainer(): Container {
  return buildContainer({
    config: testConfig(),
    clock: fixedClock(TEST_NOW),
    startedAt: new Date(TEST_NOW),
    consentVersion: '1.0.0',
    consentMandatoryPurposes: ['kyc_processing', 'aml_screening', 'compliance_reporting'],
  });
}

describe('ConsentService', () => {
  describe('grantConsent', () => {
    it('creates a new consent record with mandatory purposes', async () => {
      const container = buildTestContainer();
      const record = await container.consentService.grantConsent({
        marketplaceId: TEST_MARKETPLACE,
        subjectId: 'seller-777',
        purposes: ['risk_scoring', 'marketing'],
        ip: '192.168.1.1',
        userAgent: 'TestAgent/1.0',
      });

      expect(record.consentId).toMatch(/^cns_[a-f0-9]{32}$/);
      expect(record.marketplaceId).toBe(TEST_MARKETPLACE);
      expect(record.subjectId).toBe('seller-777');
      expect(record.granted).toBe(true);
      expect(record.purposes).toEqual(
        expect.arrayContaining(['kyc_processing', 'aml_screening', 'compliance_reporting', 'risk_scoring', 'marketing']),
      );
      expect(record.version).toBe('1.0.0');
      expect(record.ip).toBe('192.168.1.1');
      expect(record.userAgent).toBe('TestAgent/1.0');
      expect(record.history).toHaveLength(1);
      expect(record.history[0].action).toBe('granted');
    });

    it('updates existing consent record', async () => {
      const container = buildTestContainer();
      await container.consentService.grantConsent({
        marketplaceId: TEST_MARKETPLACE,
        subjectId: 'seller-777',
        purposes: ['risk_scoring'],
      });

      const record = await container.consentService.grantConsent({
        marketplaceId: TEST_MARKETPLACE,
        subjectId: 'seller-777',
        purposes: ['marketing'],
        version: '2.0.0',
      });

      expect(record.purposes).toEqual(
        expect.arrayContaining(['kyc_processing', 'aml_screening', 'compliance_reporting', 'risk_scoring', 'marketing']),
      );
      expect(record.version).toBe('2.0.0');
      expect(record.history).toHaveLength(2);
      expect(record.history[1].action).toBe('updated');
    });

    it('deduplicates purposes', async () => {
      const container = buildTestContainer();
      const record = await container.consentService.grantConsent({
        marketplaceId: TEST_MARKETPLACE,
        subjectId: 'seller-777',
        purposes: ['risk_scoring', 'risk_scoring', 'marketing'],
      });

      const riskScoringCount = record.purposes.filter(p => p === 'risk_scoring').length;
      expect(riskScoringCount).toBe(1);
    });
  });

  describe('withdrawConsent', () => {
    it('withdraws optional purposes while keeping mandatory ones', async () => {
      const container = buildTestContainer();
      await container.consentService.grantConsent({
        marketplaceId: TEST_MARKETPLACE,
        subjectId: 'seller-777',
        purposes: ['risk_scoring', 'marketing', 'analytics'],
      });

      const record = await container.consentService.withdrawConsent({
        marketplaceId: TEST_MARKETPLACE,
        subjectId: 'seller-777',
        purposes: ['marketing', 'analytics'],
        ip: '192.168.1.1',
      });

      expect(record.granted).toBe(true);
      expect(record.purposes).toEqual(
        expect.arrayContaining(['kyc_processing', 'aml_screening', 'compliance_reporting', 'risk_scoring']),
      );
      expect(record.purposes).not.toContain('marketing');
      expect(record.purposes).not.toContain('analytics');
      expect(record.withdrawnAt).toBeNull();
      expect(record.history).toHaveLength(2);
      expect(record.history[1].action).toBe('withdrawn');
      expect(record.history[1].purposes).toEqual(['marketing', 'analytics']);
    });

    it('fully withdraws consent when all optional purposes removed', async () => {
      const container = buildTestContainer();
      await container.consentService.grantConsent({
        marketplaceId: TEST_MARKETPLACE,
        subjectId: 'seller-777',
        purposes: ['risk_scoring'],
      });

      const record = await container.consentService.withdrawConsent({
        marketplaceId: TEST_MARKETPLACE,
        subjectId: 'seller-777',
        purposes: ['risk_scoring'],
      });

      expect(record.granted).toBe(false);
      expect(record.purposes).toEqual(['kyc_processing', 'aml_screening', 'compliance_reporting']);
      expect(record.withdrawnAt).not.toBeNull();
    });

    it('throws when no consent record exists', async () => {
      const container = buildTestContainer();
      await expect(
        container.consentService.withdrawConsent({
          marketplaceId: TEST_MARKETPLACE,
          subjectId: 'unknown-seller',
          purposes: ['marketing'],
        }),
      ).rejects.toThrow('No consent record found');
    });

    it('throws when consent already withdrawn', async () => {
      const container = buildTestContainer();
      await container.consentService.grantConsent({
        marketplaceId: TEST_MARKETPLACE,
        subjectId: 'seller-777',
        purposes: ['risk_scoring'],
      });
      await container.consentService.withdrawConsent({
        marketplaceId: TEST_MARKETPLACE,
        subjectId: 'seller-777',
        purposes: ['risk_scoring'],
      });

      await expect(
        container.consentService.withdrawConsent({
          marketplaceId: TEST_MARKETPLACE,
          subjectId: 'seller-777',
          purposes: ['marketing'],
        }),
      ).rejects.toThrow('Consent is already withdrawn');
    });

    it('cannot withdraw mandatory purposes', async () => {
      const container = buildTestContainer();
      await container.consentService.grantConsent({
        marketplaceId: TEST_MARKETPLACE,
        subjectId: 'seller-777',
        purposes: ['risk_scoring'],
      });

      const record = await container.consentService.withdrawConsent({
        marketplaceId: TEST_MARKETPLACE,
        subjectId: 'seller-777',
        purposes: ['kyc_processing', 'aml_screening'], // mandatory
      });

      // Mandatory purposes should remain
      expect(record.purposes).toContain('kyc_processing');
      expect(record.purposes).toContain('aml_screening');
      expect(record.purposes).toContain('compliance_reporting');
    });
  });

  describe('getConsentStatus', () => {
    it('returns status for existing consent', async () => {
      const container = buildTestContainer();
      await container.consentService.grantConsent({
        marketplaceId: TEST_MARKETPLACE,
        subjectId: 'seller-777',
        purposes: ['risk_scoring', 'marketing'],
      });

      const status = await container.consentService.getConsentStatus(TEST_MARKETPLACE, 'seller-777');

      expect(status.consentId).toBeDefined();
      expect(status.subjectId).toBe('seller-777');
      expect(status.granted).toBe(true);
      expect(status.purposes).toEqual(
        expect.arrayContaining(['kyc_processing', 'aml_screening', 'compliance_reporting', 'risk_scoring', 'marketing']),
      );
      expect(status.mandatoryPurposes).toEqual(['kyc_processing', 'aml_screening', 'compliance_reporting']);
      expect(status.version).toBe('1.0.0');
      expect(status.grantedAt).toBe(TEST_NOW);
      expect(status.withdrawnAt).toBeNull();
      expect(status.canWithdrawFully).toBe(true);
    });

    it('returns default status for unknown subject', async () => {
      const container = buildTestContainer();
      const status = await container.consentService.getConsentStatus(TEST_MARKETPLACE, 'unknown-seller');

      expect(status.consentId).toBeNull();
      expect(status.subjectId).toBe('unknown-seller');
      expect(status.granted).toBe(false);
      expect(status.purposes).toEqual([]);
      expect(status.mandatoryPurposes).toEqual(['kyc_processing', 'aml_screening', 'compliance_reporting']);
      expect(status.version).toBe('1.0.0');
      expect(status.grantedAt).toBeNull();
      expect(status.withdrawnAt).toBeNull();
      expect(status.canWithdrawFully).toBe(false);
    });
  });

  describe('getConsentRecord', () => {
    it('returns full record with history', async () => {
      const container = buildTestContainer();
      await container.consentService.grantConsent({
        marketplaceId: TEST_MARKETPLACE,
        subjectId: 'seller-777',
        purposes: ['risk_scoring'],
      });
      await container.consentService.withdrawConsent({
        marketplaceId: TEST_MARKETPLACE,
        subjectId: 'seller-777',
        purposes: ['risk_scoring'],
      });

      const record = await container.consentService.getConsentRecord(TEST_MARKETPLACE, 'seller-777');

      expect(record).toBeDefined();
      if (record) {
        expect(record.history).toHaveLength(2);
        expect(record.history[0].action).toBe('granted');
        expect(record.history[1].action).toBe('withdrawn');
      }
    });

    it('returns undefined for unknown subject', async () => {
      const container = buildTestContainer();
      const record = await container.consentService.getConsentRecord(TEST_MARKETPLACE, 'unknown-seller');
      expect(record).toBeUndefined();
    });
  });

  describe('hasValidConsent', () => {
    it('returns true for granted purpose', async () => {
      const container = buildTestContainer();
      await container.consentService.grantConsent({
        marketplaceId: TEST_MARKETPLACE,
        subjectId: 'seller-777',
        purposes: ['risk_scoring'],
      });

      expect(await container.consentService.hasValidConsent(TEST_MARKETPLACE, 'seller-777', 'risk_scoring')).toBe(true);
      expect(await container.consentService.hasValidConsent(TEST_MARKETPLACE, 'seller-777', 'kyc_processing')).toBe(true);
    });

    it('returns false for withdrawn purpose', async () => {
      const container = buildTestContainer();
      await container.consentService.grantConsent({
        marketplaceId: TEST_MARKETPLACE,
        subjectId: 'seller-777',
        purposes: ['risk_scoring', 'marketing'],
      });
      await container.consentService.withdrawConsent({
        marketplaceId: TEST_MARKETPLACE,
        subjectId: 'seller-777',
        purposes: ['marketing'],
      });

      expect(await container.consentService.hasValidConsent(TEST_MARKETPLACE, 'seller-777', 'marketing')).toBe(false);
      expect(await container.consentService.hasValidConsent(TEST_MARKETPLACE, 'seller-777', 'risk_scoring')).toBe(true);
    });

    it('returns false for unknown subject', async () => {
      const container = buildTestContainer();
      expect(await container.consentService.hasValidConsent(TEST_MARKETPLACE, 'unknown-seller', 'risk_scoring')).toBe(false);
    });
  });

  describe('listConsentRecords', () => {
    it('lists all consent records for a marketplace', async () => {
      const container = buildTestContainer();
      await container.consentService.grantConsent({
        marketplaceId: TEST_MARKETPLACE,
        subjectId: 'seller-1',
        purposes: ['risk_scoring'],
      });
      await container.consentService.grantConsent({
        marketplaceId: TEST_MARKETPLACE,
        subjectId: 'seller-2',
        purposes: ['marketing'],
      });

      const records = await container.consentService.listConsentRecords(TEST_MARKETPLACE);

      expect(records).toHaveLength(2);
      expect(records.map(r => r.subjectId).sort()).toEqual(['seller-1', 'seller-2']);
    });

    it('returns empty array for marketplace with no records', async () => {
      const container = buildTestContainer();
      const records = await container.consentService.listConsentRecords('other-marketplace');
      expect(records).toHaveLength(0);
    });
  });
});