import { SanctionsScreener } from './sanctions';
import { EU_CONSOLIDATED_SANCTIONS, type SanctionsEntry } from './referenceData';

const ENTRY: SanctionsEntry = {
  reference: 'EU-TEST-1',
  name: 'Viktor Petrovich Morozov',
  dateOfBirth: '1971-03-14',
  aliases: ['V. P. Morozov'],
  programme: 'EU 833/2014 — asset freezes',
  listName: 'test-list',
};

describe('SanctionsScreener', () => {
  const screener = new SanctionsScreener([ENTRY], 'test-list');

  it('matches a declared name exactly and reports the programme', () => {
    const [hit, ...rest] = screener.screen({ name: 'Viktor Petrovich Morozov' });
    expect(rest).toHaveLength(0);
    expect(hit).toMatchObject({
      listName: 'test-list',
      reference: 'EU-TEST-1',
      matchedOn: 'name',
      programme: 'EU 833/2014 — asset freezes',
    });
  });

  it('corroborates a match with the date of birth', () => {
    const hits = screener.screen({
      name: 'Viktor Petrovich Morozov',
      dateOfBirth: '1971-03-14',
    });
    expect(hits[0].matchedOn).toBe('name_and_dob');
  });

  it('normalises case, punctuation and word order before comparing', () => {
    const hits = screener.screen({ name: 'MOROZOV, Viktor-Petrovich' });
    expect(hits).toHaveLength(1);
  });

  it('strips diacritics so accented names still match the list', () => {
    const accented = new SanctionsScreener(
      [{ ...ENTRY, name: 'José Ávilà-Straße' }],
      'test-list',
    );
    expect(accented.screen({ name: 'jose avila strasse' })).toHaveLength(1);
  });

  it('matches on aliases', () => {
    expect(screener.screen({ name: 'v p morozov' })).toHaveLength(1);
  });

  it('does not match a name that merely shares a token', () => {
    expect(screener.screen({ name: 'Viktor Morozov' })).toHaveLength(0);
    expect(screener.screen({ name: 'Anna Morozova' })).toHaveLength(0);
  });

  it('does not match an empty or whitespace name', () => {
    expect(screener.screen({ name: '' })).toHaveLength(0);
    expect(screener.screen({ name: '   ' })).toHaveLength(0);
  });

  it('treats a different date of birth as a name-only match, still blocking', () => {
    const hits = screener.screen({ name: 'Viktor Petrovich Morozov', dateOfBirth: '1990-01-01' });
    expect(hits).toHaveLength(1);
    expect(hits[0].matchedOn).toBe('name');
  });

  it('only exposes entries belonging to the configured list', () => {
    const isolated = new SanctionsScreener(
      [{ ...ENTRY, listName: 'test-list' }, { ...ENTRY, reference: 'OFAC-9', listName: 'ofac-sdn' }],
      'test-list',
    );
    const hits = isolated.screen({ name: 'Viktor Petrovich Morozov' });
    expect(hits).toHaveLength(1);
    expect(hits[0].reference).toBe('EU-TEST-1');
    expect(isolated.size).toBe(1);
  });

  it('sends an entity entry (no date of birth) to the wallet screen only', () => {
    const entity = new SanctionsScreener(
      [{ reference: 'EU-TEST-2', name: '0xAbC00000000000000000000000000000000000001', programme: 'test' }],
      'test-list',
    );
    expect(entity.screen({ name: 'Totally Different Person' })).toHaveLength(0);
    const hits = entity.screen({
      name: 'Totally Different Person',
      walletAddress: '0xAbC00000000000000000000000000000000000001',
    });
    expect(hits).toHaveLength(1);
    expect(hits[0].matchedOn).toBe('wallet');
  });

  it('returns nothing when the list is empty', () => {
    expect(new SanctionsScreener([], 'empty-list').screen({ name: 'Anyone At All' })).toHaveLength(0);
  });

  it('ships a seeded EU consolidated list', () => {
    const seed = new SanctionsScreener(EU_CONSOLIDATED_SANCTIONS, 'eu-consolidated');
    expect(seed.size).toBeGreaterThan(0);
    expect(seed.screen({ name: 'Amara Okonkwo-Bright', dateOfBirth: '1984-11-02' })).toHaveLength(1);
  });
});