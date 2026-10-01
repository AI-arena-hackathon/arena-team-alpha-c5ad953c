import type {
  IdentityVerificationResult,
  KycRecord,
  KycStatus,
  KycSubmissionInput,
  RiskAssessment,
} from '../domain/types';
import { EidProviderRegistry } from '../identity/eidProvider';
import { LedgerChain } from '../ledger/chain';
import { RiskEngine } from '../risk/engine';
import {
  credentialDigest,
  digestOf,
  EnvelopeCipher,
} from '../security/encryption';
import type { KycRepository } from '../store/repository';
import type { Clock } from '../util/clock';
import { newSubmissionId } from '../util/id';
import { recordSerializer } from './recordSerializer';
import { ConsentService } from './consentService';

/**
 * KYC ingestion service (README component 1).
 *
 * One method is the whole promise of the product: `submit()` takes a marketplace's
 * seller data plus an e-ID credential and returns a decision the marketplace can
 * gate listings on. The pipeline is deliberately linear and observable:
 *
 *   idempotency -> e-ID verification -> sanctions + AML scoring -> AES-256-GCM
 *   encryption of PII -> PII-free record persistence -> hash-chain anchor
 *
 * Personal data is encrypted before it reaches the repository, and the ledger
 * only ever sees the salted credential digest (README risk 2).
 */
export interface KycServiceDeps {
  repository: KycRepository;
  ledger: LedgerChain;
  riskEngine: RiskEngine;
  cipher: EnvelopeCipher;
  providers: EidProviderRegistry;
  clock: Clock;
  credentialHashSalt: string;
  consentService: ConsentService;
  /** Structured decision log; every payload is redacted before it is written. */
  logger?: Pick<Console, 'info'>;
}

export interface SubmitResult {
  record: KycRecord;
  idempotentReplay: boolean;
  ledgerAnchor: { index: number; hash: string };
}

export class SubmissionValidationError extends Error {
  constructor(
    message: string,
    readonly field: string,
  ) {
    super(message);
    this.name = 'SubmissionValidationError';
  }
}

export class KycService {
  constructor(private readonly deps: KycServiceDeps) {}

  async submit(
    marketplaceId: string,
    input: KycSubmissionInput,
  ): Promise<SubmitResult> {
    validateSubmission(input);

    const submissionId = input.submissionId ?? newSubmissionId();
    const requestDigest = digestOf(stripVolatileFields(input));

    // Idempotency: a marketplace retrying a submission (network blip, webhook
    // redelivery) must not create a second record or a second ledger anchor.
    const existing = await this.deps.repository.getBySubmissionId(marketplaceId, submissionId);
    if (existing) {
      if (existing.requestDigest !== requestDigest) {
        throw new SubmissionValidationError(
          `submissionId "${submissionId}" was already used with a different payload`,
          'submissionId',
        );
      }
      return {
        record: existing,
        idempotentReplay: true,
        ledgerAnchor: { index: -1, hash: existing.ledgerAnchorHash },
      };
    }

    const now = this.deps.clock.now();
    const identity = this.verifyIdentity(input);
    const risk = this.deps.riskEngine.assess({
      subjectId: input.subject.subjectId,
      fullName: input.subject.fullName,
      dateOfBirth: input.subject.dateOfBirth,
      countryCode: input.subject.countryCode,
      documentType: input.subject.document.type,
      documentExpiresOn: input.subject.document.expiresOn,
      wallet: input.subject.wallet,
      claims: input.claims ?? {},
      identity,
      consentGranted: input.consent.granted,
      now,
    });

    const status = statusFor(risk.decision);
    const assertion = identity.verified ? identity.assertion : null;

    // Personal data: encrypted at rest, bound to this submission id via AAD.
    const personalDataEnvelope = this.deps.cipher.encrypt(
      {
        fullName: input.subject.fullName,
        dateOfBirth: input.subject.dateOfBirth,
        countryCode: input.subject.countryCode,
        document: input.subject.document,
        wallet: input.subject.wallet,
        claimedSourceOfFunds: input.claims?.sourceOfFunds,
        notes: input.claims?.notes,
        consentIp: input.consent.ip,
        assertedName: assertion?.fullName ?? null,
        assertedDateOfBirth: assertion?.dateOfBirth ?? null,
        assertedMethod: assertion?.method ?? null,
        providerAuditClaims: assertion?.claims ?? {},
      },
      submissionId,
    );

    const credentialHash =
      input.credential
        ? credentialDigest({
            subjectId: input.subject.subjectId,
            assertion: input.credential.assertion,
            salt: this.deps.credentialHashSalt,
          })
        : digestOf({ submissionId, subjectId: input.subject.subjectId });

    const anchor = await this.deps.ledger.append({
      type: 'kyc_proof',
      subjectId: input.subject.subjectId,
      submissionId,
      marketplaceId,
      credentialDigest: credentialHash,
      decision: risk.decision,
      riskScore: risk.score,
      createdAt: now.toISOString(),
    });

    const record: KycRecord = {
      submissionId,
      marketplaceId,
      subjectId: input.subject.subjectId,
      ...(input.listingId ? { listingId: input.listingId } : {}),
      status,
      decision: risk.decision,
      risk,
      identity: {
        provider: identityProvider(identity, this.deps.providers.ids()),
        assurance: identity.verified ? identity.assertion.assurance : 'none',
        method: identity.verified ? identity.assertion.method : 'none',
        verifiedAt: now.toISOString(),
      },
      credentialDigest: credentialHash,
      personalDataEnvelope,
      ledgerAnchorHash: anchor.hash,
      consentCapturedAt: input.consent.capturedAt,
      submittedAt: now.toISOString(),
      evaluatedAt: now.toISOString(),
      requestDigest,
    };

    const stored = await this.deps.repository.put(record);

    // Grant/update consent record for this subject
    await this.deps.consentService.grantConsent({
      marketplaceId,
      subjectId: input.subject.subjectId,
      purposes: ['risk_scoring', 'ledger_anchoring'],
      ip: input.consent.ip,
      userAgent: input.consent.userAgent,
    });

    this.logDecision(recordSerializer.toLogSummary(stored));

    // Sanctions matches are surfaced to the partner as a separate notice so a
    // freeze workflow can subscribe to them without polling every submission.
    if (risk.sanctionsHits.length > 0) {
      await this.deps.ledger.append({
        type: 'sanctions_notice',
        subjectId: input.subject.subjectId,
        submissionId,
        marketplaceId,
        credentialDigest: credentialHash,
        decision: 'reject',
        riskScore: risk.score,
        createdAt: now.toISOString(),
      });
    }

    return { record: stored, idempotentReplay: false, ledgerAnchor: { index: anchor.index, hash: anchor.hash } };
  }

  async getRecord(marketplaceId: string, submissionId: string): Promise<KycRecord | undefined> {
    return this.deps.repository.getBySubmissionId(marketplaceId, submissionId);
  }

  async getSubjectHistory(marketplaceId: string, subjectId: string): Promise<KycRecord[]> {
    return this.deps.repository.listBySubject(marketplaceId, subjectId);
  }

  private logDecision(summary: Record<string, unknown>): void {
    this.deps.logger?.info('[kyc] submission evaluated', summary);
  }

  private verifyIdentity(input: KycSubmissionInput): IdentityVerificationResult {
    const now = this.deps.clock.now();
    if (!input.credential) {
      const providerIds = this.deps.providers.ids();
      return {
        verified: false,
        reason: 'credential_missing',
        detail: 'submission carried no e-ID credential; seller cannot be listed until one is supplied',
        provider: providerIds.length > 0 ? `none (available: ${providerIds.join(', ')})` : 'none',
      };
    }
    const provider = this.deps.providers.find(input.credential.format);
    if (!provider) {
      return {
        verified: false,
        reason: 'unknown_provider',
        detail: `no e-ID adapter registered for format "${input.credential.format}"`,
        provider: String(input.credential.format),
      };
    }
    return provider.verify(input.credential, { subjectId: input.subject.subjectId }, now);
  }
}

function statusFor(decision: KycRecord['decision']): KycStatus {
  if (decision === 'approve') return 'verified';
  if (decision === 'reject') return 'rejected';
  return 'review';
}

function identityProvider(result: IdentityVerificationResult, known: string[]): string {
  if (result.provider) return result.provider.split(':')[0];
  return known.join(',') || 'none';
}

function stripVolatileFields(input: KycSubmissionInput): unknown {
  const { consent, ...rest } = input;
  return { ...rest, consent: { granted: consent.granted } };
}

/**
 * Structural validation beyond zod's shape checks: rules that protect the
 * product's own guarantees rather than the request's well-formedness.
 */
export function validateSubmission(input: KycSubmissionInput): void {
  if (!input.consent?.granted) {
    throw new SubmissionValidationError('consent.granted must be true to process a KYC submission', 'consent.granted');
  }
  if (!isIsoDate(input.subject?.dateOfBirth)) {
    throw new SubmissionValidationError('subject.dateOfBirth must be an ISO date (yyyy-mm-dd)', 'subject.dateOfBirth');
  }
  if (!isIsoDate(input.subject?.document?.expiresOn)) {
    throw new SubmissionValidationError('subject.document.expiresOn must be an ISO date (yyyy-mm-dd)', 'subject.document.expiresOn');
  }
  if (!isIsoTimestamp(input.subject?.wallet?.firstSeenAt)) {
    throw new SubmissionValidationError('subject.wallet.firstSeenAt must be an ISO timestamp', 'subject.wallet.firstSeenAt');
  }
  if (!isIsoTimestamp(input.consent?.capturedAt)) {
    throw new SubmissionValidationError('consent.capturedAt must be an ISO timestamp', 'consent.capturedAt');
  }
  if (!/^0x[a-fA-F0-9]{40}$/.test(input.subject?.wallet?.address ?? '')) {
    throw new SubmissionValidationError(
      'subject.wallet.address must be a 20-byte hex Ethereum address',
      'subject.wallet.address',
    );
  }
  if (input.subject.wallet.transactionCount < 0 || input.subject.wallet.volumeUsd < 0) {
    throw new SubmissionValidationError(
      'subject.wallet counters cannot be negative',
      'subject.wallet',
    );
  }
}

function isIsoDate(value: string | undefined): boolean {
  return Boolean(value) && /^\d{4}-\d{2}-\d{2}$/.test(value as string) && !Number.isNaN(Date.parse(value as string));
}

function isIsoTimestamp(value: string | undefined): boolean {
  return Boolean(value) && !Number.isNaN(Date.parse(value as string));
}

export type { RiskAssessment };