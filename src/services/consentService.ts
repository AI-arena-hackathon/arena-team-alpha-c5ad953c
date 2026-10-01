import type { KycRepository } from '../store/repository';
import type { Clock } from '../util/clock';
import { newConsentId } from '../util/id';

export interface ConsentRecord {
  consentId: string;
  marketplaceId: string;
  subjectId: string;
  /** The version of the consent form/terms the subject agreed to. */
  version: string;
  /** Specific purposes the subject consented to. */
  purposes: ConsentPurpose[];
  /** Whether consent is currently granted. */
  granted: boolean;
  /** When consent was originally granted. */
  grantedAt: string;
  /** When consent was withdrawn (if applicable). */
  withdrawnAt: string | null;
  /** IP address at time of grant/withdrawal. */
  ip: string | null;
  /** User agent at time of grant/withdrawal. */
  userAgent: string | null;
  /** Audit trail of consent changes. */
  history: ConsentHistoryEntry[];
}

export type ConsentPurpose =
  | 'kyc_processing'
  | 'aml_screening'
  | 'ledger_anchoring'
  | 'compliance_reporting'
  | 'risk_scoring'
  | 'marketing'
  | 'analytics';

export interface ConsentHistoryEntry {
  action: 'granted' | 'withdrawn' | 'updated';
  purposes: ConsentPurpose[];
  timestamp: string;
  ip: string | null;
  userAgent: string | null;
  version: string;
}

export interface ConsentConfig {
  repository: KycRepository;
  clock: Clock;
  /** Current version of the consent form. */
  currentVersion: string;
  /** Required purposes that cannot be withdrawn without terminating service. */
  mandatoryPurposes: ConsentPurpose[];
  logger?: Pick<Console, 'info' | 'warn' | 'error'>;
}

export interface GrantConsentInput {
  marketplaceId: string;
  subjectId: string;
  purposes: ConsentPurpose[];
  ip?: string;
  userAgent?: string;
  version?: string;
}

export interface WithdrawConsentInput {
  marketplaceId: string;
  subjectId: string;
  purposes: ConsentPurpose[];
  ip?: string;
  userAgent?: string;
}

export interface ConsentStatus {
  consentId: string | null;
  subjectId: string;
  granted: boolean;
  purposes: ConsentPurpose[];
  mandatoryPurposes: ConsentPurpose[];
  version: string;
  grantedAt: string | null;
  withdrawnAt: string | null;
  canWithdrawFully: boolean;
}

const DEFAULT_MANDATORY_PURPOSES: ConsentPurpose[] = [
  'kyc_processing',
  'aml_screening',
  'compliance_reporting',
];

export class ConsentService {
  private readonly repository: KycRepository;
  private readonly clock: Clock;
  private readonly currentVersion: string;
  private readonly mandatoryPurposes: ConsentPurpose[];
  private readonly logger?: Pick<Console, 'info' | 'warn' | 'error'>;
  private readonly consentStore = new Map<string, ConsentRecord>();

  constructor(config: ConsentConfig) {
    this.repository = config.repository;
    this.clock = config.clock;
    this.currentVersion = config.currentVersion;
    this.mandatoryPurposes = config.mandatoryPurposes.length > 0
      ? config.mandatoryPurposes
      : DEFAULT_MANDATORY_PURPOSES;
    this.logger = config.logger;
  }

  /** Grants or updates consent for a subject. */
  async grantConsent(input: GrantConsentInput): Promise<ConsentRecord> {
    const now = this.clock.now().toISOString();
    const key = consentKey(input.marketplaceId, input.subjectId);
    const existing = this.consentStore.get(key);

    // Merge existing optional purposes with new ones, always include mandatory
    const existingOptionalPurposes = existing
      ? existing.purposes.filter((p) => !this.mandatoryPurposes.includes(p))
      : [];
    const purposes = this.deduplicatePurposes([
      ...this.mandatoryPurposes,
      ...existingOptionalPurposes,
      ...input.purposes,
    ]);

    const record: ConsentRecord = existing
      ? {
          ...existing,
          purposes,
          granted: true,
          version: input.version ?? this.currentVersion,
          history: [
            ...existing.history,
            {
              action: 'updated' as const,
              purposes,
              timestamp: now,
              ip: input.ip ?? null,
              userAgent: input.userAgent ?? null,
              version: input.version ?? this.currentVersion,
            },
          ],
        }
      : {
          consentId: newConsentId(),
          marketplaceId: input.marketplaceId,
          subjectId: input.subjectId,
          purposes,
          granted: true,
          grantedAt: now,
          withdrawnAt: null,
          ip: input.ip ?? null,
          userAgent: input.userAgent ?? null,
          version: input.version ?? this.currentVersion,
          history: [
            {
              action: 'granted' as const,
              purposes,
              timestamp: now,
              ip: input.ip ?? null,
              userAgent: input.userAgent ?? null,
              version: input.version ?? this.currentVersion,
            },
          ],
        };

    this.consentStore.set(key, record);
    this.logger?.info('[consent] Consent granted/updated', {
      marketplaceId: input.marketplaceId,
      subjectId: input.subjectId,
      consentId: record.consentId,
      purposes: record.purposes,
    });

    return record;
  }

  /** Withdraws consent for specific purposes. Mandatory purposes cannot be withdrawn. */
  async withdrawConsent(input: WithdrawConsentInput): Promise<ConsentRecord> {
    const key = consentKey(input.marketplaceId, input.subjectId);
    const existing = this.consentStore.get(key);

    if (!existing) {
      throw new Error(`No consent record found for subject ${input.subjectId} in marketplace ${input.marketplaceId}`);
    }

    // Check if all optional purposes have already been withdrawn
    const existingOptionalPurposes = existing.purposes.filter(
      (p) => !this.mandatoryPurposes.includes(p),
    );
    if (existingOptionalPurposes.length === 0) {
      throw new Error('Consent is already withdrawn (no optional purposes remain)');
    }

    const now = this.clock.now().toISOString();
    const requestedWithdrawal = new Set(input.purposes);
    const remainingPurposes = existing.purposes.filter(
      (p) => !requestedWithdrawal.has(p) || this.mandatoryPurposes.includes(p),
    );

    // Fully withdrawn = no optional purposes remain
    const remainingOptionalPurposes = remainingPurposes.filter(
      (p) => !this.mandatoryPurposes.includes(p),
    );
    const fullyWithdrawn = remainingOptionalPurposes.length === 0;

    const record: ConsentRecord = {
      ...existing,
      purposes: remainingPurposes,
      granted: !fullyWithdrawn,
      withdrawnAt: fullyWithdrawn ? now : existing.withdrawnAt,
      history: [
        ...existing.history,
        {
          action: 'withdrawn' as const,
          purposes: input.purposes,
          timestamp: now,
          ip: input.ip ?? null,
          userAgent: input.userAgent ?? null,
          version: existing.version,
        },
      ],
    };

    this.consentStore.set(key, record);
    this.logger?.info('[consent] Consent withdrawn', {
      marketplaceId: input.marketplaceId,
      subjectId: input.subjectId,
      consentId: record.consentId,
      withdrawnPurposes: input.purposes,
      fullyWithdrawn,
      remainingPurposes: record.purposes,
    });

    return record;
  }

  /** Gets the current consent status for a subject. */
  async getConsentStatus(marketplaceId: string, subjectId: string): Promise<ConsentStatus> {
    const key = consentKey(marketplaceId, subjectId);
    const record = this.consentStore.get(key);

    if (!record) {
      return {
        consentId: null,
        subjectId,
        granted: false,
        purposes: [],
        mandatoryPurposes: this.mandatoryPurposes,
        version: this.currentVersion,
        grantedAt: null,
        withdrawnAt: null,
        canWithdrawFully: false,
      };
    }

    const withdrawablePurposes = record.purposes.filter(
      (p) => !this.mandatoryPurposes.includes(p),
    );

    return {
      consentId: record.consentId,
      subjectId,
      granted: record.granted,
      purposes: record.purposes,
      mandatoryPurposes: this.mandatoryPurposes,
      version: record.version,
      grantedAt: record.grantedAt,
      withdrawnAt: record.withdrawnAt,
      canWithdrawFully: withdrawablePurposes.length > 0,
    };
  }

  /** Gets the full consent record including audit history. */
  async getConsentRecord(marketplaceId: string, subjectId: string): Promise<ConsentRecord | undefined> {
    const key = consentKey(marketplaceId, subjectId);
    return this.consentStore.get(key);
  }

  /** Checks if consent is valid for a specific purpose. */
  async hasValidConsent(marketplaceId: string, subjectId: string, purpose: ConsentPurpose): Promise<boolean> {
    const record = await this.getConsentRecord(marketplaceId, subjectId);
    return record !== undefined && record.granted && record.purposes.includes(purpose);
  }

  /** Lists all consent records for a marketplace (for compliance reporting). */
  async listConsentRecords(marketplaceId: string): Promise<ConsentRecord[]> {
    const results: ConsentRecord[] = [];
    for (const [_key, record] of this.consentStore.entries()) {
      if (record.marketplaceId === marketplaceId) {
        results.push(record);
      }
    }
    return results.sort((a, b) => Date.parse(b.grantedAt) - Date.parse(a.grantedAt));
  }

  private deduplicatePurposes(purposes: ConsentPurpose[]): ConsentPurpose[] {
    return Array.from(new Set(purposes));
  }
}

function consentKey(marketplaceId: string, subjectId: string): string {
  return `${marketplaceId}#${subjectId}`;
}