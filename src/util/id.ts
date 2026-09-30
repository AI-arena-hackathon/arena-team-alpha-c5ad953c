import { createHash, randomUUID } from 'node:crypto';

/** Stable opaque identifiers. Submission ids are supplied by partners for idempotency. */
export function newSubmissionId(): string {
  return 'kyc_' + randomUUID().replace(/-/g, '');
}

export function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

/** Short, human-quotable digest used in reports and logs (never a security boundary). */
export function shortDigest(hex: string, length = 12): string {
  return hex.slice(0, length);
}