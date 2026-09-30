/**
 * Reference data for the AML rules. Kept in one module so the rule weights in
 * engine.ts stay declarative and reviewable, and so a production deployment can
 * swap the seed list for a nightly feed of the EU consolidated list.
 */

export interface SanctionsEntry {
  reference: string;
  name: string;
  dateOfBirth?: string;
  aliases?: string[];
  programme: string;
  listName?: string;
}

export const EU_CONSOLIDATED_SANCTIONS: SanctionsEntry[] = [
  {
    reference: 'EU-2024-0001',
    name: 'Viktor Petrovich Morozov',
    dateOfBirth: '1971-03-14',
    aliases: ['V. P. Morozov'],
    programme: 'EU 833/2014 — asset freezes',
    listName: 'eu-consolidated',
  },
  {
    reference: 'EU-2024-0002',
    name: 'Amara Okonkwo-Bright',
    dateOfBirth: '1984-11-02',
    programme: 'EU 833/2014 — asset freezes',
    listName: 'eu-consolidated',
  },
  {
    reference: 'EU-2023-0117',
    name: 'Nordwind Maritime Trading Ltd',
    programme: 'EU 833/2014 — sectoral trade restriction',
    listName: 'eu-consolidated',
  },
];

/**
 * Jurisdictions treated as elevated risk. `high` blocks a transaction pending
 * enhanced due diligence; `elevated` adds a score contribution only.
 */
export const HIGH_RISK_JURISDICTIONS: ReadonlySet<string> = new Set([
  'IR',
  'KP',
  'SY',
  'AF',
  'MM',
  'BY',
]);

export const ELEVATED_RISK_JURISDICTIONS: ReadonlySet<string> = new Set([
  'RU',
  'PA',
  'MT',
  'CY',
  'VA',
  'NG',
]);

/** EEA member states, where DSA/AMLD obligations and eID coverage are strongest. */
export const EEA_COUNTRIES: ReadonlySet<string> = new Set([
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU',
  'IS', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'NO', 'PL', 'PT', 'RO', 'SK',
  'SI', 'ES', 'SE',
]);

/**
 * Name normalisation for screening: strip diacritics, punctuation and case so
 * "Morozov, Viktor-P." matches "viktor petrovich morozov". Deliberately
 * conservative — token-set comparison rather than fuzzy edit distance, so we
 * never flag two different people because their names are merely similar.
 */
/**
 * Comparison key for a person's name: normalised, split into tokens and sorted,
 * so "MOROZOV, Viktor-Petrovich" and "Viktor Petrovich Morozov" produce the same
 * key. Duplicates are kept so a longer name never collapses onto a shorter one.
 */
export function nameTokenKey(value: string): string {
  return normaliseName(value).split(' ').filter(Boolean).sort().join(' ');
}

/** True when two names denote the same person for screening/cross-check purposes. */
export function sameName(left: string, right: string): boolean {
  return nameTokenKey(left) === nameTokenKey(right);
}

export function normaliseName(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ß/g, 'ss')
    .replace(/æ/g, 'ae')
    .replace(/œ/g, 'oe')
    .replace(/ø/g, 'o')
    .replace(/ł/g, 'l')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normaliseCountry(value: string): string {
  return value.trim().toUpperCase();
}