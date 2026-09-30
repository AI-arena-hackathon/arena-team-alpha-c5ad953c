import type { ListingDecision } from '../domain/types';
import type { KycRepository } from '../store/repository';
import type { Clock } from '../util/clock';

/**
 * Marketplace listing gate (README: "listings are blocked until KYC is complete").
 *
 * A marketplace calls this before minting or listing. The rule is deliberately
 * narrow and explainable: a listing is allowed only when the seller's most recent
 * assessment for this marketplace is `verified`. Anything else returns the exact
 * remediation the marketplace must surface to the seller, and every check is
 * persisted so the compliance report can quote how often listings were blocked.
 */
export class ListingGate {
  constructor(
    private readonly repository: KycRepository,
    private readonly clock: Clock,
  ) {}

  async check(params: {
    marketplaceId: string;
    listingId: string;
    subjectId: string;
  }): Promise<ListingDecision> {
    const history = await this.repository.listBySubject(params.marketplaceId, params.subjectId);
    const latest = history[history.length - 1];

    const decision = buildDecision(params, latest, this.clock.now().toISOString());
    await this.repository.saveListingDecision(decision);
    return decision;
  }
}

function buildDecision(
  params: { marketplaceId: string; listingId: string; subjectId: string },
  latest: { status: ListingDecision['status']; risk: { score: number } } | undefined,
  checkedAt: string,
): ListingDecision {
  const base = {
    listingId: params.listingId,
    marketplaceId: params.marketplaceId,
    subjectId: params.subjectId,
    checkedAt,
  };

  if (!latest) {
    return {
      ...base,
      allowed: false,
      status: 'unknown',
      reason: 'no KYC submission on file for this seller',
      requiredAction: 'submit a KYC submission with a valid e-ID credential',
      riskScore: null,
    };
  }

  if (latest.status === 'verified') {
    return {
      ...base,
      allowed: true,
      status: latest.status,
      reason: 'seller is KYC-verified for this marketplace',
      requiredAction: 'none',
      riskScore: latest.risk.score,
    };
  }

  if (latest.status === 'rejected') {
    return {
      ...base,
      allowed: false,
      status: latest.status,
      reason: 'seller was refused KYC; listing is permanently blocked',
      requiredAction: 'escalate to compliance; a new submission requires a compliance officer decision',
      riskScore: latest.risk.score,
    };
  }

  return {
    ...base,
    allowed: false,
    status: latest.status,
    reason: `seller is pending compliance review (risk score ${latest.risk.score})`,
    requiredAction: 'wait for review to complete, or submit remediation requested by the reviewer',
    riskScore: latest.risk.score,
  };
}