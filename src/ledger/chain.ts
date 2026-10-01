import type { LedgerAnchor } from '../domain/types';
import { digestOf } from '../security/encryption';
import { canonicalClone, canonicalJson } from '../util/canonical';
import type { LedgerAdapter } from './adapter';
import type { AnchorInput, ChainVerification } from '../domain/types';

/**
 * Tamper-evident proof-of-KYC ledger.
 *
 * This is the README's documented fallback scope ("periodic signed snapshots",
 * no on-chain dependency) implemented as an append-only hash chain: every anchor
 * commits to its predecessor, so editing or removing any historical anchor
 * invalidates every link after it. The anchor payload is deliberately PII-free —
 * salted credential digest, decision, score — so the same struct can be posted to
 * the Polygon zkEVM side-chain when that integration lands (the chain hash is
 * already the value an on-chain anchor would store).
 *
 * Writes are serialised through a promise queue so two concurrent submissions
 * cannot claim the same index or prevHash.
 */
export const GENESIS_HASH = '0'.repeat(64);

export class LedgerChain implements LedgerAdapter {
  private readonly entries: LedgerAnchor[] = [];
  private tail: Promise<unknown> = Promise.resolve();

  get length(): number {
    return this.entries.length;
  }

  headHash(): string {
    return this.entries.length === 0 ? GENESIS_HASH : this.entries[this.entries.length - 1].hash;
  }

  all(): LedgerAnchor[] {
    return canonicalClone(this.entries);
  }

  find(hash: string): LedgerAnchor | undefined {
    const entry = this.entries.find((item) => item.hash === hash);
    return entry ? canonicalClone(entry) : undefined;
  }

  append(input: AnchorInput): Promise<LedgerAnchor> {
    const run = this.tail.then(
      () => this.appendNow(input),
      () => this.appendNow(input),
    );
    // Keep the queue alive even if a caller inspects the rejected promise.
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async appendAll(inputs: AnchorInput[]): Promise<LedgerAnchor[]> {
    const out: LedgerAnchor[] = [];
    for (const input of inputs) out.push(await this.append(input));
    return out;
  }

  verify(): ChainVerification {
    let prevHash = GENESIS_HASH;
    for (let index = 0; index < this.entries.length; index += 1) {
      const entry = this.entries[index];
      if (entry.index !== index) {
        return broken(index, this.entries.length, prevHash, `entry index ${entry.index} is out of order`);
      }
      if (entry.prevHash !== prevHash) {
        return broken(index, this.entries.length, prevHash, 'prevHash does not match the preceding anchor');
      }
      if (entry.payloadDigest !== digestOf(payloadOf(entry))) {
        return broken(index, this.entries.length, prevHash, 'payload digest does not match the stored payload');
      }
      if (entry.hash !== computeHash(entry)) {
        return broken(index, this.entries.length, prevHash, 'anchor hash does not match its contents');
      }
      prevHash = entry.hash;
    }
    return {
      valid: true,
      length: this.entries.length,
      headHash: prevHash,
      brokenAtIndex: null,
      detail: 'every anchor links to its predecessor and matches its payload digest',
    };
  }

  private appendNow(input: AnchorInput): LedgerAnchor {
    const index = this.entries.length;
    const payload = { ...input };
    const entry: LedgerAnchor = {
      ...payload,
      index,
      payloadDigest: digestOf(payload),
      prevHash: this.headHash(),
      hash: '',
    };
    entry.hash = computeHash(entry);
    this.entries.push(entry);
    return canonicalClone(entry);
  }
}

/**
 * Test seam: mutate the chain so chain-integrity detection can be exercised.
 * Deliberately explicit and outside the public write path — it exists so the
 * tamper-evidence guarantee is proven by a test rather than asserted in prose.
 */
export function corruptEntryForTesting(chain: LedgerChain, index: number, patch: Partial<LedgerAnchor>): void {
  (chain as unknown as { entries: LedgerAnchor[] }).entries[index] = {
    ...(chain as unknown as { entries: LedgerAnchor[] }).entries[index],
    ...patch,
  };
}

function payloadOf(entry: LedgerAnchor): AnchorInput {
  return {
    type: entry.type,
    subjectId: entry.subjectId,
    submissionId: entry.submissionId,
    marketplaceId: entry.marketplaceId,
    credentialDigest: entry.credentialDigest,
    decision: entry.decision,
    riskScore: entry.riskScore,
    createdAt: entry.createdAt,
  };
}

function computeHash(entry: LedgerAnchor): string {
  return digestOf({
    index: entry.index,
    prevHash: entry.prevHash,
    payloadDigest: entry.payloadDigest,
  });
}

function broken(
  index: number,
  length: number,
  headHash: string,
  detail: string,
): ChainVerification {
  return { valid: false, length, headHash, brokenAtIndex: index, detail };
}

export { canonicalJson };