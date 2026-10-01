import { PolygonAdapter } from './polygonAdapter';
import type { AnchorInput, ChainVerification, LedgerAnchor } from '../domain/types';

describe('PolygonAdapter', () => {
  const validConfig = {
    rpcUrl: 'https://zkevm-rpc.com',
    privateKey: 'a'.repeat(64),
    contractAddress: '0x1234567890123456789012345678901234567890',
    chainId: 1101,
    gasLimit: 100_000,
  };

  const sampleAnchorInput: AnchorInput = {
    type: 'kyc_proof',
    subjectId: 'seller-123',
    submissionId: 'sub-123',
    marketplaceId: 'market-alpha',
    credentialDigest: 'b'.repeat(64),
    decision: 'approve',
    riskScore: 25,
    createdAt: '2025-03-01T09:00:00.000Z',
  };

  describe('constructor and basic properties', () => {
    it('creates an adapter instance with valid config', () => {
      const adapter = new PolygonAdapter(validConfig);
      expect(adapter).toBeInstanceOf(PolygonAdapter);
      expect(adapter.length).toBe(0);
      expect(adapter.headHash()).toBe('0'.repeat(64));
    });

    it('accepts localCache from config', () => {
      const localCache = [
        {
          index: 0,
          type: 'kyc_proof' as const,
          subjectId: 'seller-cached',
          submissionId: 'sub-cached',
          marketplaceId: 'market-alpha',
          credentialDigest: 'f'.repeat(64),
          decision: 'approve' as const,
          riskScore: 5,
          payloadDigest: '0'.repeat(64),
          prevHash: '0'.repeat(64),
          hash: '0x' + 'f'.repeat(64),
          createdAt: '2025-01-01T00:00:00.000Z',
        },
      ];
      const adapter = new PolygonAdapter({ ...validConfig, localCache });
      expect(adapter.length).toBe(1);
      expect(adapter.all()[0].subjectId).toBe('seller-cached');
    });
  });

  describe('computeHash (internal)', () => {
    it('produces deterministic hashes for same input', () => {
      const adapter1 = new PolygonAdapter(validConfig);
      const adapter2 = new PolygonAdapter(validConfig);

      const entry: LedgerAnchor = {
        ...sampleAnchorInput,
        index: 0,
        payloadDigest: 'd'.repeat(64),
        prevHash: '0'.repeat(64),
        hash: '',
      };

      // Access private method via type assertion
      const hash1 = (adapter1 as unknown as { computeHash: (e: LedgerAnchor) => string }).computeHash(entry);
      const hash2 = (adapter2 as unknown as { computeHash: (e: LedgerAnchor) => string }).computeHash(entry);
      expect(hash1).toBe(hash2);
      expect(hash1).toMatch(/^[a-f0-9]{64}$/);
    });

    it('produces different hashes for different inputs', () => {
      const adapter = new PolygonAdapter(validConfig);
      const entry1: LedgerAnchor = {
        ...sampleAnchorInput,
        index: 0,
        payloadDigest: 'd'.repeat(64),
        prevHash: '0'.repeat(64),
        hash: '',
      };
      const entry2: LedgerAnchor = {
        ...sampleAnchorInput,
        index: 1,
        payloadDigest: 'd'.repeat(64),
        prevHash: '0'.repeat(64),
        hash: '',
      };

      const hash1 = (adapter as unknown as { computeHash: (e: LedgerAnchor) => string }).computeHash(entry1);
      const hash2 = (adapter as unknown as { computeHash: (e: LedgerAnchor) => string }).computeHash(entry2);
      expect(hash1).not.toBe(hash2);
    });
  });

  describe('localVerify (internal)', () => {
    it('returns valid for intact chain', () => {
      const adapter = new PolygonAdapter(validConfig);
      const cache = (adapter as unknown as { localCache: LedgerAnchor[] }).localCache;

      const entry1: LedgerAnchor = {
        ...sampleAnchorInput,
        index: 0,
        payloadDigest: 'd'.repeat(64),
        prevHash: '0'.repeat(64),
        hash: '0x' + 'a'.repeat(64),
      };
      entry1.hash = (adapter as unknown as { computeHash: (e: LedgerAnchor) => string }).computeHash(entry1);
      cache.push(entry1);

      const result = (adapter as unknown as { localVerify: () => ChainVerification }).localVerify();
      expect(result.valid).toBe(true);
      expect(result.length).toBe(1);
      expect(result.brokenAtIndex).toBeNull();
    });

    it('detects out-of-order index', () => {
      const adapter = new PolygonAdapter(validConfig);
      const cache = (adapter as unknown as { localCache: LedgerAnchor[] }).localCache;

      const entry1: LedgerAnchor = {
        ...sampleAnchorInput,
        index: 0,
        payloadDigest: 'd'.repeat(64),
        prevHash: '0'.repeat(64),
        hash: '0x' + 'a'.repeat(64),
      };
      entry1.hash = (adapter as unknown as { computeHash: (e: LedgerAnchor) => string }).computeHash(entry1);
      cache.push(entry1);

      const entry2: LedgerAnchor = {
        ...sampleAnchorInput,
        index: 2, // Skip index 1
        payloadDigest: 'd'.repeat(64),
        prevHash: entry1.hash,
        hash: '0x' + 'b'.repeat(64),
      };
      entry2.hash = (adapter as unknown as { computeHash: (e: LedgerAnchor) => string }).computeHash(entry2);
      cache.push(entry2);

      const result = (adapter as unknown as { localVerify: () => ChainVerification }).localVerify();
      expect(result.valid).toBe(false);
      expect(result.brokenAtIndex).toBe(1);
      expect(result.detail).toContain('out of order');
    });

    it('detects mismatched prevHash', () => {
      const adapter = new PolygonAdapter(validConfig);
      const cache = (adapter as unknown as { localCache: LedgerAnchor[] }).localCache;

      const entry1: LedgerAnchor = {
        ...sampleAnchorInput,
        index: 0,
        payloadDigest: 'd'.repeat(64),
        prevHash: '0'.repeat(64),
        hash: '0x' + 'a'.repeat(64),
      };
      entry1.hash = (adapter as unknown as { computeHash: (e: LedgerAnchor) => string }).computeHash(entry1);
      cache.push(entry1);

      const entry2: LedgerAnchor = {
        ...sampleAnchorInput,
        index: 1,
        payloadDigest: 'd'.repeat(64),
        prevHash: '0x' + 'z'.repeat(64), // Wrong prevHash
        hash: '0x' + 'b'.repeat(64),
      };
      entry2.hash = (adapter as unknown as { computeHash: (e: LedgerAnchor) => string }).computeHash(entry2);
      cache.push(entry2);

      const result = (adapter as unknown as { localVerify: () => ChainVerification }).localVerify();
      expect(result.valid).toBe(false);
      expect(result.brokenAtIndex).toBe(1);
      expect(result.detail).toContain('prevHash does not match');
    });

    it('detects forged hash', () => {
      const adapter = new PolygonAdapter(validConfig);
      const cache = (adapter as unknown as { localCache: LedgerAnchor[] }).localCache;

      const entry1: LedgerAnchor = {
        ...sampleAnchorInput,
        index: 0,
        payloadDigest: 'd'.repeat(64),
        prevHash: '0'.repeat(64),
        hash: '0x' + 'wrong'.padEnd(64, '0'), // Forged hash
      };
      cache.push(entry1);

      const result = (adapter as unknown as { localVerify: () => ChainVerification }).localVerify();
      expect(result.valid).toBe(false);
      expect(result.brokenAtIndex).toBe(0);
      expect(result.detail).toContain('anchor hash does not match');
    });
  });

  describe('interface compliance', () => {
    it('implements LedgerAdapter interface', () => {
      const adapter = new PolygonAdapter(validConfig);

      // Check all required methods exist
      expect(typeof adapter.length).toBe('number');
      expect(typeof adapter.headHash).toBe('function');
      expect(typeof adapter.all).toBe('function');
      expect(typeof adapter.find).toBe('function');
      expect(typeof adapter.append).toBe('function');
      expect(typeof adapter.appendAll).toBe('function');
      expect(typeof adapter.verify).toBe('function');
    });
  });

  describe('cache behavior', () => {
    it('returns copies from all()', () => {
      const adapter = new PolygonAdapter(validConfig);
      const cache = (adapter as unknown as { localCache: LedgerAnchor[] }).localCache;
      cache.push({
        ...sampleAnchorInput,
        index: 0,
        payloadDigest: 'd'.repeat(64),
        prevHash: '0'.repeat(64),
        hash: '0x' + 'a'.repeat(64),
      });

      const all1 = adapter.all();
      const all2 = adapter.all();
      expect(all1).not.toBe(all2); // Different array instances
      expect(all1[0]).not.toBe(all2[0]); // Different object instances
    });

    it('find returns copy of anchor', () => {
      const adapter = new PolygonAdapter(validConfig);
      const cache = (adapter as unknown as { localCache: LedgerAnchor[] }).localCache;
      const entry = {
        ...sampleAnchorInput,
        index: 0,
        payloadDigest: 'd'.repeat(64),
        prevHash: '0'.repeat(64),
        hash: '0x' + 'a'.repeat(64),
      };
      cache.push(entry);

      const found = adapter.find(entry.hash);
      expect(found).toBeDefined();
      expect(found).not.toBe(entry); // Different object instance
      if (found) {
        found.decision = 'reject';
      }
      expect(adapter.find(entry.hash)?.decision).toBe('approve'); // Original unchanged
    });
  });
});