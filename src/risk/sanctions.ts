import type { SanctionsHit } from '../domain/types';
import {
  EU_CONSOLIDATED_SANCTIONS,
  nameTokenKey,
  type SanctionsEntry,
} from './referenceData';

export interface SanctionsFeed {
  listName?: string;
  entries: SanctionsEntry[];
}

/**
 * Sanctions / PEP screening.
 *
 * Matching is exact on the normalised name (token set, order-independent) and
 * optionally corroborated by date of birth. We deliberately do not use fuzzy
 * edit-distance matching on names: for NFT sellers the cost of a false positive
 * (blocking a legitimate creator) is paid by a human reviewer, while the cost of
 * a missed match is regulatory. Token-exact matching with DOB corroboration
 * keeps the hit list short and explainable.
 */
export class SanctionsScreener {
  private readonly entries: SanctionsEntry[];
  readonly listName: string;

  constructor(entries: SanctionsEntry[] = EU_CONSOLIDATED_SANCTIONS, listName = 'eu-consolidated') {
    this.listName = listName;
    this.entries = entries.filter((entry) => (entry.listName ?? listName) === listName);
  }

  get size(): number {
    return this.entries.length;
  }

  /**
   * @param subjectName  name as declared by the marketplace
   * @param dateOfBirth  ISO date of birth, used to corroborate a name match
   * @param walletAddress optional blockchain address, matched against entries
   *        whose name is an entity (a frozen wallet is often the only signal)
   */
  screen(subject: {
    name: string;
    dateOfBirth?: string;
    walletAddress?: string;
  }): SanctionsHit[] {
    const hits: SanctionsHit[] = [];
    const subjectTokens = nameTokenKey(subject.name);

    for (const entry of this.entries) {
      const candidates = [entry.name, ...(entry.aliases ?? [])];
      const nameMatched = candidates.some(
        (candidate) => nameTokenKey(candidate) === subjectTokens,
      );

      const walletMatched = Boolean(
        subject.walletAddress && isEntityEntry(entry) && entry.name === subject.walletAddress,
      );

      if (!nameMatched && !walletMatched) continue;

      const dobMatched = Boolean(
        entry.dateOfBirth && entry.dateOfBirth === subject.dateOfBirth,
      );

      hits.push({
        listName: entry.listName ?? this.listName,
        matchedOn: dobMatched ? 'name_and_dob' : nameMatched ? 'name' : 'wallet',
        subjectName: entry.name,
        reference: entry.reference,
        programme: entry.programme,
      });
    }

    return hits;
  }
}

/** Organisation-level entries are screened by name or wallet, never by DOB. */
function isEntityEntry(entry: SanctionsEntry): boolean {
  return entry.dateOfBirth === undefined;
}

/**
 * Fetch and parse a live sanctions feed (the nightly EU consolidated export).
 * Accepts either `{ listName, entries: [...] }` or a bare top-level array.
 * Entries missing a reference, name or programme are dropped rather than
 * screened with partial data — a malformed row must never silently match.
 *
 * Hardened against DoS:
 * - Request timeout (default 10s) via AbortController
 * - Response body size limit (default 5 MB) to prevent memory exhaustion
 */
export interface LoadSanctionsFeedOptions {
  /** Request timeout in milliseconds. Default: 10_000 (10s). */
  timeoutMs?: number;
  /** Maximum response body size in bytes. Default: 5_242_880 (5 MB). */
  maxResponseSizeBytes?: number;
  /** Custom fetch implementation (for testing). */
  fetchImpl?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESPONSE_SIZE = 5 * 1024 * 1024; // 5 MB

async function readLimitedJson<T>(response: Response, maxBytes: number): Promise<T> {
  const headers = response.headers;
  const contentLength = headers?.get?.('content-length') ?? null;
  if (contentLength !== null) {
    const declaredLength = parseInt(contentLength, 10);
    if (!Number.isNaN(declaredLength) && declaredLength > maxBytes) {
      throw new Error(`Response too large: ${declaredLength} bytes (limit ${maxBytes} bytes)`);
    }
  }

  const reader = response.body?.getReader?.();
  if (!reader) {
    throw new Error('Response body is not readable');
  }

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.length;
      if (totalBytes > maxBytes) {
        throw new Error(`Response exceeds size limit of ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const combined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.length;
  }

  const text = new TextDecoder().decode(combined);
  return JSON.parse(text) as T;
}

export async function loadSanctionsFeed(
  url: string,
  options: LoadSanctionsFeedOptions = {},
): Promise<SanctionsFeed> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, maxResponseSizeBytes = DEFAULT_MAX_RESPONSE_SIZE, fetchImpl = fetch } = options;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`Failed to fetch sanctions feed: ${response.status} ${response.statusText}`);
    }

    const data: unknown = await readLimitedJson(response, maxResponseSizeBytes);
    const feed = Array.isArray(data) ? { entries: data } : data;
    if (typeof feed !== 'object' || feed === null || Array.isArray(feed)) {
      throw new Error('Sanctions feed must be a JSON object or array');
    }
    const record = feed as Record<string, unknown>;
    const listName = typeof record.listName === 'string' ? record.listName : undefined;
    const rawEntries = Array.isArray(record.entries) ? record.entries : [];
    const entries: SanctionsEntry[] = rawEntries
      .filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null && !Array.isArray(entry))
      .map((entry) => ({
        reference: typeof entry.reference === 'string' ? entry.reference : '',
        name: typeof entry.name === 'string' ? entry.name : '',
        dateOfBirth: typeof entry.dateOfBirth === 'string' ? entry.dateOfBirth : undefined,
        aliases: Array.isArray(entry.aliases) ? entry.aliases.filter((a): a is string => typeof a === 'string') : undefined,
        programme: typeof entry.programme === 'string' ? entry.programme : '',
        listName: typeof entry.listName === 'string' ? entry.listName : undefined,
      }))
      .filter((entry) => entry.reference && entry.name && entry.programme);
    return { listName, entries };
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error(`Sanctions feed request timed out after ${timeoutMs} ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}
