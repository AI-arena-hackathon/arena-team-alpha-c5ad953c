/**
 * Field names that must never leave the encryption boundary: into the ledger,
 * into compliance reports, into logs or into API responses.
 *
 * This list is the single source of truth for two jobs: `redactPii` scrubs a
 * payload before it is written to a log, and `findPiiPaths`/`containsPii` let the
 * tests assert that stored envelopes, ledger payloads, reports and log lines
 * carry no personal data. Adding a personal field to the domain model without
 * adding it here shows up as a failing leak test.
 */
export const PII_FIELD_NAMES = [
  'fullName',
  'firstName',
  'lastName',
  'dateOfBirth',
  'birthDate',
  'birthdate',
  'documentNumber',
  'nationality',
  'addressLine',
  'street',
  'postcode',
  'email',
  'phone',
  'passportNumber',
  'idNumber',
  'rawAssertion',
] as const;

const PII_FIELD_SET: ReadonlySet<string> = new Set<string>(PII_FIELD_NAMES);

/** Deep, key-based redaction. Replaces PII values with a fixed marker. */
export function redactPii<T>(value: T, marker = '[REDACTED]'): T {
  return walk(value, marker) as T;
}

function walk(value: unknown, marker: string): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => walk(item, marker));
  }
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      output[key] = PII_FIELD_SET.has(key) ? marker : walk(entry, marker);
    }
    return output;
  }
  return value;
}

/**
 * Collects the JSON paths of every PII field in a payload. Used by the
 * leak-detection test to assert that stored envelopes, ledger payloads and
 * generated reports carry no personal data in the clear.
 */
export function findPiiPaths(value: unknown, path = '$', found: string[] = []): string[] {
  if (Array.isArray(value)) {
    value.forEach((item, index) => findPiiPaths(item, `${path}[${index}]`, found));
    return found;
  }
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      const next = `${path}.${key}`;
      if (PII_FIELD_SET.has(key)) found.push(next);
      findPiiPaths(entry, next, found);
    }
  }
  return found;
}

/** True when a serialised payload contains a PII key or a bare-looking personal name. */
export function containsPii(value: unknown): boolean {
  return findPiiPaths(value).length > 0;
}