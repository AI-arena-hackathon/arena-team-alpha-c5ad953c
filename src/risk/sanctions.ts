import type { SanctionsHit } from '../domain/types';
import {
  EU_CONSOLIDATED_SANCTIONS,
  nameTokenKey,
  type SanctionsEntry,
} from './referenceData';

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
