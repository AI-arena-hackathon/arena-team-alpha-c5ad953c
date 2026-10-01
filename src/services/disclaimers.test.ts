import {
  DISCLAIMERS,
  getApiDisclaimer,
  getReportDisclaimers,
  getConsentDisclaimers,
  getPrivacyNotice,
  getDisclaimerVersion,
} from './disclaimers';

describe('Disclaimers', () => {
  describe('DISCLAIMERS constant', () => {
    it('has a version and update date', () => {
      expect(DISCLAIMERS.version).toBe('1.0.0');
      expect(DISCLAIMERS.updatedAt).toBe('2025-01-15T00:00:00.000Z');
    });

    it('has all required API disclaimers', () => {
      expect(DISCLAIMERS.api.kycSubmission).toContain('GDPR');
      expect(DISCLAIMERS.api.kycSubmission).toContain('AMLD5');
      expect(DISCLAIMERS.api.listingCheck).toContain('blocked');
      expect(DISCLAIMERS.api.complianceReport).toContain('no personal data');
      expect(DISCLAIMERS.api.ledgerVerify).toContain('tamper-evidence');
    });

    it('has all required report disclaimers', () => {
      expect(DISCLAIMERS.report.header).toContain('regulatory audit');
      expect(DISCLAIMERS.report.footer).toContain('HMAC-SHA256');
      expect(DISCLAIMERS.report.dataProcessing).toContain('AES-256-GCM');
      expect(DISCLAIMERS.report.retention).toContain('7 years');
    });

    it('has all required consent disclaimers', () => {
      expect(DISCLAIMERS.consent.grant.toLowerCase()).toContain('mandatory purposes');
      expect(DISCLAIMERS.consent.withdrawal.toLowerCase()).toContain('legal obligation');
    });

    it('has all required privacy notice components', () => {
      expect(DISCLAIMERS.privacy.controller).toContain('data controller');
      expect(DISCLAIMERS.privacy.processor).toContain('data processor');
      expect(DISCLAIMERS.privacy.dpoContact).toContain('@');
      expect(DISCLAIMERS.privacy.lawfulBasis).toContain('Art. 6');
      expect(DISCLAIMERS.privacy.rightsSummary).toContain('erasure');
    });
  });

  describe('getApiDisclaimer', () => {
    it('returns the correct disclaimer for each endpoint', () => {
      expect(getApiDisclaimer('kycSubmission')).toBe(DISCLAIMERS.api.kycSubmission);
      expect(getApiDisclaimer('listingCheck')).toBe(DISCLAIMERS.api.listingCheck);
      expect(getApiDisclaimer('complianceReport')).toBe(DISCLAIMERS.api.complianceReport);
      expect(getApiDisclaimer('ledgerVerify')).toBe(DISCLAIMERS.api.ledgerVerify);
    });

    it('throws for invalid endpoint at compile time', () => {
      // This is a compile-time check via TypeScript
      // getApiDisclaimer('invalidEndpoint'); // Would cause TS error
    });
  });

  describe('getReportDisclaimers', () => {
    it('returns the report disclaimer subset', () => {
      const disclaimers = getReportDisclaimers();
      expect(disclaimers.header).toBe(DISCLAIMERS.report.header);
      expect(disclaimers.footer).toBe(DISCLAIMERS.report.footer);
      expect(disclaimers.dataProcessing).toBe(DISCLAIMERS.report.dataProcessing);
      expect(disclaimers.retention).toBe(DISCLAIMERS.report.retention);
    });
  });

  describe('getConsentDisclaimers', () => {
    it('returns the consent disclaimer subset', () => {
      const disclaimers = getConsentDisclaimers();
      expect(disclaimers.grant).toBe(DISCLAIMERS.consent.grant);
      expect(disclaimers.withdrawal).toBe(DISCLAIMERS.consent.withdrawal);
    });
  });

  describe('getPrivacyNotice', () => {
    it('returns the full privacy notice', () => {
      const privacy = getPrivacyNotice();
      expect(privacy).toBe(DISCLAIMERS.privacy);
    });
  });

  describe('getDisclaimerVersion', () => {
    it('returns the current version', () => {
      expect(getDisclaimerVersion()).toBe('1.0.0');
    });
  });
});