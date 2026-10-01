import { type Container, buildApp } from '../container';
import {
  eidasAssertion,
  healthySubmission,
  TEST_MARKETPLACE,
  TEST_API_KEY,
  TEST_NOW,
  testConfig,
} from '../testing/fixtures';
import { fixedClock } from '../util/clock';
import request from 'supertest';

function buildTestApp() {
  const clock = fixedClock(TEST_NOW);
  const { app, container } = buildApp({
    config: testConfig(),
    clock,
    startedAt: new Date(TEST_NOW),
    consentVersion: '1.0.0',
    consentMandatoryPurposes: ['kyc_processing', 'aml_screening', 'compliance_reporting'],
  });
  return { app, container, clock };
}

async function submitKyc(container: Container, submissionId: string, subjectId: string) {
  return container.kycService.submit(TEST_MARKETPLACE, healthySubmission({
    submissionId,
    subject: { ...healthySubmission().subject, subjectId },
    credential: { format: 'eidas', assertion: eidasAssertion() },
  }));
}

describe('Compliance HTTP endpoints', () => {
  let container: Container;
  let app: ReturnType<typeof buildTestApp>['app'];

  beforeEach(() => {
    const testApp = buildTestApp();
    container = testApp.container;
    app = testApp.app;
  });

  describe('GET /v1/consent/status/:subjectId', () => {
    it('returns consent status for a subject with no prior consent', async () => {
      const response = await request(app)
        .get('/v1/consent/status/seller-unknown')
        .set('x-api-key', TEST_API_KEY)
        .expect(200);

      expect(response.body).toMatchObject({
        consentId: null,
        subjectId: 'seller-unknown',
        granted: false,
        purposes: [],
        mandatoryPurposes: ['kyc_processing', 'aml_screening', 'compliance_reporting'],
        version: '1.0.0',
        grantedAt: null,
        withdrawnAt: null,
        canWithdrawFully: false,
        disclaimerVersion: '1.0.0',
      });
      expect(response.body.disclaimer).toContain('withdrawal');
    });

    it('returns consent status after granting consent', async () => {
      await submitKyc(container, 'kyc_001', 'seller-777');

      const response = await request(app)
        .get('/v1/consent/status/seller-777')
        .set('x-api-key', TEST_API_KEY)
        .expect(200);

      expect(response.body.consentId).toMatch(/^cns_[a-f0-9]{32}$/);
      expect(response.body.subjectId).toBe('seller-777');
      expect(response.body.granted).toBe(true);
      expect(response.body.purposes).toEqual(
        expect.arrayContaining(['kyc_processing', 'aml_screening', 'compliance_reporting']),
      );
      expect(response.body.grantedAt).toBe(TEST_NOW);
    });
  });

  describe('POST /v1/consent/withdraw/:subjectId', () => {
    it('withdraws optional purposes', async () => {
      await submitKyc(container, 'kyc_001', 'seller-777');
      // Grant additional optional consent
      await container.consentService.grantConsent({
        marketplaceId: TEST_MARKETPLACE,
        subjectId: 'seller-777',
        purposes: ['risk_scoring', 'marketing', 'analytics'],
      });

      const response = await request(app)
        .post('/v1/consent/withdraw/seller-777')
        .set('x-api-key', TEST_API_KEY)
        .send({ purposes: ['marketing', 'analytics'] })
        .expect(200);

      expect(response.body.granted).toBe(true);
      expect(response.body.purposes).toEqual(
        expect.arrayContaining(['kyc_processing', 'aml_screening', 'compliance_reporting', 'risk_scoring']),
      );
      expect(response.body.purposes).not.toContain('marketing');
      expect(response.body.purposes).not.toContain('analytics');
      expect(response.body.withdrawnAt).toBeNull();
    });

    it('fully withdraws when all optional purposes removed', async () => {
      await submitKyc(container, 'kyc_001', 'seller-777');
      // Grant additional optional consent (ledger_anchoring is already granted by KYC)
      await container.consentService.grantConsent({
        marketplaceId: TEST_MARKETPLACE,
        subjectId: 'seller-777',
        purposes: ['marketing', 'analytics'],
      });

      const response = await request(app)
        .post('/v1/consent/withdraw/seller-777')
        .set('x-api-key', TEST_API_KEY)
        .send({ purposes: ['risk_scoring', 'ledger_anchoring', 'marketing', 'analytics'] })
        .expect(200);

      expect(response.body.granted).toBe(false);
      expect(response.body.purposes).toEqual(['kyc_processing', 'aml_screening', 'compliance_reporting']);
      expect(response.body.withdrawnAt).toBe(TEST_NOW);
    });

    it('rejects withdrawal for unknown subject', async () => {
      const response = await request(app)
        .post('/v1/consent/withdraw/unknown-seller')
        .set('x-api-key', TEST_API_KEY)
        .send({ purposes: ['marketing'] })
        .expect(404);

      expect(response.body.error).toBe('not_found');
    });

    it('validates purposes array is not empty', async () => {
      await submitKyc(container, 'kyc_001', 'seller-777');

      const response = await request(app)
        .post('/v1/consent/withdraw/seller-777')
        .set('x-api-key', TEST_API_KEY)
        .send({ purposes: [] })
        .expect(400);

      expect(response.body.error).toBe('validation_failed');
    });

    it('validates purposes are known values', async () => {
      await submitKyc(container, 'kyc_001', 'seller-777');

      const response = await request(app)
        .post('/v1/consent/withdraw/seller-777')
        .set('x-api-key', TEST_API_KEY)
        .send({ purposes: ['invalid_purpose'] })
        .expect(400);

      expect(response.body.error).toBe('validation_failed');
    });
  });

  describe('POST /v1/subjects/:subjectId/erasure-request', () => {
    it('deletes all records for a subject with no legal hold', async () => {
      await submitKyc(container, 'kyc_001', 'seller-777');
      await submitKyc(container, 'kyc_002', 'seller-777');

      const response = await request(app)
        .post('/v1/subjects/seller-777/erasure-request')
        .set('x-api-key', TEST_API_KEY)
        .send({ reason: 'User requested deletion', confirmDeletion: true })
        .expect(200);

      expect(response.body.subjectId).toBe('seller-777');
      expect(response.body.deletedRecords).toBe(2);
      expect(response.body.status).toBe('completed');
      expect(response.body.disclaimerVersion).toBe('1.0.0');

      // Verify records are deleted
      const record1 = await container.kycService.getRecord(TEST_MARKETPLACE, 'kyc_001');
      const record2 = await container.kycService.getRecord(TEST_MARKETPLACE, 'kyc_002');
      expect(record1).toBeUndefined();
      expect(record2).toBeUndefined();
    });

    it('rejects erasure for unknown subject', async () => {
      const response = await request(app)
        .post('/v1/subjects/unknown-seller/erasure-request')
        .set('x-api-key', TEST_API_KEY)
        .send({ reason: 'Test', confirmDeletion: true })
        .expect(404);

      expect(response.body.error).toBe('not_found');
    });

    it('rejects erasure when legal hold exists (sanctions match)', async () => {
      await container.kycService.submit(TEST_MARKETPLACE, healthySubmission({
        submissionId: 'kyc_sanctioned',
        subject: {
          ...healthySubmission().subject,
          subjectId: 'seller-sanctioned',
          fullName: 'Viktor Petrovich Morozov',
          dateOfBirth: '1971-03-14',
        },
        credential: { format: 'eidas', assertion: eidasAssertion({ name: 'Viktor Petrovich Morozov', birth_date: '1971-03-14' }) },
      }));

      const response = await request(app)
        .post('/v1/subjects/seller-sanctioned/erasure-request')
        .set('x-api-key', TEST_API_KEY)
        .send({ reason: 'Test', confirmDeletion: true })
        .expect(409);

      expect(response.body.error).toBe('legal_hold');
      expect(response.body.message).toContain('legal hold');
    });

    it('rejects erasure when legal hold exists (rejection)', async () => {
      await container.kycService.submit(TEST_MARKETPLACE, healthySubmission({
        submissionId: 'kyc_rejected',
        subject: { ...healthySubmission().subject, subjectId: 'seller-rejected', dateOfBirth: '2012-05-05' },
        credential: { format: 'eidas', assertion: eidasAssertion({ birth_date: '2012-05-05' }) },
      }));

      const response = await request(app)
        .post('/v1/subjects/seller-rejected/erasure-request')
        .set('x-api-key', TEST_API_KEY)
        .send({ reason: 'Test', confirmDeletion: true })
        .expect(409);

      expect(response.body.error).toBe('legal_hold');
    });

    it('validates confirmDeletion is true', async () => {
      await submitKyc(container, 'kyc_001', 'seller-777');

      const response = await request(app)
        .post('/v1/subjects/seller-777/erasure-request')
        .set('x-api-key', TEST_API_KEY)
        .send({ reason: 'Test', confirmDeletion: false })
        .expect(400);

      expect(response.body.error).toBe('validation_failed');
    });

    it('validates reason is provided', async () => {
      await submitKyc(container, 'kyc_001', 'seller-777');

      const response = await request(app)
        .post('/v1/subjects/seller-777/erasure-request')
        .set('x-api-key', TEST_API_KEY)
        .send({ confirmDeletion: true })
        .expect(400);

      expect(response.body.error).toBe('validation_failed');
    });
  });

  describe('GET /v1/retention/policy', () => {
    it('returns the current retention policy', async () => {
      const response = await request(app)
        .get('/v1/retention/policy')
        .set('x-api-key', TEST_API_KEY)
        .expect(200);

      expect(response.body.policy).toMatchObject({
        kycRecordMaxAgeDays: 2555,
        listingDecisionMaxAgeDays: 1095,
        consentRecordMaxAgeDays: 2555,
        autoCleanupEnabled: false,
        cleanupSchedule: '0 2 * * *',
      });
      expect(response.body.disclaimerVersion).toBe('1.0.0');
    });
  });

  describe('GET /v1/retention/preview', () => {
    it('shows which subjects would be deleted', async () => {
      const customClock = fixedClock('2025-01-01T00:00:00.000Z');
      const { app: customApp, container: customContainer } = buildApp({
        config: testConfig(),
        clock: customClock,
        startedAt: new Date('2025-01-01T00:00:00.000Z'),
        consentVersion: '1.0.0',
        consentMandatoryPurposes: ['kyc_processing', 'aml_screening', 'compliance_reporting'],
        retentionPolicy: { kycRecordMaxAgeDays: 30, autoCleanupEnabled: true },
      });

      await customContainer.kycService.submit(TEST_MARKETPLACE, healthySubmission({
        submissionId: 'kyc_old_001',
        subject: { ...healthySubmission().subject, subjectId: 'seller-old' },
      }));
      customClock.advance(60 * 24 * 60 * 60 * 1000);
      await customContainer.kycService.submit(TEST_MARKETPLACE, healthySubmission({
        submissionId: 'kyc_fresh_001',
        subject: { ...healthySubmission().subject, subjectId: 'seller-fresh' },
      }));

      const response = await request(customApp)
        .get('/v1/retention/preview')
        .set('x-api-key', TEST_API_KEY)
        .expect(200);

      expect(response.body.subjectsToDelete).toHaveLength(1);
      expect(response.body.subjectsToDelete[0].subjectId).toBe('seller-old');
      expect(response.body.totalRecordsToDelete).toBe(1);
      expect(response.body.disclaimerVersion).toBe('1.0.0');
    });
  });

  describe('POST /v1/retention/cleanup', () => {
    it('runs cleanup and deletes expired records', async () => {
      const customClock = fixedClock('2025-01-01T00:00:00.000Z');
      const { app: customApp, container: customContainer } = buildApp({
        config: testConfig(),
        clock: customClock,
        startedAt: new Date('2025-01-01T00:00:00.000Z'),
        consentVersion: '1.0.0',
        consentMandatoryPurposes: ['kyc_processing', 'aml_screening', 'compliance_reporting'],
        retentionPolicy: { kycRecordMaxAgeDays: 30, autoCleanupEnabled: true },
      });

      await customContainer.kycService.submit(TEST_MARKETPLACE, healthySubmission({
        submissionId: 'kyc_old_001',
        subject: { ...healthySubmission().subject, subjectId: 'seller-old' },
      }));
      customClock.advance(60 * 24 * 60 * 60 * 1000);
      await customContainer.kycService.submit(TEST_MARKETPLACE, healthySubmission({
        submissionId: 'kyc_fresh_001',
        subject: { ...healthySubmission().subject, subjectId: 'seller-fresh' },
      }));

      const response = await request(customApp)
        .post('/v1/retention/cleanup')
        .set('x-api-key', TEST_API_KEY)
        .expect(200);

      expect(response.body.deletedKycRecords).toBe(1);
      expect(response.body.errors).toHaveLength(0);
      expect(response.body.disclaimerVersion).toBe('1.0.0');

      // Verify old record deleted, fresh remains
      const oldRecord = await customContainer.kycService.getRecord(TEST_MARKETPLACE, 'kyc_old_001');
      const freshRecord = await customContainer.kycService.getRecord(TEST_MARKETPLACE, 'kyc_fresh_001');
      expect(oldRecord).toBeUndefined();
      expect(freshRecord).toBeDefined();
    });

    it('returns skipped message when autoCleanupEnabled is false', async () => {
      await submitKyc(container, 'kyc_001', 'seller-777');

      const response = await request(app)
        .post('/v1/retention/cleanup')
        .set('x-api-key', TEST_API_KEY)
        .expect(200);

      expect(response.body.deletedKycRecords).toBe(0);
      expect(response.body.errors).toContain('Cleanup skipped: autoCleanupEnabled is false');
    });
  });

  describe('GET /v1/disclaimers', () => {
    it('returns all disclaimers with version', async () => {
      const response = await request(app)
        .get('/v1/disclaimers')
        .set('x-api-key', TEST_API_KEY)
        .expect(200);

      expect(response.body.version).toBe('1.0.0');
      expect(response.body.api).toHaveProperty('kycSubmission');
      expect(response.body.api).toHaveProperty('listingCheck');
      expect(response.body.api).toHaveProperty('complianceReport');
      expect(response.body.api).toHaveProperty('ledgerVerify');
      expect(response.body.report).toHaveProperty('header');
      expect(response.body.report).toHaveProperty('footer');
      expect(response.body.report).toHaveProperty('dataProcessing');
      expect(response.body.report).toHaveProperty('retention');
      expect(response.body.consent).toHaveProperty('grant');
      expect(response.body.consent).toHaveProperty('withdrawal');
      expect(response.body.privacy).toHaveProperty('controller');
      expect(response.body.privacy).toHaveProperty('processor');
      expect(response.body.privacy).toHaveProperty('dpoContact');
      expect(response.body.privacy).toHaveProperty('lawfulBasis');
      expect(response.body.privacy).toHaveProperty('rightsSummary');
    });
  });

  describe('GET /v1/privacy-notice', () => {
    it('returns privacy notice without auth', async () => {
      const response = await request(app)
        .get('/v1/privacy-notice')
        .expect(200);

      expect(response.body.version).toBe('1.0.0');
      expect(response.body.controller).toContain('data controller');
      expect(response.body.processor).toContain('data processor');
      expect(response.body.dpoContact).toContain('@');
      expect(response.body.lawfulBasis).toContain('Art. 6');
      expect(response.body.rightsSummary).toContain('erasure');
    });
  });

  describe('Existing endpoints include disclaimers', () => {
    it('KYC submission response includes disclaimer', async () => {
      const response = await request(app)
        .post('/v1/kyc/submissions')
        .set('x-api-key', TEST_API_KEY)
        .send(healthySubmission({
          submissionId: 'kyc_disclaimer_001',
          credential: { format: 'eidas', assertion: eidasAssertion() },
        }))
        .expect(201);

      expect(response.body.disclaimer).toContain('GDPR');
      expect(response.body.disclaimerVersion).toBe('1.0.0');
    });

    it('Compliance report includes disclaimer', async () => {
      await submitKyc(container, 'kyc_001', 'seller-777');

      const response = await request(app)
        .get('/v1/compliance/report')
        .set('x-api-key', TEST_API_KEY)
        .expect(200);

      expect(response.body.disclaimer).toHaveProperty('header');
      expect(response.body.disclaimer).toHaveProperty('footer');
      expect(response.body.disclaimer).toHaveProperty('dataProcessing');
      expect(response.body.disclaimer).toHaveProperty('retention');
      expect(response.body.disclaimerVersion).toBe('1.0.0');
    });

    it('Listing check includes disclaimer', async () => {
      await submitKyc(container, 'kyc_001', 'seller-777');

      const response = await request(app)
        .post('/v1/listings/listing-001/check')
        .set('x-api-key', TEST_API_KEY)
        .send({ subjectId: 'seller-777' })
        .expect(200);

      expect(response.body.disclaimer).toContain('blocked');
      expect(response.body.disclaimerVersion).toBe('1.0.0');
    });

    it('Ledger verify includes disclaimer', async () => {
      const response = await request(app)
        .get('/v1/ledger/verify')
        .set('x-api-key', TEST_API_KEY)
        .expect(200);

      expect(response.body.disclaimer).toContain('tamper-evidence');
      expect(response.body.disclaimerVersion).toBe('1.0.0');
    });
  });
});