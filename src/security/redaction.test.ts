import { containsPii, findPiiPaths, redactPii } from './redaction';

describe('redactPii', () => {
  it('replaces personal fields at any depth while keeping the shape', () => {
    expect(
      redactPii({
        submissionId: 'kyc_1',
        subject: {
          fullName: 'Ines Ferreira',
          countryCode: 'PT',
          document: { type: 'passport', number: 'PT4417X' },
        },
        history: [{ email: 'ines@example.com' }],
        evaluatedAt: '2025-03-01T09:00:00.000Z',
      }),
    ).toEqual({
      submissionId: 'kyc_1',
      subject: {
        fullName: '[REDACTED]',
        countryCode: 'PT',
        document: { type: 'passport', number: 'PT4417X' },
      },
      history: [{ email: '[REDACTED]' }],
      evaluatedAt: '2025-03-01T09:00:00.000Z',
    });
  });

  it('leaves primitives, arrays of primitives and dates untouched', () => {
    const at = new Date('2025-03-01T09:00:00.000Z');
    expect(redactPii({ at, tags: ['a', 'b'], n: 1, ok: true, nothing: null })).toEqual({
      at,
      tags: ['a', 'b'],
      n: 1,
      ok: true,
      nothing: null,
    });
  });

  it('accepts a custom marker', () => {
    expect(redactPii({ phone: '+351 900 000 000' }, '***')).toEqual({ phone: '***' });
  });
});

describe('PII leak detection', () => {
  it('finds personal fields at any depth', () => {
    const payload = {
      subject: { fullName: 'Ines Ferreira', countryCode: 'PT' },
      history: [{ nested: { documentNumber: 'PT4417X' } }],
    };
    expect(findPiiPaths(payload)).toEqual([
      '$.subject.fullName',
      '$.history[0].nested.documentNumber',
    ]);
    expect(containsPii(payload)).toBe(true);
  });

  it('reports a clean payload', () => {
    const safe = {
      submissionId: 'kyc_1',
      risk: { score: 0, reasons: [{ code: 'DOCUMENT_EXPIRED', detail: 'expired 3 day(s) ago' }] },
      credentialDigest: 'a'.repeat(64),
      evaluatedAt: '2025-03-01T09:00:00.000Z',
    };
    expect(findPiiPaths(safe)).toEqual([]);
    expect(containsPii(safe)).toBe(false);
  });

  it('catches alternative spellings vendors use for the same field', () => {
    expect(containsPii({ birthdate: '1991-04-17' })).toBe(true);
    expect(containsPii({ birthDate: '1991-04-17' })).toBe(true);
    expect(containsPii({ dateOfBirth: '1991-04-17' })).toBe(true);
    expect(containsPii({ passportNumber: 'X123' })).toBe(true);
  });

  it('walks arrays, nulls and dates without misreading them', () => {
    expect(findPiiPaths([{ score: 1 }, new Date('2025-01-01'), null])).toEqual([]);
    expect(findPiiPaths(undefined)).toEqual([]);
    expect(findPiiPaths('a string')).toEqual([]);
    expect(findPiiPaths(42)).toEqual([]);
  });

  it('reports the path of a personal field nested under arrays of arrays', () => {
    expect(findPiiPaths({ batches: [[{ email: 'x@example.com' }]] })).toEqual([
      '$.batches[0][0].email',
    ]);
  });
});
