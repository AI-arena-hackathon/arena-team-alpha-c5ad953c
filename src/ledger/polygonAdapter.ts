import { ethers } from 'ethers';
import type { LedgerAdapter, AnchorInput, ChainVerification } from './adapter';
import type { LedgerAnchor } from '../domain/types';
import { digestOf } from '../security/encryption';

/**
 * Polygon zk-EVM anchoring adapter (production scope).
 *
 * This adapter replaces the in-memory hash chain with on-chain anchoring.
 * Each KYC proof is submitted as a transaction to a Polygon zk-EVM smart
 * contract that stores the anchor hash. The contract maintains an append-only
 * registry of anchors, providing tamper-evidence through blockchain finality.
 *
 * The adapter maintains a local index for fast lookup and verification, but
 * the source of truth is the on-chain contract state.
 */

export interface PolygonAdapterConfig {
  /** RPC endpoint for Polygon zk-EVM (e.g., https://zkevm-rpc.com) */
  rpcUrl: string;
  /** Private key of the anchoring wallet (32 bytes, hex) */
  privateKey: string;
  /** Address of the deployed anchor registry contract */
  contractAddress: string;
  /** Chain ID (1101 for Polygon zk-EVM mainnet, 1442 for testnet) */
  chainId: number;
  /** Gas limit for anchor transactions */
  gasLimit?: number;
  /** Maximum retries for transaction submission */
  maxRetries?: number;
  /** Local cache of anchors for fast reads (populated from events) */
  localCache?: LedgerAnchor[];
}

const ANCHOR_REGISTRY_ABI = [
  'function anchor(bytes32 hash, string calldata metadata) external',
  'function getAnchor(uint256 index) external view returns (bytes32 hash, string metadata, uint256 timestamp, address submitter)',
  'function anchorCount() external view returns (uint256)',
  'function verifyChain() external view returns (bool valid, uint256 length, bytes32 headHash, uint256 brokenAtIndex)',
  'event Anchored(uint256 indexed index, bytes32 indexed hash, string metadata, address indexed submitter)',
] as const;

interface OnChainAnchor {
  hash: string;
  metadata: string;
  timestamp: bigint;
  submitter: string;
}

export class PolygonAdapter implements LedgerAdapter {
  private readonly provider: ethers.JsonRpcProvider;
  private readonly wallet: ethers.Wallet;
  private readonly contract: ethers.Contract;
  private readonly config: PolygonAdapterConfig;
  private localCache: LedgerAnchor[] = [];
  private cacheInitialized = false;
  private readonly nonceManager: NonceManager;

  constructor(config: PolygonAdapterConfig) {
    this.config = {
      gasLimit: 100_000,
      maxRetries: 3,
      ...config,
    };

    this.provider = new ethers.JsonRpcProvider(this.config.rpcUrl);
    this.wallet = new ethers.Wallet(this.config.privateKey, this.provider);
    this.contract = new ethers.Contract(
      this.config.contractAddress,
      ANCHOR_REGISTRY_ABI,
      this.wallet,
    );
    this.nonceManager = new NonceManager(this.provider, this.wallet.address);

    // Initialize local cache from config if provided (for testing/offline mode)
    if (this.config.localCache) {
      this.localCache = this.config.localCache.map((anchor) => ({ ...anchor }));
      this.cacheInitialized = true;
    }
  }

  get length(): number {
    return this.localCache.length;
  }

  headHash(): string {
    if (this.localCache.length === 0) {
      return '0'.repeat(64);
    }
    return this.localCache[this.localCache.length - 1].hash;
  }

  all(): LedgerAnchor[] {
    return this.localCache.map((anchor) => ({ ...anchor }));
  }

  find(hash: string): LedgerAnchor | undefined {
    const entry = this.localCache.find((anchor) => anchor.hash === hash);
    return entry ? { ...entry } : undefined;
  }

  async append(input: AnchorInput): Promise<LedgerAnchor> {
    await this.ensureCacheInitialized();

    const index = this.localCache.length;
    const payload = { ...input };
    const payloadDigest = digestOf(payload);
    const prevHash = this.headHash();

    const entry: LedgerAnchor = {
      ...payload,
      index,
      payloadDigest,
      prevHash,
      hash: '',
      createdAt: input.createdAt,
    };
    entry.hash = this.computeHash(entry);

    const metadata = JSON.stringify({
      index,
      subjectId: input.subjectId,
      submissionId: input.submissionId,
      marketplaceId: input.marketplaceId,
      type: input.type,
      decision: input.decision,
      riskScore: input.riskScore,
    });

    await this.submitAnchorWithRetry(entry.hash, metadata);

    this.localCache.push(entry);
    return { ...entry };
  }

  async appendAll(inputs: AnchorInput[]): Promise<LedgerAnchor[]> {
    const out: LedgerAnchor[] = [];
    for (const input of inputs) {
      out.push(await this.append(input));
    }
    return out;
  }

  async verify(): Promise<ChainVerification> {
    await this.ensureCacheInitialized();

    try {
      const result = await this.contract.verifyChain();
      const [valid, length, headHash, brokenAtIndex] = result;

      return {
        valid: Boolean(valid),
        length: Number(length),
        headHash: String(headHash),
        brokenAtIndex: Number(brokenAtIndex) === 0xFFFFFFFF ? null : Number(brokenAtIndex),
        detail: valid
          ? 'every anchor links to its predecessor and matches its payload digest (on-chain verified)'
          : 'on-chain verification failed: chain integrity broken',
      };
    } catch {
      // Fallback to local verification if contract call fails
      return this.localVerify();
    }
  }

  /**
   * Initializes the local cache by reading all anchors from the contract.
   * Called lazily on first read operation.
   */
  private async ensureCacheInitialized(): Promise<void> {
    if (this.cacheInitialized) return;

    try {
      const count = await this.contract.anchorCount();
      const total = Number(count);

      this.localCache = [];
      for (let i = 0; i < total; i++) {
        const anchor = await this.contract.getAnchor(i);
        const onChainAnchor = anchor as OnChainAnchor;
        const metadata = JSON.parse(onChainAnchor.metadata);
        this.localCache.push({
          index: metadata.index,
          type: metadata.type,
          subjectId: metadata.subjectId,
          submissionId: metadata.submissionId,
          marketplaceId: metadata.marketplaceId,
          credentialDigest: metadata.credentialDigest ?? '0'.repeat(64),
          decision: metadata.decision,
          riskScore: metadata.riskScore,
          payloadDigest: '0'.repeat(64), // Not stored on-chain
          prevHash: '0'.repeat(64), // Not stored on-chain
          hash: onChainAnchor.hash,
          createdAt: new Date(Number(onChainAnchor.timestamp) * 1000).toISOString(),
        });
      }

      this.cacheInitialized = true;
    } catch {
      // If we can't read from chain, start with empty cache
      // (e.g., fresh deployment or network issues)
      this.localCache = this.config.localCache ?? [];
      this.cacheInitialized = true;
    }
  }

  private async submitAnchorWithRetry(hash: string, metadata: string): Promise<void> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < (this.config.maxRetries ?? 3); attempt++) {
      try {
        const nonce = await this.nonceManager.getNextNonce();
        const tx = await this.contract.anchor(hash, metadata, {
          gasLimit: this.config.gasLimit,
          nonce,
        });
        await tx.wait();
        return;
      } catch (error) {
        lastError = error as Error;
        // Increment nonce on failure to avoid stuck nonce
        await this.nonceManager.incrementNonce();
        if (attempt < (this.config.maxRetries ?? 3) - 1) {
          await this.sleep(1000 * (attempt + 1));
        }
      }
    }

    throw new Error(`Failed to submit anchor after ${this.config.maxRetries} attempts: ${lastError?.message}`);
  }

  private localVerify(): ChainVerification {
    let prevHash = '0'.repeat(64);
    for (let index = 0; index < this.localCache.length; index++) {
      const entry = this.localCache[index];
      if (entry.index !== index) {
        return broken(index, this.localCache.length, prevHash, `entry index ${entry.index} is out of order`);
      }
      if (entry.prevHash !== prevHash) {
        return broken(index, this.localCache.length, prevHash, 'prevHash does not match the preceding anchor');
      }
      if (entry.hash !== this.computeHash(entry)) {
        return broken(index, this.localCache.length, prevHash, 'anchor hash does not match its contents');
      }
      prevHash = entry.hash;
    }
    return {
      valid: true,
      length: this.localCache.length,
      headHash: prevHash,
      brokenAtIndex: null,
      detail: 'every anchor links to its predecessor and matches its payload digest (local verification)',
    };
  }

  private computeHash(entry: LedgerAnchor): string {
    return digestOf({
      index: entry.index,
      prevHash: entry.prevHash,
      payloadDigest: entry.payloadDigest,
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/**
 * Simple nonce manager to handle concurrent transactions.
 * In production, consider using a more robust solution (e.g., Redis-backed).
 */
class NonceManager {
  private pendingNonce: number | null = null;
  private readonly provider: ethers.JsonRpcProvider;
  private readonly address: string;

  constructor(provider: ethers.JsonRpcProvider, address: string) {
    this.provider = provider;
    this.address = address;
  }

  async getNextNonce(): Promise<number> {
    if (this.pendingNonce !== null) {
      return this.pendingNonce;
    }
    this.pendingNonce = await this.provider.getTransactionCount(this.address, 'pending');
    return this.pendingNonce;
  }

  async incrementNonce(): Promise<void> {
    if (this.pendingNonce !== null) {
      this.pendingNonce += 1;
    } else {
      this.pendingNonce = await this.provider.getTransactionCount(this.address, 'pending');
    }
  }
}

function broken(
  index: number,
  length: number,
  headHash: string,
  detail: string,
): ChainVerification {
  return { valid: false, length, headHash, brokenAtIndex: index, detail };
}