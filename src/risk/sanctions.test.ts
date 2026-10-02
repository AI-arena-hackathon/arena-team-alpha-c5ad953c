import { SanctionsScreener, isFeedUsable, loadSanctionsFeed, type LoadSanctionsFeedOptions } from './sanctions';
import { EU_CONSOLIDATED_SANCTIONS, type SanctionsEntry } from './referenceData';

const ENTRY: SanctionsEntry = {
  reference: 'EU-TEST-1',
  name: 'Viktor Petrovich Morozov',
  dateOfBirth: '1971-03-14',
  aliases: ['V. P. Morozov'],
  programme: 'EU 833/2014 — asset freezes',
  listName: 'test-list',
};

/** Create a mock Response with a readable body stream from a JSON-serializable body. */
function mockResponse(body: unknown, options: { ok?: boolean; status?: number; statusText?: string; headers?: Record<string, string> } = {}): Response {
  const json = JSON.stringify(body);
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(json));
      controller.close();
    },
  });
  const headersObj = new Headers({
    'content-length': String(json.length),
    'content-type': 'application/json',
    ...options.headers,
  });
  return {
    ok: options.ok ?? true,
    status: options.status ?? 200,
    statusText: options.statusText ?? 'OK',
    headers: headersObj,
    body: stream,
    json: async () => body,
  } as unknown as Response;
}

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

describe('isFeedUsable', () => {
  it('accepts a feed that meets the minimum', () => {
    expect(isFeedUsable({ entries: [ENTRY] })).toBe(true);
  });

  it('rejects an empty feed by default', () => {
    expect(isFeedUsable({ entries: [] })).toBe(false);
  });

  it('honours a configured minimum', () => {
    expect(isFeedUsable({ entries: [ENTRY] }, 2)).toBe(false);
    expect(isFeedUsable({ entries: [ENTRY, ENTRY] }, 2)).toBe(true);
  });
});

describe('loadSanctionsFeed', () => {
  const ok = (body: unknown): LoadSanctionsFeedOptions => ({
    fetchImpl: async () => mockResponse(body),
  });

  it('loads a named feed and preserves entry fields', async () => {
    const feed = await loadSanctionsFeed(
      'https://example.test/sanctions.json',
      ok({ listName: 'eu-consolidated', entries: [ENTRY] }),
    );
    expect(feed.listName).toBe('eu-consolidated');
    expect(feed.entries).toHaveLength(1);
    expect(feed.entries[0]).toMatchObject({ reference: 'EU-TEST-1', name: 'Viktor Petrovich Morozov' });
  });

  it('accepts a bare top-level array of entries', async () => {
    const feed = await loadSanctionsFeed('https://example.test/sanctions.json', ok([ENTRY]));
    expect(feed.listName).toBeUndefined();
    expect(feed.entries).toHaveLength(1);
  });

  it('drops malformed rows missing a reference, name or programme', async () => {
    const feed = await loadSanctionsFeed(
      'https://example.test/sanctions.json',
      ok([
        ENTRY,
        { name: 'No Reference', programme: 'x' },
        { reference: 'R1', programme: 'x' },
        { reference: 'R2', name: 'No Programme' },
      ]),
    );
    expect(feed.entries).toHaveLength(1);
    expect(feed.entries[0].reference).toBe('EU-TEST-1');
  });

  it('normalises optional aliases and list names', async () => {
    const feed = await loadSanctionsFeed(
      'https://example.test/sanctions.json',
      ok({
        entries: [
          {
            reference: 'R3',
            name: 'Entity Ltd',
            programme: 'test',
            aliases: ['Entity', 42, null],
            listName: 'ofac-sdn',
          },
        ],
      }),
    );
    expect(feed.entries[0].aliases).toEqual(['Entity']);
    expect(feed.entries[0].listName).toBe('ofac-sdn');
    expect(feed.entries[0].dateOfBirth).toBeUndefined();
  });

  it('throws when the endpoint responds with an error status', async () => {
    const failing: LoadSanctionsFeedOptions = {
      fetchImpl: async () => mockResponse(null, { ok: false, status: 503, statusText: 'Service Unavailable' }),
    };
    await expect(loadSanctionsFeed('https://example.test/sanctions.json', failing)).rejects.toThrow(
      /503 Service Unavailable/,
    );
  });

  it('rejects a feed whose body is not an object or array', async () => {
    await expect(
      loadSanctionsFeed('https://example.test/sanctions.json', ok('not-a-feed')),
    ).rejects.toThrow(/must be a JSON object or array/);
  });

  describe('timeout and size limits', () => {
    it('times out when the request exceeds the timeout', async () => {
      const slow: LoadSanctionsFeedOptions = {
        fetchImpl: async (input: string | URL | Request, init?: RequestInit) => {
          await new Promise((resolve, reject) => {
            const signal = init?.signal as AbortSignal | undefined;
            if (signal?.aborted) {
              reject(new DOMException('Aborted', 'AbortError'));
              return;
            }
            const timeout = setTimeout(resolve, 50);
            signal?.addEventListener('abort', () => {
              clearTimeout(timeout);
              reject(new DOMException('Aborted', 'AbortError'));
            });
          });
          return mockResponse([ENTRY]);
        },
        timeoutMs: 10,
      };
      await expect(loadSanctionsFeed('https://example.test/sanctions.json', slow)).rejects.toThrow(
        /timed out after 10 ms/,
      );
    });

    it('rejects responses exceeding the size limit (declared content-length)', async () => {
      const large: LoadSanctionsFeedOptions = {
        fetchImpl: (async () => ({
          ok: true,
          headers: new Headers({ 'content-length': '10000000' }), // 10 MB
          json: async () => [ENTRY],
        })) as unknown as typeof fetch,
        maxResponseSizeBytes: 1024, // 1 KB limit
      };
      await expect(loadSanctionsFeed('https://example.test/sanctions.json', large)).rejects.toThrow(
        /Response too large/,
      );
    });

    it('rejects responses exceeding the size limit (streamed body)', async () => {
      const largeBody = JSON.stringify({ entries: Array(1000).fill(ENTRY) }); // ~large payload
      const large: LoadSanctionsFeedOptions = {
        fetchImpl: (async () => ({
          ok: true,
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(largeBody));
              controller.close();
            },
          }),
        })) as unknown as typeof fetch,
        maxResponseSizeBytes: 100, // tiny limit
      };
      await expect(loadSanctionsFeed('https://example.test/sanctions.json', large)).rejects.toThrow(
        /exceeds size limit/,
      );
    });

    it('uses default timeout and size limit when not specified', async () => {
      const feed = await loadSanctionsFeed('https://example.test/sanctions.json', ok([ENTRY]));
      expect(feed.entries).toHaveLength(1);
    });

    it('allows custom timeout and size limit to be set', async () => {
      const customOptions: LoadSanctionsFeedOptions = {
        fetchImpl: async () => mockResponse([ENTRY]),
        timeoutMs: 5000,
        maxResponseSizeBytes: 1024 * 1024, // 1 MB
      };
      const feed = await loadSanctionsFeed('https://example.test/sanctions.json', customOptions);
      expect(feed.entries).toHaveLength(1);
    });
  });
});