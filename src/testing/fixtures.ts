import { loadConfig, type AppConfig } from '../config';
import { signAssertion } from '../identity/eidProvider';
import type { CredentialFormat, KycSubmissionInput } from '../domain/types';

/**
 * Test fixtures. One place defines "a healthy EU creator", so tests that differ
 * by one risk signal stay readable, and the happy path has a single source of
 * truth that the risk-engine tests can perturb.
 */

export const TEST_API_KEY = 'test-market-key-001';
export const TEST_MARKETPLACE = 'market-alpha';
export const TEST_EIDAS_SECRET = 'test-eidas-secret';
export const TEST_FRANCE_CONNECT_SECRET = 'test-franceconnect-secret';
export const TEST_REPORT_KEY = 'test-report-signing-key';
export const TEST_MASTER_KEY = 'a'.repeat(64);
export const TEST_NOW = '2025-03-01T09:00:00.000Z';

export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const base = loadConfig({
    NODE_ENV: 'test',
    KYC_MASTER_KEY: TEST_MASTER_KEY,
    KYC_MASTER_KEY_ID: 'k-test',
    CREDENTIAL_HASH_SALT: 'test-credential-hash-salt',
    REPORT_SIGNING_KEY: TEST_REPORT_KEY,
    EID_EIDAS_SECRET: TEST_EIDAS_SECRET,
    EID_FRANCE_CONNECT_SECRET: TEST_FRANCE_CONNECT_SECRET,
    PARTNER_API_KEYS: `${TEST_API_KEY}:${TEST_MARKETPLACE}`,
  } as NodeJS.ProcessEnv);

  return { ...base, warnings: [], ...overrides };
}

export function eidasAssertion(
  claims: Record<string, unknown> = {},
  secret = TEST_EIDAS_SECRET,
): string {
  return signAssertion(
    {
      iss: 'https://eidas-gateway.demo/issuer',
      sub: 'seller-777',
      name: 'Ines Ferreira',
      birth_date: '1991-04-17',
      acr: 'high',
      aalink: 'passport',
      iat: '2025-02-28T10:00:00.000Z',
      exp: '2026-02-28T10:00:00.000Z',
      ...claims,
    },
    secret,
  );
}

export function franceConnectAssertion(
  claims: Record<string, unknown> = {},
  secret = TEST_FRANCE_CONNECT_SECRET,
): string {
  return signAssertion(
    {
      iss: 'https://app.franceconnect.gouv.fr',
      sub: 'seller-777',
      name: 'Ines Ferreira',
      birthdate: '1991-04-17',
      acr: 'eidas-aalink-substantial',
      amr: ['pwd', 'mfa'],
      idp: 'franceconnect',
      iat: '2025-02-28T10:00:00.000Z',
      exp: '2026-02-28T10:00:00.000Z',
      ...claims,
    },
    secret,
  );
}

/** A low-risk EU creator: verified e-ID, valid document, established wallet. */
export function healthySubmission(
  overrides: Partial<KycSubmissionInput> = {},
): KycSubmissionInput {
  return {
    submissionId: 'kyc_submission_0001',
    subject: {
      subjectId: 'seller-777',
      fullName: 'Ines Ferreira',
      dateOfBirth: '1991-04-17',
      countryCode: 'PT',
      document: {
        type: 'passport',
        number: 'PT4417X',
        issuingCountry: 'PT',
        expiresOn: '2031-04-16',
      },
      wallet: {
        address: '0x' + '1'.repeat(40),
        chain: 'polygon',
        firstSeenAt: '2021-06-01T00:00:00.000Z',
        transactionCount: 412,
        volumeUsd: 48_000,
      },
    },
    claims: { politicallyExposed: false, sourceOfFunds: 'salary' },
    credential: { format: 'eidas' as CredentialFormat, assertion: eidasAssertion() },
    consent: { granted: true, capturedAt: '2025-02-28T12:00:00.000Z' },
    listingId: 'listing-9001',
    ...overrides,
  };
}