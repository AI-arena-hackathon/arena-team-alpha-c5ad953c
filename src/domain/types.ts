import type { EncryptedEnvelope } from '../security/encryption';

/**
 * Domain model for the KYC hub. Anything carrying personal data lives under
 * `KycRecord.personalDataEnvelope` (encrypted) — every other shape in this file
 * is PII-free and therefore safe to anchor, report on and log.
 */

export type DocumentType = 'passport' | 'national_id' | 'drivers_license';

export type Chain = 'polygon' | 'polygon-zkevm' | 'ethereum';

export type SourceOfFunds =
  | 'salary'
  | 'business_revenue'
  | 'crypto_savings'
  | 'investment'
  | 'inheritance'
  | 'unknown';

export type CredentialFormat = 'eidas' | 'franceconnect';

export type AssuranceLevel = 'high' | 'substantial' | 'low' | 'none';

export type RiskBand = 'low' | 'medium' | 'high';

/** Outcome of the full KYC decision. Maps 1:1 onto the marketplace listing gate. */
export type KycStatus = 'verified' | 'review' | 'rejected';

/** Terminal per-submission outcome; `approve` blocks nothing, `reject` is an outright refusal. */
export type Decision = 'approve' | 'review' | 'reject';

export interface IdentityDocument {
  type: DocumentType;
  number: string;
  issuingCountry: string;
  expiresOn: string;
}

export interface WalletProfile {
  address: string;
  chain: Chain;
  firstSeenAt: string;
  transactionCount: number;
  volumeUsd: number;
}

export interface SubjectClaims {
  politicallyExposed?: boolean;
  sourceOfFunds?: SourceOfFunds;
  /** Free-text justification supplied by the marketplace; not stored in plaintext. */
  notes?: string;
}

export interface RawCredential {
  format: CredentialFormat;
  assertion: string;
}

export interface KycSubmissionInput {
  submissionId?: string;
  subject: {
    subjectId: string;
    fullName: string;
    dateOfBirth: string;
    countryCode: string;
    document: IdentityDocument;
    wallet: WalletProfile;
  };
  claims?: SubjectClaims;
  credential?: RawCredential;
  consent: {
    granted: boolean;
    capturedAt: string;
    ip?: string;
  };
  listingId?: string;
}

/** Identity assertion as normalised out of the vendor-specific credential. */
export interface IdentityAssertion {
  subjectId: string;
  fullName: string;
  dateOfBirth: string;
  assurance: AssuranceLevel;
  method: string;
  issuer: string;
  issuedAt: string;
  expiresAt: string;
  /** Extra vendor claims kept for the audit trail (no raw token ever persisted). */
  claims: Record<string, string>;
}

export type IdentityFailureReason =
  | 'credential_missing'
  | 'credential_malformed'
  | 'signature_invalid'
  | 'credential_expired'
  | 'subject_mismatch'
  | 'assurance_too_low'
  | 'unknown_provider';

export interface IdentityVerificationFailure {
  verified: false;
  reason: IdentityFailureReason;
  detail: string;
  provider: string;
}

export interface IdentityVerificationSuccess {
  verified: true;
  assertion: IdentityAssertion;
  provider: string;
}

export type IdentityVerificationResult =
  | IdentityVerificationSuccess
  | IdentityVerificationFailure;

export interface SanctionsHit {
  listName: string;
  matchedOn: 'name' | 'name_and_dob' | 'wallet';
  subjectName: string;
  reference: string;
  programme: string;
}

export type RiskSeverity =
  /** Hard rule: the submission is refused outright. */
  | 'blocking'
  /** Not aggregable: one occurrence alone must always reach a human reviewer. */
  | 'review'
  /** Accumulates into the score; only meaningful in combination. */
  | 'score';

export interface RiskFeature {
  code: string;
  label: string;
  weight: number;
  severity: RiskSeverity;
  detail: string;
}

export interface RiskAssessment {
  score: number;
  band: RiskBand;
  decision: Decision;
  /** Hard rules that override the score (sanctions hit, failed identity). */
  overrides: RiskFeature[];
  features: RiskFeature[];
  sanctionsHits: SanctionsHit[];
  modelVersion: string;
  assessedAt: string;
}

export interface LedgerAnchor {
  index: number;
  type: 'kyc_proof' | 'sanctions_notice' | 'decision_notice';
  subjectId: string;
  submissionId: string;
  marketplaceId: string;
  credentialDigest: string;
  decision: Decision;
  riskScore: number;
  payloadDigest: string;
  prevHash: string;
  hash: string;
  createdAt: string;
}

export interface KycRecord {
  submissionId: string;
  marketplaceId: string;
  subjectId: string;
  listingId?: string;
  status: KycStatus;
  decision: Decision;
  risk: RiskAssessment;
  identity: {
    provider: string;
    assurance: AssuranceLevel;
    method: string;
    verifiedAt: string;
  };
  /** Salted digest of the credential — never the credential itself. */
  credentialDigest: string;
  /** AES-256-GCM envelope; the only place personal data is stored. */
  personalDataEnvelope: EncryptedEnvelope;
  ledgerAnchorHash: string;
  consentCapturedAt: string;
  submittedAt: string;
  evaluatedAt: string;
  /** Idempotency fingerprint of the request payload. */
  requestDigest: string;
}

export interface ListingDecision {
  listingId: string;
  marketplaceId: string;
  subjectId: string;
  allowed: boolean;
  status: KycStatus | 'unknown';
  reason: string;
  requiredAction: string;
  riskScore: number | null;
  checkedAt: string;
}

export interface ComplianceReport {
  reportId: string;
  generatedAt: string;
  window: { from: string; to: string };
  marketplaceId: string;
  totals: {
    submissions: number;
    verified: number;
    review: number;
    rejected: number;
    blockedListings: number;
    sanctionsHits: number;
    averageRiskScore: number;
  };
  riskDistribution: Record<RiskBand, number>;
  topRiskDrivers: Array<{ code: string; label: string; occurrences: number }>;
  records: Array<{
    submissionId: string;
    subjectId: string;
    status: KycStatus;
    riskScore: number;
    riskBand: RiskBand;
    credentialDigest: string;
    ledgerHash: string;
    decidedAt: string;
  }>;
  signature: { alg: 'HMAC-SHA256'; keyId: string; value: string };
  attestation: string;
}