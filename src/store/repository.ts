import type { KycRecord, ListingDecision } from '../domain/types';
import { canonicalClone } from '../util/canonical';

/**
 * Persistence port. The DynamoDB deployment uses a single-table layout, so the
 * port is shaped by access pattern rather than by entity:
 *
 *   PK = `MARKETPLACE#<marketplaceId>#SUBMISSION#<submissionId>`  SK = `METADATA#<submissionId>`
 *   GSI1PK = `MARKETPLACE#<marketplaceId>#SUBJECT#<subjectId>`    GSI1SK = `<evaluatedAt>#<submissionId>`
 *
 * `InMemoryKycRepository` below is the reference implementation of that contract
 * (used by tests and local runs); the DynamoDB adapter is a drop-in replacement
 * because every read here goes through a named access pattern.
 */
export interface KycRepository {
  put(record: KycRecord): Promise<KycRecord>;
  getBySubmissionId(marketplaceId: string, submissionId: string): Promise<KycRecord | undefined>;
  listBySubject(marketplaceId: string, subjectId: string): Promise<KycRecord[]>;
  listByMarketplace(marketplaceId: string, options?: ListOptions): Promise<KycRecord[]>;
  saveListingDecision(decision: ListingDecision): Promise<ListingDecision>;
  countListingDecisions(marketplaceId: string, blocked: boolean): Promise<number>;
}

export interface ListOptions {
  from?: string;
  to?: string;
  limit?: number;
}

export class InMemoryKycRepository implements KycRepository {
  private readonly bySubmissionId = new Map<string, KycRecord>();
  private readonly listingDecisions: ListingDecision[] = [];

  async put(record: KycRecord): Promise<KycRecord> {
    const stored = canonicalClone(record);
    this.bySubmissionId.set(submissionKey(record.marketplaceId, record.submissionId), stored);
    return canonicalClone(stored);
  }

  async getBySubmissionId(marketplaceId: string, submissionId: string): Promise<KycRecord | undefined> {
    const found = this.bySubmissionId.get(submissionKey(marketplaceId, submissionId));
    return found ? canonicalClone(found) : undefined;
  }

  async listBySubject(marketplaceId: string, subjectId: string): Promise<KycRecord[]> {
    const all = await this.listByMarketplace(marketplaceId);
    return all
      .filter((record) => record.subjectId === subjectId)
      .sort((left, right) => left.evaluatedAt.localeCompare(right.evaluatedAt));
  }

  async listByMarketplace(marketplaceId: string, options: ListOptions = {}): Promise<KycRecord[]> {
    const from = options.from ? Date.parse(options.from) : Number.NEGATIVE_INFINITY;
    const to = options.to ? Date.parse(options.to) : Number.POSITIVE_INFINITY;

    const matches = [...this.bySubmissionId.values()]
      .filter((record) => record.marketplaceId === marketplaceId)
      .filter((record) => {
        const at = Date.parse(record.evaluatedAt);
        return at >= from && at <= to;
      })
      .sort((left, right) => left.evaluatedAt.localeCompare(right.evaluatedAt));

    return canonicalClone(options.limit ? matches.slice(0, options.limit) : matches);
  }

  async saveListingDecision(decision: ListingDecision): Promise<ListingDecision> {
    const stored = canonicalClone(decision);
    this.listingDecisions.push(stored);
    return canonicalClone(stored);
  }

  async countListingDecisions(marketplaceId: string, blocked: boolean): Promise<number> {
    return this.listingDecisions.filter(
      (decision) => decision.marketplaceId === marketplaceId && decision.allowed === !blocked,
    ).length;
  }
}

function submissionKey(marketplaceId: string, submissionId: string): string {
  return `${marketplaceId}#${submissionId}`;
}