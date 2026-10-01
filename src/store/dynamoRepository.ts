import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  QueryCommand as DocQueryCommand,
  DeleteCommand,
} from '@aws-sdk/lib-dynamodb';
import type { KycRecord, ListingDecision, KycRepository, ListOptions } from './repository';
import { canonicalClone } from '../util/canonical';

export interface DynamoRepositoryOptions {
  tableName: string;
  region?: string;
  endpoint?: string;
  client?: DynamoDBClient;
}

const PK_PREFIX = 'MARKETPLACE#';
const SUBMISSION_PK_SUFFIX = '#SUBMISSION#';
const SUBJECT_GSI1PK_SUFFIX = '#SUBJECT#';
const METADATA_SK = 'METADATA#';
const DECISION_PK_PREFIX = 'MARKETPLACE#';
const DECISION_SK_PREFIX = 'DECISION#';

function submissionPk(marketplaceId: string, submissionId: string): string {
  return `${PK_PREFIX}${marketplaceId}${SUBMISSION_PK_SUFFIX}${submissionId}`;
}

function submissionSk(submissionId: string): string {
  return `${METADATA_SK}${submissionId}`;
}

function subjectGsi1Pk(marketplaceId: string, subjectId: string): string {
  return `${PK_PREFIX}${marketplaceId}${SUBJECT_GSI1PK_SUFFIX}${subjectId}`;
}

function subjectGsi1Sk(evaluatedAt: string, submissionId: string): string {
  return `${evaluatedAt}#${submissionId}`;
}

function decisionPk(marketplaceId: string): string {
  return `${DECISION_PK_PREFIX}${marketplaceId}`;
}

function decisionSk(listingId: string, subjectId: string): string {
  return `${DECISION_SK_PREFIX}${listingId}#${subjectId}`;
}

export class DynamoKycRepository implements KycRepository {
  private readonly docClient: DynamoDBDocumentClient;
  private readonly tableName: string;

  constructor(options: DynamoRepositoryOptions) {
    const client = options.client ?? new DynamoDBClient({ region: options.region, endpoint: options.endpoint });
    this.docClient = DynamoDBDocumentClient.from(client, { marshallOptions: { removeUndefinedValues: true } });
    this.tableName = options.tableName;
  }

  async put(record: KycRecord): Promise<KycRecord> {
    const stored = canonicalClone(record);
    const pk = submissionPk(record.marketplaceId, record.submissionId);
    const sk = submissionSk(record.submissionId);
    const gsi1Pk = subjectGsi1Pk(record.marketplaceId, record.subjectId);
    const gsi1Sk = subjectGsi1Sk(record.evaluatedAt, record.submissionId);

    await this.docClient.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          pk,
          sk,
          gsi1Pk,
          gsi1Sk,
          entityType: 'KYC_RECORD',
          ...stored,
        },
      }),
    );

    return canonicalClone(stored);
  }

  async getBySubmissionId(marketplaceId: string, submissionId: string): Promise<KycRecord | undefined> {
    const pk = submissionPk(marketplaceId, submissionId);
    const sk = submissionSk(submissionId);

    const result = await this.docClient.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { pk, sk },
      }),
    );

    if (!result.Item) return undefined;
    return canonicalClone(this.itemToRecord(result.Item));
  }

  async listBySubject(marketplaceId: string, subjectId: string): Promise<KycRecord[]> {
    const gsi1Pk = subjectGsi1Pk(marketplaceId, subjectId);

    const result = await this.docClient.send(
      new DocQueryCommand({
        TableName: this.tableName,
        IndexName: 'GSI1',
        KeyConditionExpression: 'gsi1Pk = :pk',
        ExpressionAttributeValues: { ':pk': gsi1Pk },
        ScanIndexForward: true,
      }),
    );

    return canonicalClone((result.Items ?? []).map((item) => this.itemToRecord(item)));
  }

  async listByMarketplace(marketplaceId: string, options: ListOptions = {}): Promise<KycRecord[]> {
    const pk = `${PK_PREFIX}${marketplaceId}${SUBMISSION_PK_SUFFIX}`;
    const from = options.from ? Date.parse(options.from) : Number.NEGATIVE_INFINITY;
    const to = options.to ? Date.parse(options.to) : Number.POSITIVE_INFINITY;

    const result = await this.docClient.send(
      new DocQueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :skPrefix)',
        ExpressionAttributeValues: {
          ':pk': pk,
          ':skPrefix': METADATA_SK,
        },
        ScanIndexForward: true,
      }),
    );

    const filtered = (result.Items ?? [])
      .map((item) => this.itemToRecord(item))
      .filter((record) => {
        const at = Date.parse(record.evaluatedAt);
        return at >= from && at <= to;
      })
      .sort((left, right) => left.evaluatedAt.localeCompare(right.evaluatedAt));

    return canonicalClone(options.limit ? filtered.slice(0, options.limit) : filtered);
  }

  async saveListingDecision(decision: ListingDecision): Promise<ListingDecision> {
    const stored = canonicalClone(decision);
    const pk = decisionPk(decision.marketplaceId);
    const sk = decisionSk(decision.listingId, decision.subjectId);

    await this.docClient.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          pk,
          sk,
          entityType: 'LISTING_DECISION',
          ...stored,
        },
      }),
    );

    return canonicalClone(stored);
  }

  async countListingDecisions(marketplaceId: string, blocked: boolean): Promise<number> {
    const pk = decisionPk(marketplaceId);
    const allowedValue = blocked ? false : true;

    const result = await this.docClient.send(
      new DocQueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: 'pk = :pk',
        FilterExpression: '#allowed = :allowed',
        ExpressionAttributeNames: { '#allowed': 'allowed' },
        ExpressionAttributeValues: { ':pk': pk, ':allowed': allowedValue },
        Select: 'COUNT',
      }),
    );

    return result.Count ?? 0;
  }

  async deleteBySubmissionId(marketplaceId: string, submissionId: string): Promise<boolean> {
    const pk = submissionPk(marketplaceId, submissionId);
    const sk = submissionSk(submissionId);

    const result = await this.docClient.send(
      new DeleteCommand({
        TableName: this.tableName,
        Key: { pk, sk },
        ReturnValues: 'ALL_OLD',
      }),
    );

    return !!result.Attributes;
  }

  async deleteBySubjectId(marketplaceId: string, subjectId: string): Promise<number> {
    const gsi1Pk = subjectGsi1Pk(marketplaceId, subjectId);

    const result = await this.docClient.send(
      new DocQueryCommand({
        TableName: this.tableName,
        IndexName: 'GSI1',
        KeyConditionExpression: 'gsi1Pk = :pk',
        ExpressionAttributeValues: { ':pk': gsi1Pk },
        ProjectionExpression: 'pk, sk',
      }),
    );

    if (!result.Items || result.Items.length === 0) {
      return 0;
    }

    // Delete each record by its pk/sk
    for (const item of result.Items) {
      await this.docClient.send(
        new DeleteCommand({
          TableName: this.tableName,
          Key: { pk: item.pk, sk: item.sk },
        }),
      );
    }

    return result.Items.length;
  }

  private itemToRecord(item: Record<string, unknown>): KycRecord {
    const { pk: _pk, sk: _sk, gsi1Pk: _gsi1Pk, gsi1Sk: _gsi1Sk, entityType: _entityType, ...record } = item;
    return record as unknown as KycRecord;
  }
}

export function createDynamoRepository(options: DynamoRepositoryOptions): KycRepository {
  return new DynamoKycRepository(options);
}