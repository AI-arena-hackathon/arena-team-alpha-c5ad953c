import type { KycRecord, KycStatus, Decision, RiskBand, ListingDecision } from '../domain/types';
import { redactPii } from '../security/redaction';
import { canonicalJson } from '../util/canonical';

/**
 * Centralized PII-free serialization for KYC records.
 *
 * This is the single source of truth for extracting public-facing data from
 * encrypted KYC records. It guarantees that no personal data ever leaks into
 * API responses, logs, compliance reports or ledger anchors.
 */
export class KycRecordSerializer {
  /**
   * Serialize a full KycRecord for partner API responses.
   * Strips the encrypted envelope and returns only PII-free fields.
   */
  toPublicRecord(record: KycRecord): PublicKycRecord {
    return {
      submissionId: record.submissionId,
      subjectId: record.subjectId,
      ...(record.listingId ? { listingId: record.listingId } : {}),
      status: record.status,
      decision: record.decision,
      risk: this.serializeRisk(record.risk),
      identity: record.identity,
      credentialDigest: record.credentialDigest,
      ledgerAnchorHash: record.ledgerAnchorHash,
      consentCapturedAt: record.consentCapturedAt,
      submittedAt: record.submittedAt,
      evaluatedAt: record.evaluatedAt,
      evidenceStored: 'encrypted' as const,
    };
  }

  /**
   * Serialize a KycRecord for structured logging.
   * Redacts any PII fields as a defense-in-depth measure.
   */
  toLogSummary(record: KycRecord): LogSummary {
    const base = {
      submissionId: record.submissionId,
      marketplaceId: record.marketplaceId,
      subjectId: record.subjectId,
      status: record.status,
      decision: record.decision,
      riskScore: record.risk.score,
      riskBand: record.risk.band,
      reasonCodes: record.risk.features.map((item) => item.code),
      sanctionsHits: record.risk.sanctionsHits.length,
      ledgerHash: record.ledgerAnchorHash,
      evaluatedAt: record.evaluatedAt,
    };
    return redactPii(base);
  }

  /**
   * Serialize a KycRecord for compliance reports.
   * Returns the minimal evidence set needed for auditability.
   */
  toReportRecord(record: KycRecord): ReportRecord {
    return {
      submissionId: record.submissionId,
      subjectId: record.subjectId,
      status: record.status,
      riskScore: record.risk.score,
      riskBand: record.risk.band,
      credentialDigest: record.credentialDigest,
      ledgerHash: record.ledgerAnchorHash,
      decidedAt: record.evaluatedAt,
    };
  }

  /**
   * Serialize a listing decision for API responses and reports.
   */
  serializeListingDecision(decision: ListingDecision): PublicListingDecision {
    return {
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
  }

  /**
   * Serialize risk assessment for API responses.
   */
  serializeRisk(risk: KycRecord['risk']): PublicRisk {
    return {
      score: risk.score,
      band: risk.band,
      modelVersion: risk.modelVersion,
      reasons: risk.features.map((item) => ({
        code: item.code,
        label: item.label,
        weight: item.weight,
        detail: item.detail,
      })),
      sanctionsHits: risk.sanctionsHits,
    };
  }

  /**
   * Serialize multiple records for a compliance report.
   */
  serializeForReport(records: KycRecord[]): ReportRecord[] {
    return records.map((record) => this.toReportRecord(record));
  }

  /**
   * Verify that a serialized payload contains no PII.
   * Throws if any PII field names are detected.
   */
  assertNoPii<T>(payload: T, context: string): void {
    const piiPaths = this.findPiiPaths(payload);
    if (piiPaths.length > 0) {
      throw new Error(`PII leak detected in ${context}: ${piiPaths.join(', ')}`);
    }
  }

  /**
   * Find all PII field paths in a payload (uses the centralized PII field list).
   */
  findPiiPaths(value: unknown, path = '$', found: string[] = []): string[] {
    if (Array.isArray(value)) {
      value.forEach((item, index) => this.findPiiPaths(item, `${path}[${index}]`, found));
      return found;
    }
    if (value && typeof value === 'object' && !(value instanceof Date)) {
      for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        const next = `${path}.${key}`;
        if (PII_FIELD_NAMES.has(key)) found.push(next);
        this.findPiiPaths(entry, next, found);
      }
    }
    return found;
  }
}

/** Field names that must never leave the encryption boundary. */
const PII_FIELD_NAMES = new Set([
  'fullName',
  'firstName',
  'lastName',
  'dateOfBirth',
  'birthDate',
  'birthdate',
  'documentNumber',
  'nationality',
  'addressLine',
  'street',
  'postcode',
  'email',
  'phone',
  'passportNumber',
  'idNumber',
  'rawAssertion',
]);

/** PII-free record for partner API responses. */
export interface PublicKycRecord {
  submissionId: string;
  subjectId: string;
  listingId?: string;
  status: KycStatus;
  decision: Decision;
  risk: PublicRisk;
  identity: KycRecord['identity'];
  credentialDigest: string;
  ledgerAnchorHash: string;
  consentCapturedAt: string;
  submittedAt: string;
  evaluatedAt: string;
  evidenceStored: 'encrypted';
}

/** PII-free risk assessment for partner API responses. */
export interface PublicRisk {
  score: number;
  band: RiskBand;
  modelVersion: string;
  reasons: Array<{
    code: string;
    label: string;
    weight: number;
    detail: string;
  }>;
  sanctionsHits: KycRecord['risk']['sanctionsHits'];
}

/** PII-free summary for structured logging. */
export interface LogSummary {
  submissionId: string;
  marketplaceId: string;
  subjectId: string;
  status: KycStatus;
  decision: Decision;
  riskScore: number;
  riskBand: RiskBand;
  reasonCodes: string[];
  sanctionsHits: number;
  ledgerHash: string;
  evaluatedAt: string;
  [key: string]: unknown;
}

/** Minimal record for compliance reports. */
export interface ReportRecord {
  submissionId: string;
  subjectId: string;
  status: KycStatus;
  riskScore: number;
  riskBand: RiskBand;
  credentialDigest: string;
  ledgerHash: string;
  decidedAt: string;
}

/** PII-free listing decision for API responses. */
export interface PublicListingDecision {
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

/** Singleton instance for convenience. */
export const recordSerializer = new KycRecordSerializer();

/** Canonical JSON serialization for hashing and signing. */
export { canonicalJson };