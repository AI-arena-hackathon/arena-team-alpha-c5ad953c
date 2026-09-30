import type {
  Decision,
  IdentityVerificationFailure,
  IdentityVerificationSuccess,
  RiskAssessment,
  RiskBand,
  RiskFeature,
  RiskSeverity,
  SanctionsHit,
} from '../domain/types';
import { wholeDaysUntil } from '../util/clock';
import {
  EEA_COUNTRIES,
  ELEVATED_RISK_JURISDICTIONS,
  HIGH_RISK_JURISDICTIONS,
  normaliseCountry,
  sameName,
} from './referenceData';
import { SanctionsScreener } from './sanctions';

/**
 * Risk-scoring engine (README component 2).
 *
 * MVP implementation of the "lightweight model": a transparent, versioned linear
 * scoring model over weighted AML features, which is exactly the documented
 * fallback scope ("rule-based sanctions list lookup") and gives every score a
 * human-readable reason list. Weights are declared as data below so they can be
 * reviewed by a compliance officer and retuned without touching the logic; the
 * same feature/weight shape is what a trained model would feed, so swapping in
 * XGBoost later is a change inside `scoreFeatures`, not across the codebase.
 *
 * Thresholds follow a conservative 3-tier decision: automatic approval only for
 * low-risk, review for medium/high, and outright rejection only for sanctions
 * matches or a failed identity check.
 */
export const MODEL_VERSION = 'rules-2025.01';

export const THRESHOLDS = {
  reviewAt: 30,
  highAt: 65,
  adultAgeYears: 18,
  documentExpiryWarningDays: 30,
  newWalletDays: 7,
  lowActivityTransactions: 5,
  highVolumeUsd: 250_000,
} as const;

export interface RiskEngineInput {
  subjectId: string;
  fullName: string;
  dateOfBirth: string;
  countryCode: string;
  documentType: string;
  documentExpiresOn: string;
  wallet: { address: string; firstSeenAt: string; transactionCount: number; volumeUsd: number };
  claims: { politicallyExposed?: boolean; sourceOfFunds?: string };
  identity: IdentityVerificationSuccess | IdentityVerificationFailure;
  consentGranted: boolean;
  now: Date;
}

export class RiskEngine {
  constructor(private readonly screener: SanctionsScreener = new SanctionsScreener()) {}

  assess(input: RiskEngineInput): RiskAssessment {
    const sanctionsHits = this.screen(input);
    const features: RiskFeature[] = [];
    const overrides: RiskFeature[] = [];

    // --- hard rules -------------------------------------------------------
    if (sanctionsHits.length > 0) {
      overrides.push(
        blocking(
          'SANCTIONS_MATCH',
          'Sanctions / watchlist match',
          sanctionsHits
            .map((hit) => `${hit.listName}#${hit.reference} (${hit.programme}) matched on ${hit.matchedOn}`)
            .join('; '),
        ),
      );
    }

    if (!input.identity.verified) {
      overrides.push(
        blocking(
          'IDENTITY_NOT_VERIFIED',
          'Identity could not be verified',
          `${input.identity.provider}: ${input.identity.reason} — ${input.identity.detail}`,
        ),
      );
    }

    if (!input.consentGranted) {
      overrides.push(
        blocking(
          'CONSENT_MISSING',
          'GDPR consent not captured',
          'processing a KYC subject without recorded consent is unlawful (GDPR art. 6/7)',
        ),
      );
    }

    if (isMinor(input.dateOfBirth, input.now)) {
      overrides.push(
        blocking(
          'SUBJECT_UNDER_AGE',
          'Subject below 18',
          `date of birth ${input.dateOfBirth} implies the subject is a minor`,
        ),
      );
    }

    // --- weighted features -------------------------------------------------
    if (input.claims.politicallyExposed) {
      features.push(
        feature('PEP_DECLARED', 'Politically exposed person', 45, 'review', 'marketplace declared a PEP'),
      );
    }

    if (input.claims.sourceOfFunds === 'unknown' || input.claims.sourceOfFunds === undefined) {
      features.push(
        feature('SOURCE_OF_FUNDS_UNKNOWN', 'Source of funds not declared', 18, 'score', 'seller did not declare funding source'),
      );
    } else if (input.claims.sourceOfFunds === 'crypto_savings') {
      features.push(
        feature('SOURCE_OF_FUNDS_CRYPTO', 'Crypto-derived funding source', 10, 'score', 'funds declared as prior crypto holdings'),
      );
    }

    const country = normaliseCountry(input.countryCode);
    if (HIGH_RISK_JURISDICTIONS.has(country)) {
      features.push(
        feature('HIGH_RISK_JURISDICTION', 'FATF high-risk jurisdiction', 40, 'review', `country of residence ${country}`),
      );
    } else if (ELEVATED_RISK_JURISDICTIONS.has(country)) {
      features.push(
        feature('ELEVATED_RISK_JURISDICTION', 'Elevated-risk jurisdiction', 12, 'score', `country of residence ${country}`),
      );
    } else if (!EEA_COUNTRIES.has(country)) {
      features.push(
        feature('NON_EEA_SUBJECT', 'Subject outside the EEA', 6, 'score', `country of residence ${country} is outside the EEA`),
      );
    }

    const expiryDays = wholeDaysUntil(input.now, parseDate(input.documentExpiresOn));
    if (expiryDays < 0) {
      features.push(
        feature('DOCUMENT_EXPIRED', 'Identity document expired', 25, 'review', `document expired ${Math.abs(expiryDays)} day(s) ago`),
      );
    } else if (expiryDays <= THRESHOLDS.documentExpiryWarningDays) {
      features.push(
        feature('DOCUMENT_EXPIRING', 'Identity document expires soon', 8, 'score', `document expires in ${expiryDays} day(s)`),
      );
    }

    const walletAgeDays = wholeDaysUntil(parseDate(input.wallet.firstSeenAt), input.now);
    if (walletAgeDays < THRESHOLDS.newWalletDays) {
      features.push(
        feature('NEW_WALLET', 'Very new wallet', 20, 'score', `wallet first seen ${Math.max(walletAgeDays, 0)} day(s) ago`),
      );
    }
    if (input.wallet.transactionCount < THRESHOLDS.lowActivityTransactions) {
      features.push(
        feature('LOW_WALLET_ACTIVITY', 'Thin on-chain history', 10, 'score', `only ${input.wallet.transactionCount} transaction(s) on record`),
      );
    }
    if (input.wallet.volumeUsd >= THRESHOLDS.highVolumeUsd) {
      features.push(
        feature('HIGH_WALLET_VOLUME', 'Large wallet volume', 15, 'review', `$${Math.round(input.wallet.volumeUsd).toLocaleString('en-US')} moved through the wallet`),
      );
    }

    if (input.identity.verified) {
      features.push(...crossCheckFeatures(input));
    }

    const score = clamp(
      overrides.reduce((total, item) => total + item.weight, 0) +
        features.reduce((total, item) => total + item.weight, 0),
      0,
      100,
    );

    const band = bandFor(score);
    const decision = decide(overrides, features, score);

    return {
      score,
      band,
      decision,
      overrides,
      features: [...overrides, ...features],
      sanctionsHits,
      modelVersion: MODEL_VERSION,
      assessedAt: input.now.toISOString(),
    };
  }

  private screen(input: RiskEngineInput): SanctionsHit[] {
    return this.screener.screen({
      name: input.fullName,
      dateOfBirth: input.dateOfBirth,
      walletAddress: input.wallet.address,
    });
  }
}

/** Compare the marketplace's declared identity against the e-ID assertion. */
function crossCheckFeatures(input: RiskEngineInput): RiskFeature[] {
  if (!input.identity.verified) return [];
  const features: RiskFeature[] = [];
  const asserted = input.identity.assertion;

  if (asserted.dateOfBirth !== input.dateOfBirth) {
    features.push(
      feature(
        'DOB_MISMATCH',
        'Date of birth differs from the e-ID assertion',
        35,
        'review',
        `submitted ${input.dateOfBirth} vs asserted ${asserted.dateOfBirth}`,
      ),
    );
  }

  if (!sameName(asserted.fullName, input.fullName)) {
    features.push(
      feature(
        'NAME_MISMATCH',
        'Name differs from the e-ID assertion',
        30,
        'review',
        `submitted "${input.fullName}" vs asserted "${asserted.fullName}"`,
      ),
    );
  }

  if (asserted.assurance === 'low') {
    features.push(
      feature('LOW_ASSURANCE', 'Low e-ID assurance level', 15, 'score', 'assertion was issued at eIDAS level "low"'),
    );
  }

  return features;
}

function feature(
  code: string,
  label: string,
  weight: number,
  severity: RiskSeverity,
  detail: string,
): RiskFeature {
  return { code, label, weight, severity, detail };
}

function blocking(
  code: string,
  label: string,
  detail: string,
): RiskFeature {
  return feature(code, label, 100, 'blocking', detail);
}

/**
 * Signals a compliance officer must always see, even when the weighted total
 * stays under the review threshold. Summable signals (thin wallet history, an
 * undeclared source of funds) only escalate in combination; a single expired
 * passport or identity mismatch never does.
 */
const REVIEW_ONLY: ReadonlySet<string> = new Set([
  'PEP_DECLARED',
  'HIGH_RISK_JURISDICTION',
  'DOCUMENT_EXPIRED',
  'HIGH_WALLET_VOLUME',
  'NAME_MISMATCH',
  'DOB_MISMATCH',
]);

/**
 * Decision policy: refuse on hard rules, escalate on any non-aggregable signal
 * or on a score at/above the review threshold, and approve only a clean profile.
 */
function decide(overrides: RiskFeature[], features: RiskFeature[], score: number): Decision {
  if (overrides.length > 0) return 'reject';
  if (features.some((item) => REVIEW_ONLY.has(item.code))) return 'review';
  return score >= THRESHOLDS.reviewAt ? 'review' : 'approve';
}

function bandFor(score: number): RiskBand {
  if (score >= THRESHOLDS.highAt) return 'high';
  if (score >= THRESHOLDS.reviewAt) return 'medium';
  return 'low';
}

function isMinor(dateOfBirth: string, now: Date): boolean {
  const born = parseDate(dateOfBirth);
  if (Number.isNaN(born.getTime())) return false;
  return wholeDaysUntil(born, now) < THRESHOLDS.adultAgeYears * 365;
}

function parseDate(value: string): Date {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date(0) : parsed;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}