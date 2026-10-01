import type { KycRepository } from '../store/repository';
import type { Clock } from '../util/clock';

export interface RetentionPolicy {
  /** Maximum age of KYC records in days. Records older than this are eligible for deletion. */
  kycRecordMaxAgeDays: number;
  /** Maximum age of listing decisions in days. */
  listingDecisionMaxAgeDays: number;
  /** Maximum age of consent records in days (separate from KYC records for regulatory reasons). */
  consentRecordMaxAgeDays: number;
  /** Whether automatic cleanup is enabled. */
  autoCleanupEnabled: boolean;
  /** Cron-like schedule for cleanup (e.g., '0 2 * * *' for 2 AM daily). Not enforced by this service; for orchestration. */
  cleanupSchedule: string;
}

export interface RetentionResult {
  deletedKycRecords: number;
  deletedListingDecisions: number;
  deletedConsentRecords: number;
  oldestKycRecord: string | null;
  oldestListingDecision: string | null;
  errors: string[];
}

export interface RetentionConfig {
  policy: RetentionPolicy;
  repository: KycRepository;
  clock: Clock;
  /** Optional logger for audit trail. */
  logger?: Pick<Console, 'info' | 'warn' | 'error'>;
}

const DEFAULT_POLICY: RetentionPolicy = {
  kycRecordMaxAgeDays: 2555, // 7 years (AMLD5 minimum)
  listingDecisionMaxAgeDays: 1095, // 3 years
  consentRecordMaxAgeDays: 2555, // 7 years (GDPR consent evidence)
  autoCleanupEnabled: false,
  cleanupSchedule: '0 2 * * *',
};

export class RetentionService {
  private readonly policy: RetentionPolicy;
  private readonly repository: KycRepository;
  private readonly clock: Clock;
  private readonly logger?: Pick<Console, 'info' | 'warn' | 'error'>;

  constructor(config: RetentionConfig) {
    this.policy = { ...DEFAULT_POLICY, ...config.policy };
    this.repository = config.repository;
    this.clock = config.clock;
    this.logger = config.logger;
  }

  /** Returns the effective retention policy. */
  getPolicy(): RetentionPolicy {
    return { ...this.policy };
  }

  /** Checks if a KYC record has exceeded its retention period. */
  isKycRecordExpired(record: { evaluatedAt: string }): boolean {
    const recordAge = this.clock.now().getTime() - Date.parse(record.evaluatedAt);
    const maxAge = this.policy.kycRecordMaxAgeDays * 24 * 60 * 60 * 1000;
    return recordAge > maxAge;
  }

  /** Checks if a listing decision has exceeded its retention period. */
  isListingDecisionExpired(decision: { checkedAt: string }): boolean {
    const decisionAge = this.clock.now().getTime() - Date.parse(decision.checkedAt);
    const maxAge = this.policy.listingDecisionMaxAgeDays * 24 * 60 * 60 * 1000;
    return decisionAge > maxAge;
  }

  /**
   * Runs a full retention cleanup cycle.
   * Note: The current repository interface does not support bulk listing decision deletion.
   * This method deletes expired KYC records by subject (which removes all their submissions).
   * In production, this would be run as a scheduled Lambda with appropriate batching.
   */
  async runCleanup(marketplaceId: string): Promise<RetentionResult> {
    const result: RetentionResult = {
      deletedKycRecords: 0,
      deletedListingDecisions: 0,
      deletedConsentRecords: 0,
      oldestKycRecord: null,
      oldestListingDecision: null,
      errors: [],
    };

    if (!this.policy.autoCleanupEnabled) {
      const message = 'Cleanup skipped: autoCleanupEnabled is false';
      this.logger?.warn('[retention]', message);
      result.errors.push(message);
      return result;
    }

    try {
      // Get all records for the marketplace
      const records = await this.repository.listByMarketplace(marketplaceId);

      if (records.length === 0) {
        this.logger?.info('[retention] No records found for marketplace', { marketplaceId });
        return result;
      }

      // Find the oldest record
      const sortedByAge = [...records].sort((a, b) =>
        Date.parse(a.evaluatedAt) - Date.parse(b.evaluatedAt),
      );
      result.oldestKycRecord = sortedByAge[0].evaluatedAt;

      // Group records by subject to delete entire subject histories when any record is expired
      const subjectsToDelete = new Set<string>();
      for (const record of records) {
        if (this.isKycRecordExpired(record)) {
          subjectsToDelete.add(record.subjectId);
        }
      }

      // Delete all records for expired subjects
      for (const subjectId of subjectsToDelete) {
        try {
          const deletedCount = await this.repository.deleteBySubjectId(marketplaceId, subjectId);
          result.deletedKycRecords += deletedCount;
          result.deletedConsentRecords += deletedCount; // Consent is part of KYC record
          this.logger?.info('[retention] Deleted expired subject records', {
            marketplaceId,
            subjectId,
            deletedCount,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error';
          result.errors.push(`Failed to delete subject ${subjectId}: ${message}`);
          this.logger?.error('[retention] Delete failed', { marketplaceId, subjectId, error: message });
        }
      }

      this.logger?.info('[retention] Cleanup completed', {
        marketplaceId,
        deletedKycRecords: result.deletedKycRecords,
        errors: result.errors.length,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      result.errors.push(`Cleanup failed: ${message}`);
      this.logger?.error('[retention] Cleanup error', { marketplaceId, error: message });
    }

    return result;
  }

  /**
   * Gets a preview of what would be deleted without actually deleting.
   * Useful for dry-run and compliance reporting.
   */
  async getCleanupPreview(marketplaceId: string): Promise<{
    subjectsToDelete: Array<{ subjectId: string; recordCount: number; oldestRecord: string }>;
    totalRecordsToDelete: number;
  }> {
    const records = await this.repository.listByMarketplace(marketplaceId);
    const subjectsMap = new Map<string, { count: number; oldest: string }>();

    for (const record of records) {
      if (this.isKycRecordExpired(record)) {
        const existing = subjectsMap.get(record.subjectId);
        if (existing) {
          existing.count += 1;
          if (Date.parse(record.evaluatedAt) < Date.parse(existing.oldest)) {
            existing.oldest = record.evaluatedAt;
          }
        } else {
          subjectsMap.set(record.subjectId, { count: 1, oldest: record.evaluatedAt });
        }
      }
    }

    const subjectsToDelete = Array.from(subjectsMap.entries()).map(([subjectId, data]) => ({
      subjectId,
      recordCount: data.count,
      oldestRecord: data.oldest,
    }));

    return {
      subjectsToDelete,
      totalRecordsToDelete: subjectsToDelete.reduce((sum, s) => sum + s.recordCount, 0),
    };
  }
}

export function createDefaultRetentionPolicy(): RetentionPolicy {
  return { ...DEFAULT_POLICY };
}