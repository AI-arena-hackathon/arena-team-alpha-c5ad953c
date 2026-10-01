import {
  corruptEntryForTesting,
  GENESIS_HASH,
  LedgerChain,
} from './chain';
import type { AnchorInput } from '../domain/types';

function anchor(index: number, patch: Partial<AnchorInput> = {}): AnchorInput {
  return {
    type: 'kyc_proof',
    subjectId: `seller-${index}`,
    submissionId: `kyc_submission_${index}`,
    marketplaceId: 'market-alpha',
    credentialDigest: 'a'.repeat(64),
    decision: 'approve',
    riskScore: index * 3,
    createdAt: `2025-03-0${(index % 9) + 1}T09:00:00.000Z`,
    ...patch,
  };
}

describe('LedgerChain', () => {
  it('starts empty at the genesis hash', () => {
    const chain = new LedgerChain();
    expect(chain.length).toBe(0);
    expect(chain.headHash()).toBe(GENESIS_HASH);
    expect(chain.verify()).toMatchObject({ valid: true, length: 0, brokenAtIndex: null });
  });

  it('links each anchor to its predecessor', async () => {
    const chain = new LedgerChain();
    const first = await chain.append(anchor(1));
    const second = await chain.append(anchor(2));

    expect(first.index).toBe(0);
    expect(first.prevHash).toBe(GENESIS_HASH);
    expect(second.index).toBe(1);
    expect(second.prevHash).toBe(first.hash);
    expect(chain.headHash()).toBe(second.hash);
    expect(chain.verify().valid).toBe(true);
  });

  it('assigns unique sequential hashes and indexes', async () => {
    const chain = new LedgerChain();
    const entries = await chain.appendAll([anchor(1), anchor(2), anchor(3)]);
    expect(entries.map((entry) => entry.index)).toEqual([0, 1, 2]);
    expect(new Set(entries.map((entry) => entry.hash)).size).toBe(3);
  });

  it('serialises concurrent appends so no two anchors share an index or prevHash', async () => {
    const chain = new LedgerChain();
    const results = await Promise.all(
      Array.from({ length: 25 }, (_unused, index) => chain.append(anchor(index))),
    );
    const indexes = results.map((entry) => entry.index).sort((a, b) => a - b);
    expect(indexes).toEqual(Array.from({ length: 25 }, (_unused, index) => index));
    expect(chain.verify().valid).toBe(true);
  });

  it('stores no personal data in an anchor', async () => {
    const chain = new LedgerChain();
    const entry = await chain.append(anchor(1));
    const serialised = JSON.stringify(entry);
    expect(serialised).not.toContain('fullName');
    expect(serialised).not.toContain('dateOfBirth');
    expect(Object.keys(entry).sort()).toEqual(
      [
        'credentialDigest',
        'createdAt',
        'decision',
        'hash',
        'index',
        'marketplaceId',
        'payloadDigest',
        'prevHash',
        'riskScore',
        'submissionId',
        'subjectId',
        'type',
      ].sort(),
    );
  });

  it('detects a rewritten historical decision', async () => {
    const chain = new LedgerChain();
    await chain.appendAll([anchor(1), anchor(2), anchor(3)]);
    corruptEntryForTesting(chain, 1, { decision: 'reject' });

    const result = chain.verify();
    expect(result.valid).toBe(false);
    expect(result.brokenAtIndex).toBe(1);
    expect(result.detail).toMatch(/payload digest/);
  });

  it('detects a removed anchor', async () => {
    const chain = new LedgerChain();
    await chain.appendAll([anchor(1), anchor(2), anchor(3)]);
    (chain as unknown as { entries: unknown[] }).entries.splice(1, 1);

    const result = chain.verify();
    expect(result.valid).toBe(false);
    expect(result.brokenAtIndex).toBe(1);
    expect(result.detail).toMatch(/out of order/);
  });

  it('detects a forged hash', async () => {
    const chain = new LedgerChain();
    await chain.append(anchor(1));
    corruptEntryForTesting(chain, 0, { hash: 'f'.repeat(64) });
    const result = chain.verify();
    expect(result.valid).toBe(false);
    expect(result.detail).toMatch(/anchor hash/);
  });

  it('keeps the queue alive after a rejected append', async () => {
    const chain = new LedgerChain();
    await chain.append(anchor(1));
    const failing = chain.append(anchor(2));
    corruptEntryForTesting(chain, 0, { prevHash: 'e'.repeat(64) });
    await failing;
    const after = await chain.append(anchor(3));
    expect(after.index).toBeGreaterThan(0);
    expect(chain.verify().valid).toBe(false);
  });

  it('hands out copies, so callers cannot mutate the chain', async () => {
    const chain = new LedgerChain();
    await chain.append(anchor(1));
    const snapshot = chain.all();
    snapshot[0].decision = 'reject';
    expect(chain.all()[0].decision).toBe('approve');
  });

  it('finds an anchor by hash and reports an unknown hash as absent', async () => {
    const chain = new LedgerChain();
    const entry = await chain.append(anchor(1));
    expect(chain.find(entry.hash)?.submissionId).toBe(entry.submissionId);
    expect(chain.find('a'.repeat(64))).toBeUndefined();
  });
});