import { canonicalClone, canonicalJson, isEmptyObject } from './canonical';

describe('canonicalJson', () => {
  it('produces identical output regardless of key insertion order', () => {
    const a = { b: 2, a: 1, nested: { z: 1, y: [3, 2, 1] } };
    const b = { nested: { y: [3, 2, 1], z: 1 }, a: 1, b: 2 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(canonicalJson(a)).toBe('{"a":1,"b":2,"nested":{"y":[3,2,1],"z":1}}');
  });

  it('preserves array order because order is data in a list', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
  });

  it('serialises dates as ISO strings and drops undefined members', () => {
    expect(canonicalJson({ at: new Date('2025-03-01T00:00:00.000Z'), gone: undefined })).toBe(
      '{"at":"2025-03-01T00:00:00.000Z"}',
    );
  });

  it('refuses non-finite numbers rather than emitting invalid JSON', () => {
    expect(() => canonicalJson({ value: Number.NaN })).toThrow(/non-finite/);
    expect(() => canonicalJson({ value: Number.POSITIVE_INFINITY })).toThrow(/non-finite/);
  });

  it('serialises bigints as strings so large integers stay lossless', () => {
    expect(canonicalJson({ id: BigInt('9007199254740993') })).toBe('{"id":"9007199254740993"}');
  });

  it('rejects values with no canonical representation', () => {
    expect(() => canonicalJson(() => undefined)).toThrow(/function/);
    expect(() => canonicalJson(Symbol('x'))).toThrow(/symbol/);
  });

  it('clone returns a structurally equal but independent copy', () => {
    const source = { nested: { list: [1, 2] } };
    const copy = canonicalClone(source);
    copy.nested.list.push(3);
    expect(source.nested.list).toEqual([1, 2]);
    expect(canonicalClone(source)).toEqual(source);
  });
});

describe('isEmptyObject', () => {
  it.each([
    [undefined, true],
    [null, true],
    [{}, true],
    [{ a: 1 }, false],
  ])('%p -> %p', (input, expected) => {
    expect(isEmptyObject(input as Record<string, unknown> | undefined)).toBe(expected);
  });
});