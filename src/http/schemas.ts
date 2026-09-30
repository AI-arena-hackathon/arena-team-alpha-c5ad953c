import { z } from 'zod';

/**
 * Request schemas for the partner API. zod does shape validation here; the
 * semantic rules that protect product guarantees live in
 * `services/kycService.validateSubmission`.
 */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be an ISO date (yyyy-mm-dd)');
const isoTimestamp = z.string().datetime({ offset: true });
const countryCode = z
  .string()
  .regex(/^[A-Za-z]{2}$/, 'must be a two-letter ISO 3166-1 alpha-2 code')
  .transform((value) => value.toUpperCase());

export const submissionSchema = z.object({
  submissionId: z.string().min(8).max(128).optional(),
  subject: z.object({
    subjectId: z.string().min(3).max(128),
    fullName: z.string().min(2).max(200),
    dateOfBirth: isoDate,
    countryCode,
    document: z.object({
      type: z.enum(['passport', 'national_id', 'drivers_license']),
      number: z.string().min(4).max(64),
      issuingCountry: countryCode,
      expiresOn: isoDate,
    }),
    wallet: z.object({
      address: z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'must be a 20-byte hex wallet address'),
      chain: z.enum(['polygon', 'polygon-zkevm', 'ethereum']),
      firstSeenAt: isoTimestamp,
      transactionCount: z.number().int().min(0).max(1_000_000),
      volumeUsd: z.number().min(0).max(1e12),
    }),
  }),
  claims: z
    .object({
      politicallyExposed: z.boolean().optional(),
      sourceOfFunds: z
        .enum(['salary', 'business_revenue', 'crypto_savings', 'investment', 'inheritance', 'unknown'])
        .optional(),
      notes: z.string().max(2000).optional(),
    })
    .optional(),
  credential: z
    .object({
      format: z.enum(['eidas', 'franceconnect']),
      assertion: z.string().min(16).max(8192),
    })
    .optional(),
  consent: z.object({
    granted: z.literal(true, {
      errorMap: () => ({ message: 'consent.granted must be true — we cannot process KYC without consent' }),
    }),
    capturedAt: isoTimestamp,
    ip: z.string().max(64).optional(),
  }),
  listingId: z.string().min(1).max(128).optional(),
});

export const listingCheckSchema = z.object({
  subjectId: z.string().min(3).max(128),
});

export const reportQuerySchema = z.object({
  from: isoTimestamp.optional(),
  to: isoTimestamp.optional(),
});

export const submissionIdSchema = z.object({
  submissionId: z.string().min(8).max(128),
});

export const subjectParamSchema = z.object({
  subjectId: z.string().min(3).max(128),
});

export const listingParamSchema = z.object({
  listingId: z.string().min(1).max(128),
});

export type SubmissionBody = z.infer<typeof submissionSchema>;
export type ListingCheckBody = z.infer<typeof listingCheckSchema>;