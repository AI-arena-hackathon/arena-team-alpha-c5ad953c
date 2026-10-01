import { DynamoKycRepository, createDynamoRepository } from './dynamoRepository';
import type { KycRecord, ListingDecision } from './repository';
import { canonicalClone } from '../util/canonical';

const mockSend = jest.fn();
const mockDocClient = { send: mockSend };

jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: {
    from: () => mockDocClient,
  },
  PutCommand: jest.fn((args) => ({ type: 'PutCommand', ...args })),
  GetCommand: jest.fn((args) => ({ type: 'GetCommand', ...args })),
  QueryCommand: jest.fn((args) => ({ type: 'QueryCommand', ...args })),
}));

jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn(),
}));

function createTestRecord(overrides: Partial<KycRecord> = {}): KycRecord {
  return {
    submissionId: 'test-submission-1',
    marketplaceId: 'market-alpha',
    subjectId: 'seller-777',
    status: 'verified',
    decision: 'approve',
    risk: {
      score: 10,
      band: 'low',
      decision: 'approve',
      overrides: [],
      features: [],
      sanctionsHits: [],
      modelVersion: '1.0.0',
      assessedAt: '2025-03-01T09:00:00.000Z',
    },
    identity: {
      provider: 'eidas-gateway',
      assurance: 'high',
      method: 'passport',
      verifiedAt: '2025-03-01T09:00:00.000Z',
    },
    credentialDigest: 'digest-123',
    personalDataEnvelope: {
      alg: 'aes-256-gcm',
      keyId: 'k1',
      iv: 'iv',
      ciphertext: 'ciphertext',
      authTag: 'tag',
    },
    ledgerAnchorHash: 'anchor-123',
    consentCapturedAt: '2025-03-01T09:00:00.000Z',
    submittedAt: '2025-03-01T09:00:00.000Z',
    evaluatedAt: '2025-03-01T09:00:00.000Z',
    requestDigest: 'request-123',
    ...overrides,
  };
}

function createTestDecision(overrides: Partial<ListingDecision> = {}): ListingDecision {
  return {
    listingId: 'listing-1',
    marketplaceId: 'market-alpha',
    subjectId: 'seller-777',
    allowed: true,
    status: 'verified',
    reason: 'KYC verified',
    requiredAction: 'none',
    riskScore: 10,
    checkedAt: '2025-03-01T09:00:00.000Z',
    ...overrides,
  };
}

describe('DynamoKycRepository', () => {
  let repository: DynamoKycRepository;

  beforeEach(() => {
    jest.clearAllMocks();
    repository = new DynamoKycRepository({
      tableName: 'test-kyc-table',
      client: { config: {} } as unknown as ConstructorParameters<typeof DynamoKycRepository>[0]['client'],
    });
    // Replace the internal docClient with our mock
    (repository as unknown as { docClient: typeof mockDocClient }).docClient = mockDocClient;
  });

  describe('put', () => {
    it('stores a KYC record with correct key structure', async () => {
      mockSend.mockResolvedValueOnce({});

      const record = createTestRecord();
      const result = await repository.put(record);

      expect(mockSend).toHaveBeenCalledTimes(1);
      const command = mockSend.mock.calls[0][0];
      expect(command.type).toBe('PutCommand');
      expect(command.TableName).toBe('test-kyc-table');
      expect(command.Item.pk).toBe('MARKETPLACE#market-alpha#SUBMISSION#test-submission-1');
      expect(command.Item.sk).toBe('METADATA#test-submission-1');
      expect(command.Item.gsi1Pk).toBe('MARKETPLACE#market-alpha#SUBJECT#seller-777');
      expect(command.Item.gsi1Sk).toBe('2025-03-01T09:00:00.000Z#test-submission-1');
      expect(command.Item.entityType).toBe('KYC_RECORD');
      expect(command.Item.submissionId).toBe('test-submission-1');
      expect(result).toEqual(canonicalClone(record));
    });
  });

  describe('getBySubmissionId', () => {
    it('returns the record when found', async () => {
      const record = createTestRecord();
      mockSend.mockResolvedValueOnce({
        Item: {
          pk: 'MARKETPLACE#market-alpha#SUBMISSION#test-submission-1',
          sk: 'METADATA#test-submission-1',
          gsi1Pk: 'MARKETPLACE#market-alpha#SUBJECT#seller-777',
          gsi1Sk: '2025-03-01T09:00:00.000Z#test-submission-1',
          entityType: 'KYC_RECORD',
          ...record,
        },
      });

      const result = await repository.getBySubmissionId('market-alpha', 'test-submission-1');

      expect(mockSend).toHaveBeenCalledTimes(1);
      const command = mockSend.mock.calls[0][0];
      expect(command.type).toBe('GetCommand');
      expect(command.Key).toEqual({
        pk: 'MARKETPLACE#market-alpha#SUBMISSION#test-submission-1',
        sk: 'METADATA#test-submission-1',
      });
      expect(result).toEqual(canonicalClone(record));
    });

    it('returns undefined when not found', async () => {
      mockSend.mockResolvedValueOnce({ Item: undefined });

      const result = await repository.getBySubmissionId('market-alpha', 'unknown-id');

      expect(result).toBeUndefined();
    });
  });

  describe('listBySubject', () => {
    it('queries GSI1 and returns records sorted by evaluatedAt', async () => {
      const record1 = createTestRecord({ submissionId: 'sub-1', evaluatedAt: '2025-03-01T09:00:00.000Z' });
      const record2 = createTestRecord({ submissionId: 'sub-2', evaluatedAt: '2025-03-02T09:00:00.000Z' });

      mockSend.mockResolvedValueOnce({
        Items: [
          { pk: '...', sk: '...', gsi1Pk: 'MARKETPLACE#market-alpha#SUBJECT#seller-777', gsi1Sk: '2025-03-01T09:00:00.000Z#sub-1', entityType: 'KYC_RECORD', ...record1 },
          { pk: '...', sk: '...', gsi1Pk: 'MARKETPLACE#market-alpha#SUBJECT#seller-777', gsi1Sk: '2025-03-02T09:00:00.000Z#sub-2', entityType: 'KYC_RECORD', ...record2 },
        ],
      });

      const result = await repository.listBySubject('market-alpha', 'seller-777');

      expect(mockSend).toHaveBeenCalledTimes(1);
      const command = mockSend.mock.calls[0][0];
      expect(command.type).toBe('QueryCommand');
      expect(command.TableName).toBe('test-kyc-table');
      expect(command.IndexName).toBe('GSI1');
      expect(command.KeyConditionExpression).toBe('gsi1Pk = :pk');
      expect(command.ExpressionAttributeValues).toEqual({ ':pk': 'MARKETPLACE#market-alpha#SUBJECT#seller-777' });
      expect(command.ScanIndexForward).toBe(true);
      expect(result).toHaveLength(2);
      expect(result[0].submissionId).toBe('sub-1');
      expect(result[1].submissionId).toBe('sub-2');
    });

    it('returns empty array when no records found', async () => {
      mockSend.mockResolvedValueOnce({ Items: [] });

      const result = await repository.listBySubject('market-alpha', 'unknown-seller');

      expect(result).toEqual([]);
    });
  });

  describe('listByMarketplace', () => {
    it('queries by marketplace PK and filters by date range', async () => {
      const record1 = createTestRecord({ submissionId: 'sub-1', evaluatedAt: '2025-03-01T09:00:00.000Z' });
      const record2 = createTestRecord({ submissionId: 'sub-2', evaluatedAt: '2025-03-02T09:00:00.000Z' });
      const record3 = createTestRecord({ submissionId: 'sub-3', evaluatedAt: '2025-03-03T09:00:00.000Z' });

      mockSend.mockResolvedValueOnce({
        Items: [
          { pk: 'MARKETPLACE#market-alpha#SUBMISSION#', sk: 'METADATA#sub-1', entityType: 'KYC_RECORD', ...record1 },
          { pk: 'MARKETPLACE#market-alpha#SUBMISSION#', sk: 'METADATA#sub-2', entityType: 'KYC_RECORD', ...record2 },
          { pk: 'MARKETPLACE#market-alpha#SUBMISSION#', sk: 'METADATA#sub-3', entityType: 'KYC_RECORD', ...record3 },
        ],
      });

      const result = await repository.listByMarketplace('market-alpha', { from: '2025-03-01T09:00:00.000Z', to: '2025-03-02T09:00:00.000Z' });

      expect(mockSend).toHaveBeenCalledTimes(1);
      const command = mockSend.mock.calls[0][0];
      expect(command.type).toBe('QueryCommand');
      expect(command.KeyConditionExpression).toBe('pk = :pk AND begins_with(sk, :skPrefix)');
      expect(result).toHaveLength(2);
      expect(result.map((r) => r.submissionId)).toEqual(['sub-1', 'sub-2']);
    });

    it('respects limit option', async () => {
      const record1 = createTestRecord({ submissionId: 'sub-1' });
      const record2 = createTestRecord({ submissionId: 'sub-2' });
      const record3 = createTestRecord({ submissionId: 'sub-3' });

      mockSend.mockResolvedValueOnce({
        Items: [
          { pk: '...', sk: '...', entityType: 'KYC_RECORD', ...record1 },
          { pk: '...', sk: '...', entityType: 'KYC_RECORD', ...record2 },
          { pk: '...', sk: '...', entityType: 'KYC_RECORD', ...record3 },
        ],
      });

      const result = await repository.listByMarketplace('market-alpha', { limit: 2 });

      expect(result).toHaveLength(2);
    });
  });

  describe('saveListingDecision', () => {
    it('stores a listing decision with correct key structure', async () => {
      mockSend.mockResolvedValueOnce({});

      const decision = createTestDecision();
      const result = await repository.saveListingDecision(decision);

      expect(mockSend).toHaveBeenCalledTimes(1);
      const command = mockSend.mock.calls[0][0];
      expect(command.type).toBe('PutCommand');
      expect(command.TableName).toBe('test-kyc-table');
      expect(command.Item.pk).toBe('MARKETPLACE#market-alpha');
      expect(command.Item.sk).toBe('DECISION#listing-1#seller-777');
      expect(command.Item.entityType).toBe('LISTING_DECISION');
      expect(result).toEqual(canonicalClone(decision));
    });
  });

  describe('countListingDecisions', () => {
    it('counts blocked decisions when blocked=true', async () => {
      mockSend.mockResolvedValueOnce({ Count: 3 });

      const result = await repository.countListingDecisions('market-alpha', true);

      expect(result).toBe(3);
      const command = mockSend.mock.calls[0][0];
      expect(command.FilterExpression).toBe('#allowed = :allowed');
      expect(command.ExpressionAttributeValues[':allowed']).toBe(false);
    });

    it('counts allowed decisions when blocked=false', async () => {
      mockSend.mockResolvedValueOnce({ Count: 5 });

      const result = await repository.countListingDecisions('market-alpha', false);

      expect(result).toBe(5);
      const command = mockSend.mock.calls[0][0];
      expect(command.ExpressionAttributeValues[':allowed']).toBe(true);
    });

    it('returns 0 when no matching decisions', async () => {
      mockSend.mockResolvedValueOnce({ Count: undefined });

      const result = await repository.countListingDecisions('market-alpha', true);

      expect(result).toBe(0);
    });
  });
});

describe('createDynamoRepository', () => {
  it('returns a DynamoKycRepository instance', () => {
    const repo = createDynamoRepository({ tableName: 'test-table' });
    expect(repo).toBeInstanceOf(DynamoKycRepository);
  });
});