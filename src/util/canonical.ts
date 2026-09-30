/**
 * Deterministic JSON serialisation used for hashing, signing and the
 * tamper-evident ledger. Object keys are sorted recursively so two structurally
 * equal payloads always produce byte-identical output — the property every
 * integrity guarantee in this service depends on.
 */
export function canonicalJson(value: unknown): string {
  return serialise(value);
}

function serialise(value: unknown): string {
  if (value === null) return 'null';

  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) {
        throw new TypeError('canonicalJson: cannot serialise non-finite number');
      }
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'undefined':
      return 'null';
    case 'bigint':
      return JSON.stringify(value.toString());
    case 'function':
    case 'symbol':
      throw new TypeError('canonicalJson: cannot serialise ' + typeof value);
    default:
      break;
  }

  if (Array.isArray(value)) {
    return '[' + value.map((item) => serialise(item === undefined ? null : item)).join(',') + ']';
  }

  if (value instanceof Date) {
    return JSON.stringify(value.toISOString());
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));

  return (
    '{' +
    entries
      .map(([key, entry]) => JSON.stringify(key) + ':' + serialise(entry))
      .join(',') +
    '}'
  );
}

/** Structured clone that survives the canonical-JSON round trip. */
export function canonicalClone<T>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T;
}

/** True when `value` has no keys — used to keep optional evidence blocks out of stored records. */
export function isEmptyObject(value: Record<string, unknown> | undefined | null): boolean {
  return !value || Object.keys(value).length === 0;
}