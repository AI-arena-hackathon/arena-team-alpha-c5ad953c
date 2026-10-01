/**
 * Compliance disclaimers and legal notices.
 *
 * Centralized legal text for API responses, reports, and UI.
 * Versioned so changes are auditable.
 */

export interface DisclaimerSet {
  version: string;
  updatedAt: string;
  api: {
    kycSubmission: string;
    listingCheck: string;
    complianceReport: string;
    ledgerVerify: string;
  };
  report: {
    header: string;
    footer: string;
    dataProcessing: string;
    retention: string;
  };
  consent: {
    grant: string;
    withdrawal: string;
  };
  privacy: {
    controller: string;
    processor: string;
    dpoContact: string;
    lawfulBasis: string;
    rightsSummary: string;
  };
}

export const DISCLAIMERS: DisclaimerSet = {
  version: '1.0.0',
  updatedAt: '2025-01-15T00:00:00.000Z',
  api: {
    kycSubmission:
      'By submitting this KYC request, you confirm that the data subject has provided explicit, informed consent for the processing of their personal data in accordance with GDPR Article 6(1)(a) and AMLD5. The data will be encrypted at rest, used solely for identity verification, AML screening, and compliance reporting, and retained per the schedule in our privacy notice. You may withdraw consent at any time via the consent withdrawal endpoint, subject to mandatory regulatory processing requirements.',
    listingCheck:
      'This listing gate decision is based on the most recent KYC assessment. A "blocked" status means the seller cannot list until the specified remediation is completed. This decision does not constitute legal advice. Marketplaces remain responsible for their own regulatory compliance.',
    complianceReport:
      'This compliance report is generated for regulatory audit purposes. It contains no personal data — sellers are referenced by marketplace-scoped subject IDs only. Evidence is quoted as salted credential digests and ledger anchor hashes. The report is signed (HMAC-SHA256) to detect tampering. This report does not replace a formal regulatory filing.',
    ledgerVerify:
      'The hash chain provides tamper-evidence for KYC decisions. It does not store personal data. Verification confirms the chain has not been rewritten since the last anchor. This is not a blockchain transaction and does not provide on-chain immutability.',
  },
  report: {
    header:
      'NFT-KYC Hub Compliance Report — Generated for regulatory audit purposes. This document contains no personal data as defined by GDPR Article 4(1).',
    footer:
      'End of report. This report is signed with HMAC-SHA256. Any modification invalidates the signature. For verification, use the /v1/compliance/report endpoint with the same parameters.',
    dataProcessing:
      'Personal data is processed under GDPR Article 6(1)(a) (consent) and Article 6(1)(c) (legal obligation under AMLD5). Data is encrypted with AES-256-GCM before storage. Encryption keys are managed in AWS KMS with automatic rotation. The ledger stores only salted credential digests — no personal data ever touches the chain.',
    retention:
      'KYC records are retained for 7 years per AMLD5 Article 40. Listing decisions are retained for 3 years. Consent records are retained for 7 years as evidence of lawful processing. Automated deletion runs per the configured schedule. Data subjects may request erasure via the right-to-erasure endpoint, subject to legal hold overrides.',
  },
  consent: {
    grant:
      'By granting consent, you allow us to process your personal data for KYC verification, AML screening, risk scoring, ledger anchoring, and compliance reporting. Mandatory purposes (KYC processing, AML screening, compliance reporting) cannot be withdrawn without terminating the service relationship. You may withdraw optional purposes at any time.',
    withdrawal:
      'Consent withdrawal is processed immediately for optional purposes. Mandatory purposes remain active as they are required by law (AMLD5, GDPR Article 6(1)(c)). Withdrawal of all consent will result in deletion of your personal data per the retention schedule, except where legal obligations require retention. You will receive a confirmation with the withdrawal timestamp.',
  },
  privacy: {
    controller: 'NFT Marketplace (data controller per GDPR Article 4(7))',
    processor: 'NFT-KYC Hub (data processor per GDPR Article 4(8))',
    dpoContact: 'dpo@nft-kyc-hub.example.com',
    lawfulBasis:
      'Processing is based on: (1) Consent (GDPR Art. 6(1)(a)) for KYC submission and optional purposes; (2) Legal obligation (GDPR Art. 6(1)(c)) for AML screening and compliance reporting under AMLD5; (3) Legitimate interest (GDPR Art. 6(1)(f)) for fraud prevention and service improvement.',
    rightsSummary:
      'Data subjects have the right to: access (Art. 15), rectification (Art. 16), erasure (Art. 17), restriction (Art. 18), portability (Art. 20), objection (Art. 21), and to lodge a complaint with a supervisory authority (Art. 77). Exercise rights via the compliance endpoints or contact the DPO.',
  },
};

/** Returns the disclaimer text for a specific API endpoint. */
export function getApiDisclaimer(endpoint: keyof DisclaimerSet['api']): string {
  return DISCLAIMERS.api[endpoint];
}

/** Returns the full disclaimer set for embedding in reports. */
export function getReportDisclaimers(): Pick<DisclaimerSet['report'], 'header' | 'footer' | 'dataProcessing' | 'retention'> {
  return DISCLAIMERS.report;
}

/** Returns consent-related disclaimers. */
export function getConsentDisclaimers(): Pick<DisclaimerSet['consent'], 'grant' | 'withdrawal'> {
  return DISCLAIMERS.consent;
}

/** Returns privacy notice components. */
export function getPrivacyNotice(): DisclaimerSet['privacy'] {
  return DISCLAIMERS.privacy;
}

/** Returns the current disclaimer version for audit trails. */
export function getDisclaimerVersion(): string {
  return DISCLAIMERS.version;
}