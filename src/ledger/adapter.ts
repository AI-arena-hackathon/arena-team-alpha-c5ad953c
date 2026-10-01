import type { LedgerAnchor, ChainVerification, AnchorInput } from '../domain/types';

/**
 * Ledger adapter port.
 *
 * Both the in-memory hash chain (fallback scope) and the Polygon zk-EVM
 * anchoring adapter (production scope) implement this interface so the
 * KYC service and HTTP layer remain unchanged when the anchoring backend
 * is swapped.
 */
export interface LedgerAdapter {
  /** Number of anchors currently stored. */
  readonly length: number;

  /** Hash of the most recent anchor, or the genesis hash if empty. */
  headHash(): string;

  /** Returns a copy of all anchors (for inspection / reporting). */
  all(): LedgerAnchor[];

  /** Finds an anchor by its hash. */
  find(hash: string): LedgerAnchor | undefined;

  /** Appends a new anchor and returns it. */
  append(input: AnchorInput): Promise<LedgerAnchor>;

  /** Appends multiple anchors sequentially. */
  appendAll(inputs: AnchorInput[]): Promise<LedgerAnchor[]>;

  /** Verifies the integrity of the entire chain. */
  verify(): ChainVerification | Promise<ChainVerification>;
}

export { GENESIS_HASH } from './chain';
export type { AnchorInput, ChainVerification, LedgerAnchor } from '../domain/types';