import { z } from 'zod';

/**
 * Response schemas for the partner API. These document the shape of successful
 * responses and can be used for contract testing or client generation.
 */

/**
 * Refresh health of the live sanctions feed, as reported by `/health`.
 * `lastError` and the feed URL are deliberately absent from this summary: they
 * are only served on the authenticated `/v1/health/details`.
 */
export const schedulerSummarySchema = z.object({
  enabled: z.boolean(),
  lastRefreshStatus: z.enum(['success', 'failed', 'never']),
  lastRefreshAt: z.string().datetime({ offset: true }).nullable(),
  consecutiveFailures: z.number().int().nonnegative(),
  circuitBreakerState: z.enum(['closed', 'open', 'half-open']),
  totalRefreshes: z.number().int().nonnegative(),
  totalFailures: z.number().int().nonnegative(),
  installedEntries: z.number().int().nonnegative().nullable(),
  minEntries: z.number().int().positive(),
});

/** Full scheduler metrics, as reported by the authenticated `/v1/health/details`. */
export const schedulerMetricsSchema = schedulerSummarySchema.extend({
  url: z.string().nullable(),
  intervalMs: z.number().int().positive(),
  lastError: z.string().nullable(),
  nextRefreshAt: z.string().datetime({ offset: true }).nullable(),
  circuitBreakerOpenedAt: z.string().datetime({ offset: true }).nullable(),
  circuitBreakerNextAttemptAt: z.string().datetime({ offset: true }).nullable(),
});

export const healthResponseSchema = z.object({
  status: z.literal('ok'),
  service: z.literal('nft-kyc-hub'),
  version: z.string(),
  startedAt: z.string().datetime({ offset: true }),
  now: z.string().datetime({ offset: true }),
  environment: z.enum(['development', 'test', 'production']),
  adapters: z.array(z.string()),
  sanctionsList: z.string(),
  warnings: z.array(z.string()),
  sanctionsScheduler: schedulerSummarySchema.nullish(),
});

export const healthDetailsResponseSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  ledger: z.object({
    valid: z.boolean(),
    length: z.number().int().nonnegative(),
    headHash: z.string().length(64),
    brokenAtIndex: z.number().int().nullable(),
    detail: z.string(),
  }),
  submissions: z.array(z.string()),
  sanctionsScheduler: schedulerMetricsSchema.nullish(),
});

export const kycSubmitResponseSchema = z.object({
  submissionId: z.string(),
  subjectId: z.string(),
  status: z.enum(['verified', 'review', 'rejected']),
  decision: z.enum(['approve', 'review', 'reject']),
  risk: z.object({
    score: z.number().int().min(0).max(100),
    band: z.enum(['low', 'medium', 'high']),
    modelVersion: z.string(),
    reasons: z.array(
      z.object({
        code: z.string(),
        label: z.string(),
        weight: z.number().int(),
        detail: z.string(),
      }),
    ),
    sanctionsHits: z.array(
      z.object({
        listName: z.string(),
        matchedOn: z.enum(['name', 'name_and_dob', 'wallet']),
        subjectName: z.string(),
        reference: z.string(),
        programme: z.string(),
      }),
    ),
  }),
  identity: z.object({
    provider: z.string(),
    assurance: z.enum(['high', 'substantial', 'low', 'none']),
    method: z.string(),
    verifiedAt: z.string().datetime({ offset: true }),
  }),
  credentialDigest: z.string().length(64),
  ledger: z.object({
    index: z.number().int().nonnegative(),
    hash: z.string().length(64),
  }),
  idempotentReplay: z.boolean(),
  listingBlocked: z.boolean(),
});

export const kycRecordResponseSchema = z.object({
  submissionId: z.string(),
  subjectId: z.string(),
  listingId: z.string().optional(),
  status: z.enum(['verified', 'review', 'rejected']),
  decision: z.enum(['approve', 'review', 'reject']),
  risk: z.object({
    score: z.number().int().min(0).max(100),
    band: z.enum(['low', 'medium', 'high']),
    reasons: z.array(
      z.object({
        code: z.string(),
        label: z.string(),
        weight: z.number().int(),
        severity: z.enum(['blocking', 'review', 'score']),
        detail: z.string(),
      }),
    ),
    sanctionsHits: z.array(
      z.object({
        listName: z.string(),
        matchedOn: z.enum(['name', 'name_and_dob', 'wallet']),
        subjectName: z.string(),
        reference: z.string(),
        programme: z.string(),
      }),
    ),
    modelVersion: z.string(),
  }),
  identity: z.object({
    provider: z.string(),
    assurance: z.enum(['high', 'substantial', 'low', 'none']),
    method: z.string(),
    verifiedAt: z.string().datetime({ offset: true }),
  }),
  credentialDigest: z.string().length(64),
  ledgerAnchorHash: z.string().length(64),
  consentCapturedAt: z.string().datetime({ offset: true }),
  submittedAt: z.string().datetime({ offset: true }),
  evaluatedAt: z.string().datetime({ offset: true }),
  evidenceStored: z.literal('encrypted'),
});

export const subjectHistoryResponseSchema = z.object({
  subjectId: z.string(),
  submissions: z.number().int().nonnegative(),
  currentStatus: z.enum(['verified', 'review', 'rejected', 'unknown']),
  history: z.array(kycRecordResponseSchema),
});

export const listingCheckResponseSchema = z.object({
  listingId: z.string(),
  marketplaceId: z.string(),
  subjectId: z.string(),
  allowed: z.boolean(),
  status: z.enum(['verified', 'review', 'rejected', 'unknown']),
  reason: z.string(),
  requiredAction: z.string(),
  riskScore: z.number().int().min(0).max(100).nullable(),
  checkedAt: z.string().datetime({ offset: true }),
});

export const complianceReportResponseSchema = z.object({
  reportId: z.string(),
  generatedAt: z.string().datetime({ offset: true }),
  window: z.object({
    from: z.string().datetime({ offset: true }),
    to: z.string().datetime({ offset: true }),
  }),
  marketplaceId: z.string(),
  totals: z.object({
    submissions: z.number().int().nonnegative(),
    verified: z.number().int().nonnegative(),
    review: z.number().int().nonnegative(),
    rejected: z.number().int().nonnegative(),
    blockedListings: z.number().int().nonnegative(),
    sanctionsHits: z.number().int().nonnegative(),
    averageRiskScore: z.number(),
  }),
  riskDistribution: z.object({
    low: z.number().int().nonnegative(),
    medium: z.number().int().nonnegative(),
    high: z.number().int().nonnegative(),
  }),
  topRiskDrivers: z.array(
    z.object({
      code: z.string(),
      label: z.string(),
      occurrences: z.number().int().nonnegative(),
    }),
  ),
  records: z.array(
    z.object({
      submissionId: z.string(),
      subjectId: z.string(),
      status: z.enum(['verified', 'review', 'rejected']),
      riskScore: z.number().int().min(0).max(100),
      riskBand: z.enum(['low', 'medium', 'high']),
      credentialDigest: z.string().length(64),
      ledgerHash: z.string().length(64),
      decidedAt: z.string().datetime({ offset: true }),
    }),
  ),
  signature: z.object({
    alg: z.literal('HMAC-SHA256'),
    keyId: z.string(),
    value: z.string().length(64),
  }),
  attestation: z.string(),
});

export const ledgerVerifyResponseSchema = z.object({
  valid: z.boolean(),
  length: z.number().int().nonnegative(),
  headHash: z.string().length(64),
  brokenAtIndex: z.number().int().nullable(),
  detail: z.string(),
});

export const ledgerAnchorResponseSchema = z.object({
  index: z.number().int().nonnegative(),
  type: z.enum(['kyc_proof', 'sanctions_notice', 'decision_notice']),
  subjectId: z.string(),
  submissionId: z.string(),
  marketplaceId: z.string(),
  credentialDigest: z.string().length(64),
  decision: z.enum(['approve', 'review', 'reject']),
  riskScore: z.number().int().min(0).max(100),
  payloadDigest: z.string().length(64),
  prevHash: z.string().length(64),
  hash: z.string().length(64),
  createdAt: z.string().datetime({ offset: true }),
});

export const errorResponseSchema = z.object({
  error: z.string(),
  message: z.string(),
  details: z.record(z.unknown()).optional(),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;
export type HealthDetailsResponse = z.infer<typeof healthDetailsResponseSchema>;
export type KycSubmitResponse = z.infer<typeof kycSubmitResponseSchema>;
export type KycRecordResponse = z.infer<typeof kycRecordResponseSchema>;
export type SubjectHistoryResponse = z.infer<typeof subjectHistoryResponseSchema>;
export type ListingCheckResponse = z.infer<typeof listingCheckResponseSchema>;
export type ComplianceReportResponse = z.infer<typeof complianceReportResponseSchema>;
export type LedgerVerifyResponse = z.infer<typeof ledgerVerifyResponseSchema>;
export type LedgerAnchorResponse = z.infer<typeof ledgerAnchorResponseSchema>;
export type ErrorResponse = z.infer<typeof errorResponseSchema>;